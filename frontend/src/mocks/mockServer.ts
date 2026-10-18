// 開発用のモックモード（2026-10-18）。`npm run dev:mock` で起動すると、clab-api-server・collab-proxy・
// ovs-helper・コンソールのWebSocketの代わりに、ブラウザの中の偽のサーバーが答える。
// サーバー（ラボ用VM）に繋げない環境（クラウドのセッション、手元のPC）で、画面の見た目・操作感を確かめるためのもの。
//
// ・どのユーザー名・パスワードでもログインできる（パスワードが「wrong」だと401になり、エラー表示を確かめられる）
// ・ラボの状態はメモリ上だけ（再読み込みで最初の状態に戻る）。起動・停止・差分反映・スナップショットも動く
// ・コンソールは簡易の偽シェル。パケットキャプチャ・共有リンクは使えない（その旨のエラーを返す）
// ・本番のビルドには入らない（main.tsxの`import.meta.env.VITE_MOCK`で除かれる）
import { load as loadYaml } from 'js-yaml'

interface MockLab {
  yaml: string
  annotations: string | null
  // null＝一度も起動していない。それ以外はノード名→状態
  nodes: Record<string, 'running' | 'exited'> | null
}

const labs = new Map<string, MockLab>()
let username = 'demo'
let versionSeq = 1

function nodeYaml(name: string, image: string) {
  return `    ${name}:\n      kind: linux\n      image: ${image}\n`
}

function seed() {
  const R = 'fnl/frr:3'
  const SW = 'fnl/l2switch:6'
  const PC = 'alpine:3.20'
  const campus =
    `name: demo-campus\ntopology:\n  nodes:\n${nodeYaml('R1', R)}${nodeYaml('R2', R)}${nodeYaml('SW1', SW)}${nodeYaml('PC1', PC)}${nodeYaml('PC2', PC)}` +
    `  links:\n    - endpoints: ["R1:eth1", "R2:eth1"]\n    - endpoints: ["R1:eth2", "SW1:eth1"]\n    - endpoints: ["SW1:eth2", "PC1:eth1"]\n    - endpoints: ["SW1:eth3", "PC2:eth1"]\n`
  const campusAnn = JSON.stringify({
    version: 2,
    title: '校内ネットワーク（デモ）',
    positions: { R1: { x: 280, y: 80 }, R2: { x: 520, y: 80 }, SW1: { x: 280, y: 240 }, PC1: { x: 180, y: 400 }, PC2: { x: 380, y: 400 } },
    extraNodes: [],
  })
  labs.set('demo-campus', {
    yaml: campus,
    annotations: campusAnn,
    nodes: { R1: 'running', R2: 'running', SW1: 'running', PC1: 'running', PC2: 'running' },
  })
  const ospf =
    `name: demo-ospf\ntopology:\n  nodes:\n${nodeYaml('R1', R)}${nodeYaml('R2', R)}${nodeYaml('R3', R)}` +
    `  links:\n    - endpoints: ["R1:eth1", "R2:eth1"]\n    - endpoints: ["R2:eth2", "R3:eth1"]\n    - endpoints: ["R3:eth2", "R1:eth2"]\n`
  labs.set('demo-ospf', {
    yaml: ospf,
    annotations: JSON.stringify({
      version: 2,
      title: 'OSPFの練習（デモ）',
      positions: { R1: { x: 300, y: 80 }, R2: { x: 480, y: 280 }, R3: { x: 120, y: 280 } },
      extraNodes: [],
    }),
    nodes: null,
  })
}

// ---------------------------------------------------------------------------

interface Reply {
  status: number
  body?: unknown
  text?: string
}

const json = (body: unknown, status = 200): Reply => ({ status, body })
const fail = (status: number, error: string): Reply => ({ status, body: { error } })
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function nodesOf(yaml: string): { name: string; image: string; kind: string }[] {
  const doc = loadYaml(yaml) as { topology?: { nodes?: Record<string, { kind?: string; image?: string }> } } | null
  return Object.entries(doc?.topology?.nodes ?? {}).map(([name, d]) => ({ name, image: d?.image ?? '', kind: d?.kind ?? 'linux' }))
}

