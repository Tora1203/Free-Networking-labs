import { useCallback, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type OnConnect,
  type OnNodesChange,
  type OnEdgesChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import NodePalette, { DND_MIME_TYPE } from './NodePalette'
import { PALETTE_NODE_CONFIGS, type PaletteNodeKind } from '../types/lab'
import './TopologyEditor.css'

const initialNodes: Node[] = [
  { id: 'r1', position: { x: 0, y: 0 }, data: { label: 'router1 (FRR)' } },
  { id: 'r2', position: { x: 250, y: 0 }, data: { label: 'router2 (FRR)' } },
  { id: 'r3', position: { x: 125, y: 150 }, data: { label: 'router3 (FRR)' } },
]

const initialEdges: Edge[] = [{ id: 'r1-r2', source: 'r1', target: 'r2' }]

function TopologyEditorInner() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const nodeIdCounter = useRef(0)
  const [nodes, setNodes] = useState<Node[]>(initialNodes)
  const [edges, setEdges] = useState<Edge[]>(initialEdges)
  const { screenToFlowPosition } = useReactFlow()

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  )
  const onConnect: OnConnect = useCallback(
    (connection) => setEdges((eds) => addEdge(connection, eds)),
    [],
  )

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      const kind = event.dataTransfer.getData(DND_MIME_TYPE) as PaletteNodeKind
      const config = PALETTE_NODE_CONFIGS[kind]
      if (!config) return

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      nodeIdCounter.current += 1
      const id = `${kind}-${nodeIdCounter.current}`

      setNodes((nds) =>
        nds.concat({
          id,
          position,
          data: { label: `${config.label} (${id})` },
        }),
      )
    },
    [screenToFlowPosition],
  )

  return (
    <div className="topology-editor">
      <NodePalette />
      <div className="topology-editor__canvas" ref={canvasRef} onDrop={onDrop} onDragOver={onDragOver}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </div>
  )
}

export default function TopologyEditor() {
  return (
    <ReactFlowProvider>
      <TopologyEditorInner />
    </ReactFlowProvider>
  )
}
