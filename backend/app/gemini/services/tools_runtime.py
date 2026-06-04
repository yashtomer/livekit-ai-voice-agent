"""
Runtime bridge between the gemini_tools DB table and Gemini Live's function calling.

For a given agent ID (or list of tool IDs), this module:
  1. Loads the matching tools from DB
  2. Builds a list of Gemini `FunctionDeclaration` objects (with parameter
     schemas + response-key documentation baked into the description)
  3. Provides an async `dispatch_tool_call(name, args)` that:
       - For builtin tools (is_builtin=True with no URL), looks up the Python
         registry in app.gemini.agent_tools.TOOL_REGISTRY.
       - For HTTP tools, makes an aiohttp request (GET → query string, POST →
         JSON body) and returns the JSON response. Network errors return a
         structured `{status: "error", message: ...}` dict so the LLM gets a
         clean response instead of an exception.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional

import aiohttp
from sqlalchemy import select

from ...db import SessionLocal
from ..models.tool import GeminiTool
from ..agent_tools import TOOL_REGISTRY as PYTHON_TOOL_REGISTRY

log = logging.getLogger("tools_runtime")


# ── Dynamic variables ─────────────────────────────────────────────────────────
# Catalog of variables a tool parameter / URL / header can bind to. `populated`
# flags whether `build_call_context` currently fills the value (others resolve to
# "" until a CRM/contact lookup is wired up). Surfaced to the UI via
# GET /api/tools/variables.
AVAILABLE_VARIABLES: list[dict[str, Any]] = [
    {"name": "caller_id",               "label": "Caller phone",        "populated": True,  "description": "The caller's phone number (E.164 without '+')."},
    {"name": "call_sid",                "label": "Call SID",            "populated": True,  "description": "Telephony provider call/stream identifier."},
    {"name": "system__conversation_id", "label": "Conversation ID",     "populated": True,  "description": "Internal call-log id for this conversation."},
    {"name": "system__time",            "label": "Current time",        "populated": True,  "description": "Current timestamp (ISO 8601) when the tool is called."},
    {"name": "system__timezone",        "label": "Timezone",            "populated": True,  "description": "Server timezone name."},
    {"name": "caller_name",             "label": "Caller name",         "populated": False, "description": "Caller's name (empty until a contact lookup is configured)."},
    {"name": "caller_email",            "label": "Caller email",        "populated": False, "description": "Caller's email (empty until a contact lookup is configured)."},
    {"name": "is_returning_caller",     "label": "Returning caller",    "populated": False, "description": "'true'/'false' (empty until a contact lookup is configured)."},
    {"name": "previous_classification", "label": "Prev. classification","populated": False, "description": "Last call's lead/contact/spam classification."},
    {"name": "previous_enquiries_count","label": "Prev. enquiries",     "populated": False, "description": "Count of prior enquiries from this caller."},
    {"name": "last_enquiry_summary",    "label": "Last enquiry",        "populated": False, "description": "Summary of the caller's last requirement."},
]

_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


def build_call_context(
    *,
    caller_id: str | None = None,
    call_sid: str | None = None,
    conversation_id: str | int | None = None,
    now_iso: str | None = None,
    timezone: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Assemble the dynamic-variable map used to resolve tool args at call time.

    Every variable in AVAILABLE_VARIABLES gets a key (defaulting to "") so a
    binding never raises; callers fill in what they know. `extra` overrides/adds.
    """
    from datetime import datetime, timezone as _tz

    ctx: dict[str, str] = {v["name"]: "" for v in AVAILABLE_VARIABLES}
    ctx["caller_id"] = (caller_id or "").lstrip("+")
    ctx["call_sid"] = call_sid or ""
    ctx["system__conversation_id"] = str(conversation_id) if conversation_id is not None else ""
    ctx["system__time"] = now_iso or datetime.now(_tz.utc).isoformat()
    ctx["system__timezone"] = timezone or "UTC"
    if extra:
        ctx.update({k: ("" if v is None else str(v)) for k, v in extra.items()})
    return ctx