function rawNodes(labName: string, lab: MockLab) {
  const defs = new Map(nodesOf(lab.yaml).map((n) => [n.name, n]))
  return Object.entries(lab.nodes ?? {}).map(([name, state], i) => ({
    name: `clab-${labName}-${name}`,
    container_id: `mock${i}${name}`.padEnd(12, '0').slice(0, 12),
    image: defs.get(name)?.image ?? '',
    kind: defs.get(name)?.kind ?? 'linux',
    state,
    status: state === 'running' ? 'Up 5 minutes' : 'Exited (0) 1 minute ago',
    ...(state === 'running' ? { ipv4_address: `172.20.20.${i + 2}/24` } : {}),
    lab_name: labName,
    nodeName: name,
    labPath: `${labName}.clab.yml`,
    absLabPath: `/var/lib/containerlab/labs/${username}/${labName}/${labName}.clab.yml`,
    group: '',
    owner: username,
  }))
}

function setLabState(lab: MockLab, state: 'running' | 'exited') {
  lab.nodes = Object.fromEntries(nodesOf(lab.yaml).map((n) => [n.name, state]))
}

// コンテナ名 clab-<ラボ>-<ノード> からノード名を取り出す
function nodeNameOf(labName: string, container: string): string {
  const prefix = `clab-${labName}-`
  return container.startsWith(prefix) ? container.slice(prefix.length) : container
}

function fakeConfig(name: string): string {
  return `hostname ${name}\n!\nline vty\n!\n`
}

