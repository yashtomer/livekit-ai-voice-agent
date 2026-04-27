from pydantic import BaseModel


class TokenRequest(BaseModel):
    stt: dict
    llm: dict
    tts: dict


class TokenResponse(BaseModel):
    token: str
    url: str
    room: str
    identity: str
    call_limit_seconds: int


class APIKeyRequest(BaseModel):
    api_key: str


class APIKeyInfo(BaseModel):
    provider: str
    configured: bool