def _substitute(template: Any, context: dict[str, str]) -> Any:
    """Replace {{variable}} placeholders in a string using `context`.

    Non-strings pass through untouched. Unknown variables resolve to "".
    """
    if not isinstance(template, str) or "{{" not in template:
        return template
    return _VAR_RE.sub(lambda m: context.get(m.group(1), ""), template)


def render_template(template: str, context: dict[str, str] | None = None) -> str:
    """Public helper: substitute {{variables}} in arbitrary text (e.g. a greeting)."""
    return _substitute(template or "", context or {})


# A parameter is exposed to the LLM only when its value_type is LLM-driven.
# Missing value_type (legacy rows) defaults to LLM-driven for backwards compat.
def _is_llm_param(p: dict[str, Any]) -> bool:
    return (p.get("value_type") or "llm_prompt") == "llm_prompt"

# Lifecycle: one shared HTTP session per process is fine; tools rarely fan out.
_http_session: Optional[aiohttp.ClientSession] = None


def _http() -> aiohttp.ClientSession:
    global _http_session
    if _http_session is None or _http_session.closed:
        _http_session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15))
    return _http_session


# ── Build FunctionDeclarations ───────────────────────────────────────────────

_TYPE_MAP = {
    "string": "STRING",
    "number": "NUMBER",
    "integer": "INTEGER",
    "boolean": "BOOLEAN",
}


def _build_declaration(tool: GeminiTool):
    """Convert a GeminiTool row into a Gemini types.FunctionDeclaration."""
    from google.genai import types

    properties: dict[str, dict] = {}
    required: list[str] = []
    for p in tool.parameters or []:
        name = p.get("name")
        if not name:
            continue
        # Constant / dynamic-variable params are injected server-side at dispatch;
        # the LLM never sees or fills them.
        if not _is_llm_param(p):
            continue
        properties[name] = {
            "type": _TYPE_MAP.get((p.get("type") or "string").lower(), "STRING"),
            "description": p.get("description") or "",
        }
        if p.get("required"):
            required.append(name)

    # Append response-schema docs to description so the LLM knows what to expect.
    desc = tool.description or ""
    if tool.response_schema:
        lines = []
        for r in tool.response_schema:
            key = r.get("key")
            if not key:
                continue
            t = (r.get("type") or "string").lower()
            rd = r.get("description") or ""
            lines.append(f"  - {key} ({t}): {rd}")
        if lines:
            desc = desc.rstrip() + "\n\nResponse keys:\n" + "\n".join(lines)

    schema: dict = {"type": "OBJECT", "properties": properties}
    if required:
        schema["required"] = required

    return types.FunctionDeclaration(
        name=tool.slug,
        description=desc,
        parameters=schema,
    )


async def load_tools_by_ids(tool_ids: list[int]) -> list[GeminiTool]:
    if not tool_ids:
        return []
    try:
        async with SessionLocal() as db:
            rows = (await db.execute(
                select(GeminiTool).where(GeminiTool.id.in_(tool_ids))
            )).scalars().all()
            # Preserve order matching tool_ids
            order = {tid: i for i, tid in enumerate(tool_ids)}
            return sorted(rows, key=lambda r: order.get(r.id, 1_000_000))
    except Exception:
        log.exception("load_tools_by_ids failed")
        return []


KB_TOOL_NAME = "search_knowledge_base"


