import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { PaletteNodeKind } from '../types/lab'
import './TopologyNode.css'

// ノード種別ごとの見た目（形・色・略称）。api-contract.md 3章の対応表と対応させている。
const KIND_VISUAL: Record<PaletteNodeKind, { badge: string; className: string }> = {
  router: { badge: 'R', className: 'topo-node--router' },
  'l2-switch': { badge: 'SW', className: 'topo-node--switch' },
  pc: { badge: 'PC', className: 'topo-node--pc' },
}

// 接続はどの向きからでも作れるようにしたいので、周囲にハンドルを置く
// （TopologyEditor側で connectionMode="loose" を設定している）。
// 4方向だけだと、1つのノードに複数のリンクを繋いだ時に同じ点から線が重なって
// 見づらくなるため、各辺の途中にもう1点ずつ追加して計8点にしている
// （style で position のデフォルト位置(50%)をずらしている）。
const HANDLE_POSITIONS = [
  { id: 'top', position: Position.Top },
  { id: 'top-right', position: Position.Top, style: { left: '80%' } },
  { id: 'right', position: Position.Right },
  { id: 'bottom-right', position: Position.Right, style: { top: '80%' } },
  { id: 'bottom', position: Position.Bottom },
  { id: 'bottom-left', position: Position.Bottom, style: { left: '20%' } },
  { id: 'left', position: Position.Left },
  { id: 'top-left', position: Position.Left, style: { top: '20%' } },
] as const

export interface TopoNodeData {
  kind: PaletteNodeKind
  clabKind: string
  image: string
  shortLabel: string
  [key: string]: unknown
}

export default function TopologyNode({ data, selected }: NodeProps) {
  const nodeData = data as TopoNodeData
  const visual = KIND_VISUAL[nodeData.kind] ?? { badge: '?', className: '' }

  return (
    <div className={`topo-node ${visual.className} ${selected ? 'topo-node--selected' : ''}`}>
      {HANDLE_POSITIONS.map((h) => (
        <Handle
          key={h.id}
          id={h.id}
          type="source"
          position={h.position}
          className="topo-node__handle"
          style={'style' in h ? h.style : undefined}
        />
      ))}
      <div className="topo-node__badge">{visual.badge}</div>
      <div className="topo-node__label">{nodeData.shortLabel}</div>
    </div>
  )
}
