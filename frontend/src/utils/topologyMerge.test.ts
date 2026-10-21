import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { mergeTopology, type TopologyState } from './topologyMerge'

const node = (id: string, x = 0, y = 0, data: Record<string, unknown> = {}): Node => ({ id, type: 'topoNode', position: { x, y }, data: { kind: 'router', label: id, ...data } })
const edge = (a: string, ai: string, b: string, bi: string, data: Record<string, unknown> = {}, idx = 0): Edge => ({
  id: `${a}:${ai}-${b}:${bi}-${idx}`,
  source: a,
  target: b,
  data: { sourceIface: ai, targetIface: bi, ...data },
})
const state = (nodes: Node[], edges: Edge[] = [], title = '授業'): TopologyState => ({ nodes, edges, title })

const BASE = state([node('R1', 0, 0), node('R2', 100, 0), node('PC1', 0, 100, { kind: 'pc' })], [edge('R1', 'eth1', 'R2', 'eth1'), edge('PC1', 'eth1', 'R1', 'eth2')])
const clone = (s: TopologyState): TopologyState => JSON.parse(JSON.stringify(s))
const dataOf = (x: Node | Edge | undefined) => (x?.data ?? {}) as Record<string, string>
const ids = (nodes: Node[]) => nodes.map((n) => n.id).sort()

