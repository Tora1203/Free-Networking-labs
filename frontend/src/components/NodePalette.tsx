import { PALETTE_NODE_CONFIGS, type PaletteNodeKind } from '../types/lab'
import './NodePalette.css'

export const DND_MIME_TYPE = 'application/reactflow-node-kind'

// ラベル（注釈）はデバイスノードではないので PaletteNodeKind には含めず、
// 同じDND_MIME_TYPEチャンネルに特別な値として流す（TopologyEditor.tsx の onDrop で分岐）
export const LABEL_DND_VALUE = 'label'

const paletteOrder: PaletteNodeKind[] = ['router', 'l2-switch', 'pc']

export default function NodePalette() {
  const onDragStart = (event: React.DragEvent, kind: PaletteNodeKind | typeof LABEL_DND_VALUE) => {
    event.dataTransfer.setData(DND_MIME_TYPE, kind)
    event.dataTransfer.effectAllowed = 'move'
  }

  return (
    <aside className="node-palette">
      <h2 className="node-palette__title">ノード</h2>
      <p className="node-palette__hint">ドラッグしてキャンバスに配置</p>
      {paletteOrder.map((kind) => {
        const config = PALETTE_NODE_CONFIGS[kind]
        return (
          <div
            key={kind}
            className={`node-palette__item node-palette__item--${kind}`}
            draggable
            onDragStart={(event) => onDragStart(event, kind)}
          >
            {config.label}
          </div>
        )
      })}
      <div className="node-palette__divider" />
      <div
        className="node-palette__item node-palette__item--label"
        draggable
        onDragStart={(event) => onDragStart(event, LABEL_DND_VALUE)}
        title="IPアドレスなどのメモをトポロジ上に自由に配置できます"
      >
        🏷 ラベル
      </div>
    </aside>
  )
}
