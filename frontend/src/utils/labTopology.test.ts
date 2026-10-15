// トポロジ⇔containerlab YAMLの変換と、ノードごとの設定コマンドのテスト（2026-10-15追加）。
// イメージのタグを上げた時（fnl/frr:1→:2）に古いルーターがPCと判定された不具合のような、
// 保存・読み込みの退行を防ぐ
import { describe, expect, it } from 'vitest'
import type { Edge, Node } from '@xyflow/react'
import { load as loadYaml } from 'js-yaml'
import { PALETTE_NODE_CONFIGS, type PaletteNodeKind } from '../types/lab'
import { serializeAnnotations } from './annotations'
import {
  buildNodeSyncCommands,
  buildTopologyContent,
  buildWipeCommand,
  hasSwitchWithoutConfigBind,
  parseImportedTopology,
  topologyToYaml,
  type EdgeIfaceData,
} from './labTopology'
import { parseTopologyYaml } from './topologyFromYaml'

function node(id: string, kind: PaletteNodeKind, x = 0, y = 0): Node {
  const c = PALETTE_NODE_CONFIGS[kind]
  return { id, type: 'topoNode', position: { x, y }, data: { kind, clabKind: c.clabKind, image: c.image, shortLabel: id } }
}

function edge(source: string, sourceIface: string, target: string, targetIface: string, extra: Partial<EdgeIfaceData> = {}): Edge {
  return { id: `${source}-${target}`, source, target, data: { sourceIface, targetIface, ...extra } }
}

// R1 ─ SW1 ─ PC1 （PC1は10.0.0.10/24、GW 10.0.0.1）
const nodes = [node('router-1', 'router', 10, 20), node('l2-switch-1', 'l2-switch', 200, 20), node('pc-1', 'pc', 400, 20)]
const edges = [
  edge('router-1', 'eth1', 'l2-switch-1', 'eth1'),
  edge('l2-switch-1', 'eth2', 'pc-1', 'eth1', { targetAddress: '10.0.0.10/24', targetGateway: '10.0.0.1' }),
]

describe('parseTopologyYaml：ノードの種類の判定', () => {
  const kindOf = (image: string, clabKind = 'linux') =>
    parseTopologyYaml(`name: t\ntopology:\n  nodes:\n    n: {kind: ${clabKind}, image: "${image}"}\n`).nodes[0].data.kind

  it('今のパレットのイメージ', () => {
    expect(kindOf(PALETTE_NODE_CONFIGS.router.image)).toBe('router')
    expect(kindOf(PALETTE_NODE_CONFIGS['l2-switch'].image)).toBe('l2-switch')
    expect(kindOf(PALETTE_NODE_CONFIGS.pc.image)).toBe('pc')
  })

  it('古いタグ・古い形式のルーターとスイッチ（タグを上げてもPCにならない）', () => {
    expect(kindOf('fnl/frr:1')).toBe('router')
    expect(kindOf('fnl/frr:99')).toBe('router')
    expect(kindOf('quay.io/frrouting/frr:10.2.1')).toBe('router')
    expect(kindOf('fnl/l2switch:1')).toBe('l2-switch')
    expect(kindOf('', 'ovs-bridge')).toBe('l2-switch')
  })

  it('それ以外はPC', () => {
    expect(kindOf('alpine:3.20')).toBe('pc')
    expect(kindOf('fnl/frrouter')).toBe('pc')
  })

  it('リンクのI/Fと、存在しないノードへのリンクを捨てること', () => {
    const p = parseTopologyYaml(
      'topology:\n  nodes:\n    a: {kind: linux, image: alpine}\n    b: {kind: linux, image: alpine}\n' +
        '  links:\n    - endpoints: ["a:eth3", "b:eth7"]\n    - endpoints: ["a:eth4", "zz:eth1"]\n',
    )
    expect(p.edges).toHaveLength(1)
    expect(p.edges[0].data).toEqual({ sourceIface: 'eth3', targetIface: 'eth7' })
    expect(p.counters).toEqual({ router: 0, 'l2-switch': 0, pc: 2 })
  })
})