def _build_kb_declaration():
    """Synthetic FunctionDeclaration for the agent's KB-search tool.

    The agent's linked KB collections are bound at call time inside
    `dispatch_tool_call`; the LLM only sees a single `query` argument.
    """
    from google.genai import types
    return types.FunctionDeclaration(
        name=KB_TOOL_NAME,
        description=(
            "Search the agent's knowledge base for information that may help answer "
            "the caller's question. Call this whenever the caller asks about company "
            "policies, products, prices, hours, procedures, doctor lists, menus, or "
            "any specific facts that you don't already know. Returns the top matching "
            "text passages with their source documents."
            "\n\nResponse keys:\n"
            "  - hits (array of objects): each item has {content, filename, page_number, score}.\n"
            "  - status (string): 'ok' or 'no_results'."
        ),
        parameters={
            "type": "OBJECT",
            "properties": {
                "query": {
                    "type": "STRING",
                    "description": "A short phrase describing what you're looking up.",
                },
            },
            "required": ["query"],
        },
    )


async def build_gemini_tools(tool_ids: list[int], kb_collection_ids: list[int] | None = None):
    """Return a list of `types.Tool` ready to drop into LiveConnectConfig.tools.

    Includes both DB-defined tools (HTTP/Python builtins) and — when the agent
    has KB collections linked — the synthetic `search_knowledge_base` tool.
    """
    from google.genai import types

    tools = await load_tools_by_ids(tool_ids)
    decls = [_build_declaration(t) for t in tools]
    if kb_collection_ids:
        decls.append(_build_kb_declaration())
    if not decls:
        return []
    return [types.Tool(function_declarations=decls)]


# ── Dispatch ────────────────────────────────────────────────────────────────

