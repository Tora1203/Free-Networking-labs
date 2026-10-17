import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createCollabServer } from './server.js'

function jwt(username, expSec = Math.floor(Date.now() / 1000) + 3600) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64({ username, exp: expSec })}.sig`
}

// clab-api-serverの代役：トークンのユーザーが持つラボだけ見える
function startMockApi(labsByUser, revoked = new Set()) {
  const calls = []
  const state = { rev: 0 }
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
    const user = token ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).username : null
    if (!user || revoked.has(token)) {
      res.writeHead(401).end('{}')
      return
    }
    const mine = labsByUser[user] ?? {}
    if (req.url === '/api/v1/labs') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Object.fromEntries(Object.keys(mine).map((l) => [l, [{ name: 'n1', state: 'running' }]]))))
      return
    }
    const m = /^\/api\/v1\/labs\/([^/]+)\/topology\/(yaml|annotations)$/.exec(req.url)
    if (m && mine[m[1]]) {
      res.writeHead(200).end(m[2] === 'yaml' ? `name: ${m[1]}${state.rev ? '#' + state.rev : ''}` : '{"title":"t"}')
      return
    }
    // 編集の共有の中継先：持ち主のラボへの書き込み系は200で応じ、呼ばれたことを記録する（本文もcallsに入れる）
    const w = /^\/api\/v1\/labs\/([^/]+)\/(apply|start|stop|restart|exec|nodes\/[^/]+\/(?:start|stop|restart)|topology\/(?:yaml|annotations))(\?.*)?$/.exec(req.url)
    if ((req.method === 'POST' || req.method === 'PUT') && w && mine[w[1]]) {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        calls.push(`body ${b}`)
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
      })
      return
    }
    if (req.method === 'POST' && /^\/api\/v1\/tools\/netem\/(set|reset)$/.test(req.url)) {
      res.writeHead(200).end('{"ok":true}')
      return
    }
    res.writeHead(404).end('{}')
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, state, base: `http://127.0.0.1:${server.address().port}` })))
}

