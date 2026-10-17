// collab-proxy（試作、2026-10-16）：ラボの「閲覧のみの共有リンク」を作る。
//
// 設計は docs/collab-design.md。clab-api-serverはラボを持ち主のLinuxユーザーでしか見せないので、
// 持ち主が共有を作った時にそのトークンをこのプロセスのメモリにだけ預かり、ゲストの閲覧を持ち主として代行する。
//
// 守りの要（トークンは持ち主の全ラボに効くため）:
//   ・ゲスト向けの窓口は「そのラボのトポロジ・注釈・状態を返す」1つだけ。ゲストはパスもラボ名も指定できない
//     （任意のAPIを中継する作りにしない）。上流に出す問い合わせは下のupstreamGetの3種類だけで、GETのみ
//   ・ゲストも自分のアカウントでログインしていること（clab-api-serverが発行したトークンが有効なこと）。
//     誰が見たかをログに残す。リンクだけでは見られない
//   ・共有の合言葉（id）は192bitの乱数。有効期限（既定8時間、持ち主のトークンの期限まで）で消える
//   ・トークンはメモリにだけ置く。ファイル・ログには出さない（再起動すると共有は消える）
//   ・共有を作れるのは、そのラボの持ち主だけ（上流にそのトークンで問い合わせ、200なら持ち主）
//   ・持ち主ごとの共有の数に上限
//
// 持ち主向け（Authorization: Bearer <JWT>）:
//   POST   /shares          {labName}  → {id, labName, role, expiresAt}
//   GET    /shares                     → 自分の共有の一覧
//   DELETE /shares/<id>                → 取り消し
//   GET    /version/<labName>[?fresh=1] → {version}。今の版（保存の前後の確認用）
//   GET    /watch/<labName>            → SSE。自分のラボのトポロジ（YAML・注釈）が変わったら通知（下の「変更の通知」）
//   POST /shares の role は "view"（既定）か "edit"。editの共有は下の「編集の共有」の窓口が使える
// ゲスト向け（自分のトークンが要る。idが合言葉）:
//   GET    /s/<id>                     → {labName, owner, viewer, role, expiresAt, yaml, annotations, nodes}
//   GET    /s/<id>/watch               → SSE。共有されたラボの変更の通知
//   GET    /s/<id>/version[?fresh=1]   → {version}（持ち主の /version/<lab> と同じ）
//   *      /s/<id>/clab/<API>          → editの共有だけ。許可表（allowClab）に合うclab-api-serverのAPIを持ち主のトークンで中継
//   WS     /s/<id>/console?sessionId=<sid>  → editの共有のコンソール（この共有で作ったセッションだけ。素通しのトンネル）
//   GET/WS /s/<id>/vnc/<sid>/vnc/…     → editの共有のキャプチャ（noVNC。この共有で作ったセッションだけ）
//   POST   /s/<id>/ovs/<frr-config|switch-config> → editの共有だけ。ovs-helperの2つの窓口（labNameは共有のラボに限る）
//
// 編集の共有（2026-10-17、段階3）: editの共有は、ゲストの操作を持ち主のトークンで代行する。
// ゲストはコンテナの中でコマンドを実行できる（exec）ので、権限の重さは「持ち主のノードを触らせる」と同じ。
// 内部ネットワークで、ログイン必須（ゲストは自分のアカウントでログイン済み）が前提（持ち主が了承した範囲）。歯止め:
//   ・中継するのは許可表のAPIだけ。ラボ名は共有に固定（パスのラボ名が違えば拒否）。他のラボ・ラボの作成削除・
//     コンソール・キャプチャは通さない。execのnodeFilterは「そのラボの1ノード」に限る
//   ・既定はview。editは持ち主が共有を作る時に明示して選ぶ。取り消し・期限（8時間）は閲覧と同じ
//   ・編集の操作は、誰が・どのラボの・どの操作かをログに残す（execのコマンドの中身は残さない）
//   ・コンソール／キャプチャ（2026-10-17追加）: セッションを作る操作（許可表）の結果のsessionIdをこの共有に記録し、
//     その後のWebSocket／noVNCの接続は「合言葉(id)＋この共有で作ったsessionId」がある時だけ、持ち主のトークンで通す。
//     ブラウザの新しいタブ・WebSocketはAuthorizationヘッダーを付けられないので、この2つは接続時にゲストのトークンを
//     確かめない（sessionIdはセッションを作ったログイン済みのゲストだけが知る）。共有を取り消す・期限が切れると切る
//
// 変更の通知（2026-10-16）: 同じラボを別の画面で開いている時、変更を1秒ほどで反映するための仕組み。
// ラボごとに1つの見張りが、WATCH_MS（既定1秒）ごとに上流のトポロジ（YAML＋注釈）を見て、変わったら
// 開いている全員に`event: version`（中身の短いハッシュ）を流す。画面は通知を受けたら取り直す。
// 上流への問い合わせは、見ている人数によらずラボあたり毎秒2本。見張りは誰も見なくなったら止まる。
// 見張りは、見ている人の誰かのトークン（接続時にそのラボを読めると確認済み）で問い合わせる。

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { pathToFileURL } from 'node:url'

