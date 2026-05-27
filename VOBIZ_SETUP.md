# Vobiz Inbound Calling — Setup Guide

Connects your Vobiz Indian phone number to the Gemini voice agent using
Vobiz's Voice API (webhook + WebSocket — same pattern as Twilio).

**No SIP. No Redis. No port forwarding. Just HTTP/WSS.**

---

## How it works

```
  Caller dials Vobiz number
        │
        ▼
  Vobiz Cloud
        │  POST  https://<your-host>/api/vobiz/voice
        ▼
  Your backend responds:
        <Response><Stream bidirectional="true">
          wss://<your-host>/api/vobiz/stream
        </Stream></Response>
        │
        ▼
  Vobiz opens WebSocket to /api/vobiz/stream
        │
        ▼
  Your bridge ↔ Gemini Live (audio streamed both ways)
```

---

## Step 1 — Set `PUBLIC_HOST` in `.env`

For local dev with ngrok:
```env
PUBLIC_HOST=unreckoned-june-unclandestinely.ngrok-free.app
```

For production:
```env
PUBLIC_HOST=aivoice.aeologic.in
```

> Make sure your reverse proxy (Apache/nginx) forwards `/api/*` to the backend
> and supports WebSocket upgrade (`Upgrade: websocket`).

---

## Step 2 — Restart the backend

```bash
docker compose -f docker-compose-dev.yml restart backend
```

Verify the route is live:
```bash
curl -X POST https://<your-host>/api/vobiz/voice
```

Should return XML with a `<Stream>` element.

---

## Step 3 — Configure Vobiz Number

1. Login to **console.vobiz.ai**
2. Go to **Numbers** → click your Indian number
3. Set:
   - **Answer URL**: `https://<your-host>/api/vobiz/voice`
   - **Answer Method**: `POST`
4. Save

---

## Step 4 — Test

Call your Vobiz number.

Watch backend logs:
```bash
docker compose -f docker-compose-dev.yml logs -f backend | grep vobiz
```

You should see:
```
/api/vobiz/voice → stream wss://.../api/vobiz/stream
Vobiz media stream connected
Vobiz stream <id> (call <id>) started
👤 Hello
🤖 Hi! How can I help you today?
```

---

## Auth ID / Auth Token — when do you need them?

- **Inbound calls (this guide)**: Not needed — Vobiz hits your webhook, no API call required.
- **Outbound calls** (future): Required to POST to `https://api.vobiz.ai/api/v1/Account/<auth_id>/Call/`.
- **Number/account management**: Required.

Store them in `.env`:
```env
VOBIZ_AUTH_ID=your_auth_id
VOBIZ_AUTH_TOKEN=your_auth_token
```

---

## Troubleshooting

**Vobiz logs show "Answer URL returned non-XML"**
- Check `curl https://<your-host>/api/vobiz/voice` returns XML
- Check Apache/nginx isn't rewriting the response

**WebSocket fails to connect**
- Your reverse proxy must support WebSocket upgrade:
  ```nginx
  location /api/ {
      proxy_pass http://127.0.0.1:8000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 86400;
  }
  ```

**One-way audio**
- Confirm `bidirectional="true"` in the XML response (already set)
- Check the `playAudio` events are being sent in backend logs

**Gemini doesn't respond**
- Ensure `GOOGLE_API_KEY` is set in `.env`
- Check Gemini Live quota at https://aistudio.google.com/

---

## Files involved

| File | Purpose |
|------|---------|
| [backend/app/routes/vobiz_bridge.py](backend/app/routes/vobiz_bridge.py) | Webhook + WebSocket bridge |
| [backend/app/main.py](backend/app/main.py) | Router registered under `/api/vobiz` |
| [.env.example](.env.example) | `VOBIZ_AUTH_ID`, `VOBIZ_AUTH_TOKEN`, `PUBLIC_HOST` |
