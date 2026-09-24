import { useCallback, useMemo, useRef, useState } from 'react'
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
import { toClabBridgeName } from '../utils/clabNaming'
import { ApiError, deployLab, type TopologyContent } from '../api/client'
import { useAuthStore } from '../store/authStore'
import './TopologyEditor.css'

const routerConfig = PALETTE_NODE_CONFIGS.router

const initialNodes: Node[] = [
  {
    id: 'r1',
    position: { x: 0, y: 0 },
    data: { label: 'router1 (FRR)', kind: routerConfig.kind, clabKind: routerConfig.clabKind, image: routerConfig.image },
  },
  {
    id: 'r2',
    position: { x: 250, y: 0 },
    data: { label: 'router2 (FRR)', kind: routerConfig.kind, clabKind: routerConfig.clabKind, image: routerConfig.image },
  },
  {
    id: 'r3',
    position: { x: 125, y: 150 },
    data: { label: 'router3 (FRR)', kind: routerConfig.kind, clabKind: routerConfig.clabKind, image: routerConfig.image },
  },
]

const initialEdges: Edge[] = [{ id: 'r1-r2', source: 'r1', target: 'r2' }]

// React Flow のノード/エッジから、POST /api/v1/labs に渡す topologyContent を組み立てる。
// L2スイッチ(ovs-bridge kind)のノード名だけ、ホスト全体でのブリッジ名衝突を避けるため
// toClabBridgeName() で <username>_<labname>_<ノード名> に変換する（2026-09-16決定、docs/direction.md参照）。
//
// 既知の制約: インターフェース名(eth1, eth2, ...)はノードごとの連番で割り当てているだけで、
// 複数のL2スイッチノードを1トポロジに置いた場合や、他ユーザーのラボと同時deployした場合の
// ホスト全体でのインターフェース名衝突（M2で発見した制約の延長）は未対応。今のところ検証は
// 「1トポロジにL2スイッチ1台まで」の範囲で行っている。
function buildTopologyContent(nodes: Node[], edges: Edge[], username: string, labName: string): TopologyContent {
  const clabNodeNames = new Map<string, string>()
  const nodesMap: TopologyContent['topology']['nodes'] = {}

  for (const node of nodes) {
    const kind = node.data.kind as PaletteNodeKind | undefined
    const clabKind = node.data.clabKind as string | undefined
    if (!kind || !clabKind) {
      throw new Error(`ノード「${node.id}」の種別情報が無く、deployできません（パレットから配置し直してください）`)
    }
    const clabName = kind === 'l2-switch' ? toClabBridgeName(username, labName, node.id) : node.id
    clabNodeNames.set(node.id, clabName)

    const image = node.data.image as string | undefined
    nodesMap[clabName] = image ? { kind: clabKind, image } : { kind: clabKind }
  }

  const ifaceCounters = new Map<string, number>()
  const nextIface = (nodeId: string) => {
    const n = (ifaceCounters.get(nodeId) ?? 0) + 1
    ifaceCounters.set(nodeId, n)
    return `eth${n}`
  }

  const links = edges.map((edge) => {
    const sourceName = clabNodeNames.get(edge.source)
    const targetName = clabNodeNames.get(edge.target)
    if (!sourceName || !targetName) {
      throw new Error(`リンク「${edge.id}」の接続先ノードが見つかりません`)
    }
    return {
      endpoints: [`${sourceName}:${nextIface(edge.source)}`, `${targetName}:${nextIface(edge.target)}`] as [string, string],
    }
  })

  return { name: labName, topology: { nodes: nodesMap, links } }
}

type DeployStatus = { kind: 'idle' } | { kind: 'deploying' } | { kind: 'success'; message: string } | { kind: 'error'; message: string }

function TopologyEditorInner() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const nodeIdCounter = useRef(0)
  const [nodes, setNodes] = useState<Node[]>(initialNodes)
  const [edges, setEdges] = useState<Edge[]>(initialEdges)
  const [labName, setLabName] = useState('')
  const [deployStatus, setDeployStatus] = useState<DeployStatus>({ kind: 'idle' })
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
          data: {
            label: `${config.label} (${id})`,
            kind: config.kind,
            clabKind: config.clabKind,
            image: config.image,
          },
        }),
      )
    },
    [screenToFlowPosition],
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
