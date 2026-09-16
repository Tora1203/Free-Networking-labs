import { PALETTE_NODE_CONFIGS, type PaletteNodeKind } from '../types/lab'
import './NodePalette.css'

export const DND_MIME_TYPE = 'application/reactflow-node-kind'

const paletteOrder: PaletteNodeKind[] = ['router', 'l2-switch', 'pc']

export default function NodePalette() {
  const onDragStart = (event: React.DragEvent, kind: PaletteNodeKind) => {
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
    </aside>
  )
}