async function setup(opts = {}) {
  const api = await startMockApi({ alice: { 'alice-lab1': true, 'alice-lab2': true }, bob: { 'bob-lab': true } }, opts.revoked)
  const logs = []
  const collab = createCollabServer({ apiBase: api.base, log: (l) => logs.push(l), ...opts })
  await new Promise((r) => collab.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${collab.address().port}`
  const call = (method, path, { token, body } = {}) =>
    fetch(url + path, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, json: await r.json() }))
  const close = () => {
    collab.close()
    api.server.close()
  }
  return { api, collab, logs, call, close }
}

test('持ち主が共有を作り、ログインしたゲストが閲覧できる。ラボ以外は出ない', async () => {
  const t = await setup()
  const alice = jwt('alice')
  const created = await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1' } })
  assert.equal(created.status, 201)
  assert.equal(created.json.role, 'view')
  assert.match(created.json.id, /^[A-Za-z0-9_-]{32}$/)
  const view = await t.call('GET', `/s/${created.json.id}`, { token: jwt('bob') })
  assert.equal(view.status, 200)
  assert.equal(view.json.viewer, 'bob')
  assert.equal(view.json.labName, 'alice-lab1')
  assert.equal(view.json.yaml, 'name: alice-lab1')
  assert.deepEqual(Object.keys(view.json).sort(), ['annotations', 'expiresAt', 'labName', 'nodes', 'owner', 'role', 'viewer', 'yaml'])
  assert.deepEqual(view.json.nodes, [{ name: 'n1', state: 'running' }]) // alice-lab2は出ない
  assert.ok(!JSON.stringify(view.json).includes('lab2'))
  t.close()
})

test('上流に出る問い合わせはGETだけで、ラボは共有のものに固定される', async () => {
  const t = await setup()
  const c = await t.call('POST', '/shares', { token: jwt('alice'), body: { labName: 'alice-lab1' } })
  t.api.calls.length = 0
  await t.call('GET', `/s/${c.json.id}`, { token: jwt('bob') })
  assert.ok(t.api.calls.every((l) => l.startsWith('GET ')))
  assert.ok(t.api.calls.every((l) => l === 'GET /api/v1/labs' || l.includes('/labs/alice-lab1/topology/')))
  t.close()
})

test('他人のラボは共有できない／不正なラボ名・トークンは拒否', async () => {
  const t = await setup()
  assert.equal((await t.call('POST', '/shares', { token: jwt('alice'), body: { labName: 'bob-lab' } })).status, 403)
  assert.equal((await t.call('POST', '/shares', { token: jwt('alice'), body: { labName: '../etc' } })).status, 400)
  assert.equal((await t.call('POST', '/shares', { body: { labName: 'alice-lab1' } })).status, 401)
  assert.equal((await t.call('POST', '/shares', { token: 'garbage', body: { labName: 'alice-lab1' } })).status, 401)
  t.close()
})

test('ゲストは合言葉の推測・ほかのパスでは何も得られない', async () => {
  const t = await setup()
  const bob = jwt('bob')
  assert.equal((await t.call('GET', '/s/short', { token: bob })).status, 404)
  assert.equal((await t.call('GET', `/s/${'a'.repeat(32)}`, { token: bob })).status, 404)
  assert.equal((await t.call('GET', '/shares')).status, 401)
  assert.equal((await t.call('GET', '/api/v1/labs')).status, 404)
  t.close()
})

test('ログインしていないゲスト（トークン無し・無効）はリンクがあっても見られない。見た人がログに残る', async () => {
  const t = await setup()
  const c = await t.call('POST', '/shares', { token: jwt('alice'), body: { labName: 'alice-lab1' } })
  assert.equal((await t.call('GET', `/s/${c.json.id}`)).status, 401)
  assert.equal((await t.call('GET', `/s/${c.json.id}`, { token: 'garbage' })).status, 401)
  assert.equal((await t.call('GET', `/s/${c.json.id}`, { token: jwt('bob') })).status, 200)
  assert.ok(t.logs.some((l) => l.includes('viewer=bob')))
  t.close()
})

test('取り消しは持ち主だけ。取り消すとゲストは見られない', async () => {
  const t = await setup()
  const alice = jwt('alice')
  const c = await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1' } })
  assert.equal((await t.call('DELETE', `/shares/${c.json.id}`, { token: jwt('bob') })).status, 404)
  assert.equal((await t.call('GET', `/s/${c.json.id}`, { token: jwt('bob') })).status, 200)
  assert.equal((await t.call('DELETE', `/shares/${c.json.id}`, { token: alice })).status, 200)
  assert.equal((await t.call('GET', `/s/${c.json.id}`, { token: jwt('bob') })).status, 404)
  t.close()
})

test('一覧は自分の共有だけ。件数の上限がある', async () => {
  const t = await setup({ maxPerUser: 2 })
  const alice = jwt('alice')
  await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1' } })
  await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab2' } })
  assert.equal((await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1' } })).status, 429)
  assert.equal((await t.call('GET', '/shares', { token: alice })).json.shares.length, 2)
  assert.equal((await t.call('GET', '/shares', { token: jwt('bob') })).json.shares.length, 0)
  t.close()
})

test('期限切れ／持ち主のトークンが失効したら見られない', async () => {
  let clock = Date.now()
  const alice = jwt('alice')
  const revoked = new Set()
  const t = await setup({ ttlHours: 1, now: () => clock, revoked })
  const c = await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1' } })
  revoked.add(alice) // 持ち主のトークンが上流で無効になった
  const bob = jwt('bob')
  assert.equal((await t.call('GET', `/s/${c.json.id}`, { token: bob })).status, 410)
  assert.equal((await t.call('GET', `/s/${c.json.id}`, { token: bob })).status, 404)
  const t2 = await setup({ ttlHours: 1, now: () => clock })
  const c2 = await t2.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1' } })
  clock += 2 * 3600 * 1000
  assert.equal((await t2.call('GET', `/s/${c2.json.id}`, { token: bob })).status, 404)
  t.close()
  t2.close()
})

test('ログにトークンを出さない', async () => {
  const t = await setup()
  const alice = jwt('alice')
  const c = await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1' } })
  await t.call('GET', `/s/${c.json.id}`, { token: jwt('bob') })
  const all = t.logs.join('\n')
  assert.ok(!all.includes(alice) && !all.includes(alice.split('.')[1]))
  assert.ok(!all.includes(c.json.id)) // 合言葉も先頭6文字だけ
  t.close()
})

test('閲覧者が何人いても、上流への問い合わせは数秒に1回分（控え）', async () => {
  const t = await setup()
  const c = await t.call('POST', '/shares', { token: jwt('alice'), body: { labName: 'alice-lab1' } })
  t.api.calls.length = 0
  const viewers = ['bob', 'bob', 'carol', 'carol', 'bob']
  const results = await Promise.all(viewers.map((v) => t.call('GET', `/s/${c.json.id}`, { token: jwt(v) })))
  assert.ok(results.every((r) => r.status === 200))
  const yamlCalls = t.api.calls.filter((l) => l.includes('/topology/yaml'))
  assert.equal(yamlCalls.length, 1)
  t.close()
})

// SSEを読む：届いたイベントを集める
async function openStream(url, token) {
  const ctrl = new AbortController()
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctrl.signal })
  const events = []
  if (res.status !== 200) return { status: res.status, events, close: () => ctrl.abort() }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const ev = /^event: (.+)$/m.exec(block)?.[1]
          const data = /^data: (.+)$/m.exec(block)?.[1]
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) })
        }
      }
    } catch {
      // 切断
    }
  })()
  return { status: 200, events, close: () => ctrl.abort() }
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return false
}

test('変更の通知：自分のラボの変更が、見ている全員に届く。他人のラボは見られない', async () => {
  const t = await setup({ watchMs: 40 })
  const base = `http://127.0.0.1:${t.collab.address().port}`
  const a1 = await openStream(`${base}/watch/alice-lab1`, jwt('alice'))
  const a2 = await openStream(`${base}/watch/alice-lab1`, jwt('alice'))
  assert.equal(a1.status, 200)
  assert.ok(await until(() => a1.events.length >= 1 && a2.events.length >= 1)) // 接続直後に今の版
  const first = a1.events[0].data.version
  assert.equal(a1.events[0].data.yaml, 'name: alice-lab1') // 通知に中身も付いてくる
  assert.equal(a1.events[0].data.annotations, '{"title":"t"}')
  t.api.state.rev = 1 // 別の画面が保存した
  assert.ok(await until(() => a1.events.length >= 2 && a2.events.length >= 2))
  assert.notEqual(a1.events[1].data.version, first)
  assert.equal((await openStream(`${base}/watch/bob-lab`, jwt('alice'))).status, 404) // 自分のラボではない
  assert.equal((await openStream(`${base}/watch/alice-lab1`)).status, 401)
  assert.equal((await openStream(`${base}/watch/..%2Fx`, jwt('alice'))).status, 400)
  a1.close()
  a2.close()
  t.close()
})

