import { useEffect, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import './AreaNode.css'

// エリア/ネットワークをグループ化して見やすくするための図形（枠）。
// あくまで見た目上のグルーピングで、containerlabのノードではないため
// buildTopologyContent側では除外している（TopologyEditor.tsx参照）。
// 内側に置いたデバイスノードを一緒にドラッグする「親子関係」は今回のスコープでは持たせず、
// 単純に枠を描いて視覚的に区切るだけの機能にしている。
export interface AreaNodeData {
  text: string
  colorIndex: number
  [key: string]: unknown
}

// 複数のエリアを見分けやすいように、色を巡回で選べるようにする
const AREA_COLORS = ['#7c887f', '#2f6fed', '#b45309', '#1f9d55', '#a855f7', '#e11d48']

export default function AreaNode({ id, data, selected }: NodeProps) {
  const nodeData = data as AreaNodeData
  const { updateNodeData } = useReactFlow()
  const color = AREA_COLORS[nodeData.colorIndex % AREA_COLORS.length] ?? AREA_COLORS[0]
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(nodeData.text ?? '')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = () => {
    updateNodeData(id, { text: draft })
    setEditing(false)
  }

  const cycleColor = () => {
    updateNodeData(id, { colorIndex: (nodeData.colorIndex + 1) % AREA_COLORS.length })
  }

  return (
    <div
      className="area-node"
      style={{ borderColor: color, background: `${color}1a` }}
    >
      <NodeResizer minWidth={140} minHeight={90} isVisible={!!selected} lineStyle={{ borderColor: color }} handleStyle={{ backgroundColor: color, borderColor: color }} />
      <div className="area-node__header">
        {editing ? (
          <input
            ref={inputRef}
            className="area-node__title-input nodrag"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                setDraft(nodeData.text ?? '')
                setEditing(false)
              }
            }}
          />
        ) : (
          <span
            className="area-node__title"
            style={{ color }}
            onClick={() => setEditing(true)}
            title="クリックで名前を編集"
          >
            {nodeData.text || 'エリア'}
          </span>
        )}
        <button
          className="area-node__color-swatch nodrag"
          style={{ background: color }}
          onClick={cycleColor}
          title="色を変更"
        />
      </div>
    </div>
  )
}
