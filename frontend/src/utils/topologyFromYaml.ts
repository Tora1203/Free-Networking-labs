// 既存ラボをトポロジエディタで開くための、containerlabトポロジYAML→React Flowノード/エッジ変換。
// `GET /api/v1/labs/{labName}/topology/yaml`（2026-10-05、Swagger仕様で存在確認）が返す
// プレーンなcontainerlab YAMLをパースする。
//
// 制約（2026-10-05時点）:
// - ノードの座標情報は持っていないため、簡易的なグリッドレイアウトで配置する
//   （`GET .../topology/annotations` でノード座標を保存できる可能性があるが、
//   実際のフォーマットは未確認のため今回は見送り。docs/STATUS.md参照）
// - ラベル/エリア（labelNode/areaNode）はcontainerlabのトポロジには存在しない注釈なので、
//   既存ラボを開いた直後は復元されない
// - l2-switch(ovs-bridge)のノード名は`toClabBridgeName()`でハッシュ化された名前のまま
//   （元のノード名は保存していないため復元できない）
import { load as loadYaml } from 'js-yaml'
import type { Node, Edge } from '@xyflow/react'
import type { TopoNodeData } from '../components/TopologyNode'
import { PALETTE_NODE_CONFIGS, type PaletteNodeKind } from '../types/lab'

// TopologyEditor.tsx内のEdgeIfaceData/SHORT_LABEL_PREFIXと同じ形。循環import を避けるため
// ここで定義を共有せず、同じ形を独立して持つ（キー自体は双方で固定・変更されない前提）
interface EdgeIfaceData {
  sourceIface: string
  targetIface: string
  [key: string]: unknown
}
const SHORT_LABEL_PREFIX: Record<PaletteNodeKind, string> = { router: 'R', 'l2-switch': 'SW', pc: 'PC' }

interface RawTopologyYaml {
  name?: string
  topology?: {
    nodes?: Record<string, { kind?: string; image?: string }>
    links?: { endpoints?: [string, string] }[]
  }
}

export interface ParsedTopology {
  nodes: Node[]
  edges: Edge[]
  // ロード後にドロップしたノードが既存ノードと番号が被らないよう、呼び出し側のカウンターを進める用
  counters: Record<PaletteNodeKind, number>
}

const GRID_COLUMNS = 4
const GRID_SPACING_X = 160
const GRID_SPACING_Y = 140

// containerlab側はrouter/pcともkind:'linux'なので、imageで見分ける
// （frontend/src/types/lab.tsのPALETTE_NODE_CONFIGSと対応）
function guessPaletteKind(clabKind: string | undefined, image: string | undefined): PaletteNodeKind {
  if (clabKind === 'ovs-bridge') return 'l2-switch'
  if (image === PALETTE_NODE_CONFIGS.router.image) return 'router'
  return 'pc'
}

function splitEndpoint(endpoint: string): [string, string] {
  const idx = endpoint.lastIndexOf(':')
  if (idx === -1) return [endpoint, 'eth1']
  return [endpoint.slice(0, idx), endpoint.slice(idx + 1)]
}

export function parseTopologyYaml(yamlText: string): ParsedTopology {
  const parsed = (loadYaml(yamlText) as RawTopologyYaml) ?? {}
  const rawNodes = parsed.topology?.nodes ?? {}
  const rawLinks = parsed.topology?.links ?? []

  const counters: Record<PaletteNodeKind, number> = { router: 0, 'l2-switch': 0, pc: 0 }
  const nodes: Node[] = Object.entries(rawNodes).map(([clabName, def], i) => {
    const kind = guessPaletteKind(def?.kind, def?.image)
    const config = PALETTE_NODE_CONFIGS[kind]
    counters[kind] += 1
    const data: TopoNodeData = {
      kind,
      clabKind: def?.kind ?? config.clabKind,
      image: def?.image ?? config.image,
      shortLabel: `${SHORT_LABEL_PREFIX[kind]}${counters[kind]}`,
    }
    return {
      id: clabName,
      type: 'topoNode',
      position: { x: (i % GRID_COLUMNS) * GRID_SPACING_X, y: Math.floor(i / GRID_COLUMNS) * GRID_SPACING_Y },
      data,
    }
  })

  const nodeIds = new Set(nodes.map((n) => n.id))
  const edges: Edge[] = []
  rawLinks.forEach((link, idx) => {
    const endpoints = link.endpoints
    if (!endpoints || endpoints.length !== 2) return
    const [sourceName, sourceIface] = splitEndpoint(endpoints[0])
    const [targetName, targetIface] = splitEndpoint(endpoints[1])
    if (!nodeIds.has(sourceName) || !nodeIds.has(targetName)) return
    edges.push({
      id: `${sourceName}:${sourceIface}-${targetName}:${targetIface}-${idx}`,
      source: sourceName,
      target: targetName,
      sourceHandle: 'right',
      targetHandle: 'left',
      type: 'floating',
      data: { sourceIface, targetIface } satisfies EdgeIfaceData,
    })
  })

  return { nodes, edges, counters }
}
