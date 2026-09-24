/// <reference types="vite/client" />

interface ImportMetaEnv {
  // clab-api-server のベースURL。未設定時は client.ts 側で https://localhost:8090 にフォールバック
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
