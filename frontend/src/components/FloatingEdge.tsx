import { BaseEdge, getStraightPath, useInternalNode, Position, type EdgeProps, type InternalNode, type Node } from '@xyflow/react'

// CMLのように、ノードをどこへ動かしても線が自然に追従して見えるようにするための
// 「フローティングエッジ」。通常の React Flow のエッジは接続時に選んだハンドル（点）に
// 固定されるため、ノードを大きく動かすと線が変な角度から生えたままになってしまう。
// ここでは毎レンダリングごとに2ノードの中心を結ぶ直線とノードの矩形の交点を計算し、
// 常に「相手ノードに一番近い辺」から線が出るようにしている
// （React Flow公式のFloating Edgesレシピと同じ考え方）。

// 同じ2ノード間に複数リンク（LAGのような並列接続）がある場合、上の交点計算だけだと
// 全リンクが完全に同じ座標を通るため1本しか見えなくなる。並列本数分だけ弧状に
// 膨らませて見分けられるようにする（間隔はpx単位、中央寄せ）。
const PARALLEL_SPACING = 22

function getNodeIntersection(intersectionNode: InternalNode<Node>, targetNode: InternalNode<Node>) {
  const { width, height } = intersectionNode.measured
  const intersectionNodePosition = intersectionNode.internals.positionAbsolute
  const targetPosition = targetNode.internals.positionAbsolute

  const w = (width ?? 0) / 2
  const h = (height ?? 0) / 2

  const x2 = intersectionNodePosition.x + w
  const y2 = intersectionNodePosition.y + h
  const x1 = targetPosition.x + (targetNode.measured.width ?? 0) / 2
  const y1 = targetPosition.y + (targetNode.measured.height ?? 0) / 2

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h)
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h)
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1)
  const xx3 = a * xx1
  const yy3 = a * yy1
  const x = w * (xx3 + yy3) + x2
  const y = h * (-xx3 + yy3) + y2

  return { x, y }
}

function getEdgePosition(node: InternalNode<Node>, intersectionPoint: { x: number; y: number }) {
  const { x: nx, y: ny } = node.internals.positionAbsolute
  const width = node.measured.width ?? 0
  const height = node.measured.height ?? 0
  const px = Math.round(intersectionPoint.x)
  const py = Math.round(intersectionPoint.y)

  if (px <= Math.round(nx) + 1) return Position.Left
  if (px >= Math.round(nx + width) - 1) return Position.Right
  if (py <= Math.round(ny) + 1) return Position.Top
  if (py >= Math.round(ny + height) - 1) return Position.Bottom
  return Position.Top
}

function getEdgeParams(source: InternalNode<Node>, target: InternalNode<Node>) {
  const sourceIntersectionPoint = getNodeIntersection(source, target)
  const targetIntersectionPoint = getNodeIntersection(target, source)

  const sourcePos = getEdgePosition(source, sourceIntersectionPoint)
  const targetPos = getEdgePosition(target, targetIntersectionPoint)

  return {
    sx: sourceIntersectionPoint.x,
    sy: sourceIntersectionPoint.y,
    tx: targetIntersectionPoint.x,
    ty: targetIntersectionPoint.y,
    sourcePos,
    targetPos,
  }
}

export interface FloatingEdgeData {
  // 同じノード間にある並列リンクの中で何番目か・全部で何本あるか（0始まり）。
  // TopologyEditor.tsx の displayEdges 側で算出して渡す。
  parallelIndex?: number
  parallelCount?: number
  [key: string]: unknown
}

export default function FloatingEdge({ id, source, target, style, label, labelStyle, labelBgStyle, data }: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)

  if (!sourceNode || !targetNode) return null

  const { sx, sy, tx, ty } = getEdgeParams(sourceNode, targetNode)

  const { parallelIndex = 0, parallelCount = 1 } = (data as FloatingEdgeData | undefined) ?? {}

  let path: string
  let labelX: number
  let labelY: number

  if (parallelCount <= 1) {
    ;[path, labelX, labelY] = getStraightPath({ sourceX: sx, sourceY: sy, targetX: tx, targetY: ty })
  } else {
    // 中央寄せのオフセット量（例: 3本なら -spacing, 0, +spacing）
    const offset = (parallelIndex - (parallelCount - 1) / 2) * PARALLEL_SPACING
    const dx = tx - sx
    const dy = ty - sy
    const len = Math.hypot(dx, dy) || 1
    // 進行方向に垂直な単位ベクトル
    const nx = -dy / len
    const ny = dx / len
    const cx = (sx + tx) / 2 + nx * offset
    const cy = (sy + ty) / 2 + ny * offset
    // 端点は正しいノード境界の交点のまま、中央だけ弧状に膨らませる
    path = `M ${sx},${sy} Q ${cx},${cy} ${tx},${ty}`
    labelX = cx
    labelY = cy
  }

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      label={label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={labelStyle}
      labelBgStyle={labelBgStyle}
    />
  )
}
