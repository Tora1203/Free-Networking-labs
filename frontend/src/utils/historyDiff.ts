// 元に戻す／やり直すで「何がどう変わるか」を文章にする（2026-10-14、テスターの要望
// 「戻した時に何を戻したのか分からない」対応）。
//
// 履歴の2つのスナップショット（from→to）を比べ、キャンバスに起きる変化をそのまま書く
// （元に戻すなら今→1つ前、やり直すなら今→1つ先）。変わったノード・接続のidも返し、
// 戻した後にそれらを選択状態にして場所を示すのに使う。
import type { Edge, Node } from '@xyflow/react'
import type { TopoNodeData } from '../components/TopologyNode'
import { PALETTE_NODE_CONFIGS } from '../types/lab'
import type { EdgeIfaceData } from './labTopology'
import { conditionSummary } from './linkCondition'

export interface HistoryChange {
  // 1行ずつの説明（例：「ルーター「router-1」を削除」）
  lines: string[]
  // 変化後のキャンバスに残っている、変わったノード・接続（削除されたものは含まない）
  nodeIds: string[]
  edgeIds: string[]
}

type Snapshot = { nodes: Node[]; edges: Edge[] }

function shorten(text: string, max = 20): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function nodeName(node: Node): string {
  const data = node.data as Partial<TopoNodeData>
  return data.shortLabel || node.id
}

// 「ルーター「router-1」」「ラベル「メモ」」のような呼び名
function describeNode(node: Node): string {
  if (node.type === 'labelNode') return `ラベル「${shorten(String(node.data.text ?? '')) || '（空）'}」`
  if (node.type === 'areaNode') return `エリア「${shorten(String(node.data.text ?? '')) || '（無題）'}」`
  const kind = (node.data as Partial<TopoNodeData>).kind
  const kindLabel = kind ? PALETTE_NODE_CONFIGS[kind]?.label : undefined
  return `${kindLabel ?? 'ノード'}「${nodeName(node)}」`
}

const valueOrNone = (v: unknown) => (typeof v === 'string' && v ? v : 'なし')