const SAFE_LAB = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const SAFE_USER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SHARE_ID = /^[A-Za-z0-9_-]{32}$/

const SAFE_NODE = /^[A-Za-z0-9_-]+$/
const ROLES = new Set(['view', 'edit'])
const OVS_PATHS = new Set(['frr-config', 'switch-config'])
const MAX_BODY_BYTES = 2 * 1024 * 1024

// 編集の共有で中継してよいclab-api-serverのAPI。restは`/api/v1/`より後ろ。
// 通れば {op, node?} を返す。ラボ名は共有のラボに固定する（違えばnull）
export function allowClab(method, rest, searchParams, labName, sessions = new Map()) {
  const keys = [...searchParams.keys()]
  const hasQuery = keys.length > 0
  const nodeOf = (c) => {
    const prefix = `clab-${labName}-`
    const node = typeof c === 'string' && c.startsWith(prefix) ? c.slice(prefix.length) : ''
    return SAFE_NODE.test(node) ? node : null
  }
  if (method === 'GET' && rest === 'labs' && !hasQuery) return { op: 'labs' }
  if (rest === 'tools/netem/show' && method === 'GET') {
    const node = nodeOf(searchParams.get('containerName'))
    return keys.length === 1 && node ? { op: 'netem-show', node } : null
  }
  if ((rest === 'tools/netem/set' || rest === 'tools/netem/reset') && method === 'POST' && !hasQuery) {
    return { op: rest.endsWith('set') ? 'netem-set' : 'netem-reset', checkNetemBody: true }
  }
  // キャプチャのセッション：この共有で作ったものだけ
  const cap = /^capture\/wireshark-vnc-sessions\/([A-Za-z0-9_-]+)(\/ready)?$/.exec(rest)
  if (cap) {
    if (hasQuery || sessions.get(cap[1]) !== 'capture') return null
    if (cap[2] && method === 'GET') return { op: 'capture-ready' }
    if (!cap[2] && method === 'DELETE') return { op: 'capture-delete', sid: cap[1] }
    return null
  }
  const m = /^labs\/([^/]+)\/(.+)$/.exec(rest)
  if (!m || m[1] !== labName) return null
  const sub = m[2]
  if (/^topology\/(yaml|annotations)$/.test(sub) && !hasQuery) {
    if (method === 'GET') return { op: 'read' }
    if (method === 'PUT') return { op: 'write-topology' }
    return null
  }
  if (method !== 'POST') return null
  if (sub === 'apply' && !hasQuery) return { op: 'apply' }
  if (/^(start|stop|restart)$/.test(sub) && !hasQuery) return { op: `lab-${sub}` }
  const n = /^nodes\/([^/]+)\/(start|stop|restart)$/.exec(sub)
  if (n && SAFE_NODE.test(n[1]) && !hasQuery) return { op: `node-${n[2]}`, node: n[1] }
  const term = /^nodes\/([^/]+)\/terminal-sessions$/.exec(sub)
  if (term && !hasQuery) {
    const node = nodeOf(term[1])
    if (node) return { op: 'console-create', node }
  }
  if (sub === 'capture/wireshark-vnc-sessions' && !hasQuery) return { op: 'capture-create', checkCaptureBody: true }
  if (sub === 'exec' && keys.length === 1) {
    const node = nodeOf(searchParams.get('nodeFilter'))
    if (node) return { op: 'exec', node }
  }
  return null
}

