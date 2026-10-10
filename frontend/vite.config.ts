import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // 開発サーバーはHostヘッダーが許可リストに無いと403を返す（DNSリバインディング対策）。
  // IPアドレス・localhostは常に許可されるので、ホスト名でアクセスする場合はここに足す。
  // 追加は`.env`の`ALLOWED_HOSTS`（カンマ区切り、例: fnl,lab.example.local）で行う。
  const env = loadEnv(mode, process.cwd(), '')
  const extraHosts = (env.ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return {
    plugins: [react()],
    server: { allowedHosts: ['fnl', ...extraHosts] },
  }
})
