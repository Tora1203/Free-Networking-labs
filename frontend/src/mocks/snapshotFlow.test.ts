import { beforeAll, describe, expect, it, vi } from 'vitest'

// モックのサーバーを相手に、スナップショットの書き出し→取り込み→別のラボとして開く、を通す
beforeAll(async () => {
  const g = globalThis as unknown as Record<string, unknown>
  g.window = globalThis
  g.location = new URL('https://mock.test/')
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const { installMockServer } = await import('./mockServer')
  installMockServer()
  // ovs-helperへの呼び出しはトークンが要る。モックはどのユーザーでもログインできる
  const { login } = await import('../api/client')
  const { token } = await login('taro', 'x')
  ;(await import('../api/client')).setAuthToken(token)
})

describe('スナップショットの書き出し・取り込み・別のラボとして開く（モック）', () => {
  it('書き出したファイルを取り込め、別のラボとしても開ける', async () => {
    const rt = await import('../utils/labRuntime')
    const built = { routerClabNames: [], switchClabNames: [] }
    const entry = await rt.createLabSnapshot('demo-ospf', built, { title: '課題の初期状態', note: 'メモ' })

    const text = await rt.exportLabSnapshot(entry)
    const imported = await rt.importLabSnapshot('demo-campus', text)
    expect(imported.meta.title).toBe('課題の初期状態')
    expect(imported.labName.startsWith('demo-campus-snap-')).toBe(true)
    expect((await rt.listLabSnapshots('demo-campus')).map((e) => e.meta.title)).toEqual(['課題の初期状態'])
    await expect(rt.importLabSnapshot('demo-campus', '{}')).rejects.toThrow()

    const progress: string[] = []
    const created = await rt.createLabFromSnapshot(entry, 'taro', 'OSPFの練習', (m) => progress.push(m))
    expect(created.title).toBe('OSPFの練習のコピー')
    expect(created.failures).toEqual([])
    const names = await rt.listLabNames()
    expect(names.ids.has(created.labName)).toBe(true)
    // もう一度開くと、名前が重ならない
    const again = await rt.createLabFromSnapshot(entry, 'taro', 'OSPFの練習', () => undefined)
    expect(again.title).toBe('OSPFの練習のコピー(2)')
    expect(again.labName).not.toBe(created.labName)
  })

  it('設定を持つスナップショットは、新しいラボを起動して設定を書き戻す', async () => {
    const rt = await import('../utils/labRuntime')
    const entry = await rt.createLabSnapshot('demo-campus', { routerClabNames: ['R1', 'R2'], switchClabNames: ['SW1'] }, { title: '設定あり', note: '' })
    expect(Object.keys(entry.meta.configs).sort()).toEqual(['R1', 'R2', 'SW1'])
    const progress: string[] = []
    const created = await rt.createLabFromSnapshot(entry, 'hanako', 'campus', (m) => progress.push(m))
    expect(created.failures).toEqual([])
    expect(progress.some((m) => m.includes('起動'))).toBe(true)
    expect(progress.some((m) => m.includes('書き戻'))).toBe(true)
    const labs = await (await import('../api/client')).getLabs()
    expect(Object.keys(labs)).toContain(created.labName)
  })
})