describe('buildTopologyContent', () => {
  const built = buildTopologyContent(nodes, edges, 'lab1')
  const topo = built.topologyContent.topology

  it('ルーターにFRRの設定のbind mountと権限が付く', () => {
    expect(topo.nodes['router-1']).toMatchObject({
      image: PALETTE_NODE_CONFIGS.router.image,
      privileged: false,
      'cap-add': ['NET_ADMIN', 'NET_RAW', 'SYS_ADMIN'],
    })
    expect(topo.nodes['router-1'].binds).toEqual([
      'frr-config/router-1/daemons:/etc/frr/daemons',
      'frr-config/router-1/frr.conf:/etc/frr/frr.conf',
      'frr-config/router-1/vtysh.conf:/etc/frr/vtysh.conf',
    ])
  })

  it('スイッチに設定の保存先のbind mountが付き、PCは特権なし・NET_ADMINだけ', () => {
    expect(topo.nodes['l2-switch-1'].binds).toEqual(['switch-config/l2-switch-1:/etc/fnl-switch'])
    expect(topo.nodes['pc-1']).toEqual({ kind: 'linux', image: 'alpine:3.20', privileged: false, 'cap-add': ['NET_ADMIN'] })
  })

  it('古いタグのルーター・スイッチは今のイメージに置き換わる', () => {
    const old = [
      { ...node('r', 'router'), data: { ...node('r', 'router').data, image: 'fnl/frr:1' } },
      { ...node('s', 'l2-switch'), data: { ...node('s', 'l2-switch').data, clabKind: 'ovs-bridge', image: undefined } },
    ]
    const t = buildTopologyContent(old, [], 'x').topologyContent.topology
    expect(t.nodes.r.image).toBe(PALETTE_NODE_CONFIGS.router.image)
    expect(t.nodes.s).toMatchObject({ kind: 'linux', image: PALETTE_NODE_CONFIGS['l2-switch'].image })
  })

  it('リンク・隣のノード・ノードの分類', () => {
    expect(topo.links).toEqual([
      { endpoints: ['router-1:eth1', 'l2-switch-1:eth1'] },
      { endpoints: ['l2-switch-1:eth2', 'pc-1:eth1'] },
    ])
    expect([...built.neighbors.get('l2-switch-1')!].sort()).toEqual(['pc-1', 'router-1'])
    expect(built.routerClabNames).toEqual(['router-1'])
    expect(built.switchClabNames).toEqual(['l2-switch-1'])
    expect(built.linuxNodeNames).toEqual(['router-1', 'pc-1'])
  })

  it('ラベルノードはcontainerlabのノードにしない', () => {
    const label: Node = { id: 'note', type: 'labelNode', position: { x: 0, y: 0 }, data: { text: 'memo' } }
    expect(Object.keys(buildTopologyContent([...nodes, label], edges, 'lab1').topologyContent.topology.nodes)).not.toContain('note')
  })

  it('種別の無いノード・I/Fの無いリンクはエラー', () => {
    expect(() => buildTopologyContent([{ id: 'x', type: 'topoNode', position: { x: 0, y: 0 }, data: {} }], [], 'l')).toThrow()
    expect(() => buildTopologyContent(nodes, [{ id: 'e', source: 'router-1', target: 'pc-1', data: {} }], 'l')).toThrow()
  })

  it('リンクの品質：何もしなくても既定の帯域が両端に入り、無制限なら外す', () => {
    expect(built.netemByNode.get('router-1')).toEqual({ eth1: { rate: 100_000 } })
    expect(built.netemByNode.get('l2-switch-1')).toEqual({ eth1: { rate: 100_000 }, eth2: { rate: 100_000 } })
    const unlimited = buildTopologyContent(nodes, [edge('router-1', 'eth1', 'pc-1', 'eth1', { condition: { rateKbit: 0 } })], 'l')
    expect(unlimited.netemByNode.size).toBe(0)
    const slow = buildTopologyContent(nodes, [edge('router-1', 'eth1', 'pc-1', 'eth1', { condition: { delayMs: 50, lossPct: 1 } })], 'l')
    expect(slow.netemByNode.get('pc-1')).toEqual({ eth1: { rate: 100_000, delay: '50ms', loss: 1 } })
  })

  it('ケーブルを抜いた時に落とす端：スイッチ→PC→source', () => {
    const down = { condition: { down: true } }
    const at = (e: Edge) => Object.fromEntries(buildTopologyContent(nodes, [e], 'l').unpluggedByNode)
    expect(at(edge('router-1', 'eth1', 'l2-switch-1', 'eth1', down))).toEqual({ 'l2-switch-1': ['eth1'] })
    expect(at(edge('router-1', 'eth1', 'pc-1', 'eth1', down))).toEqual({ 'pc-1': ['eth1'] })
    expect(at(edge('pc-1', 'eth1', 'router-1', 'eth1', down))).toEqual({ 'pc-1': ['eth1'] })
    const r2 = node('router-2', 'router')
    expect(Object.fromEntries(buildTopologyContent([...nodes, r2], [edge('router-2', 'eth3', 'router-1', 'eth2', down)], 'l').unpluggedByNode)).toEqual({
      'router-2': ['eth3'],
    })
  })
})