async function handle(method: string, url: URL, bodyText: string): Promise<Reply> {
  const path = url.pathname
  const q = url.searchParams
  const body = (() => {
    try {
      return bodyText ? JSON.parse(bodyText) : {}
    } catch {
      return {}
    }
  })() as Record<string, unknown>
  let m: RegExpExecArray | null

  // ---- 認証 ----
  if (path === '/login' && method === 'POST') {
    await wait(300)
    if (body.password === 'wrong') return fail(401, 'Invalid credentials')
    username = String(body.username || 'demo')
    return json({ token: 'mock-token' })
  }

  // ---- ovs-helper ----
  if (/^\/(frr-config|switch-config)$/.test(path)) return json({ ok: true })

  // ---- collab-proxy（共有・版の確認は使えない。版の確認は画面の自動取り込みが動くよう答える） ----
  if (path === '/shares') return method === 'GET' ? json({ shares: [] }) : fail(501, 'モックモードでは共有リンクを作れません')
  if ((m = /^\/version\/([^/]+)$/.exec(path))) {
    const lab = labs.get(decodeURIComponent(m[1]))
    return lab ? json({ version: String(versionSeq) }) : fail(404, 'not found')
  }
  if (/^\/(watch|s)\//.test(path)) return fail(404, 'モックモードでは使えません')

  // ---- clab-api-server ----
  if (!path.startsWith('/api/v1/')) return fail(404, 'not found')
  const p = path.slice('/api/v1'.length)

  if (p === '/health/metrics') {
    return json({
      metrics: {
        cpu: { usagePercent: 18 + Math.random() * 10, numCPU: 8 },
        mem: { usagePercent: 41, totalMem: 12 * 2 ** 30, usedMem: 5 * 2 ** 30, availableMem: 7 * 2 ** 30 },
        disk: { usagePercent: 33, totalDisk: 100 * 2 ** 30, usedDisk: 33 * 2 ** 30, freeDisk: 67 * 2 ** 30, path: '/' },
      },
    })
  }

  if (p === '/labs' && method === 'GET') {
    await wait(120)
    return json(Object.fromEntries([...labs].filter(([, l]) => l.nodes).map(([name, l]) => [name, rawNodes(name, l)])))
  }
  if (p === '/labs/topology/files') {
    return json(
      [...labs].map(([name, l]) => ({
        labName: name,
        yamlFileName: `${name}.clab.yml`,
        annotationsFileName: `${name}.clab.yml.annotations.json`,
        hasAnnotations: l.annotations !== null,
      })),
    )
  }

  if ((m = /^\/labs\/([^/]+)\/topology\/(yaml|annotations|file)$/.exec(p))) {
    const name = decodeURIComponent(m[1])
    const lab = labs.get(name)
    const what = m[2]
    if (what === 'file' && method === 'DELETE') {
      if (!lab) return fail(404, 'File not found')
      const file = q.get('path') ?? ''
      if (file.endsWith('.json')) lab.annotations = null
      else labs.delete(name)
      versionSeq++
      return json({ success: true })
    }
    if (what === 'yaml' && method === 'GET') return lab ? { status: 200, text: lab.yaml } : fail(404, 'File not found')
    if (what === 'annotations' && method === 'GET') return lab?.annotations != null ? { status: 200, text: lab.annotations } : fail(404, 'File not found')
    if (method === 'PUT') {
      const created = lab ?? { yaml: '', annotations: null, nodes: null }
      if (what === 'yaml') created.yaml = bodyText
      else created.annotations = bodyText
      labs.set(name, created)
      versionSeq++
      return { status: 200, text: '' }
    }
  }

  if ((m = /^\/labs\/([^/]+)\/apply$/.exec(p)) && method === 'POST') {
    const name = decodeURIComponent(m[1])
    const lab = labs.get(name)
    if (!lab) return fail(404, 'lab not found')
    const wanted = nodesOf(lab.yaml).map((n) => n.name)
    const empty = { dryRun: false, labName: name, recreatedNodes: null, restartedNodes: null, addedLinks: null, deletedEndpoints: null }
    if (!lab.nodes) {
      await wait(1200)
      setLabState(lab, 'running')
      return json({ ...empty, deployedLab: true, addedNodes: wanted, deletedNodes: null, startedNodes: null })
    }
    await wait(500)
    const current = lab.nodes
    const added = wanted.filter((n) => !(n in current))
    const deleted = Object.keys(current).filter((n) => !wanted.includes(n))
    const started = wanted.filter((n) => current[n] === 'exited')
    lab.nodes = Object.fromEntries(wanted.map((n) => [n, 'running' as const]))
    return json({
      ...empty,
      deployedLab: false,
      addedNodes: added.length ? added : null,
      deletedNodes: deleted.length ? deleted : null,
      startedNodes: started.length ? started : null,
    })
  }

  if ((m = /^\/labs\/([^/]+)\/(start|stop|restart)$/.exec(p)) && method === 'POST') {
    const lab = labs.get(decodeURIComponent(m[1]))
    if (!lab?.nodes) return fail(404, 'lab not found')
    await wait(600)
    setLabState(lab, m[2] === 'stop' ? 'exited' : 'running')
    return json({ message: 'ok' })
  }
  if ((m = /^\/labs\/([^/]+)\/nodes\/([^/]+)\/(start|stop|restart)$/.exec(p)) && method === 'POST') {
    const lab = labs.get(decodeURIComponent(m[1]))
    const node = nodeNameOf(decodeURIComponent(m[1]), decodeURIComponent(m[2]))
    if (!lab?.nodes || !(node in lab.nodes)) return fail(404, 'node not found')
    await wait(400)
    lab.nodes[node] = m[3] === 'stop' ? 'exited' : 'running'
    return json({ message: 'ok' })
  }
  if ((m = /^\/labs\/([^/]+)$/.exec(p)) && method === 'DELETE') {
    const name = decodeURIComponent(m[1])
    const lab = labs.get(name)
    if (!lab) return fail(404, 'lab not found')
    await wait(500)
    if (q.get('purgeLabDir') === 'true') labs.delete(name)
    else lab.nodes = null
    versionSeq++
    return json({ message: 'ok' })
  }

  if ((m = /^\/labs\/([^/]+)\/exec$/.exec(p)) && method === 'POST') {
    const container = q.get('nodeFilter') ?? ''
    await wait(80)
    const command = String(body.command ?? '')
    const stdout = command.includes('base64 | tr') ? btoa(fakeConfig(nodeNameOf(decodeURIComponent(m[1]), container))) : ''
    return json({ [container]: [{ cmd: ['sh', '-c', command], 'return-code': 0, stdout, stderr: '' }] })
  }

  if ((m = /^\/labs\/([^/]+)\/nodes\/([^/]+)\/terminal-sessions$/.exec(p)) && method === 'POST') {
    const now = Date.now()
    return json({
      sessionId: `mock-${now.toString(36)}`,
      labName: decodeURIComponent(m[1]),
      nodeName: decodeURIComponent(m[2]),
      protocol: 'shell',
      state: 'ready',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 3600_000).toISOString(),
    })
  }

  if (p.startsWith('/tools/netem/')) return p.endsWith('/show') ? json({}) : json({ message: 'ok' })
  if (p.includes('capture')) return fail(501, 'モックモードではパケットキャプチャを使えません')

  return fail(404, `モックにはこのAPIがありません: ${method} ${p}`)
}

