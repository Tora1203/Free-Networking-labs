// 統合コンソール用のWebSocket中継プロキシ。
//
// なぜ必要か（2026-09-24発見、docs/direction.md参照）:
//   clab-api-server の統合コンソール用WebSocket（GET /api/v1/terminal-sessions/{id}/stream）は
//   認証を `Authorization: Bearer <jwt>` ヘッダーでしか受け付けない（ソースコード・実機確認済み、
//   クエリパラメータ/Cookie等の代替手段は無い）。一方、ブラウザの WebSocket API は
//   ハンドシェイク時にカスタムヘッダーを一切設定できない制約がある。
//   → ブラウザからは直接繋げないため、この小さなプロキシがヘッダーを付けて代わりに接続する。
//
// プロトコル:
//   1. ブラウザは `ws://<proxy>/console?sessionId=<terminal session id>` に接続
//   2. 接続後、最初のメッセージとして `{"token":"<jwt>"}` を送る（トークンをURLに含めない。
//      アクセスログ等に残らないようにするため）
//   3. プロキシはそのトークンで clab-api-server 側に `Authorization` ヘッダー付きで接続し、
//      以降はメッセージをそのまま双方向に中継するだけ（中身のJSON構造は解釈しない）

import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'node:http'
import { URL } from 'node:url'

const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8082)
const CLAB_API_BASE_URL = process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
const AUTH_TIMEOUT_MS = 5000

const upstreamWsBase = CLAB_API_BASE_URL.replace(/^http/, 'ws')

const httpServer = createServer()
const wss = new WebSocketServer({ server: httpServer, path: '/console' })

wss.on('connection', (client, req) => {
  const { searchParams } = new URL(req.url, 'http://localhost')
  const sessionId = searchParams.get('sessionId')
  if (!sessionId) {
    client.close(1008, 'sessionId query parameter is required')
    return
  }

  let authenticated = false
  const authTimer = setTimeout(() => {
    if (!authenticated) client.close(1008, 'auth timeout')
  }, AUTH_TIMEOUT_MS)

  client.once('message', (raw) => {
    clearTimeout(authTimer)
    let token
    try {
      token = JSON.parse(raw.toString()).token
    } catch {
      client.close(1008, 'first message must be {"token": "..."}')
      return
    }
    if (!token) {
      client.close(1008, 'token is required')
      return
    }
    authenticated = true
    connectUpstream(client, sessionId, token)
  })

  client.on('close', () => clearTimeout(authTimer))
})

function connectUpstream(client, sessionId, token) {
  const upstream = new WebSocket(`${upstreamWsBase}/api/v1/terminal-sessions/${encodeURIComponent(sessionId)}/stream`, {
    headers: { Authorization: `Bearer ${token}` },
    rejectUnauthorized: false, // clab-api-server の自己署名証明書のため（api-contract.md参照）
  })

  upstream.on('open', () => {
    // クライアント→アップストリーム
    client.on('message', (data) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data)
    })
  })

  // アップストリーム→クライアント
  upstream.on('message', (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data)
  })

  upstream.on('unexpected-response', (_req, res) => {
    let body = ''
    res.on('data', (chunk) => (body += chunk))
    res.on('end', () => {
      client.close(1011, `upstream auth failed (${res.statusCode}): ${body.slice(0, 100)}`)
    })
  })

  upstream.on('close', (code, reason) => client.close(code === 1005 ? 1000 : code, reason))
  upstream.on('error', () => client.close(1011, 'upstream connection error'))
  client.on('close', () => upstream.close())
  client.on('error', () => upstream.close())
}

httpServer.listen(PROXY_PORT, () => {
  console.log(`console-proxy listening on ws://localhost:${PROXY_PORT}/console (upstream: ${upstreamWsBase})`)
})
