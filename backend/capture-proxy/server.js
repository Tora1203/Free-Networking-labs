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
//   ブラウザで `https://<proxy>/capture/<jwt>/<clab-api-serverのパス（先頭/から）>` を開くと、
//   このプロキシが `<clab-api-serverのパス>` 部分をそのまま
//   `https://<clab-api-server><そのパス>` にAuthorizationヘッダー付きで転送する
//   （WebSocketアップグレードも同じパスパターンで中継）。
//   `GET .../ready`が返す`url`は`/api/v1/capture/wireshark-vnc-sessions/<sessionId>/vnc/...`
//   という**フルパス**なので（2026-10-08実機確認：`vnc/{proxyPath}`配下の相対パスではなかった）、
//   このプロキシは`/vnc`以下を自分で組み立てたりせず、渡されたパスをそのまま右から左に流すだけにする
//   （sessionIdをこのプロキシ自身のURLパスに含めないのもこのため。既にrest側に入っている）
//
// このプロキシ自身を2026-10-09にHTTPS化した。理由：noVNC（jlesage/baseimage-gui）には
// ブラウザのClipboard APIを使った「ホストクリップボード自動同期」機能があるが、
// Clipboard APIの非同期read/writeは「secure context」（HTTPS、またはlocalhost）でないと
// 動かない。capture-proxyが平文HTTPのままだと自動同期が有効化されず、ユーザーは
// noVNCのサイドバーにある手動のクリップボードテキストエリア経由でしかコピペできず
// 「ちょっと面倒」という指摘を受けた（手動の方法自体は`backend/capture-proxy/README.md`参照）。
// 自己署名証明書は`certs/`に生成済み（.gitignore対象、リポジトリには含めない）

import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROXY_PORT = Number(process.env.CAPTURE_PROXY_PORT ?? 8084)
// 待ち受けるアドレス（2026-10-15〜既定は127.0.0.1）。ブラウザからはnginx（443）経由でしか使わないので、
// LANに直接開かない（開くと認証の無い前段を素通りで叩ける窓口が増えるため）。開発で直接使う時だけ0.0.0.0に
const LISTEN_HOST = process.env.LISTEN_HOST ?? '127.0.0.1'
const CLAB_API_BASE_URL = process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
const TLS_CERT_PATH = process.env.CAPTURE_PROXY_TLS_CERT ?? path.join(__dirname, 'certs', 'cert.pem')
const TLS_KEY_PATH = process.env.CAPTURE_PROXY_TLS_KEY ?? path.join(__dirname, 'certs', 'key.pem')
const upstreamOrigin = new URL(CLAB_API_BASE_URL)
const upstreamIsTls = upstreamOrigin.protocol === 'https:'

// `/capture/<token>/<clab-api-serverのパス...>?label=<表示ラベル>` を分解する。restはそのまま
// clab-api-server側のパス（`/api/v1/...`）として使うので、ここでは組み立て直さない。
// `label`はこのプロキシだけで使う（上流には渡さない。タブの見分けづらさ対策、2026-10-08追加）
function parseCapturePath(rawUrl) {
  const [pathPart, queryRaw] = rawUrl.split('?')
  const m = /^\/capture\/([^/]+)(\/.*)?$/.exec(pathPart)
  if (!m) return null
  // 中継するのはWiresharkのnoVNC（/api/v1/capture/wireshark-vnc-sessions/<id>/vnc/...）だけ。
  // 以前は任意のパスを中継していた（トークンを持つ本人の権限を超えはしないが、窓口を広げない、2026-10-15）
  if (!/^\/api\/v1\/capture\/wireshark-vnc-sessions\/[^/]+\/vnc(\/|$)/.test(m[2] ?? '')) return null
  const params = new URLSearchParams(queryRaw ?? '')
  const label = params.get('label')
  params.delete('label')
  const query = params.toString()
  return {
    token: m[1],
    rest: m[2] || '/',
    query: query ? `?${query}` : '',
    label,
  }
}

// ログに出すURL。パスに埋め込んだトークン（JWT）を伏せる（journalに24時間有効なトークンが残っていた、2026-10-15）
function redactUrl(rawUrl) {
  return String(rawUrl ?? '').replace(/^\/capture\/[^/?]+/, '/capture/<token>')
}

