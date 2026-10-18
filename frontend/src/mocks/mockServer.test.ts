import { beforeAll, describe, expect, it, vi } from 'vitest'

// ブラウザの代わりに最小のwindow・locationを用意して、モックのfetchを直接叩く
beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.window = globalThis
  g.location = new URL('https://mock.test/')
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const { installMockServer } = await import('./mockServer')
  installMockServer()
})

const call = async (method: string, path: string, body?: unknown, text?: string) => {
  const res = await fetch(`https://mock.test${path}`, { method, body: text ?? (body === undefined ? undefined : JSON.stringify(body)) })
  const t = await res.text()
  return { status: res.status, text: t, json: () => JSON.parse(t) }
}

describe('モックサーバー', () => {
  it('ログインできる。パスワードが wrong なら401', async () => {
    expect((await call('POST', '/login', { username: 'a', password: 'x' })).json().token).toBeTruthy()
    expect((await call('POST', '/login', { username: 'a', password: 'wrong' })).status).toBe(401)
  })

  it('最初から、動いているラボと未起動のラボがある', async () => {
    const labs = (await call('GET', '/api/v1/labs')).json()
    expect(Object.keys(labs)).toEqual(['demo-campus'])
    expect(labs['demo-campus']).toHaveLength(5)
    const files = (await call('GET', '/api/v1/labs/topology/files')).json()
    expect(files.map((f: { labName: string }) => f.labName).sort()).toEqual(['demo-campus', 'demo-ospf'])
  })

  it('未起動のラボをapplyすると起動し、トポロジを変えて再applyすると差分だけ反映する', async () => {
    const first = (await call('POST', '/api/v1/labs/demo-ospf/apply')).json()
    expect(first.deployedLab).toBe(true)
    expect(first.addedNodes).toEqual(['R1', 'R2', 'R3'])
    const yaml = (await call('GET', '/api/v1/labs/demo-ospf/topology/yaml')).text
    await call('PUT', '/api/v1/labs/demo-ospf/topology/yaml', undefined, yaml.replace(/    R3:[\s\S]*?(?=  links:)/, ''))
    const second = (await call('POST', '/api/v1/labs/demo-ospf/apply')).json()
    expect(second.deployedLab).toBe(false)
    expect(second.deletedNodes).toEqual(['R3'])
  })

  it('ノードの停止・ラボの停止・削除ができる', async () => {
    await call('POST', '/api/v1/labs/demo-campus/nodes/clab-demo-campus-PC1/stop')
    let nodes = (await call('GET', '/api/v1/labs')).json()['demo-campus']
    expect(nodes.find((n: { nodeName: string }) => n.nodeName === 'PC1').state).toBe('exited')
    await call('DELETE', '/api/v1/labs/demo-ospf?cleanup=true&purgeLabDir=true')
    nodes = (await call('GET', '/api/v1/labs/topology/files')).json()
    expect(nodes.map((f: { labName: string }) => f.labName)).toEqual(['demo-campus'])
  })

  it('スナップショット用の読み取り（base64）とannotationsの保存・404が動く', async () => {
    const r = await call('POST', '/api/v1/labs/demo-campus/exec?nodeFilter=clab-demo-campus-R1', { command: `sh -c 'cat x | base64 | tr -d "\\n"'` })
    const out = Object.values(r.json())[0] as { stdout: string }[]
    expect(atob(out[0].stdout)).toContain('hostname R1')
    await call('PUT', '/api/v1/labs/new-snap/topology/yaml', undefined, 'name: new-snap\n')
    expect((await call('GET', '/api/v1/labs/new-snap/topology/annotations')).status).toBe(404)
  })

  it('コンソールは偽のシェルが答える', async () => {
    const ws = new WebSocket('wss://mock.test/console?sessionId=s1')
    const received: string[] = []
    ws.addEventListener('message', (e) => received.push(JSON.parse(e.data).type))
    await new Promise((r) => ws.addEventListener('open', r))
    ws.send(JSON.stringify({ token: 't' }))
    expect(received).toEqual(['ready', 'output'])
    expect(WebSocket.OPEN).toBe(1)
  })
})
