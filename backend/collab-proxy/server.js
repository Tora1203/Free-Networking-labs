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
// ゲスト向け（自分のトークンが要る。idが合言葉）:
//   GET    /s/<id>                     → {labName, owner, viewer, role, expiresAt, yaml, annotations, nodes}

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { pathToFileURL } from 'node:url'

const SAFE_LAB = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const SAFE_USER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SHARE_ID = /^[A-Za-z0-9_-]{32}$/

export function createCollabServer(options = {}) {
  const apiBase = options.apiBase ?? process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
  const ttlMs = (options.ttlHours ?? Number(process.env.SHARE_TTL_HOURS ?? 8)) * 3600 * 1000
  const maxPerUser = options.maxPerUser ?? Number(process.env.MAX_SHARES_PER_USER ?? 10)
  const log = options.log ?? ((line) => console.log(line))
  const now = options.now ?? (() => Date.now())

  /** id → {labName, owner, token, role, createdAt, expiresAt} （メモリのみ） */
  const shares = new Map()

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

  function sweep() {
    for (const [id, s] of shares) if (s.expiresAt <= now()) shares.delete(id)
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
    const r = await upstreamGet('/api/v1/labs', token).catch(() => null)
    if (!r || r.status !== 200) return null
    const expMs = payload && typeof payload.exp === 'number' ? payload.exp * 1000 : now() + ttlMs
    return { token, username, expMs }
  }

  // ゲストとして認証する：ログイン済み（トークンが上流で有効）であること。持ち主の認証と同じ確かめ方
  const authGuest = (req) => authOwner(req)

  async function handle(req, res) {
    sweep()
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()

    // ---- ゲスト：ログイン済みで、idが合言葉 ----
    let m = /^\/s\/([^/]+)$/.exec(path)
    if (m && req.method === 'GET') {
      const guest = await authGuest(req)
      if (!guest) return send(res, 401, { error: 'ログインが必要です' })
      const id = m[1]
      const s = SHARE_ID.test(id) ? shares.get(id) : undefined
      if (!s) return send(res, 404, { error: '共有が見つからないか、期限が切れています' })
      const lab = encodeURIComponent(s.labName)
      // 上流に出すのはこの3つのGETだけ（ラボ名は共有に固定。ゲストの入力は使わない）
      const [yaml, annotations, labs] = await Promise.all([
        upstreamGet(`/api/v1/labs/${lab}/topology/yaml`, s.token),
        upstreamGet(`/api/v1/labs/${lab}/topology/annotations`, s.token),
        upstreamGet('/api/v1/labs', s.token),
      ]).catch(() => [null, null, null])
      if (!yaml || !labs) return send(res, 502, { error: 'サーバーに問い合わせられませんでした' })
      if (yaml.status === 401 || labs.status === 401) {
        shares.delete(id) // 持ち主のトークンが切れた
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
      log(`view share=${id.slice(0, 6)} lab=${s.labName} owner=${s.owner} viewer=${guest.username} ip=${ip}`)
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
          role: 'view',
          createdAt: now(),
          expiresAt: Math.min(now() + ttlMs, owner.expMs),
        }
        shares.set(id, s)
        log(`create share=${id.slice(0, 6)} lab=${labName} owner=${owner.username}`)
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
        shares.delete(m[1])
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
  server.sharesForTest = shares
  return server
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.COLLAB_PROXY_PORT ?? 8085)
  const host = process.env.LISTEN_HOST ?? '127.0.0.1'
  createCollabServer().listen(port, host, () => console.log(`collab-proxy listening on ${host}:${port}`))
}
