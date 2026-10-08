// パケットキャプチャ（Wireshark noVNCセッション）用のHTTP+WebSocket中継プロキシ。
//
// なぜ必要か（2026-10-08、console-proxyと同じ理由）:
//   clab-api-serverの`GET /api/v1/capture/wireshark-vnc-sessions/{sessionId}/vnc/{proxyPath}`
//   （noVNCのHTML/JS/CSS資産＋VNC用WebSocketを中継するエンドポイント）は
//   `Authorization: Bearer <jwt>`ヘッダーでしか認証できない（ソースコード確認済み、
//   clab-api-serverの`AuthMiddleware`はクエリパラメータ等の代替を一切持たない）。
//   一方、ブラウザが新しいタブ（`window.open()`）で開くページや、そこから発生する
//   個々のアセット読み込み・WebSocket接続は、カスタムヘッダーを一切設定できない。
//   → ブラウザからは直接開けないため、この中継プロキシがヘッダーを付けて代わりに取得する。
//
// プロトコル（console-proxyと違い、こちらはトークンをURLのパスに埋め込む方式にしている。
// 理由：noVNCは複数のHTML/JS/CSSファイルを素のGETで読みに行く通常のWebアプリであり、
// 「最初の1メッセージでトークンを送る」ようなハンドシェイクをフックできないため）：
//   ブラウザで `http://<proxy>/capture/<jwt>/<clab-api-serverのパス（先頭/から）>` を開くと、
//   このプロキシが `<clab-api-serverのパス>` 部分をそのまま
//   `https://<clab-api-server><そのパス>` にAuthorizationヘッダー付きで転送する
//   （WebSocketアップグレードも同じパスパターンで中継）。
//   `GET .../ready`が返す`url`は`/api/v1/capture/wireshark-vnc-sessions/<sessionId>/vnc/...`
//   という**フルパス**なので（2026-10-08実機確認：`vnc/{proxyPath}`配下の相対パスではなかった）、
//   このプロキシは`/vnc`以下を自分で組み立てたりせず、渡されたパスをそのまま右から左に流すだけにする
//   （sessionIdをこのプロキシ自身のURLパスに含めないのもこのため。既にrest側に入っている）

import { createServer } from 'node:http'
import https from 'node:https'
import { WebSocketServer, WebSocket } from 'ws'

const PROXY_PORT = Number(process.env.CAPTURE_PROXY_PORT ?? 8084)
const CLAB_API_BASE_URL = process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
const upstreamOrigin = new URL(CLAB_API_BASE_URL)
const upstreamIsTls = upstreamOrigin.protocol === 'https:'

// `/capture/<token>/<clab-api-serverのパス...>` を分解する。restはそのまま
// clab-api-server側のパス（`/api/v1/...`）として使うので、ここでは組み立て直さない
function parseCapturePath(rawUrl) {
  const [pathPart, query] = rawUrl.split('?')
  const m = /^\/capture\/([^/]+)(\/.*)?$/.exec(pathPart)
  if (!m) return null
  return {
    token: m[1],
    rest: m[2] || '/',
    query: query ? `?${query}` : '',
  }
}

function upstreamPathFor(parsed) {
  return `${parsed.rest}${parsed.query}`
}

const server = createServer((req, res) => {
  const parsed = parseCapturePath(req.url ?? '')
  if (!parsed) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found: expected /capture/<sessionId>/<token>/...')
    return
  }

  const proxyReq = https.request(
    {
      hostname: upstreamOrigin.hostname,
      port: upstreamOrigin.port || (upstreamIsTls ? 443 : 80),
      path: upstreamPathFor(parsed),
      method: req.method,
      headers: { ...req.headers, authorization: `Bearer ${parsed.token}`, host: upstreamOrigin.host },
      // clab-api-serverの自己署名証明書のため（api-contract.md参照、console-proxyと同じ対応）
      rejectUnauthorized: false,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end('{"error":"upstream request failed"}')
  })
  req.pipe(proxyReq)
})

// noVNC自身が開くVNC用WebSocket接続を中継する。console-proxyと違い、こちらは
// RFBプロトコルの生バイナリフレームをそのまま双方向に流すだけ（JSON等の解釈はしない）
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const parsed = parseCapturePath(req.url ?? '')
  if (!parsed) {
    socket.destroy()
    return
  }

  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(`${upstreamOrigin.protocol === 'https:' ? 'wss' : 'ws'}://${upstreamOrigin.host}${upstreamPathFor(parsed)}`, {
      headers: { Authorization: `Bearer ${parsed.token}` },
      rejectUnauthorized: false,
    })

    const pending = []
    let upstreamOpen = false
    upstream.on('open', () => {
      upstreamOpen = true
      for (const { data, isBinary } of pending.splice(0)) upstream.send(data, { binary: isBinary })
    })

    client.on('message', (data, isBinary) => {
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
      else pending.push({ data, isBinary })
    })
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
    })

    upstream.on('unexpected-response', (_req, upstreamRes) => {
      client.close(1011, `upstream auth failed (${upstreamRes.statusCode})`)
    })
    upstream.on('close', (code, reason) => client.close(code === 1005 ? 1000 : code, reason))
    upstream.on('error', () => client.close(1011, 'upstream connection error'))
    client.on('close', () => upstream.close())
    client.on('error', () => upstream.close())
  })
})

server.listen(PROXY_PORT, () => {
  console.log(`capture-proxy listening on http://localhost:${PROXY_PORT}/capture/<sessionId>/<token>/... (upstream: ${CLAB_API_BASE_URL})`)
})
