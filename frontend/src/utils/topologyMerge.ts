// 同じラボを複数の画面で編集した時の、ノード単位の統合（2026-10-21、docs/collab-design.md）。
//
// 3方向の統合：共通の元（最後に保存した内容）・自分の今の内容・別の画面が保存した内容を比べ、
// - 片方だけが変えた所は、変えた方を採る
// - 両方が同じ所を同じに変えていれば、そのまま
// - 両方が同じ所を違うように変えた所（衝突）は、自分の内容を残して知らせる
// ノードは「位置」「設定（data）」「それ以外（大きさなど）」に分けて比べるので、一方が動かして
// 他方が設定を変えた場合は両方残る。リンクは両端（ノード:インターフェース）の組みで同じものとみなす
// （エッジのidには並び順の番号が入っていて、別の画面と揃わない）。
// 自動では決められない場合（同じインターフェースに別々のリンクをつないだ、同じ名前のノードを別々に
// 足した）は hardConflict を返し、呼び出し側は従来の「最新を読み込む／自分の内容で上書き」にする。
//
// 3つとも「保存形式（YAML＋annotations）を読み込んだ形」でそろえて渡すこと（座標の丸めや、
// 画面だけの状態（選択など）の差が、変更に見えないように）。
import type { Edge, Node } from '@xyflow/react'

export interface TopologyState {
  nodes: Node[]
  edges: Edge[]
  // ラボの表示名
  title: string
}

export interface MergeResult {
  nodes: Node[]
  edges: Edge[]
  title: string
  // 同じ所を両方が違うように変えたため、自分の内容を残した所（画面に出す）
  conflicts: string[]
  // 自動では決められない理由。あれば、他のフィールドは使わない
  hardConflict: string | null
  // 別の画面の変更を取り込んだか（取り込む物が無ければ、自分の内容のまま）
  tookRemote: boolean
}

