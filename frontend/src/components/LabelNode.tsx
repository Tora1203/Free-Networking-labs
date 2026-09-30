import { useEffect, useRef, useState } from 'react'
import { useReactFlow, type NodeProps } from '@xyflow/react'
import './LabelNode.css'

// トポロジ図にIPアドレスやメモを書き込むための自由記述ラベル（CMLの注釈機能相当）。
// containerlabのトポロジには含めないただの編集メモなので、buildTopologyContent側で
// node.type === 'topoNode' 以外を除外している（TopologyEditor.tsx参照）。
export interface LabelNodeData {
  text: string
  [key: string]: unknown
}

export default function LabelNode({ id, data, selected }: NodeProps) {
  const nodeData = data as LabelNodeData
  const { updateNodeData } = useReactFlow()
  const [editing, setEditing] = useState(!nodeData.text)
  const [draft, setDraft] = useState(nodeData.text ?? '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus()
      textareaRef.current?.select()
    }
  }, [editing])

  const commit = () => {
    updateNodeData(id, { text: draft })
    setEditing(false)
  }

  const cancel = () => {
    setDraft(nodeData.text ?? '')
    setEditing(false)
  }

  if (editing) {
    return (
      <div className={`label-node label-node--editing ${selected ? 'label-node--selected' : ''}`}>
        <textarea
          ref={textareaRef}
          className="label-node__textarea nodrag"
          value={draft}
          placeholder="例: 10.0.0.1/30"
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              cancel()
            }
          }}
        />
      </div>
    )
  }

  return (
    <div
      className={`label-node ${selected ? 'label-node--selected' : ''}`}
      onDoubleClick={() => setEditing(true)}
      title="ダブルクリックで編集"
    >
      {nodeData.text || '(ダブルクリックで編集)'}
    </div>
  )
}
