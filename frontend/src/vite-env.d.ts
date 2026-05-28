/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL: string;
  readonly VITE_BACKEND_WS_URL: string;
  readonly VITE_ULTRAVOX_BRIDGE_URL: string;
  readonly VITE_WHATSAPP_NUMBER: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