// ---------------------------------------------------------------------------
// コンソールの偽のシェル（clab-api-serverのターミナルのWebSocketの代わり）
// ---------------------------------------------------------------------------

class MockConsoleSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = 0
  private line = ''
  private host: string

  constructor(url: string) {
    super()
    this.host = new URL(url, location.href).searchParams.get('sessionId') ?? 'node'
    setTimeout(() => {
      this.readyState = 1
      this.dispatchEvent(new Event('open'))
    }, 50)
  }

  private emit(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }))
  }

  private out(text: string) {
    this.emit({ type: 'output', data: btoa(text), encoding: 'base64' })
  }

  send(raw: string) {
    const msg = JSON.parse(raw) as { token?: string; type?: string; data?: string }
    if (msg.token) {
      this.emit({ type: 'ready', sessionId: this.host, protocol: 'shell' })
      this.out('[mock mode] fake shell: input is not sent anywhere\r\n/ # ')
      return
    }
    if (msg.type !== 'input' || !msg.data) return
    for (const ch of msg.data) {
      if (ch === '\r' || ch === '\n') {
        const cmd = this.line.trim()
        this.line = ''
        this.out(`\r\n${cmd ? `sh: ${cmd.split(' ')[0]}: not available in mock mode\r\n` : ''}/ # `)
      } else if (ch === '\x7f') {
        if (this.line) {
          this.line = this.line.slice(0, -1)
          this.out('\b \b')
        }
      } else if (ch >= ' ') {
        this.line += ch
        this.out(ch)
      }
    }
  }

  close() {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }))
  }
}

// ---------------------------------------------------------------------------

const MOCK_PATH = /^\/(login$|api\/v1\/|shares$|version\/|watch\/|s\/|frr-config$|switch-config$)/

export function installMockServer() {
  seed()
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null
    const url = new URL(req?.url ?? String(input), location.href)
    if (!MOCK_PATH.test(url.pathname)) return realFetch(input, init)
    const method = (init?.method ?? req?.method ?? 'GET').toUpperCase()
    const bodyText = typeof init?.body === 'string' ? init.body : ''
    const reply = await handle(method, url, bodyText)
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
    return new Response(text, {
      status: reply.status,
      headers: { 'Content-Type': reply.text !== undefined ? 'text/plain' : 'application/json' },
    })
  }

  const RealWebSocket = window.WebSocket
  window.WebSocket = new Proxy(RealWebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      return /\/console(\?|$)/.test(String(args[0])) ? (new MockConsoleSocket(String(args[0])) as unknown as WebSocket) : new target(...args)
    },
  })
  console.info('[mock] モックモードで動いています（サーバーには繋がりません）')
}
