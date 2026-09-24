import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
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

// リンクの両端に割り当てるインターフェース名。エッジの `data` にノードごとの
// 実際のインターフェース名を保持する（CMLのようにユーザーが接続時に選べるようにするため、
// 配列の並び順から機械的に決めるのではなく、エッジ自身のデータとして持たせる）。
interface EdgeIfaceData {
  sourceIface: string
  targetIface: string
  [key: string]: unknown
}

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
  {
    id: 'r1-r2',
    source: 'r1',
    target: 'r2',
    sourceHandle: 'right',
    targetHandle: 'left',
    type: 'straight',
    data: { sourceIface: 'eth1', targetIface: 'eth1' } satisfies EdgeIfaceData,
  },
]

// 初期デモノードの分だけ、ドロップ時のカウンターを進めておく（R4から採番されるように）
const initialCounters: Record<PaletteNodeKind, number> = { router: 3, 'l2-switch': 0, pc: 0 }

const IFACE_OPTIONS = Array.from({ length: 8 }, (_, i) => `eth${i + 1}`)

function usedInterfaces(nodeId: string, edges: Edge[]): Set<string> {
  const used = new Set<string>()
  for (const e of edges) {
    const data = e.data as Partial<EdgeIfaceData> | undefined
    if (e.source === nodeId && data?.sourceIface) used.add(data.sourceIface)
    if (e.target === nodeId && data?.targetIface) used.add(data.targetIface)
  }
  return used
}

function nextAvailableIface(nodeId: string, edges: Edge[]): string {
  const used = usedInterfaces(nodeId, edges)
  return IFACE_OPTIONS.find((iface) => !used.has(iface)) ?? `eth${used.size + 1}`
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

  const links = edges.map((edge) => {
    const sourceName = clabNodeNames.get(edge.source)
    const targetName = clabNodeNames.get(edge.target)
    const iface = edge.data as Partial<EdgeIfaceData> | undefined
    if (!sourceName || !targetName || !iface?.sourceIface || !iface?.targetIface) {
      throw new Error(`リンク「${edge.id}」のインターフェース情報が見つかりません`)
    }
    return { endpoints: [`${sourceName}:${iface.sourceIface}`, `${targetName}:${iface.targetIface}`] as [string, string] }
  })

  return { name: labName, topology: { nodes: nodesMap, links } }
}

type DeployStatus = { kind: 'idle' } | { kind: 'deploying' } | { kind: 'success'; message: string } | { kind: 'error'; message: string }
type ContextMenu =
  | { x: number; y: number; kind: 'node'; nodeId: string }
  | { x: number; y: number; kind: 'edge'; edgeId: string }
  | null
type PendingConnection = { source: string; target: string; sourceHandle: string | null; targetHandle: string | null } | null

