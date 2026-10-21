/// <reference types="vite/client" />

interface ImportMetaEnv {
  // clab-api-server のベースURL。未設定時は client.ts 側で https://localhost:8090 にフォールバック
  readonly VITE_API_BASE_URL?: string
  // 統合コンソール中継プロキシ（backend/console-proxy/）のURL。未設定時はws://localhost:8082
  readonly VITE_CONSOLE_PROXY_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