function upstreamPathFor(parsed) {
  return `${parsed.rest}${parsed.query}`
}

// noVNCのトップページ（HTML）にタブタイトルを埋め込む。どのリンク/インターフェースを
// キャプチャしているタブなのかが見た目で分からない、という指摘（2026-10-08）への対応。
// 単純に<title>を書き換えるだけでは不十分だった：このベースイメージ（jlesage/baseimage-gui）の
// noVNCアプリは読み込み後にJSで`document.title`を"Wireshark"（APP_NAME）に上書きしてしまうため、
// 静的なHTML書き換えがすぐ上書きされて効かなかった（2026-10-09実機確認）。
// → setIntervalで定期的に強制上書きするスクリプトを埋め込んで対抗する
function injectTitle(html, label) {
  const escapedHtml = String(label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const withTitle = /<title>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapedHtml}</title>`)
    : html.replace(/<head[^>]*>/i, (tag) => `${tag}<title>${escapedHtml}</title>`)

  const script = `<script>(function(){var t=${JSON.stringify(String(label))};function enforce(){if(document.title!==t)document.title=t;}enforce();setInterval(enforce,500);})();</script>`
  return /<\/body>/i.test(withTitle) ? withTitle.replace(/<\/body>/i, `${script}</body>`) : `${withTitle}${script}`
}

// ---- 使われなくなったセッションの片付け（2026-10-15） ----
// これまではブラウザ側（captureClient.ts）がタブの`closed`を見て削除していたが、メイン画面を
// リロード・閉じるとその見張りごと消え、Wiresharkコンテナが残っていた。clab-api-server自身は
// 「作ってから2時間（CAPTURE_WIRESHARK_SESSION_TTL）」でしか消さない。
// そこでこのプロキシが、セッションごとにVNCのWebSocketの数を数え、0になって（タブを閉じた）
// IDLE_MS経っても繋ぎ直されなければ、最後に見たトークンでDELETEする。タブのリロードは数秒で
// 繋ぎ直すので消さない。ページは開いたのにWebSocketが一度も来ないもの（読み込み中に閉じた等）も同様
const IDLE_MS = Number(process.env.CAPTURE_IDLE_SECONDS ?? 60) * 1000
const sessions = new Map() // sessionId → { token, sockets, timer }

function sessionIdOf(parsed) {
  return /^\/api\/v1\/capture\/wireshark-vnc-sessions\/([^/]+)\//.exec(parsed.rest)?.[1] ?? null
}

function trackSession(parsed) {
  const id = sessionIdOf(parsed)
  if (!id) return null
  let s = sessions.get(id)
  if (!s) {
    s = { token: parsed.token, sockets: 0, timer: null }
    sessions.set(id, s)
  }
  s.token = parsed.token // 再ログインで新しいトークンになっていればそれを使う
  if (s.sockets === 0) scheduleClose(id, s)
  return id
}

function scheduleClose(id, s) {
  clearTimeout(s.timer)
  s.timer = setTimeout(() => closeSession(id), IDLE_MS)
}

function closeSession(id) {
  const s = sessions.get(id)
  if (!s || s.sockets > 0) return
  sessions.delete(id)
  const req = https.request(
    {
      hostname: upstreamOrigin.hostname,
      port: upstreamOrigin.port || (upstreamIsTls ? 443 : 80),
      path: `/api/v1/capture/wireshark-vnc-sessions/${encodeURIComponent(id)}`,
      method: 'DELETE',
      headers: { authorization: `Bearer ${s.token}` },
      rejectUnauthorized: false,
    },
    (res) => {
      // 404はブラウザ側が先に消していた（タブを閉じた時）ということなので問題ない
      console.log(`[idle] session ${id} unused for ${IDLE_MS / 1000}s -> DELETE ${res.statusCode}`)
      res.resume()
    },
  )
  req.on('error', (err) => console.log(`[idle] session ${id} DELETE failed: ${err.message}`))
  req.end()
}

const tlsOptions = { cert: fs.readFileSync(TLS_CERT_PATH), key: fs.readFileSync(TLS_KEY_PATH) }

const server = https.createServer(tlsOptions, (req, res) => {
  const parsed = parseCapturePath(req.url ?? '')
  if (!parsed) {
    console.log(`[http] 404 no-match: ${req.method} ${redactUrl(req.url)}`)
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found: expected /capture/<token>/<path>')
    return
  }
  trackSession(parsed)
  console.log(`[http] ${req.method} ${redactUrl(req.url)} -> upstream ${upstreamPathFor(parsed)}`)

  const proxyReq = https.request(
    {
      hostname: upstreamOrigin.hostname,
      port: upstreamOrigin.port || (upstreamIsTls ? 443 : 80),
      path: upstreamPathFor(parsed),
      method: req.method,
      // タイトルを書き換える時（label あり）は本文を文字列として読むので、上流に圧縮させない
      headers: {
        ...req.headers,
        ...(parsed.label ? { 'accept-encoding': 'identity' } : {}),
        authorization: `Bearer ${parsed.token}`,
        host: upstreamOrigin.host,
      },
      // clab-api-serverの自己署名証明書のため（api-contract.md参照、console-proxyと同じ対応）
      rejectUnauthorized: false,
    },
    (proxyRes) => {
      console.log(`[http]   <- upstream status ${proxyRes.statusCode}`)
      const contentType = proxyRes.headers['content-type'] ?? ''
      if (parsed.label && contentType.includes('text/html')) {
        let body = ''
        proxyRes.setEncoding('utf8')
        proxyRes.on('data', (chunk) => (body += chunk))
        proxyRes.on('end', () => {
          const rewritten = injectTitle(body, parsed.label)
          // 上流が chunked（transfer-encoding）で返す場合、content-length を足すと両方のヘッダーが付いてしまい、
          // nginx が「Content-Length と Transfer-Encoding が同時にある」として 502 にする（2026-10-29実機確認）。
          // 書き換えた本文は長さが分かっているので、transfer-encoding のほうを外す
          const headers = { ...proxyRes.headers, 'content-length': Buffer.byteLength(rewritten) }
          delete headers['transfer-encoding']
          res.writeHead(proxyRes.statusCode ?? 502, headers)
          res.end(rewritten)
        })
        return
      }
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxyReq.on('error', (err) => {
    console.log(`[http]   <- upstream error: ${err.message}`)
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
    console.log(`[ws] reject no-match: ${redactUrl(req.url)}`)
    socket.destroy()
    return
  }
  console.log(`[ws] upgrade ${redactUrl(req.url)} -> upstream ${upstreamPathFor(parsed)}`)

  // noVNCが要求するサブプロトコル（通常"binary"）をそのまま上流にも伝える。
  // 2026-10-08実機確認：この`Sec-WebSocket-Protocol`ヘッダーが無いと、Wireshark VNCコンテナ内の
  // nginx（websockifyモジュール）がハンドシェイクを`400 Bad Request`で拒否することが分かった
  // （`ws`ライブラリは`protocols`引数を渡さない限りこのヘッダーを自動では送らない）
  const requestedProtocol = req.headers['sec-websocket-protocol']

  wss.handleUpgrade(req, socket, head, (client) => {
    const sessionId = trackSession(parsed)
    const tracked = sessionId ? sessions.get(sessionId) : null
    if (tracked) {
      tracked.sockets++
      clearTimeout(tracked.timer)
      client.on('close', () => {
        tracked.sockets--
        if (tracked.sockets === 0 && sessions.get(sessionId) === tracked) scheduleClose(sessionId, tracked)
      })
    }
    const upstream = new WebSocket(
      `${upstreamOrigin.protocol === 'https:' ? 'wss' : 'ws'}://${upstreamOrigin.host}${upstreamPathFor(parsed)}`,
      requestedProtocol ? requestedProtocol.split(',').map((p) => p.trim()) : undefined,
      {
        headers: { Authorization: `Bearer ${parsed.token}` },
        rejectUnauthorized: false,
      },
    )
    upstream.on('unexpected-response', (_r, upstreamRes) => console.log(`[ws]   <- upstream rejected with ${upstreamRes.statusCode}`))
    upstream.on('open', () => console.log('[ws]   <- upstream open'))
    upstream.on('error', (err) => console.log(`[ws]   <- upstream error: ${err.message}`))

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

server.listen(PROXY_PORT, LISTEN_HOST, () => {
  console.log(`capture-proxy listening on https://localhost:${PROXY_PORT}/capture/<token>/... (upstream: ${CLAB_API_BASE_URL})`)
})