def resolve_tool_args(
    tool: GeminiTool, llm_args: dict[str, Any], context: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Merge LLM-provided args with server-sourced parameter values.

    For each declared parameter:
      • llm_prompt       → take the model's value (from `llm_args`).
      • constant         → its `constant_value`, with {{variables}} substituted.
      • dynamic_variable → the named variable's value from `context` ("" if unknown).

    Parameters not declared on the tool but emitted by the model are dropped, so
    a model can never override a server-injected value. Returns the final payload.
    """
    ctx = context or {}
    params = tool.parameters or []
    if not params:
        # No declared params — pass the model's args through unchanged.
        return dict(llm_args or {})

    resolved: dict[str, Any] = {}
    for p in params:
        name = p.get("name")
        if not name:
            continue
        vtype = p.get("value_type") or "llm_prompt"
        if vtype == "constant":
            resolved[name] = _substitute(p.get("constant_value") or "", ctx)
        elif vtype == "dynamic_variable":
            var = (p.get("dynamic_variable") or "").strip()
            val = ctx.get(var, "")
            # Fall back to the configured default when the variable is missing
            # or empty (e.g. caller_id / call_sid on a browser call).
            if val in (None, ""):
                val = _substitute(p.get("fallback") or "", ctx)
            resolved[name] = val
        else:  # llm_prompt
            if llm_args and name in llm_args:
                resolved[name] = llm_args[name]
    return resolved


async def _http_call(tool: GeminiTool, args: dict[str, Any],
                     context: dict[str, str] | None = None,
                     meta_out: dict[str, Any] | None = None) -> dict[str, Any]:
    if not tool.url:
        return {"status": "error", "message": f"Tool {tool.slug} has no URL configured"}
    ctx = context or {}
    method = (tool.http_method or "GET").upper()
    # URL and header values may embed {{variables}} too.
    url = _substitute(tool.url, ctx)
    headers = {k: _substitute(v, ctx) for k, v in (tool.headers or {}).items()}
    # Record the outgoing request for the transcript timeline. Headers are
    # intentionally omitted — they can carry secrets (auth tokens).
    if meta_out is not None:
        meta_out.update({"kind": "http", "method": method, "url": url, "payload": args})
    try:
        session = _http()
        if method == "GET":
            async with session.get(url, params=args, headers=headers) as resp:
                body = await resp.text()
        else:
            headers.setdefault("Content-Type", "application/json")
            async with session.request(method, url, json=args, headers=headers) as resp:
                body = await resp.text()

        # Try JSON first; if not JSON, wrap raw body.
        try:
            import json as _json
            return _json.loads(body)
        except Exception:
            return {"status": "ok", "raw": body[:4000]}
    except Exception as e:
        log.exception("HTTP call for tool %s failed", tool.slug)
        return {"status": "error", "message": str(e)}


async def dispatch_tool_call(tool_ids: list[int], name: str, args: dict[str, Any],
                              kb_collection_ids: list[int] | None = None,
                              context: dict[str, str] | None = None,
                              meta_out: dict[str, Any] | None = None) -> dict[str, Any]:
    """Resolve `name` against the agent's tool list and dispatch.

    `context` holds dynamic-variable values (caller_id, system__time, …) used to
    fill constant/dynamic-variable parameters and substitute {{vars}} in the URL
    and headers. See `build_call_context`.

    `meta_out`, when provided, is populated with the actual outgoing request
    (kind/method/url/payload) so the caller can surface it in the transcript.

    Lookup order:
      1. The synthetic `search_knowledge_base` (when the agent has KB collections).
      2. DB tool with matching slug (HTTP or Python builtin).
      3. Direct Python builtin registry (legacy fallback for tools not yet in DB).
    """
    # 1. Built-in KB search
    if name == KB_TOOL_NAME:
        if not kb_collection_ids:
            return {"status": "error", "message": "Agent has no knowledge-base configured"}
        query = (args or {}).get("query") or ""
        if meta_out is not None:
            meta_out.update({"kind": "kb_search", "payload": {"query": str(query), "collection_ids": list(kb_collection_ids)}})
        try:
            from ..kb.search import search as kb_search
            hits = await kb_search(collection_ids=kb_collection_ids, query=str(query), top_k=5)
        except Exception as e:
            log.exception("KB search failed")
            return {"status": "error", "message": f"KB search error: {e}"}
        if not hits:
            return {"status": "no_results", "hits": []}
        # Return full chunk text (cap generously — a chunk is ~600 words ≈ 4 KB).
        # Truncating too aggressively drops the part of the chunk that actually
        # answers the question.
        return {
            "status": "ok",
            "hits": [
                {
                    "content":     h.get("content", "")[:6000],
                    "filename":    h.get("filename"),
                    "page_number": h.get("page_number"),
                    "score":       round(float(h.get("score") or 0), 4),
                }
                for h in hits
            ],
        }

    # 2. DB lookup
    tools = await load_tools_by_ids(tool_ids)
    match = next((t for t in tools if t.slug == name), None)
    if match:
        resolved = resolve_tool_args(match, args or {}, context)
        if match.is_builtin and not match.url:
            if meta_out is not None:
                meta_out.update({"kind": "builtin", "payload": resolved})
            fn = PYTHON_TOOL_REGISTRY.get(name)
            if fn:
                try:
                    return fn(**resolved)
                except Exception as e:
                    log.exception("Builtin tool %s failed", name)
                    return {"status": "error", "message": str(e)}
            return {"status": "error", "message": f"Builtin tool {name} has no Python implementation"}
        return await _http_call(match, resolved, context, meta_out)

    # 3. Direct Python fallback (in case the agent has no tool_ids but tool was emitted)
    if meta_out is not None:
        meta_out.update({"kind": "builtin", "payload": dict(args or {})})
    fn = PYTHON_TOOL_REGISTRY.get(name)
    if fn:
        try:
            return fn(**(args or {}))
        except Exception as e:
            return {"status": "error", "message": str(e)}

    return {"status": "error", "message": f"Unknown tool: {name}"}


# ── Seeding ──────────────────────────────────────────────────────────────────

async def seed_builtin_tools() -> None:
    """Insert the get_doctors_by_department builtin tool on first boot,
    and link it to the healthcare_booking agent so behaviour matches the
    previous static setup."""
    from ..models.agent import GeminiAgent
    try:
        async with SessionLocal() as db:
            existing = (await db.execute(
                select(GeminiTool).where(GeminiTool.slug == "get_doctors_by_department")
            )).scalar_one_or_none()
            if not existing:
                tool = GeminiTool(
                    slug="get_doctors_by_department",
                    name="Doctor Lookup",
                    description=(
                        "Look up the doctors available in a specified medical department "
                        "(e.g. cardiology, dermatology, pediatrics). Call this whenever the "
                        "caller mentions which department or specialty they need so you can "
                        "offer real doctor names."
                    ),
                    http_method="GET",
                    url=None,
                    headers={},
                    parameters=[
                        {
                            "name": "department",
                            "type": "string",
                            "required": True,
                            "description": "Department or medical specialty name, e.g. 'cardiology', 'orthopedics', 'ENT'.",
                        }
                    ],
                    response_schema=[
                        {"key": "status",     "type": "string", "description": "'ok' when doctors found, 'not_found' otherwise."},
                        {"key": "department", "type": "string", "description": "Canonical department name (lowercased)."},
                        {"key": "doctors",    "type": "array",  "description": "List of {name, qualification} when status=ok."},
                        {"key": "message",    "type": "string", "description": "Human-readable message when status=not_found."},
                    ],
                    is_builtin=True,
                )
                db.add(tool)
                await db.commit()
                await db.refresh(tool)
                log.info("Seeded builtin tool: get_doctors_by_department (id=%d)", tool.id)
            else:
                tool = existing

            # Link to healthcare_booking agent if not already linked.
            agent = (await db.execute(
                select(GeminiAgent).where(GeminiAgent.slug == "healthcare_booking")
            )).scalar_one_or_none()
            if agent:
                current = list(agent.tool_ids or [])
                if tool.id not in current:
                    current.append(tool.id)
                    agent.tool_ids = current
                    await db.commit()
                    log.info("Linked builtin tool to healthcare_booking agent")

            # ── transfer_call builtin (warm hand-off to a human agent) ──
            transfer = (await db.execute(
                select(GeminiTool).where(GeminiTool.slug == "transfer_call")
            )).scalar_one_or_none()
            if not transfer:
                transfer = GeminiTool(
                    slug="transfer_call",
                    name="Transfer to Human",
                    description=(
                        "Hand the call off to a live human agent. Use when the caller asks "
                        "for a human/manager, or is clearly frustrated and you can't help. "
                        "Tell the caller you're connecting them first. Works on phone calls "
                        "(Twilio/Vobiz); not available on browser calls."
                    ),
                    http_method="GET",
                    url=None,
                    headers={},
                    parameters=[
                        {"name": "reason", "type": "string", "required": False,
                         "description": "Short reason for the transfer (e.g. 'caller frustrated')."},
                    ],
                    response_schema=[
                        {"key": "status",         "type": "string", "description": "'ok' when transfer started, 'unavailable' on browser, 'error' otherwise."},
                        {"key": "message",         "type": "string", "description": "Human-readable result to read out to the caller."},
                        {"key": "transferred_to",  "type": "string", "description": "The human-agent number the call was redirected to (when status=ok)."},
                    ],
                    is_builtin=True,
                )
                db.add(transfer)
                await db.commit()
                await db.refresh(transfer)
                log.info("Seeded builtin tool: transfer_call (id=%d)", transfer.id)

            # Link transfer_call to the phone-facing demo agents.
            for slug in ("healthcare_booking", "customer_support", "sales_agent"):
                ag = (await db.execute(
                    select(GeminiAgent).where(GeminiAgent.slug == slug)
                )).scalar_one_or_none()
                if not ag:
                    continue
                current = list(ag.tool_ids or [])
                if transfer.id not in current:
                    current.append(transfer.id)
                    ag.tool_ids = current
                    await db.commit()
                    log.info("Linked transfer_call to %s agent", slug)
    except Exception:
        log.exception("seed_builtin_tools failed")