export function createCollabServer(options = {}) {
  const apiBase = options.apiBase ?? process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
  const ovsBase = options.ovsBase ?? process.env.OVS_HELPER_BASE_URL ?? 'http://127.0.0.1:8083'
  const ttlMs = (options.ttlHours ?? Number(process.env.SHARE_TTL_HOURS ?? 8)) * 3600 * 1000
  const maxPerUser = options.maxPerUser ?? Number(process.env.MAX_SHARES_PER_USER ?? 10)
  const log = options.log ?? ((line) => console.log(line))
  const now = options.now ?? (() => Date.now())

  /** id → {labName, owner, token, role, createdAt, expiresAt} （メモリのみ） */
  const shares = new Map()
  // ログイン確認の結果の控え（トークン → {username, expMs, until}）。閲覧のたびに上流へ問い合わせないため。
  // 失効（ログアウト等）の反映が最大でこの時間遅れるが、見られるのは閲覧のみで、共有の期限も別にある
  const WATCH_MS = options.watchMs ?? Number(process.env.WATCH_MS ?? 1000)
  const HEARTBEAT_MS = options.heartbeatMs ?? 20000
  const MAX_EVENT_BYTES = 512 * 1024
  /** `${ユーザー}:${ラボ}` → {key, labName, subs: Map<res, {token, check?}>, version, timer, polling} */
  const watchers = new Map()
  const AUTH_CACHE_MS = 30000
  const authCache = new Map()
  // 共有ごとの上流の結果の控え。閲覧者が何人いても、上流への問い合わせは共有あたり数秒に1回にする
  const DATA_CACHE_MS = options.dataCacheMs ?? 3000

  function upstreamGet(path, token) {
    return new Promise((resolve, reject) => {
      const url = new URL(apiBase + path)
      const lib = url.protocol === 'http:' ? http : https
      const req = lib.request(
        url,
        { headers: { Authorization: `Bearer ${token}` }, rejectUnauthorized: false, method: 'GET', timeout: 10000 },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
        },
      )
      req.on('timeout', () => req.destroy(new Error('upstream timeout')))
      req.on('error', reject)
      req.end()
    })
  }

  // 編集の共有の中継用：メソッド・ボディつきで上流に出す。結果はそのまま返す（ステータス・種類・本文）
  function upstreamForward(base, method, path, token, body, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const url = new URL(base + path)
      const lib = url.protocol === 'http:' ? http : https
      const headers = { Authorization: `Bearer ${token}` }
      if (body && body.length > 0) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = String(body.length)
      }
      const req = lib.request(url, { headers, rejectUnauthorized: false, method, timeout }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? 'application/json'), body: Buffer.concat(chunks) }),
        )
      })
      req.on('timeout', () => req.destroy(new Error('upstream timeout')))
      req.on('error', reject)
      req.end(body && body.length > 0 ? body : undefined)
    })
  }

  function readBody(req, limit = MAX_BODY_BYTES) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > limit) {
          reject(new Error('too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  function jwtPayload(token) {
    try {
      return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'))
    } catch {
      return null
    }
  }

  function bearer(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
    return m ? m[1] : null
  }

  function send(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  }

  function readJson(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > limit) {
          reject(new Error('too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch (e) {
          reject(e)
        }
      })
      req.on('error', reject)
    })
  }

  // 共有を終わらせる（取り消し・期限・持ち主のトークン失効）。開いているコンソール／キャプチャの接続も切る
  function endShare(id) {
    const s = shares.get(id)
    shares.delete(id)
    if (s && s.tunnels) for (const t of [...s.tunnels]) t.destroy()
  }

  function sweep() {
    for (const [id, s] of shares) if (s.expiresAt <= now()) endShare(id)
    for (const [t, c] of authCache) if (c.until <= now()) authCache.delete(t)
  }

  // 共有のラボの中身を上流から取る（数秒の控え＋同時の問い合わせは1本にまとめる）
  function loadShareData(s) {
    if (s.cache && s.cache.until > now()) return s.cache.promise
    const lab = encodeURIComponent(s.labName)
    const promise = Promise.all([
      upstreamGet(`/api/v1/labs/${lab}/topology/yaml`, s.token),
      upstreamGet(`/api/v1/labs/${lab}/topology/annotations`, s.token),
      upstreamGet('/api/v1/labs', s.token),
    ])
    s.cache = { until: now() + DATA_CACHE_MS, promise }
    promise.catch(() => {
      if (s.cache && s.cache.promise === promise) s.cache = null // 失敗は控えない
    })
    return promise
  }

  function publicShare(id, s) {
    return { id, labName: s.labName, role: s.role, expiresAt: new Date(s.expiresAt).toISOString() }
  }

  // 持ち主として認証する：トークンが有効（200）で、JWTのユーザー名が読めること
  async function authOwner(req) {
    const token = bearer(req)
    if (!token) return null
    const payload = jwtPayload(token)
    const username = payload && typeof payload.username === 'string' ? payload.username : null
    if (!username || !SAFE_USER.test(username)) return null
    const expMs = payload && typeof payload.exp === 'number' ? payload.exp * 1000 : now() + ttlMs
    const cached = authCache.get(token)
    if (cached && cached.until > now() && expMs > now()) return { token, username, expMs }
    const r = await upstreamGet('/api/v1/labs', token).catch(() => null)
    if (!r || r.status !== 200) {
      authCache.delete(token)
      return null
    }
    authCache.set(token, { until: now() + AUTH_CACHE_MS })
    return { token, username, expMs }
  }

  // ゲストとして認証する：ログイン済み（トークンが上流で有効）であること。持ち主の認証と同じ確かめ方
  const authGuest = (req) => authOwner(req)

  function sseWrite(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  // 上流のトポロジ（YAML＋注釈）の版（短いハッシュ）と中身。トークンが使えない・上流が答えない時はnull
  async function computeSnapshot(labName, token, strict = false) {
    const lab = encodeURIComponent(labName)
    const [y, a] = await Promise.all([
      upstreamGet(`/api/v1/labs/${lab}/topology/yaml`, token),
      upstreamGet(`/api/v1/labs/${lab}/topology/annotations`, token),
    ]).catch(() => [null, null])
    if (!y || y.status === 401) return null
    if (strict && y.status !== 200) return null // ラボが無い・読めない
    const version = createHash('sha1').update(`${y.status}\0${y.body}\0${a ? a.status : ''}\0${a ? a.body : ''}`).digest('hex').slice(0, 12)
    return {
      version,
      // 通知に中身も載せる（受け取った画面が取り直さずに済む）。大きすぎる時は版だけ
      yaml: y.status === 200 && y.body.length + (a ? a.body.length : 0) <= MAX_EVENT_BYTES ? y.body : null,
      annotations: a && a.status === 200 && y.body.length + a.body.length <= MAX_EVENT_BYTES ? a.body : null,
    }
  }

  // 版が変わっていたら、見ている全員に流す
  function publishVersion(w, snap) {
    if (snap.version === w.version) return
    w.version = snap.version
    w.snap = snap
    // 共有の閲覧の控え（数秒）は古くなったので捨てる
    for (const sh of shares.values()) if (`${sh.owner}:${sh.labName}` === w.key) sh.cache = null
    for (const res of w.subs.keys()) sseWrite(res, 'version', snap)
  }

  async function pollWatcher(w) {
    if (w.polling) return
    w.polling = true
    try {
      for (const token of new Set([...w.subs.values()].map((x) => x.token))) {
        const snap = await computeSnapshot(w.labName, token) // このトークンが使えなければ次の人のトークンで
        if (snap === null) continue
        publishVersion(w, snap)
        break
      }
    } finally {
      w.polling = false
    }
  }

  // SSEで見張りに加わる。checkは共有の期限など「まだ見ていてよいか」の確認（falseなら切る）
  function subscribe(req, res, key, labName, token, check) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let w = watchers.get(key)
    if (!w) {
      w = { key, labName, subs: new Map(), version: null, snap: null, timer: null, polling: false }
      watchers.set(key, w)
      w.timer = setInterval(() => {
        for (const [r, sub] of w.subs) if (sub.check && !sub.check()) { sseWrite(r, 'closed', { reason: 'expired' }); r.end() }
        void pollWatcher(w)
      }, WATCH_MS)
    }
    w.subs.set(res, { token, check })
    if (w.snap) sseWrite(res, 'version', w.snap) // 接続直後に今の版と中身を教える
    else void pollWatcher(w)
    const beat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS)
    const leave = () => {
      clearInterval(beat)
      w.subs.delete(res)
      if (w.subs.size === 0) {
        clearInterval(w.timer)
        watchers.delete(key)
      }
    }
    req.on('close', leave)
  }

  // 今の版を返す（見張りが持っていればそれ、?fresh=1や未取得なら上流を見る）。持ち主・ゲスト共通
  async function respondVersion(res, url, key, labName, token) {
    const w = watchers.get(key)
    let version = w && w.version
    if (!version || url.searchParams.get('fresh') === '1') {
      const snap = await computeSnapshot(labName, token, true)
      if (snap === null) return send(res, 404, { error: 'ラボが見つかりません' })
      version = snap.version
      if (w) publishVersion(w, snap) // 見ている人がいれば、すぐ通知する
    }
    return send(res, 200, { version })
  }

  // 編集の共有：許可表に合うAPIだけを、共有のラボに固定して持ち主のトークンで中継する。
  // restは元のパス（%エンコードのまま）。%を含むパスは受け付けない（ラボ名・ノード名は英数字だけ）
  async function relayClab(req, res, url, id, s, guest, rest, ip) {
    if (s.role !== 'edit') return send(res, 403, { error: 'この共有は閲覧のみです' })
    const rule = rest.includes('%') ? null : allowClab(req.method ?? '', rest, url.searchParams, s.labName, s.sessions)
    if (!rule) return send(res, 403, { error: 'このAPIは共有では使えません' })
    let body = Buffer.alloc(0)
    if (req.method === 'POST' || req.method === 'PUT') {
      try {
        body = await readBody(req)
      } catch {
        return send(res, 413, { error: 'リクエストが大きすぎます' })
      }
    }
    if (rule.checkCaptureBody) {
      // 対象はそのラボのノード（フルネームか短い名前）とインターフェース名だけ
      let ok = false
      try {
        const targets = JSON.parse(body.toString('utf8')).targets
        const prefix = `clab-${s.labName}-`
        ok =
          Array.isArray(targets) &&
          targets.length >= 1 &&
          targets.length <= 8 &&
          targets.every((t) => {
            const c = t && typeof t.containerName === 'string' ? t.containerName : ''
            return (c.startsWith(prefix) ? SAFE_NODE.test(c.slice(prefix.length)) : !c.startsWith('clab-') && SAFE_NODE.test(c)) && /^[A-Za-z0-9_.-]{1,32}$/.test(t.interfaceName ?? '')
          })
      } catch {
        ok = false
      }
      if (!ok) return send(res, 403, { error: 'このAPIは共有では使えません' })
    }
    if (rule.checkNetemBody) {
      let c = ''
      try {
        c = JSON.parse(body.toString('utf8')).containerName
      } catch {
        /* 下で弾く */
      }
      const prefix = `clab-${s.labName}-`
      const node = typeof c === 'string' && c.startsWith(prefix) ? c.slice(prefix.length) : ''
      if (!SAFE_NODE.test(node)) return send(res, 403, { error: 'このAPIは共有では使えません' })
      rule.node = node
    }
    const r = await upstreamForward(apiBase, req.method ?? 'GET', `/api/v1/${rest}${url.search}`, s.token, body).catch(() => null)
    if (!r) return send(res, 502, { error: 'サーバーに問い合わせられませんでした' })
    if (r.status === 401) {
      endShare(id) // 持ち主のトークンが切れた
      return send(res, 410, { error: '共有の期限が切れました（持ち主のログインが切れたため）' })
    }
    if ((rule.op === 'console-create' || rule.op === 'capture-create') && r.status >= 200 && r.status < 300) {
      // この共有で作ったセッションを覚える（あとのWebSocket／noVNCの接続はこのsessionIdがある時だけ通す）
      try {
        const j = JSON.parse(r.body.toString('utf8'))
        const ids = rule.op === 'console-create' ? [j.sessionId] : (Array.isArray(j.sessions) ? j.sessions : []).map((x) => x && x.sessionId)
        for (const sid of ids) {
          if (typeof sid === 'string' && /^[A-Za-z0-9_-]+$/.test(sid) && s.sessions.size < 50) s.sessions.set(sid, rule.op === 'console-create' ? 'console' : 'capture')
        }
      } catch {
        /* 覚えられなかったセッションには接続できないだけ */
      }
    }
    if (rule.op === 'capture-delete' && ((r.status >= 200 && r.status < 300) || r.status === 404)) s.sessions.delete(rule.sid)
    if (rule.op !== 'read' && rule.op !== 'labs' && rule.op !== 'netem-show' && rule.op !== 'capture-ready') {
      s.cache = null
      log(`edit share=${id.slice(0, 6)} lab=${s.labName} owner=${s.owner} editor=${guest.username} op=${rule.op}${rule.node ? ` node=${rule.node}` : ''} status=${r.status} ip=${ip}`)
    }
    let out = r.body
    if (rule.op === 'labs') {
      // 全ラボの一覧から、この共有のラボの分だけを返す
      try {
        const all = JSON.parse(r.body.toString('utf8'))
        out = Buffer.from(JSON.stringify(Array.isArray(all[s.labName]) ? { [s.labName]: all[s.labName] } : {}))
      } catch {
        out = Buffer.from('{}')
      }
    }
    res.writeHead(r.status, { 'Content-Type': r.type, 'Cache-Control': 'no-store' })
    return res.end(out)
  }

  async function relayOvs(req, res, id, s, guest, name, ip) {
    if (s.role !== 'edit') return send(res, 403, { error: 'この共有は閲覧のみです' })
    if (req.method !== 'POST' || !OVS_PATHS.has(name)) return send(res, 403, { error: 'このAPIは共有では使えません' })
    let body
    try {
      body = await readBody(req, 4096)
      if (JSON.parse(body.toString('utf8') || '{}').labName !== s.labName) return send(res, 403, { error: '共有のラボ以外は使えません' })
    } catch {
      return send(res, 400, { error: 'リクエストが不正です' })
    }
    const r = await upstreamForward(ovsBase, 'POST', `/${name}`, s.token, body, 30000).catch(() => null)
    if (!r) return send(res, 502, { error: 'サーバーに問い合わせられませんでした' })
    log(`edit share=${id.slice(0, 6)} lab=${s.labName} owner=${s.owner} editor=${guest.username} op=${name} status=${r.status} ip=${ip}`)
    res.writeHead(r.status, { 'Content-Type': r.type, 'Cache-Control': 'no-store' })
    return res.end(r.body)
  }

  // 編集の共有のコンソール／キャプチャの接続先を決める。通るのは「この共有で作ったセッション」だけ。
  // 返すのは {s, id, path}（上流のパス）。通せなければnull
  function resolveStream(rawUrl) {
    const [pathPart, query = ''] = rawUrl.split('?')
    sweep()
    let m = /^\/s\/([^/]+)\/console$/.exec(pathPart)
    if (m) {
      const sid = new URLSearchParams(query).get('sessionId') ?? ''
      const s = SHARE_ID.test(m[1]) ? shares.get(m[1]) : undefined
      if (!s || s.role !== 'edit' || s.sessions.get(sid) !== 'console') return null
      return { s, id: m[1], kind: 'console', path: `/api/v1/terminal-sessions/${encodeURIComponent(sid)}/stream` }
    }
    m = /^\/s\/([^/]+)\/vnc\/([A-Za-z0-9_-]+)\/vnc(\/[^?]*)?$/.exec(pathPart)
    if (m) {
      const s = SHARE_ID.test(m[1]) ? shares.get(m[1]) : undefined
      if (!s || s.role !== 'edit' || s.sessions.get(m[2]) !== 'capture') return null
      if ((m[3] ?? '').includes('..') || (m[3] ?? '').includes('%')) return null
      const params = new URLSearchParams(query)
      params.delete('label') // 画面側のタブ名用。上流には渡さない
      const q = params.toString()
      return { s, id: m[1], kind: 'capture', path: `/api/v1/capture/wireshark-vnc-sessions/${m[2]}/vnc${m[3] ?? ''}${q ? `?${q}` : ''}` }
    }
    return null
  }

  // noVNCのページ・資産（GET）を持ち主のトークンで取って返す
  function relayVnc(req, res, target) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' })
    const { s, id } = target
    const url = new URL(apiBase + target.path)
    const lib = url.protocol === 'http:' ? http : https
    const headers = { Authorization: `Bearer ${s.token}` }
    for (const h of ['accept', 'accept-language', 'range', 'if-none-match', 'if-modified-since', 'user-agent']) if (req.headers[h]) headers[h] = req.headers[h]
    const up = lib.request(url, { headers, rejectUnauthorized: false, method: req.method, timeout: 30000 }, (r) => {
      if (r.statusCode === 401) {
        r.resume()
        endShare(id)
        return send(res, 410, { error: '共有の期限が切れました（持ち主のログインが切れたため）' })
      }
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    up.on('timeout', () => up.destroy(new Error('upstream timeout')))
    up.on('error', () => {
      if (!res.headersSent) send(res, 502, { error: 'サーバーに問い合わせられませんでした' })
      else res.destroy()
    })
    up.end()
  }

  // WebSocketの素通しのトンネル：クライアントのハンドシェイクを、持ち主のトークンを付けて上流へ流し、
  // あとは双方向にバイト列をそのまま流す（フレームの中身は読まない）
  function tunnel(req, socket, head, target, ip) {
    const { s, id, kind } = target
    const base = new URL(apiBase)
    const secure = base.protocol === 'https:'
    const port = Number(base.port || (secure ? 443 : 80))
    const up = secure ? tls.connect({ host: base.hostname, port, rejectUnauthorized: false, servername: base.hostname }) : net.connect({ host: base.hostname, port })
    const done = () => {
      s.tunnels.delete(socket)
      socket.destroy()
      up.destroy()
    }
    s.tunnels.add(socket)
    socket.on('error', done)
    socket.on('close', done)
    up.on('error', done)
    up.on('close', done)
    up.once(secure ? 'secureConnect' : 'connect', () => {
      const lines = [`GET ${target.path} HTTP/1.1`, `Host: ${base.host}`, 'Connection: Upgrade', 'Upgrade: websocket']
      for (const h of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
        const v = req.headers[h]
        if (typeof v === 'string') lines.push(`${h}: ${v}`)
      }
      lines.push(`Authorization: Bearer ${s.token}`)
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head && head.length) up.write(head)
      socket.pipe(up)
      up.pipe(socket)
    })
    log(`stream share=${id.slice(0, 6)} lab=${s.labName} owner=${s.owner} kind=${kind} ip=${ip}`)
  }

  async function handle(req, res) {
    sweep()
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()

    // ---- 編集の共有のキャプチャ（noVNCのページ）：新しいタブはヘッダーを付けられないので、合言葉＋sessionIdで通す ----
    if (/^\/s\/[^/]+\/vnc\//.test(path)) {
      const target = resolveStream(req.url ?? '')
      if (!target || target.kind !== 'capture') return send(res, 404, { error: '共有が見つからないか、期限が切れています' })
      return relayVnc(req, res, target)
    }

    // ---- ゲスト：ログイン済みで、idが合言葉 ----
    let m = /^\/s\/([^/]+)\/watch$/.exec(path)
    if (m && req.method === 'GET') {
      const guest = await authGuest(req)
      if (!guest) return send(res, 401, { error: 'ログインが必要です' })
      const id = m[1]
      const s = SHARE_ID.test(id) ? shares.get(id) : undefined
      if (!s) return send(res, 404, { error: '共有が見つからないか、期限が切れています' })
      return subscribe(req, res, `${s.owner}:${s.labName}`, s.labName, s.token, () => shares.has(id) && s.expiresAt > now())
    }
    m = /^\/s\/([^/]+)\/version$/.exec(path)
    if (m && req.method === 'GET') {
      const guest = await authGuest(req)
      if (!guest) return send(res, 401, { error: 'ログインが必要です' })
      const s = SHARE_ID.test(m[1]) ? shares.get(m[1]) : undefined
      if (!s) return send(res, 404, { error: '共有が見つからないか、期限が切れています' })
      return respondVersion(res, url, `${s.owner}:${s.labName}`, s.labName, s.token)
    }
    m = /^\/s\/([^/]+)\/(clab|ovs)\/(.+)$/.exec((req.url ?? '').split('?')[0])
    if (m) {
      const guest = await authGuest(req)
      if (!guest) return send(res, 401, { error: 'ログインが必要です' })
      const id = m[1]
      const s = SHARE_ID.test(id) ? shares.get(id) : undefined
      if (!s) return send(res, 404, { error: '共有が見つからないか、期限が切れています' })
      return m[2] === 'clab' ? relayClab(req, res, url, id, s, guest, m[3], ip) : relayOvs(req, res, id, s, guest, m[3], ip)
    }
    m = /^\/s\/([^/]+)$/.exec(path)
    if (m && req.method === 'GET') {
      const guest = await authGuest(req)
      if (!guest) return send(res, 401, { error: 'ログインが必要です' })
      const id = m[1]
      const s = SHARE_ID.test(id) ? shares.get(id) : undefined
      if (!s) return send(res, 404, { error: '共有が見つからないか、期限が切れています' })
      const t0 = Date.now()
      // 上流に出すのはこの3つのGETだけ（ラボ名は共有に固定。ゲストの入力は使わない）
      const [yaml, annotations, labs] = await loadShareData(s).catch(() => [null, null, null])
      if (!yaml || !labs) return send(res, 502, { error: 'サーバーに問い合わせられませんでした' })
      if (yaml.status === 401 || labs.status === 401) {
        endShare(id) // 持ち主のトークンが切れた
        return send(res, 410, { error: '共有の期限が切れました（持ち主のログインが切れたため）' })
      }
      if (yaml.status !== 200) return send(res, 404, { error: 'ラボが見つかりません' })
      let nodes = []
      try {
        // 全ラボの一覧から、このラボの分だけを返す（他のラボの情報は出さない）
        const all = JSON.parse(labs.body)
        nodes = Array.isArray(all[s.labName]) ? all[s.labName] : []
      } catch {
        nodes = []
      }
      log(`view share=${id.slice(0, 6)} lab=${s.labName} owner=${s.owner} viewer=${guest.username} ip=${ip} ms=${Date.now() - t0}`)
      return send(res, 200, {
        labName: s.labName,
        owner: s.owner,
        viewer: guest.username,
        role: s.role,
        expiresAt: new Date(s.expiresAt).toISOString(),
        yaml: yaml.body,
        annotations: annotations && annotations.status === 200 ? annotations.body : null,
        nodes,
      })
    }

    // ---- 自分のラボの変更の通知 ----
    m = /^\/watch\/([^/]+)$/.exec(path)
    if (m && req.method === 'GET') {
      const me = await authOwner(req)
      if (!me) return send(res, 401, { error: 'ログインが必要です' })
      if (!SAFE_LAB.test(m[1])) return send(res, 400, { error: 'ラボ名が不正です' })
      const own = await upstreamGet(`/api/v1/labs/${encodeURIComponent(m[1])}/topology/yaml`, me.token).catch(() => null)
      if (!own || own.status !== 200) return send(res, 404, { error: 'ラボが見つかりません' })
      return subscribe(req, res, `${me.username}:${m[1]}`, m[1], me.token, null)
    }

    // 自分のラボの今の版（保存の前後の確認用。軽い）。?fresh=1は見張りの次の周期を待たず今の上流を見る
    m = /^\/version\/([^/]+)$/.exec(path)
    if (m && req.method === 'GET') {
      const me = await authOwner(req)
      if (!me) return send(res, 401, { error: 'ログインが必要です' })
      if (!SAFE_LAB.test(m[1])) return send(res, 400, { error: 'ラボ名が不正です' })
      return respondVersion(res, url, `${me.username}:${m[1]}`, m[1], me.token)
    }

    // ---- 持ち主 ----
    if (path === '/shares' || /^\/shares\/[^/]+$/.test(path)) {
      const owner = await authOwner(req)
      if (!owner) return send(res, 401, { error: 'ログインが必要です' })

      if (path === '/shares' && req.method === 'POST') {
        let body
        try {
          body = await readJson(req)
        } catch {
          return send(res, 400, { error: 'リクエストが不正です' })
        }
        const labName = typeof body.labName === 'string' ? body.labName : ''
        if (!SAFE_LAB.test(labName)) return send(res, 400, { error: 'ラボ名が不正です' })
        const role = body.role === undefined ? 'view' : body.role
        if (typeof role !== 'string' || !ROLES.has(role)) return send(res, 400, { error: 'roleはviewかeditです' })
        // そのラボの持ち主か（持ち主のトークンで問い合わせて200ならそう）
        const own = await upstreamGet(`/api/v1/labs/${encodeURIComponent(labName)}/topology/yaml`, owner.token).catch(() => null)
        if (!own || own.status !== 200) return send(res, 403, { error: '自分のラボだけ共有できます' })
        const mine = [...shares.values()].filter((s) => s.owner === owner.username).length
        if (mine >= maxPerUser) return send(res, 429, { error: `共有は${maxPerUser}件までです。不要なものを取り消してください` })
        const id = randomBytes(24).toString('base64url')
        const s = {
          labName,
          owner: owner.username,
          token: owner.token,
          role,
          sessions: new Map(), // sessionId → 'console'|'capture'（この共有で作ったもの）
          tunnels: new Set(), // 開いているWebSocketのトンネル（共有の終了で切る）
          createdAt: now(),
          expiresAt: Math.min(now() + ttlMs, owner.expMs),
        }
        shares.set(id, s)
        log(`create share=${id.slice(0, 6)} lab=${labName} owner=${owner.username} role=${role}`)
        return send(res, 201, publicShare(id, s))
      }
      if (path === '/shares' && req.method === 'GET') {
        const list = [...shares].filter(([, s]) => s.owner === owner.username).map(([id, s]) => publicShare(id, s))
        return send(res, 200, { shares: list })
      }
      m = /^\/shares\/([^/]+)$/.exec(path)
      if (m && req.method === 'DELETE') {
        const s = shares.get(m[1])
        // 他人の共有は存在も教えない
        if (!s || s.owner !== owner.username) return send(res, 404, { error: '共有が見つかりません' })
        endShare(m[1])
        log(`delete share=${m[1].slice(0, 6)} lab=${s.labName} owner=${owner.username}`)
        return send(res, 200, { ok: true })
      }
    }
    return send(res, 404, { error: 'not found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`error ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })
  server.on('upgrade', (req, socket, head) => {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()
    const target = resolveStream(req.url ?? '')
    if (!target) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    tunnel(req, socket, head, target, ip)
  })
  server.sharesForTest = shares
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.COLLAB_PROXY_PORT ?? 8085)
  const host = process.env.LISTEN_HOST ?? '127.0.0.1'
  createCollabServer().listen(port, host, () => console.log(`collab-proxy listening on ${host}:${port}`))
}
