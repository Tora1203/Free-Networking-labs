import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
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
import TopologyNode, { type TopoNodeData } from './TopologyNode'
import { PALETTE_NODE_CONFIGS, type PaletteNodeKind } from '../types/lab'
import { toClabBridgeName } from '../utils/clabNaming'
import { ApiError, deployLab, type TopologyContent } from '../api/client'
import { useAuthStore } from '../store/authStore'
import './TopologyEditor.css'

// パレットの種別ごとに「R1」「SW1」「PC1」のような短い表示名を振るための接頭辞とカウンター
const SHORT_LABEL_PREFIX: Record<PaletteNodeKind, string> = { router: 'R', 'l2-switch': 'SW', pc: 'PC' }

const nodeTypes = { topoNode: TopologyNode }

function makeNodeData(kind: PaletteNodeKind, shortLabel: string): TopoNodeData {
  const config = PALETTE_NODE_CONFIGS[kind]
  return { kind, clabKind: config.clabKind, image: config.image, shortLabel }
}

const initialNodes: Node[] = [
  { id: 'r1', type: 'topoNode', position: { x: 0, y: 0 }, data: makeNodeData('router', 'R1') },
  { id: 'r2', type: 'topoNode', position: { x: 220, y: 0 }, data: makeNodeData('router', 'R2') },
  { id: 'r3', type: 'topoNode', position: { x: 110, y: 150 }, data: makeNodeData('router', 'R3') },
]

const initialEdges: Edge[] = [
  { id: 'r1-r2', source: 'r1', target: 'r2', sourceHandle: 'right', targetHandle: 'left' },
]

// 初期デモノードの分だけ、ドロップ時のカウンターを進めておく（R4から採番されるように）
const initialCounters: Record<PaletteNodeKind, number> = { router: 3, 'l2-switch': 0, pc: 0 }

// ノード間リンクのインターフェース名(eth1, eth2, ...)を、同じノードに何本目の
// リンクが繋がっているかで機械的に割り当てる。deploy時のtopologyContent組み立てと
// キャンバス上のラベル表示の両方で同じ結果になるよう、ロジックを1箇所にまとめている。
function assignInterfaces(edges: Edge[]): Map<string, { source: string; target: string }> {
  const counters = new Map<string, number>()
  const nextIface = (nodeId: string) => {
    const n = (counters.get(nodeId) ?? 0) + 1
    counters.set(nodeId, n)
    return `eth${n}`
  }
  const result = new Map<string, { source: string; target: string }>()
  for (const edge of edges) {
    result.set(edge.id, { source: nextIface(edge.source), target: nextIface(edge.target) })
  }
  return result
}

// React Flowのノード/エッジから、POST /api/v1/labs に渡す topologyContent を組み立てる。
// L2スイッチ(ovs-bridge kind)のノード名だけ、ホスト全体でのブリッジ名衝突を避けるため
// toClabBridgeName() で短いハッシュ名に変換する（2026-09-24改訂、docs/direction.md参照）。
function buildTopologyContent(nodes: Node[], edges: Edge[], username: string, labName: string): TopologyContent {
  const clabNodeNames = new Map<string, string>()
  const nodesMap: TopologyContent['topology']['nodes'] = {}

  for (const node of nodes) {
    const data = node.data as Partial<TopoNodeData>
    if (!data.kind || !data.clabKind) {
      throw new Error(`ノード「${node.id}」の種別情報が無く、deployできません（パレットから配置し直してください）`)
    }
    const clabName = data.kind === 'l2-switch' ? toClabBridgeName(username, labName, node.id) : node.id
    clabNodeNames.set(node.id, clabName)
    nodesMap[clabName] = data.image ? { kind: data.clabKind, image: data.image } : { kind: data.clabKind }
  }

  const ifaces = assignInterfaces(edges)
  const links = edges.map((edge) => {
    const sourceName = clabNodeNames.get(edge.source)
    const targetName = clabNodeNames.get(edge.target)
    const iface = ifaces.get(edge.id)
    if (!sourceName || !targetName || !iface) {
      throw new Error(`リンク「${edge.id}」の接続先ノードが見つかりません`)
    }
    return { endpoints: [`${sourceName}:${iface.source}`, `${targetName}:${iface.target}`] as [string, string] }
  })

  return { name: labName, topology: { nodes: nodesMap, links } }
}

