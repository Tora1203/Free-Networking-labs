// ノード座標・ラベル/エリア注釈の保存/復元（2026-10-05追加）。
// `GET/PUT /api/v1/labs/{labName}/topology/annotations` はtext/plainで「文字列を保存するだけ」の
// エンドポイントで、中身のフォーマットはクライアント側が決めてよい（Swagger仕様で確認済み）。
// containerlab公式ツール向けの既存フォーマットがある可能性もあるが未確認のため、
// 今回は自分たちの用途に閉じた独自JSONとして保存する（他ツールとの互換性は持たない）。
import type { Node, Edge } from '@xyflow/react'

// L2スイッチのブリッジ名・ポート名はホスト全体での衝突を避けるためハッシュ化した実名で
// デプロイするが、そのままだと再読み込み時に「p-1e45bb1d」のような実名がI/F名として
// 表示されてしまう（文字化けのように見える、2026-10-07指摘）うえ、VLAN/IPアドレス設定も
// トポロジYAML自体には書けないため再読み込みで消えてしまう。実名をキーにしてUI上の
// 分かりやすい名前・VLAN・アドレスをここに保存し、再読み込み時に引き戻す
interface PortAnnotation {
  iface: string
  vlan?: unknown
  address?: string
}

interface AnnotationsFile {
  version: 1 | 2
  // デバイスノード（topoNode）の座標。id（＝containerlab上のノード名）をキーにする
  positions: Record<string, { x: number; y: number }>
  // ラベル/エリアなど、containerlabのトポロジYAMLには存在しない注釈ノード
  extraNodes: {
    id: string
    type: 'labelNode' | 'areaNode'
    position: { x: number; y: number }
    width?: number
    height?: number
    data: Record<string, unknown>
  }[]
  // version 2から追加。`${実際にYAMLに書かれるclabName}:${実際のポート名}`をキーにする
  // （TopologyEditor.tsxのbuildTopologyContent()が返すportAnnotationsと同じ形）
  portAnnotations?: Record<string, PortAnnotation>
  // version 2から追加。L2スイッチのブリッジ名（clabName）→ 元のUI上のnode.idの対応
  // （2026-10-07レビュー指摘で追加）。
  // L2スイッチのブリッジ名はnode.idをハッシュ化して作るため、再読み込み後にnode.idが
  // ハッシュ化済みの実名（clabName）に置き換わったままだと、次回のdeployでそれをさらに
  // ハッシュしてしまい、redeployするたびにブリッジ名・ポート名がズレて別物になっていく
  // （古いブリッジ/vethがホストに残骸として残り続け、VLAN設定も失われる）。
  // ここに元のnode.idを保存しておき、再読み込み時に戻す
  switchOriginalIds?: Record<string, string>
}

export function serializeAnnotations(
  nodes: Node[],
  portAnnotations?: Record<string, PortAnnotation>,
  switchOriginalIds?: Record<string, string>,
): string {
  const positions: AnnotationsFile['positions'] = {}
  const extraNodes: AnnotationsFile['extraNodes'] = []

  for (const n of nodes) {
    if (n.type === 'topoNode') {
      positions[n.id] = { x: n.position.x, y: n.position.y }
    } else if (n.type === 'labelNode' || n.type === 'areaNode') {
      const width = typeof n.style?.width === 'number' ? n.style.width : undefined
      const height = typeof n.style?.height === 'number' ? n.style.height : undefined
      extraNodes.push({
        id: n.id,
        type: n.type,
        position: { x: n.position.x, y: n.position.y },
        width,
        height,
        data: n.data as Record<string, unknown>,
      })
    }
  }

  const file: AnnotationsFile = { version: 2, positions, extraNodes, portAnnotations, switchOriginalIds }
  return JSON.stringify(file)
}