describe('buildNodeSyncCommands', () => {
  it('PCはアドレスとデフォルトゲートウェイ、ルーターはeth0のデフォルトルートの削除だけ', () => {
    const cmds = buildNodeSyncCommands(buildTopologyContent(nodes, edges, 'lab1'))
    expect(cmds.get('pc-1')).toBe(
      "sh -c 'set -e; while ip route del default 2>/dev/null; do :; done; ip link set eth1 up; ip -f inet addr flush dev eth1; " +
        "ip addr add 10.0.0.10/24 dev eth1; ip route add default via 10.0.0.1'",
    )
    expect(cmds.get('router-1')).toBe("sh -c 'ip route del default dev eth0 2>/dev/null || true'")
    expect(cmds.get('l2-switch-1')).toBe("sh -c 'mkdir -p /run/fnl-switch; : > /run/fnl-switch/unplugged'")
  })

  it('ルーターの古いアドレス設定は流さない（vtyshの設定と競合するため）', () => {
    const cmds = buildNodeSyncCommands(
      buildTopologyContent(nodes, [edge('router-1', 'eth1', 'pc-1', 'eth1', { sourceAddress: '10.0.0.1/24', sourceGateway: '10.0.0.254' })], 'l'),
    )
    expect(cmds.get('router-1')).not.toContain('10.0.0.1')
  })

  it('形式の違うアドレス・I/F名はコマンドに埋め込まない（シェルに渡るため）', () => {
    const cmds = buildNodeSyncCommands(
      buildTopologyContent(nodes, [edge('router-1', 'eth1', 'pc-1', 'eth1', { targetAddress: "1.2.3.4/24'; reboot; '", targetGateway: '$(id)' })], 'l'),
    )
    expect(cmds.get('pc-1')).not.toMatch(/reboot|\$\(id\)/)
    const bad = buildNodeSyncCommands(buildTopologyContent(nodes, [edge('router-1', 'eth1', 'pc-1', "eth1'; id; '", { condition: { down: true } })], 'l'))
    expect(bad.get('pc-1')).not.toContain('id;')
  })

  it('ケーブルを抜いた端：スイッチはファイル、PCはdown、ルーター同士はdown', () => {
    const down = { condition: { down: true } }
    const r2 = node('router-2', 'router')
    const cmds = buildNodeSyncCommands(
      buildTopologyContent(
        [...nodes, r2],
        [edge('router-1', 'eth1', 'l2-switch-1', 'eth1', down), edge('l2-switch-1', 'eth2', 'pc-1', 'eth1'), edge('router-2', 'eth1', 'router-1', 'eth2', down)],
        'l',
      ),
    )
    expect(cmds.get('l2-switch-1')).toContain('echo eth1 > /run/fnl-switch/unplugged')
    expect(cmds.get('pc-1')).toContain('ip link set eth1 up')
    expect(cmds.get('router-2')).toContain('ip link set eth1 down')
    expect(cmds.get('router-1')).not.toContain('down')
  })
})