export function describeHistoryChange(from: Snapshot, to: Snapshot): HistoryChange {
  const lines: string[] = []
  const nodeIds = new Set<string>()
  const edgeIds = new Set<string>()

  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]))
  const toNodes = new Map(to.nodes.map((n) => [n.id, n]))
  // 接続の説明に使うノード名は、消えたノードの分も引けるよう両方から集める
  const names = new Map<string, string>()
  for (const n of [...from.nodes, ...to.nodes]) names.set(n.id, nodeName(n))
  const endpoint = (nodeId: string, iface: unknown) => `${names.get(nodeId) ?? nodeId}${iface ? ` ${String(iface)}` : ''}`
  const describeEdge = (e: Edge) => {
    const d = (e.data ?? {}) as Partial<EdgeIfaceData>
    return `接続「${endpoint(e.source, d.sourceIface)} ⇔ ${endpoint(e.target, d.targetIface)}」`
  }

  // ---- ノード ----
  const removedNodeIds = new Set<string>()
  const moved: Node[] = []
  for (const [id, before] of fromNodes) {
    const after = toNodes.get(id)
    if (!after) {
      removedNodeIds.add(id)
      continue
    }
    if (before.position.x !== after.position.x || before.position.y !== after.position.y) moved.push(after)
    const changes: string[] = []
    if (after.type === 'topoNode') {
      const a = before.data as Partial<TopoNodeData>
      const b = after.data as Partial<TopoNodeData>
      if (a.shortLabel !== b.shortLabel) changes.push(`${describeNode(before)}の名前を「${nodeName(after)}」に変更`)
    } else {
      if (before.data.text !== after.data.text) {
        changes.push(`${describeNode(before)}の文字を「${shorten(String(after.data.text ?? '')) || '（空）'}」に変更`)
      }
      if (before.data.colorIndex !== after.data.colorIndex) changes.push(`${describeNode(after)}の色を変更`)
      if (before.width !== after.width || before.height !== after.height) changes.push(`${describeNode(after)}の大きさを変更`)
    }
    if (changes.length > 0) {
      lines.push(...changes)
      nodeIds.add(id)
    }
  }
  for (const [id, after] of toNodes) {
    if (fromNodes.has(id)) continue
    lines.push(`${describeNode(after)}を追加`)
    nodeIds.add(id)
  }
  for (const id of removedNodeIds) {
    const before = fromNodes.get(id)!
    // ノードと一緒に消える接続は、1行にまとめる
    const attached = from.edges.filter((e) => (e.source === id || e.target === id) && !to.edges.some((t) => t.id === e.id))
    lines.push(`${describeNode(before)}を削除${attached.length > 0 ? `（接続${attached.length}本も）` : ''}`)
  }
  if (moved.length === 1) lines.push(`${describeNode(moved[0])}を移動`)
  else if (moved.length > 1) lines.push(`${moved.length}個のノードを移動（${moved.slice(0, 3).map(nodeName).join('、')}${moved.length > 3 ? ' など' : ''}）`)
  for (const n of moved) nodeIds.add(n.id)

  // ---- 接続 ----
  const fromEdges = new Map(from.edges.map((e) => [e.id, e]))
  const toEdges = new Map(to.edges.map((e) => [e.id, e]))
  for (const [id, after] of toEdges) {
    const before = fromEdges.get(id)
    if (!before) {
      lines.push(`${describeEdge(after)}を追加`)
      edgeIds.add(id)
      continue
    }
    const a = (before.data ?? {}) as Partial<EdgeIfaceData>
    const b = (after.data ?? {}) as Partial<EdgeIfaceData>
    const changes: string[] = []
    const sides = [
      { node: after.source, prefix: 'source' },
      { node: after.target, prefix: 'target' },
    ] as const
    for (const { node, prefix } of sides) {
      const ifaceKey = `${prefix}Iface` as const
      const addressKey = `${prefix}Address` as const
      const gatewayKey = `${prefix}Gateway` as const
      if (a[ifaceKey] !== b[ifaceKey]) {
        changes.push(`${names.get(node) ?? node}のI/Fを ${valueOrNone(a[ifaceKey])} → ${valueOrNone(b[ifaceKey])} に変更`)
      }
      if (a[addressKey] !== b[addressKey]) {
        changes.push(`${endpoint(node, b[ifaceKey])}のIPアドレスを ${valueOrNone(a[addressKey])} → ${valueOrNone(b[addressKey])} に変更`)
      }
      if (a[gatewayKey] !== b[gatewayKey]) {
        changes.push(`${names.get(node) ?? node}のゲートウェイを ${valueOrNone(a[gatewayKey])} → ${valueOrNone(b[gatewayKey])} に変更`)
      }
    }
    // リンクの品質・ケーブルの抜き差し（2026-10-14）
    if (!!a.condition?.down !== !!b.condition?.down) {
      changes.push(`${describeEdge(after)}のケーブルを${b.condition?.down ? '抜く' : '差す'}`)
    }
    const qualityBefore = conditionSummary(a.condition)
    const qualityAfter = conditionSummary(b.condition)
    if (qualityBefore !== qualityAfter) {
      changes.push(`${describeEdge(after)}の品質を ${qualityBefore || 'なし'} → ${qualityAfter || 'なし'} に変更`)
    }
    if (changes.length === 0 && JSON.stringify(before) !== JSON.stringify(after)) changes.push(`${describeEdge(after)}を変更`)
    if (changes.length > 0) {
      lines.push(...changes)
      edgeIds.add(id)
    }
  }
  for (const [id, before] of fromEdges) {
    if (toEdges.has(id)) continue
    if (removedNodeIds.has(before.source) || removedNodeIds.has(before.target)) continue // ノード削除の行に含めた
    lines.push(`${describeEdge(before)}を削除`)
  }

  if (lines.length === 0) lines.push('表示の変更')
  return { lines, nodeIds: [...nodeIds], edgeIds: [...edgeIds] }
}