// 既存ラボ読み込み時、YAMLから再構築したノード（座標はグリッド配置の仮の値）に、
// 保存済みのannotationsがあれば座標を上書きし、ラベル/エリアノードを追加する。
// フォーマットが想定と違う/壊れている場合は何もせず元のノードをそのまま返す
// （読み込み失敗を理由にエディタ自体が開けなくなることは避けたいため）
function parseAnnotationsFile(annotationsText: string): AnnotationsFile | null {
  try {
    const obj = JSON.parse(annotationsText)
    if (!obj || (obj.version !== 1 && obj.version !== 2)) return null
    return obj as AnnotationsFile
  } catch {
    return null
  }
}

export function applyAnnotations(nodes: Node[], annotationsText: string): Node[] {
  const parsed = parseAnnotationsFile(annotationsText)
  if (!parsed) return nodes

  const withPositions = nodes.map((n) => {
    const pos = parsed.positions?.[n.id]
    return pos ? { ...n, position: pos } : n
  })

  const extra: Node[] = (parsed.extraNodes ?? []).map((e) => ({
    id: e.id,
    type: e.type,
    position: e.position,
    style: e.width !== undefined || e.height !== undefined ? { width: e.width, height: e.height } : undefined,
    data: e.data,
    ...(e.type === 'areaNode' ? { zIndex: -1 } : {}),
  }))

  return [...withPositions, ...extra]
}

// L2スイッチ接続のI/F名（実際はハッシュ化されたポート名）・VLAN・IPアドレス設定を、
// 保存済みのportAnnotationsから引き戻す。古い保存データ（version 1、portAnnotations無し）や
// 保存データそのものが無い場合は何もせずそのまま返す（2026-10-07追加）
export function applyPortAnnotations(edges: Edge[], annotationsText: string): Edge[] {
  const parsed = parseAnnotationsFile(annotationsText)
  const portAnnotations = parsed?.portAnnotations
  if (!portAnnotations) return edges

  return edges.map((edge) => {
    const data = (edge.data ?? {}) as Record<string, unknown>
    const sourceIface = data.sourceIface as string | undefined
    const targetIface = data.targetIface as string | undefined
    const sourceAnnotation = sourceIface ? portAnnotations[`${edge.source}:${sourceIface}`] : undefined
    const targetAnnotation = targetIface ? portAnnotations[`${edge.target}:${targetIface}`] : undefined
    if (!sourceAnnotation && !targetAnnotation) return edge

    return {
      ...edge,
      data: {
        ...data,
        sourceIface: sourceAnnotation?.iface ?? sourceIface,
        targetIface: targetAnnotation?.iface ?? targetIface,
        sourceVlan: sourceAnnotation?.vlan,
        targetVlan: targetAnnotation?.vlan,
        sourceAddress: sourceAnnotation?.address,
        targetAddress: targetAnnotation?.address,
      },
    }
  })
}

// L2スイッチのnode.id（YAML読み込み直後はハッシュ化されたブリッジ名そのもの）を、
// 元のUI上のidに戻す。**`applyPortAnnotations`を先に呼んだ後に呼ぶこと**
// （portAnnotationsのキーはハッシュ化されたclabName基準で保存されているため、
// 先にnode.idを戻してしまうと参照が合わなくなる。2026-10-07レビュー指摘で追加）
export function restoreSwitchIdentities(nodes: Node[], edges: Edge[], annotationsText: string): { nodes: Node[]; edges: Edge[] } {
  const parsed = parseAnnotationsFile(annotationsText)
  const switchOriginalIds = parsed?.switchOriginalIds
  if (!switchOriginalIds) return { nodes, edges }

  const idMap = new Map(Object.entries(switchOriginalIds))
  const remappedNodes = nodes.map((n) => {
    const originalId = idMap.get(n.id)
    return originalId ? { ...n, id: originalId } : n
  })
  const remappedEdges = edges.map((e) => {
    const source = idMap.get(e.source) ?? e.source
    const target = idMap.get(e.target) ?? e.target
    return source === e.source && target === e.target ? e : { ...e, source, target }
  })

  return { nodes: remappedNodes, edges: remappedEdges }
}
