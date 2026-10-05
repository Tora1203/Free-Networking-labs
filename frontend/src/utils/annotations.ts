// ノード座標・ラベル/エリア注釈の保存/復元（2026-10-05追加）。
// `GET/PUT /api/v1/labs/{labName}/topology/annotations` はtext/plainで「文字列を保存するだけ」の
// エンドポイントで、中身のフォーマットはクライアント側が決めてよい（Swagger仕様で確認済み）。
// containerlab公式ツール向けの既存フォーマットがある可能性もあるが未確認のため、
// 今回は自分たちの用途に閉じた独自JSONとして保存する（他ツールとの互換性は持たない）。
import type { Node } from '@xyflow/react'

interface AnnotationsFile {
  version: 1
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
}

export function serializeAnnotations(nodes: Node[]): string {
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

  const file: AnnotationsFile = { version: 1, positions, extraNodes }
  return JSON.stringify(file)
}

// 既存ラボ読み込み時、YAMLから再構築したノード（座標はグリッド配置の仮の値）に、
// 保存済みのannotationsがあれば座標を上書きし、ラベル/エリアノードを追加する。
// フォーマットが想定と違う/壊れている場合は何もせず元のノードをそのまま返す
// （読み込み失敗を理由にエディタ自体が開けなくなることは避けたいため）
export function applyAnnotations(nodes: Node[], annotationsText: string): Node[] {
  let parsed: AnnotationsFile
  try {
    const obj = JSON.parse(annotationsText)
    if (!obj || obj.version !== 1) return nodes
    parsed = obj as AnnotationsFile
  } catch {
    return nodes
  }

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