test('変更の通知：共有のゲストにも届く。取り消すと切れる。ログインが要る', async () => {
  const t = await setup({ watchMs: 40 })
  const base = `http://127.0.0.1:${t.collab.address().port}`
  const c = await t.call('POST', '/shares', { token: jwt('alice'), body: { labName: 'alice-lab1' } })
  assert.equal((await openStream(`${base}/s/${c.json.id}/watch`)).status, 401)
  const g = await openStream(`${base}/s/${c.json.id}/watch`, jwt('bob'))
  assert.ok(await until(() => g.events.length >= 1))
  t.api.state.rev = 2
  assert.ok(await until(() => g.events.length >= 2))
  await t.call('DELETE', `/shares/${c.json.id}`, { token: jwt('alice') })
  assert.ok(await until(() => g.events.some((e) => e.event === 'closed')))
  g.close()
  t.close()
})

test('版の確認：軽く答え、?fresh=1は見張りの周期を待たずに通知する', async () => {
  const t = await setup({ watchMs: 60000 }) // 見張りの周期は十分長い（通知が周期に頼っていないことを見る）
  const base = `http://127.0.0.1:${t.collab.address().port}`
  const alice = jwt('alice')
  const s = await openStream(`${base}/watch/alice-lab1`, alice)
  try {
  assert.ok(await until(() => s.events.length >= 1))
  const v0 = (await t.call('GET', '/version/alice-lab1', { token: alice })).json.version
  assert.equal(v0, s.events[0].data.version)
  t.api.state.rev = 3 // 保存した
  assert.equal((await t.call('GET', '/version/alice-lab1', { token: alice })).json.version, v0) // 見張りの控えのまま
  const fresh = await t.call('GET', '/version/alice-lab1?fresh=1', { token: alice })
  assert.notEqual(fresh.json.version, v0)
  assert.ok(await until(() => s.events.length >= 2)) // 見ている人に即通知
  assert.equal(s.events[1].data.version, fresh.json.version)
  assert.equal((await t.call('GET', '/version/bob-lab', { token: alice })).status, 404)
  assert.equal((await t.call('GET', '/version/alice-lab1')).status, 401)
  } finally {
    s.close()
    t.close()
  }
})