describe('保存→読み込みの往復', () => {
  it('YAMLとannotationsから、ノード・座標・I/F・アドレス・リンクの品質が戻る', () => {
    const condition = { rateKbit: 1_000, delayMs: 30, down: true }
    const e = [edges[0], edge('l2-switch-1', 'eth2', 'pc-1', 'eth1', { targetAddress: '10.0.0.10/24', targetGateway: '10.0.0.1', condition })]
    const built = buildTopologyContent(nodes, e, 'lab1')
    const yaml = topologyToYaml(built.topologyContent)
    expect(yaml).not.toContain('&ref_') // cap-addの配列を共有してもYAMLアンカーにしない
    const annotations = serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds, '表示名')

    const restored = parseImportedTopology(yaml, annotations)
    expect(restored.nodes.map((n) => [n.id, n.data.kind, n.position])).toEqual([
      ['router-1', 'router', { x: 10, y: 20 }],
      ['l2-switch-1', 'l2-switch', { x: 200, y: 20 }],
      ['pc-1', 'pc', { x: 400, y: 20 }],
    ])
    const back = restored.edges.find((x) => x.target === 'pc-1')!.data as EdgeIfaceData
    expect(back).toMatchObject({ sourceIface: 'eth2', targetIface: 'eth1', targetAddress: '10.0.0.10/24', targetGateway: '10.0.0.1', condition })

    // 読み込んだものをもう一度保存しても同じ内容になる
    expect(topologyToYaml(buildTopologyContent(restored.nodes, restored.edges, 'lab1').topologyContent)).toBe(yaml)
  })

  it('annotationsが壊れていてもグリッド配置で開ける', () => {
    const yaml = topologyToYaml(buildTopologyContent(nodes, edges, 'lab1').topologyContent)
    expect(parseImportedTopology(yaml, '{broken').nodes).toHaveLength(3)
    expect(parseImportedTopology(yaml, null).edges).toHaveLength(2)
  })
})

describe('hasSwitchWithoutConfigBind', () => {
  it('設定の保存先を持たない古いスイッチを見つける', () => {
    const current = topologyToYaml(buildTopologyContent(nodes, edges, 'lab1').topologyContent)
    expect(hasSwitchWithoutConfigBind(current)).toBe(false)
    const doc = loadYaml(current) as { topology: { nodes: Record<string, { binds?: string[] }> } }
    delete doc.topology.nodes['l2-switch-1'].binds
    expect(hasSwitchWithoutConfigBind(JSON.stringify(doc))).toBe(true)
    expect(hasSwitchWithoutConfigBind(':::')).toBe(false)
  })
})

describe('buildWipeCommand（ノードを初期状態に戻す）', () => {
  it('ルーターはfrr.confを最初の内容に、スイッチはstartup.jsonを消す、PCは何もしない', () => {
    expect(buildWipeCommand('router', 'router-1')).toBe(
      `sh -c 'printf "frr version 10.2.1\\nfrr defaults traditional\\nhostname router-1\\n!\\nline vty\\n!\\n" > /etc/frr/frr.conf'`,
    )
    expect(buildWipeCommand('l2-switch', 'l2-switch-1')).toContain('rm -f /etc/fnl-switch/startup.json')
    expect(buildWipeCommand('pc', 'pc-1')).toBeNull()
    expect(buildWipeCommand(undefined, 'x')).toBeNull()
  })

  it('シェルに渡るので、使えない文字を含むルーター名は拒否する', () => {
    expect(() => buildWipeCommand('router', "r'; reboot; '")).toThrow()
    expect(() => buildWipeCommand('router', '$(id)')).toThrow()
  })
})
