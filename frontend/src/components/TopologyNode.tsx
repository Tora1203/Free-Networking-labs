import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { PaletteNodeKind } from '../types/lab'
import './TopologyNode.css'
import { NODE_RUN_STATUS_LABEL, useNodeRunStatus } from './nodeRuntimeContext'

// ノード種別ごとの見た目（形・色・略称）。api-contract.md 3章の対応表と対応させている。
const KIND_VISUAL: Record<PaletteNodeKind, { badge: string; className: string }> = {
  router: { badge: 'R', className: 'topo-node--router' },
  'l2-switch': { badge: 'SW', className: 'topo-node--switch' },
  'l3-switch': { badge: 'L3', className: 'topo-node--switch topo-node--l3switch' },
  pc: { badge: 'PC', className: 'topo-node--pc' },
}

// 接続はどの向きからでも作れるようにしたいので、四方にハンドルを置く
// （TopologyEditor側で connectionMode="loose" を設定している）。
// どのハンドルを起点にドラッグしたかは接続の可否にのみ使い、実際の線の描画は
// floating edge（TopologyEditor.tsx の FloatingEdge）が2ノードの中心角度から
// 毎回動的に計算するため、線が重なったりノード移動に追従しなかったりする心配はない。
const HANDLE_POSITIONS = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
] as const

export interface TopoNodeData {
  kind: PaletteNodeKind
  clabKind: string
  image: string
  shortLabel: string
  [key: string]: unknown
}

export default function TopologyNode({ id, data, selected }: NodeProps) {
  const nodeData = data as TopoNodeData
  const visual = KIND_VISUAL[nodeData.kind] ?? { badge: '?', className: '' }
  const runStatus = useNodeRunStatus(id)

  return (
    <div
      className={`topo-node ${visual.className} ${selected ? 'topo-node--selected' : ''} topo-node--status-${runStatus}`}
      title={NODE_RUN_STATUS_LABEL[runStatus] || undefined}
    >
      {HANDLE_POSITIONS.map((h) => (
        <Handle
          key={h.id}
          id={h.id}
          type="source"
          position={h.position}
          className="topo-node__handle"
        />
      ))}
      <div className="topo-node__badge">{visual.badge}</div>
      {runStatus !== 'none' && <span className="topo-node__status" aria-label={NODE_RUN_STATUS_LABEL[runStatus]} />}
      <div className="topo-node__label">{nodeData.shortLabel}</div>
    </div>
  )
}