// キーの並びによらず同じ文字列になるJSON
function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`
}

// 画面だけの状態（選択・ドラッグ中・測った大きさ）は、変更とみなさない
const TRANSIENT_NODE_KEYS = new Set(['selected', 'dragging', 'measured', 'positionAbsolute', 'resizing'])
const TRANSIENT_EDGE_KEYS = new Set(['selected'])

interface NodeParts {
  position: string
  data: string
  shape: string
}

function nodeParts(node: Node): NodeParts {
  const shape: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if (k === 'id' || k === 'position' || k === 'data' || TRANSIENT_NODE_KEYS.has(k)) continue
    shape[k] = v
  }
  return { position: stable(node.position), data: stable(node.data), shape: stable(shape) }
}

function sameNode(a: Node, b: Node): boolean {
  const pa = nodeParts(a)
  const pb = nodeParts(b)
  return pa.position === pb.position && pa.data === pb.data && pa.shape === pb.shape
}

function edgeSig(edge: Edge): string {
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(edge)) {
    if (k === 'id' || TRANSIENT_EDGE_KEYS.has(k)) continue
    rest[k] = v
  }
  return stable(rest)
}

function endpoint(edge: Edge, side: 'source' | 'target'): string {
  const iface = (edge.data as { sourceIface?: string; targetIface?: string } | undefined)?.[side === 'source' ? 'sourceIface' : 'targetIface'] ?? ''
  return `${edge[side]}:${iface}`
}

// リンクの同一性：両端の組み（向きによらない）
function edgeKey(edge: Edge): string {
  return [endpoint(edge, 'source'), endpoint(edge, 'target')].sort().join('|')
}

function describeEdge(edge: Edge): string {
  return `${endpoint(edge, 'source')} ⇄ ${endpoint(edge, 'target')}`
}

// 1つの値の3方向の統合。衝突したら自分（local）を採る
function pick<T>(base: T | undefined, local: T, remote: T, same: (a: T, b: T) => boolean, onConflict: () => void): T {
  if (same(local, remote)) return local
  if (base !== undefined && same(local, base)) return remote
  if (base !== undefined && same(remote, base)) return local
  onConflict()
  return local
}

const eq = (a: string, b: string) => a === b

export function mergeTopology(base: TopologyState, local: TopologyState, remote: TopologyState): MergeResult {
  const conflicts: string[] = []
  let tookRemote = false
  const fail = (hardConflict: string): MergeResult => ({ nodes: local.nodes, edges: local.edges, title: local.title, conflicts, hardConflict, tookRemote })

  const baseNodes = new Map(base.nodes.map((n) => [n.id, n]))
  const localNodes = new Map(local.nodes.map((n) => [n.id, n]))
  const remoteNodes = new Map(remote.nodes.map((n) => [n.id, n]))

  // ---- ノード ----
  const mergedNodes: Node[] = []
  const ids = [...new Set([...local.nodes.map((n) => n.id), ...remote.nodes.map((n) => n.id)])]
  for (const id of ids) {
    const b = baseNodes.get(id)
    const l = localNodes.get(id)
    const r = remoteNodes.get(id)
    if (l && r) {
      if (!b) {
        // 両方が同じ名前のノードを別々に足した
        if (!sameNode(l, r)) return fail(`「${id}」という名前のノードを、両方の画面が別々に追加しています`)
        mergedNodes.push(l)
        continue
      }
      const pb = nodeParts(b)
      const pl = nodeParts(l)
      const pr = nodeParts(r)
      // 位置・設定・それ以外を、それぞれ採った側（自分 or 別の画面）から組み立てる
      const PART_LABEL = { position: '位置', data: '設定', shape: '大きさなど' } as const
      const from = {} as Record<'position' | 'data' | 'shape', Node>
      for (const part of ['position', 'data', 'shape'] as const) {
        const value = pick(pb[part], pl[part], pr[part], eq, () => conflicts.push(`ノード ${id}（${PART_LABEL[part]}）`))
        const useRemote = value !== pl[part]
        if (useRemote) tookRemote = true
        from[part] = useRemote ? r : l
      }
      mergedNodes.push({ ...from.shape, id, position: from.position.position, data: from.data.data })
      continue
    }
    if (l && !r) {
      if (!b) {
        mergedNodes.push(l) // 自分だけが追加した
      } else if (sameNode(l, b)) {
        tookRemote = true // 別の画面が削除し、自分は触っていない → 削除
      } else {
        conflicts.push(`ノード ${id}（別の画面が削除したが、自分が変更したので残しました）`)
        mergedNodes.push(l)
      }
      continue
    }
    if (r && !l) {
      if (!b) {
        tookRemote = true
        mergedNodes.push(r) // 別の画面だけが追加した
      } else if (sameNode(r, b)) {
        // 自分が削除し、別の画面は触っていない → 削除のまま
      } else {
        conflicts.push(`ノード ${id}（自分が削除したが、別の画面が変更したので残しました）`)
        tookRemote = true
        mergedNodes.push(r)
      }
    }
  }

  // ---- リンク ----
  const keyed = (edges: Edge[]) => new Map(edges.map((e) => [edgeKey(e), e]))
  const baseEdges = keyed(base.edges)
  const localEdges = keyed(local.edges)
  const remoteEdges = keyed(remote.edges)
  const mergedEdges: Edge[] = []
  const edgeKeys = [...new Set([...localEdges.keys(), ...remoteEdges.keys()])]
  for (const key of edgeKeys) {
    const b = baseEdges.get(key)
    const l = localEdges.get(key)
    const r = remoteEdges.get(key)
    if (l && r) {
      const sb = b ? edgeSig(b) : undefined
      const sl = edgeSig(l)
      const sr = edgeSig(r)
      if (sl === sr) mergedEdges.push(l)
      else {
        const value = pick(sb, sl, sr, eq, () => conflicts.push(`リンク ${describeEdge(l)}`))
        if (value === sr) tookRemote = true
        mergedEdges.push(value === sr ? r : l)
      }
      continue
    }
    if (l && !r) {
      if (!b) mergedEdges.push(l)
      else if (edgeSig(l) === edgeSig(b)) tookRemote = true // 別の画面が削除
      else {
        conflicts.push(`リンク ${describeEdge(l)}（別の画面が削除したが、自分が変更したので残しました）`)
        mergedEdges.push(l)
      }
      continue
    }
    if (r && !l) {
      if (!b) {
        tookRemote = true
        mergedEdges.push(r)
      } else if (edgeSig(r) !== edgeSig(b)) {
        conflicts.push(`リンク ${describeEdge(r)}（自分が削除したが、別の画面が変更したので残しました）`)
        tookRemote = true
        mergedEdges.push(r)
      }
    }
  }

  // 消えたノードにつながるリンクは残せない。ノードを消したのが自分で、別の画面がそのノードに足したリンク等
  const present = new Set(mergedNodes.map((n) => n.id))
  const edges = mergedEdges.filter((e) => {
    if (present.has(e.source) && present.has(e.target)) return true
    conflicts.push(`リンク ${describeEdge(e)}（つなぎ先のノードが無いため外しました）`)
    return false
  })

  // 同じインターフェースに2本のリンクがつながっていたら、自動では決められない
  const used = new Map<string, Edge>()
  for (const e of edges) {
    for (const side of ['source', 'target'] as const) {
      const ep = endpoint(e, side)
      const other = used.get(ep)
      if (other && other !== e) return fail(`${ep} に、両方の画面が別々のリンクをつないでいます`)
      used.set(ep, e)
    }
  }

  const title = pick(base.title, local.title, remote.title, (a, b) => a === b, () => conflicts.push('ラボの表示名'))
  if (title !== local.title) tookRemote = true
  return { nodes: mergedNodes, edges, title, conflicts, hardConflict: null, tookRemote }
}