test('編集の共有：許可表のAPIだけを共有のラボに限って中継し、操作をログに残す（コマンドの中身は残さない）', async () => {
  const t = await setup()
  const alice = jwt('alice')
  const bob = jwt('bob')
  const view = (await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1' } })).json
  assert.equal(view.role, 'view')
  const bad = await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1', role: 'root' } })
  assert.equal(bad.status, 400)
  const edit = (await t.call('POST', '/shares', { token: alice, body: { labName: 'alice-lab1', role: 'edit' } })).json
  assert.equal(edit.role, 'edit')
  const c = (p) => `/s/${edit.id}/clab/${p}`

  // 閲覧の共有では通らない
  const denied = await t.call('PUT', `/s/${view.id}/clab/labs/alice-lab1/topology/yaml`, { token: bob, body: { a: 1 } })
  assert.equal(denied.status, 403)
  // ログインしていなければ通らない
  assert.equal((await t.call('POST', c('labs/alice-lab1/apply'))).status, 401)

  // 許可されるもの
  assert.equal((await t.call('POST', c('labs/alice-lab1/apply'), { token: bob })).status, 200)
  assert.equal((await t.call('POST', c('labs/alice-lab1/nodes/R1/restart'), { token: bob })).status, 200)
  assert.equal((await t.call('POST', c('labs/alice-lab1/exec?nodeFilter=clab-alice-lab1-R1'), { token: bob, body: { command: 'SECRET-CMD' } })).status, 200)
  assert.equal((await t.call('POST', c('tools/netem/set'), { token: bob, body: { containerName: 'clab-alice-lab1-R1', interface: 'eth1' } })).status, 200)
  assert.ok(t.api.calls.includes('body {"command":"SECRET-CMD"}'))

  // 許可されないもの：他のラボ、他のノード指定、ラボの作成・削除、コンソール、%エンコード、他のラボのコンテナのnetem
  for (const [method, p, body] of [
    ['POST', 'labs/alice-lab2/apply'],
    ['POST', 'labs/alice-lab1/exec?nodeFilter=clab-alice-lab2-R1', { command: 'x' }],
    ['POST', 'labs/alice-lab1/exec?nodeFilter=clab-alice-lab1-R1&x=1', { command: 'x' }],
    ['POST', 'labs/alice-lab1/exec?nodeFilter=clab-alice-lab1-.*', { command: 'x' }],
    ['POST', 'labs', { topologyContent: 'x' }],
    ['DELETE', 'labs/alice-lab1'],
    ['POST', 'labs/alice-lab1/nodes/clab-alice-lab1-R1/terminal-sessions', {}],
    ['POST', 'labs/alice%2Dlab1/apply'],
    ['POST', 'tools/netem/set', { containerName: 'clab-alice-lab2-R1', interface: 'eth1' }],
    ['GET', 'health/metrics'],
  ]) {
    const r = await t.call(method, c(p), { token: bob, body })
    assert.equal(r.status, 403, `${method} ${p}`)
  }

  // ログ：編集の操作は誰が何をしたかが残り、コマンドの中身・トークンは残らない
  const logs = t.logs.join('\n')
  assert.match(logs, /edit share=\S{6} lab=alice-lab1 owner=alice editor=bob op=exec node=R1/)
  assert.doesNotMatch(logs, /SECRET-CMD/)
  assert.doesNotMatch(logs, new RegExp(alice.split('.')[1]))
  t.close()
})

test('編集の共有：/labsは共有のラボの分だけ返す。ovsはlabNameが共有のラボの時だけ通す', async () => {
  const t = await setup()
  const alice = jwt('alice')
  const bob = jwt('bob')
  const ovsCalls = []
  const ovs = http.createServer((req, res) => {
    let b = ''
    req.on('data', (d) => (b += d))
    req.on('end', () => {
      ovsCalls.push(`${req.method} ${req.url} ${b}`)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
    })
  })
  await new Promise((r) => ovs.listen(0, '127.0.0.1', r))
  t.collab.close()
  const collab = createCollabServer({ apiBase: t.api.base, ovsBase: `http://127.0.0.1:${ovs.address().port}`, log: () => {} })
  await new Promise((r) => collab.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${collab.address().port}`
  const call = (method, path, token, body) =>
    fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json() }))
  try {
    const edit = (await call('POST', '/shares', alice, { labName: 'alice-lab1', role: 'edit' })).json
    const labs = await call('GET', `/s/${edit.id}/clab/labs`, bob)
    assert.deepEqual(Object.keys(labs.json), ['alice-lab1'])
    assert.equal((await call('POST', `/s/${edit.id}/ovs/frr-config`, bob, { labName: 'alice-lab1', routerName: 'R1' })).status, 200)
    assert.equal((await call('POST', `/s/${edit.id}/ovs/frr-config`, bob, { labName: 'alice-lab2', routerName: 'R1' })).status, 403)
    assert.equal((await call('POST', `/s/${edit.id}/ovs/bridge`, bob, { labName: 'alice-lab1' })).status, 403)
    assert.equal(ovsCalls.length, 1)
    const v = await call('GET', `/s/${edit.id}/version`, bob)
    assert.equal(v.status, 200)
    assert.ok(v.json.version)
  } finally {
    collab.close()
    ovs.close()
    t.api.server.close()
  }
})
