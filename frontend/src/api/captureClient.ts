// パケットキャプチャ（WiresharkのnoVNCセッション）を開始し、backend/capture-proxy/ 経由で
// 新しいブラウザタブに表示するためのクライアント（2026-10-08追加）。
//
// clab-api-serverの`GET /capture/wireshark-vnc-sessions/{sessionId}/vnc/{proxyPath}`は
// Authorizationヘッダーでしか認証できず、ブラウザの新規タブ/WebSocketはカスタムヘッダーを
// 設定できないため、console-proxyと同様に専用の中継プロキシ（capture-proxy）を経由する。
// 違いは、capture-proxyはトークンをURLのパスに埋め込む方式にしている点
// （noVNCは複数ファイルを素のGETで読みに行く通常のWebアプリのため、
// 「最初の1メッセージでトークンを送る」ようなハンドシェイクが使えない。
// backend/capture-proxy/README.md参照）。
import { createCaptureSessions, getCaptureSessionReady, getAuthToken, type CaptureTarget } from './client'

const CAPTURE_PROXY_BASE_URL = import.meta.env.VITE_CAPTURE_PROXY_URL ?? 'http://localhost:8084'

// セッション作成直後はまだWiresharkコンテナの起動中で`ready`がfalseのことがあるため、
// 少し待ってから何度か再確認する
const READY_POLL_INTERVAL_MS = 1000
const READY_POLL_MAX_ATTEMPTS = 30

async function waitUntilReady(sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < READY_POLL_MAX_ATTEMPTS; attempt++) {
    const { ready, url } = await getCaptureSessionReady(sessionId)
    if (ready) return url
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS))
  }
  throw new Error('キャプチャセッションの起動がタイムアウトしました')
}

// 指定したターゲット（コンテナ名＋インターフェース名）ごとにWireshark noVNCセッションを作成し、
// 準備ができたらcapture-proxy経由のURLを新しいタブで開く。1つでも失敗したらエラーを投げる
export async function startPacketCapture(labName: string, targets: CaptureTarget[]): Promise<void> {
  const token = getAuthToken()
  if (!token) throw new Error('ログインしていません')
  if (targets.length === 0) throw new Error('キャプチャ対象のインターフェースがありません（L2スイッチはコンテナを持たないため対象外）')

  const { sessions } = await createCaptureSessions(labName, targets)
  await Promise.all(
    sessions.map(async (session) => {
      // readyが返す`url`はclab-api-server側の完全なパス（`/api/v1/capture/wireshark-vnc-sessions/
      // <sessionId>/vnc/...`）であり、`/vnc/`配下の相対パスではない（2026-10-08実機確認）。
      // そのままcapture-proxyのパスに埋め込んで渡す（capture-proxy側もそのまま中継するだけ）
      const vncPath = await waitUntilReady(session.sessionId)
      const normalizedPath = vncPath.startsWith('/') ? vncPath : `/${vncPath}`
      const url = `${CAPTURE_PROXY_BASE_URL}/capture/${encodeURIComponent(token)}${normalizedPath}`
      window.open(url, '_blank')
    }),
  )
}