type DeployStatus = { kind: 'idle' } | { kind: 'deploying' } | { kind: 'success'; message: string } | { kind: 'error'; message: string }
type ContextMenu = { x: number; y: number; nodeId: string } | null

function TopologyEditorInner() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const counters = useRef<Record<PaletteNodeKind, number>>({ ...initialCounters })
  const [nodes, setNodes] = useState<Node[]>(initialNodes)
  const [edges, setEdges] = useState<Edge[]>(initialEdges)
  const [labName, setLabName] = useState('')
  const [deployStatus, setDeployStatus] = useState<DeployStatus>({ kind: 'idle' })
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null)
  const { screenToFlowPosition } = useReactFlow()
  const username = useAuthStore((s) => s.username)

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    [],
  )
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    [],
  )
  const onConnect: OnConnect = useCallback(
    (connection) => setEdges((eds) => addEdge({ ...connection, type: 'straight' }, eds)),
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
      counters.current[kind] += 1
      const n = counters.current[kind]
      const id = `${kind}-${n}`
      const shortLabel = `${SHORT_LABEL_PREFIX[kind]}${n}`

      setNodes((nds) => nds.concat({ id, type: 'topoNode', position, data: makeNodeData(kind, shortLabel) }))
    },
    [screenToFlowPosition],
  )

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, nodeId: node.id })
  }, [])
  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId))
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
    setContextMenu(null)
  }, [])

  const renameNode = useCallback((nodeId: string) => {
    setContextMenu(null)
    setNodes((nds) => {
      const target = nds.find((n) => n.id === nodeId)
      const current = (target?.data as Partial<TopoNodeData> | undefined)?.shortLabel ?? ''
      const next = window.prompt('新しいノード名', current)
      if (!next || !next.trim()) return nds
      return nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, shortLabel: next.trim() } } : n))
    })
  }, [])

  // キャンバス表示用: どのeth番号同士が繋がっているかをエッジのラベルに出す
  const displayEdges = useMemo(() => {
    const ifaces = assignInterfaces(edges)
    return edges.map((edge) => {
      const iface = ifaces.get(edge.id)
      return {
        ...edge,
        type: edge.type ?? 'straight',
        label: iface ? `${iface.source}↔${iface.target}` : undefined,
        style: { stroke: 'var(--edge)', strokeWidth: 2 },
        labelStyle: { fill: 'var(--ink-soft)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--surface)' },
      }
    })
  }, [edges])

  const canDeploy = useMemo(
    () => labName.trim().length > 0 && nodes.length > 0 && deployStatus.kind !== 'deploying',
    [labName, nodes.length, deployStatus.kind],
  )

  const onDeploy = useCallback(async () => {
    if (!username) return
    setDeployStatus({ kind: 'deploying' })
    try {
      const topologyContent = buildTopologyContent(nodes, edges, username, labName.trim())
      await deployLab(topologyContent)
      setDeployStatus({ kind: 'success', message: `ラボ「${labName.trim()}」をdeployしました` })
    } catch (e) {
      const message = e instanceof ApiError || e instanceof Error ? e.message : 'deployに失敗しました'
      setDeployStatus({ kind: 'error', message })
    }
  }, [nodes, edges, username, labName])

  return (
    <div className="topology-editor">
      <NodePalette />
      <div className="topology-editor__main">
        <div className="topology-editor__toolbar">
          <input
            className="topology-editor__lab-name"
            placeholder="ラボ名"
            value={labName}
            onChange={(e) => setLabName(e.target.value)}
          />
          <button onClick={onDeploy} disabled={!canDeploy}>
            {deployStatus.kind === 'deploying' ? 'deploy中...' : 'Deploy'}
          </button>
          {deployStatus.kind === 'success' && <span className="topology-editor__status topology-editor__status--ok">{deployStatus.message}</span>}
          {deployStatus.kind === 'error' && <span className="topology-editor__status topology-editor__status--error">{deployStatus.message}</span>}
        </div>
        <div className="topology-editor__canvas" ref={canvasRef} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeContextMenu={onNodeContextMenu}
            onPaneClick={closeContextMenu}
            onMoveStart={closeContextMenu}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{ type: 'straight' }}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
          {contextMenu && (
            <div className="topology-editor__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <button onClick={() => renameNode(contextMenu.nodeId)}>名前を変更</button>
              <button onClick={() => deleteNode(contextMenu.nodeId)}>削除</button>
            </div>
          )}
        </div>
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