function TopologyEditorInner() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const counters = useRef<Record<PaletteNodeKind, number>>({ ...initialCounters })
  const [nodes, setNodes] = useState<Node[]>(initialNodes)
  const [edges, setEdges] = useState<Edge[]>(initialEdges)
  const [labName, setLabName] = useState('')
  const [deployStatus, setDeployStatus] = useState<DeployStatus>({ kind: 'idle' })
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null)
  const [pendingConnection, setPendingConnection] = useState<PendingConnection>(null)
  const [pendingSourceIface, setPendingSourceIface] = useState('')
  const [pendingTargetIface, setPendingTargetIface] = useState('')
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

  // ノード同士を繋いだら即座に確定させず、CMLのように「どのI/Fを使うか」を選ぶポップアップを出す
  const onConnect: OnConnect = useCallback(
    (connection) => {
      if (!connection.source || !connection.target) return
      setPendingConnection({
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle,
        targetHandle: connection.targetHandle,
      })
      setPendingSourceIface(nextAvailableIface(connection.source, edges))
      setPendingTargetIface(nextAvailableIface(connection.target, edges))
    },
    [edges],
  )

  const confirmConnection = useCallback(() => {
    if (!pendingConnection) return
    const { source, target, sourceHandle, targetHandle } = pendingConnection
    const id = `${source}:${pendingSourceIface}-${target}:${pendingTargetIface}`
    setEdges((eds) =>
      eds.concat({
        id,
        source,
        target,
        sourceHandle: sourceHandle ?? undefined,
        targetHandle: targetHandle ?? undefined,
        type: 'straight',
        data: { sourceIface: pendingSourceIface, targetIface: pendingTargetIface } satisfies EdgeIfaceData,
      }),
    )
    setPendingConnection(null)
  }, [pendingConnection, pendingSourceIface, pendingTargetIface])

  const cancelConnection = useCallback(() => setPendingConnection(null), [])

  const sourceIfaceConflict = pendingConnection
    ? usedInterfaces(pendingConnection.source, edges).has(pendingSourceIface)
    : false
  const targetIfaceConflict = pendingConnection
    ? usedInterfaces(pendingConnection.target, edges).has(pendingTargetIface)
    : false

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
    setContextMenu({ x: event.clientX, y: event.clientY, kind: 'node', nodeId: node.id })
  }, [])
  const onEdgeContextMenu = useCallback((event: React.MouseEvent, edge: Edge) => {
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, kind: 'edge', edgeId: edge.id })
  }, [])
  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId))
    setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
    setContextMenu(null)
  }, [])

  const disconnectEdge = useCallback((edgeId: string) => {
    setEdges((eds) => eds.filter((e) => e.id !== edgeId))
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

  // キャンバス表示用: エッジのI/F情報をラベルとして出す
  const displayEdges = useMemo(
    () =>
      edges.map((edge) => {
        const iface = edge.data as Partial<EdgeIfaceData> | undefined
        return {
          ...edge,
          type: edge.type ?? 'straight',
          label: iface?.sourceIface && iface.targetIface ? `${iface.sourceIface}↔${iface.targetIface}` : undefined,
          style: { stroke: 'var(--edge)', strokeWidth: 2 },
          labelStyle: { fill: 'var(--ink-soft)', fontSize: 10 },
          labelBgStyle: { fill: 'var(--surface)' },
        }
      }),
    [edges],
  )

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

  const nodeLabel = (id: string) => (nodes.find((n) => n.id === id)?.data as Partial<TopoNodeData> | undefined)?.shortLabel ?? id

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
            onEdgeContextMenu={onEdgeContextMenu}
            onPaneClick={closeContextMenu}
            onMoveStart={closeContextMenu}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{ type: 'straight' }}
            minZoom={0.4}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>

          {contextMenu?.kind === 'node' && (
            <div className="topology-editor__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <button onClick={() => renameNode(contextMenu.nodeId)}>名前を変更</button>
              <button onClick={() => deleteNode(contextMenu.nodeId)}>削除</button>
            </div>
          )}
          {contextMenu?.kind === 'edge' && (
            <div className="topology-editor__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <button onClick={() => disconnectEdge(contextMenu.edgeId)}>接続を解除</button>
            </div>
          )}

          {pendingConnection && (
            <div className="topology-editor__modal-overlay" onClick={cancelConnection}>
              <div className="topology-editor__modal" onClick={(e) => e.stopPropagation()}>
                <h3>接続するインターフェースを選択</h3>
                <div className="topology-editor__modal-row">
                  <label>
                    {nodeLabel(pendingConnection.source)} 側
                    <select value={pendingSourceIface} onChange={(e) => setPendingSourceIface(e.target.value)}>
                      {IFACE_OPTIONS.map((iface) => (
                        <option key={iface} value={iface}>
                          {iface}
                        </option>
                      ))}
                    </select>
                  </label>
                  {sourceIfaceConflict && <span className="topology-editor__modal-warn">既に使用中のI/Fです</span>}
                </div>
                <div className="topology-editor__modal-row">
                  <label>
                    {nodeLabel(pendingConnection.target)} 側
                    <select value={pendingTargetIface} onChange={(e) => setPendingTargetIface(e.target.value)}>
                      {IFACE_OPTIONS.map((iface) => (
                        <option key={iface} value={iface}>
                          {iface}
                        </option>
                      ))}
                    </select>
                  </label>
                  {targetIfaceConflict && <span className="topology-editor__modal-warn">既に使用中のI/Fです</span>}
                </div>
                <div className="topology-editor__modal-actions">
                  <button onClick={cancelConnection}>キャンセル</button>
                  <button onClick={confirmConnection} disabled={sourceIfaceConflict || targetIfaceConflict}>
                    接続
                  </button>
                </div>
              </div>
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