describe('ノード単位の統合', () => {
  it('どちらも変えていなければ、何も取り込まない', () => {
    const r = mergeTopology(BASE, clone(BASE), clone(BASE))
    expect(r.hardConflict).toBeNull()
    expect(r.conflicts).toEqual([])
    expect(r.tookRemote).toBe(false)
    expect(ids(r.nodes)).toEqual(['PC1', 'R1', 'R2'])
  })

  it('別々のノードの変更は、両方残る', () => {
    const local = clone(BASE)
    local.nodes[0] = node('R1', 50, 50) // 自分がR1を動かした
    const remote = clone(BASE)
    remote.nodes[1] = node('R2', 100, 0, { label: 'ルーター2' }) // 別の画面がR2の設定を変えた
    const r = mergeTopology(BASE, local, remote)
    expect(r.conflicts).toEqual([])
    expect(r.tookRemote).toBe(true)
    expect(r.nodes.find((n) => n.id === 'R1')?.position).toEqual({ x: 50, y: 50 })
    expect(dataOf(r.nodes.find((n) => n.id === 'R2')).label).toBe('ルーター2')
  })

  it('同じノードでも、位置と設定は別々に統合する', () => {
    const local = clone(BASE)
    local.nodes[0] = node('R1', 50, 50)
    const remote = clone(BASE)
    remote.nodes[0] = node('R1', 0, 0, { label: '新しい名前' })
    const r = mergeTopology(BASE, local, remote)
    expect(r.conflicts).toEqual([])
    const r1 = r.nodes.find((n) => n.id === 'R1')!
    expect(r1.position).toEqual({ x: 50, y: 50 })
    expect(dataOf(r1).label).toBe('新しい名前')
  })

  it('同じ所を両方が違うように変えたら、自分の内容を残して知らせる', () => {
    const local = clone(BASE)
    local.nodes[0] = node('R1', 50, 50)
    const remote = clone(BASE)
    remote.nodes[0] = node('R1', 70, 70)
    const r = mergeTopology(BASE, local, remote)
    expect(r.hardConflict).toBeNull()
    expect(r.conflicts).toEqual(['ノード R1（位置）'])
    expect(r.nodes.find((n) => n.id === 'R1')?.position).toEqual({ x: 50, y: 50 })
  })

  it('両方が同じに変えたなら衝突ではない', () => {
    const local = clone(BASE)
    local.nodes[0] = node('R1', 50, 50)
    const r = mergeTopology(BASE, local, clone(local))
    expect(r.conflicts).toEqual([])
  })

  it('選択・ドラッグ中などの画面だけの状態は、変更とみなさない', () => {
    const local = clone(BASE)
    ;(local.nodes[0] as Node).selected = true
    ;(local.nodes[1] as Node).measured = { width: 80, height: 40 }
    const r = mergeTopology(BASE, local, clone(BASE))
    expect(r.tookRemote).toBe(false)
    expect(r.conflicts).toEqual([])
  })

  it('それぞれが足したノードとリンクは、両方残る', () => {
    const local = clone(BASE)
    local.nodes.push(node('R3', 200, 0))
    local.edges.push(edge('R2', 'eth2', 'R3', 'eth1'))
    const remote = clone(BASE)
    remote.nodes.push(node('SW1', 100, 100, { kind: 'l2-switch' }))
    remote.edges.push(edge('PC1', 'eth2', 'SW1', 'eth1'))
    const r = mergeTopology(BASE, local, remote)
    expect(r.hardConflict).toBeNull()
    expect(ids(r.nodes)).toEqual(['PC1', 'R1', 'R2', 'R3', 'SW1'])
    expect(r.edges).toHaveLength(4)
    expect(r.tookRemote).toBe(true)
  })

  it('別の画面が削除し、自分は触っていなければ削除する。つながるリンクも消える', () => {
    const remote = clone(BASE)
    remote.nodes = remote.nodes.filter((n) => n.id !== 'PC1')
    remote.edges = remote.edges.filter((e) => e.source !== 'PC1')
    const r = mergeTopology(BASE, clone(BASE), remote)
    expect(ids(r.nodes)).toEqual(['R1', 'R2'])
    expect(r.edges).toHaveLength(1)
    expect(r.conflicts).toEqual([])
    expect(r.tookRemote).toBe(true)
  })

  it('別の画面が削除したが、自分が変更したノードは残す', () => {
    const local = clone(BASE)
    local.nodes[2] = node('PC1', 0, 100, { kind: 'pc', label: '先生のPC' })
    const remote = clone(BASE)
    remote.nodes = remote.nodes.filter((n) => n.id !== 'PC1')
    remote.edges = remote.edges.filter((e) => e.source !== 'PC1')
    const r = mergeTopology(BASE, local, remote)
    expect(ids(r.nodes)).toContain('PC1')
    expect(r.conflicts.some((c) => c.includes('PC1') && c.includes('残しました'))).toBe(true)
  })

  it('自分が削除したが、別の画面が変更したノードは残す', () => {
    const local = clone(BASE)
    local.nodes = local.nodes.filter((n) => n.id !== 'R2')
    local.edges = local.edges.filter((e) => e.target !== 'R2')
    const remote = clone(BASE)
    remote.nodes[1] = node('R2', 100, 0, { label: '変更' })
    const r = mergeTopology(BASE, local, remote)
    expect(ids(r.nodes)).toContain('R2')
    expect(r.conflicts.some((c) => c.includes('R2'))).toBe(true)
  })

  it('自分が削除したノードに、別の画面がリンクを足していたら、そのリンクは外す', () => {
    const local = clone(BASE)
    local.nodes = local.nodes.filter((n) => n.id !== 'PC1')
    local.edges = local.edges.filter((e) => e.source !== 'PC1')
    const remote = clone(BASE)
    remote.nodes.push(node('SW1', 100, 100))
    remote.edges.push(edge('PC1', 'eth2', 'SW1', 'eth1'))
    const r = mergeTopology(BASE, local, remote)
    expect(ids(r.nodes)).toEqual(['R1', 'R2', 'SW1'])
    expect(r.edges.every((e) => e.source !== 'PC1' && e.target !== 'PC1')).toBe(true)
    expect(r.conflicts.some((c) => c.includes('外しました'))).toBe(true)
  })

  it('リンクの設定（アドレスなど）も、リンクごとに統合する', () => {
    const local = clone(BASE)
    local.edges[0] = edge('R1', 'eth1', 'R2', 'eth1', { sourceAddress: '10.0.0.1/24' })
    const remote = clone(BASE)
    remote.edges[1] = edge('PC1', 'eth1', 'R1', 'eth2', { sourceAddress: '192.168.0.2/24' })
    const r = mergeTopology(BASE, local, remote)
    expect(r.conflicts).toEqual([])
    expect(dataOf(r.edges.find((e) => e.source === 'R1')).sourceAddress).toBe('10.0.0.1/24')
    expect(dataOf(r.edges.find((e) => e.source === 'PC1')).sourceAddress).toBe('192.168.0.2/24')
  })

  it('リンクのidの通し番号や向きが違っても、同じリンクとして扱う', () => {
    const remote = clone(BASE)
    remote.edges = [edge('R2', 'eth1', 'R1', 'eth1', {}, 5), BASE.edges[1]] // 向きと番号が違うだけ
    remote.edges[0].data = { sourceIface: 'eth1', targetIface: 'eth1' }
    const r = mergeTopology(BASE, clone(BASE), remote)
    expect(r.edges).toHaveLength(2)
    expect(r.conflicts).toEqual([])
  })

  it('同じインターフェースに別々のリンクをつないだら、自動では決めない', () => {
    const local = clone(BASE)
    local.nodes.push(node('R3'))
    local.edges.push(edge('R1', 'eth3', 'R3', 'eth1'))
    const remote = clone(BASE)
    remote.nodes.push(node('R4'))
    remote.edges.push(edge('R1', 'eth3', 'R4', 'eth1'))
    const r = mergeTopology(BASE, local, remote)
    expect(r.hardConflict).toContain('R1:eth3')
  })

  it('同じ名前のノードを別々に足したら、自動では決めない', () => {
    const local = clone(BASE)
    local.nodes.push(node('R3', 0, 0, { label: 'A' }))
    const remote = clone(BASE)
    remote.nodes.push(node('R3', 5, 5, { label: 'B' }))
    expect(mergeTopology(BASE, local, remote).hardConflict).toContain('R3')
  })

  it('表示名も統合する', () => {
    const remote = { ...clone(BASE), title: '応用' }
    const r = mergeTopology(BASE, clone(BASE), remote)
    expect(r.title).toBe('応用')
    expect(r.tookRemote).toBe(true)
    const local = { ...clone(BASE), title: '自分の名前' }
    expect(mergeTopology(BASE, local, { ...clone(BASE), title: '相手の名前' }).conflicts).toContain('ラボの表示名')
  })
})
