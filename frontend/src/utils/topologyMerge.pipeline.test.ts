import { describe, expect, it } from 'vitest'
import { dump as dumpYaml, load as loadYaml } from 'js-yaml'
import type { Node } from '@xyflow/react'
import { serializeAnnotations } from './annotations'
import { buildTopologyContent, parseImportedTopology, topologyToYaml } from './labTopology'
import { mergeTopology } from './topologyMerge'

// 画面と同じ経路（保存形式のYAML＋annotations→読み込み→統合）で確かめる
const YAML = `name: lab1
topology:
  nodes:
    R1:
      kind: linux
      image: fnl/frr:3
    R2:
      kind: linux
      image: fnl/frr:3
  links:
    - endpoints: ["R1:eth1", "R2:eth1"]
`

function serialize(nodes: Node[], edges: ReturnType<typeof parseImportedTopology>['edges'], title: string) {
  const built = buildTopologyContent(nodes, edges, 'lab1')
  return { yaml: topologyToYaml(built.topologyContent), annotations: serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds, title) }
}

describe('保存形式を通した統合', () => {
  const start = parseImportedTopology(YAML, null)
  const baseSaved = serialize(start.nodes, start.edges, '授業')
  const base = parseImportedTopology(baseSaved.yaml, baseSaved.annotations)

  it('一方がノードを動かし、他方がルーターとリンクを足したら、両方残る', () => {
    // 自分：R1を動かした
    const moved = base.nodes.map((n) => (n.id === 'R1' ? { ...n, position: { x: 400, y: 300 } } : n))
    const mine = serialize(moved, base.edges, '授業')
    // 別の画面：R3を足してR2とつないだ（保存形式のYAMLを直接書き換えて再現）
    const doc = loadYaml(baseSaved.yaml) as { topology: { nodes: Record<string, unknown>; links: { endpoints: string[] }[] } }
    doc.topology.nodes.R3 = { kind: 'linux', image: 'fnl/frr:3' }
    doc.topology.links.push({ endpoints: ['R2:eth2', 'R3:eth1'] })
    const theirsYaml = dumpYaml(doc)

    const local = parseImportedTopology(mine.yaml, mine.annotations)
    const theirs = parseImportedTopology(theirsYaml, baseSaved.annotations)
    const r = mergeTopology(
      { nodes: base.nodes, edges: base.edges, title: '授業' },
      { nodes: local.nodes, edges: local.edges, title: '授業' },
      { nodes: theirs.nodes, edges: theirs.edges, title: '授業' },
    )
    expect(r.hardConflict).toBeNull()
    expect(r.conflicts).toEqual([])
    expect(r.nodes.map((n) => n.id).sort()).toEqual(['R1', 'R2', 'R3'])
    expect(r.nodes.find((n) => n.id === 'R1')?.position).toEqual({ x: 400, y: 300 })
    expect(r.edges).toHaveLength(2)
    // 統合の結果は、そのまま保存できる形になっている
    expect(() => serialize(r.nodes, r.edges, r.title)).not.toThrow()
  })

  it('保存し直しただけ（何も変えていない）なら、変更なしと判定する', () => {
    const again = parseImportedTopology(baseSaved.yaml, baseSaved.annotations)
    const r = mergeTopology(
      { nodes: base.nodes, edges: base.edges, title: '授業' },
      { nodes: again.nodes, edges: again.edges, title: '授業' },
      { nodes: base.nodes, edges: base.edges, title: '授業' },
    )
    expect(r.tookRemote).toBe(false)
    expect(r.conflicts).toEqual([])
  })
})
