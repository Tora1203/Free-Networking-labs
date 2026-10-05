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
import NodePalette, { DND_MIME_TYPE, LABEL_DND_VALUE, AREA_DND_VALUE } from './NodePalette'
import TopologyNode, { type TopoNodeData } from './TopologyNode'
import LabelNode, { type LabelNodeData } from './LabelNode'
import AreaNode, { type AreaNodeData } from './AreaNode'
import FloatingEdge, { type FloatingEdgeData } from './FloatingEdge'
import { PALETTE_NODE_CONFIGS, type PaletteNodeKind } from '../types/lab'
import { toClabBridgeName } from '../utils/clabNaming'
import { isSafeLabName, rememberLabDisplayName, toSafeLabName } from '../utils/labName'
import { ApiError, deployLab, type TopologyContent } from '../api/client'
import { useAuthStore } from '../store/authStore'
import { useConsoleStore } from '../store/consoleStore'
import { useUiStore } from '../store/uiStore'
import './TopologyEditor.css'

// パレットの種別ごとに「R1」「SW1」「PC1」のような短い表示名を振るための接頭辞とカウンター
const SHORT_LABEL_PREFIX: Record<PaletteNodeKind, string> = { router: 'R', 'l2-switch': 'SW', pc: 'PC' }

const nodeTypes = { topoNode: TopologyNode, labelNode: LabelNode, areaNode: AreaNode }
const edgeTypes = { floating: FloatingEdge }

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

// 以前はデモ用にr1/r2/r3のルーター3台を最初から置いていたが、既存の動いているラボの
// コンテナ名（例: `test`ラボの`r1`等）とたまたま一致することがあり、デモノードを
// 実際のラボのノードと誤解して右クリックしてしまう事故につながっていた（2026-10-05指摘）。
// トポロジエディタは「今deployしようとしている新規トポロジ」専用で、既存ラボを読み込む機能は
// まだ無いため、誤解を避けるため空のキャンバスから始めるようにした
const initialNodes: Node[] = []
const initialEdges: Edge[] = []
const initialCounters: Record<PaletteNodeKind, number> = { router: 0, 'l2-switch': 0, pc: 0 }

// ラベル・エリアのid採番。crypto.randomUUID()はセキュアコンテキスト（https/localhost）でしか
// 使えず、LANのIPに http:// でアクセスする運用（docs/api-contract.md参照）があるため使わない
function randomAnnotationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

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

  // ラベル（labelNode）はトポロジ上のメモに過ぎずcontainerlabのノードではないため除外する
  const deviceNodes = nodes.filter((n) => n.type === 'topoNode')

  for (const node of deviceNodes) {
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
  // 直近にdeployできたラボ名と、その時点でコンソールを開けるノード（l2-switch以外の
  // デバイスノード）のid集合。トポロジエディタからワンタッチでコンソールを開けるようにするため、
  // deploy成功時にここへ記録しておく（deploy前のノードやdeploy後に追加したノードは無効化する）
  const [deployedLab, setDeployedLab] = useState<{ labName: string; nodeIds: Set<string> } | null>(null)
  const { screenToFlowPosition } = useReactFlow()
  const username = useAuthStore((s) => s.username)
  const openConsole = useConsoleStore((s) => s.openConsole)
  // ConsolePane自体はApp.tsx側に1つだけマウントされている。ここで管理するのは
  // 「トポロジエディタの右側にドッキング表示するか」というフラグだけ（詳細はstore/uiStore.ts参照）
  const consolePanelDocked = useUiStore((s) => s.consolePanelDocked)
  const setConsolePanelDocked = useUiStore((s) => s.setConsolePanelDocked)

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
      if (connection.source === connection.target) return // 自己ループ接続は禁止
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
        type: 'floating',
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
      const dragged = event.dataTransfer.getData(DND_MIME_TYPE)
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })

      // ラベル（IPアドレス等のメモ）・エリア（グループ化の枠）はデバイスノードとは別扱い。
      // containerlabのノードではないためbuildTopologyContent側でも除外している
      if (dragged === LABEL_DND_VALUE) {
        setNodes((nds) => nds.concat({ id: randomAnnotationId('label'), type: 'labelNode', position, data: { text: '' } satisfies LabelNodeData }))
        return
      }
      if (dragged === AREA_DND_VALUE) {
        setNodes((nds) =>
          nds.concat({
            id: randomAnnotationId('area'),
            type: 'areaNode',
            position,
            // 常にデバイスノードの背面に表示されるようにする（前面に出て隠れてしまわないように）
            zIndex: -1,
            style: { width: 260, height: 180 },
            data: { text: '', colorIndex: 0 } satisfies AreaNodeData,
          }),
        )
        return
      }

      const kind = dragged as PaletteNodeKind
      const config = PALETTE_NODE_CONFIGS[kind]
      if (!config) return

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

  // トポロジエディタから直接、統合コンソールをワンタッチで開く（ラボ一覧に行かなくて済むように）。
  // deployedLabに載っているノード＝直近のdeployに含まれていたノードのみ開ける
  const openNodeConsole = useCallback(
    (nodeId: string) => {
      if (!deployedLab || !deployedLab.nodeIds.has(nodeId)) return
      // ルーターはCMLのように最初からvtyshを開いた状態にしておく
      const kind = (nodes.find((n) => n.id === nodeId)?.data as Partial<TopoNodeData> | undefined)?.kind
      openConsole(deployedLab.labName, nodeId, kind === 'router' ? 'vtysh' : undefined)
      setConsolePanelDocked(true)
      setContextMenu(null)
    },
    [deployedLab, nodes, openConsole, setConsolePanelDocked],
  )

  const renameNode = useCallback(
    (nodeId: string) => {
      setContextMenu(null)
      // window.prompt（副作用）は setState の更新関数の外で呼ぶこと。
      // 更新関数の中で呼ぶと、StrictModeが更新関数を2回実行する際にプロンプトも2回出てしまい、
      // 1回目の入力が握りつぶされる（2回目の確定でようやく反映される）不具合になっていた。
      const target = nodes.find((n) => n.id === nodeId)
      const current = (target?.data as Partial<TopoNodeData> | undefined)?.shortLabel ?? ''
      const next = window.prompt('新しいノード名', current)
      if (!next || !next.trim()) return
      setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, shortLabel: next.trim() } } : n)))
    },
    [nodes],
  )

  // キャンバス表示用: エッジのI/F情報をラベルとして出す。
  // 同じ2ノード間に複数リンク（LAGのような並列接続）がある場合、そのままだと
  // floating edgeの交点計算が全リンクで同じ座標になり1本しか見えなくなるため、
  // 同じノードペアごとに何番目・全部で何本かを数えてedge.dataに載せる
  // （実際に弧状にずらす計算はFloatingEdge.tsx側で行う）
  const displayEdges = useMemo(() => {
    const pairCounts = new Map<string, number>()
    for (const edge of edges) {
      const pairKey = [edge.source, edge.target].sort().join('|')
      pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1)
    }
    const pairSeen = new Map<string, number>()

    return edges.map((edge) => {
      const iface = edge.data as Partial<EdgeIfaceData> | undefined
      const pairKey = [edge.source, edge.target].sort().join('|')
      const parallelIndex = pairSeen.get(pairKey) ?? 0
      pairSeen.set(pairKey, parallelIndex + 1)
      const parallelCount = pairCounts.get(pairKey) ?? 1

      return {
        ...edge,
        type: edge.type ?? 'floating',
        label: iface?.sourceIface && iface.targetIface ? `${iface.sourceIface}↔${iface.targetIface}` : undefined,
        style: { stroke: 'var(--edge)', strokeWidth: 2 },
        labelStyle: { fill: 'var(--ink-soft)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--surface)' },
        data: { ...edge.data, parallelIndex, parallelCount } satisfies FloatingEdgeData,
      }
    })
  }, [edges])

  // ラベル（labelNode）はデバイスではないので、deployできるかどうかの判定からは除く
  const deviceNodeCount = useMemo(() => nodes.filter((n) => n.type === 'topoNode').length, [nodes])
  const canDeploy = useMemo(
    () => labName.trim().length > 0 && deviceNodeCount > 0 && deployStatus.kind !== 'deploying',
    [labName, deviceNodeCount, deployStatus.kind],
  )
  // 入力欄のラボ名が「直近deployしたラボ」と同じなら、今回のDeployは新規ではなく変更の反映になる
  const isRedeploy = useMemo(() => deployedLab?.labName === toSafeLabName(labName.trim()), [deployedLab, labName])

  const onDeploy = useCallback(async () => {
    if (!username) return
    setDeployStatus({ kind: 'deploying' })
    try {
      const displayName = labName.trim()
      // ラボ名は英数字・ハイフン・アンダースコアのみAPIが受け付ける（日本語等は拒否される、
      // 2026-09-28実機確認）。安全でない名前は決定的なハッシュ名に変換し、元の名前は
      // ラボ一覧での表示用にlocalStorageへ保存しておく（utils/labName.ts参照）。
      const safeName = toSafeLabName(displayName)
      const topologyContent = buildTopologyContent(nodes, edges, username, safeName)
      // 同じラボ名に対する2回目以降のdeployは「新規」ではなく「変更を反映」（reconfigure）として送る。
      // reconfigureを付けずに既存のラボ名へPOSTすると「既に存在する」エラーになり、
      // deploy後にトポロジを直せなくなってしまうため（2026-09-30指摘）
      await deployLab(topologyContent, { reconfigure: isRedeploy })
      rememberLabDisplayName(safeName, displayName)
      setDeployStatus({
        kind: 'success',
        message: isRedeploy ? `ラボ「${displayName}」の変更を反映しました` : `ラボ「${displayName}」をdeployしました`,
      })
      // l2-switchはコンテナを起動しないkindなのでコンソールの対象から除く
      const consoleNodeIds = new Set(
        nodes
          .filter((n) => n.type === 'topoNode' && (n.data as Partial<TopoNodeData>).kind !== 'l2-switch')
          .map((n) => n.id),
      )
      setDeployedLab({ labName: safeName, nodeIds: consoleNodeIds })
    } catch (e) {
      const message = e instanceof ApiError || e instanceof Error ? e.message : 'deployに失敗しました'
      setDeployStatus({ kind: 'error', message })
    }
  }, [nodes, edges, username, labName, isRedeploy])

  const nodeLabel = (id: string) => (nodes.find((n) => n.id === id)?.data as Partial<TopoNodeData> | undefined)?.shortLabel ?? id

  // コンテキストメニューの対象が注釈（ラベル/エリア）かデバイスかで出す項目を変える
  const contextMenuNode = contextMenu?.kind === 'node' ? nodes.find((n) => n.id === contextMenu.nodeId) : undefined
  const contextMenuIsAnnotation = contextMenuNode?.type === 'labelNode' || contextMenuNode?.type === 'areaNode'
  const contextMenuCanOpenConsole =
    contextMenu?.kind === 'node' && !contextMenuIsAnnotation && !!deployedLab?.nodeIds.has(contextMenu.nodeId)

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
          {labName.trim() && !isSafeLabName(labName.trim()) && (
            <span className="topology-editor__status" title="ラボ名は英数字・ハイフン・アンダースコアのみAPIが受け付けるため、実際には自動生成した名前でdeployされます">
              実際の名前: {toSafeLabName(labName)}
            </span>
          )}
          <button onClick={onDeploy} disabled={!canDeploy} title={isRedeploy ? '既にdeploy済みのラボに変更を反映します' : undefined}>
            {deployStatus.kind === 'deploying' ? (isRedeploy ? '反映中...' : 'deploy中...') : isRedeploy ? '変更を反映' : 'Deploy'}
          </button>
          {deployStatus.kind === 'success' && <span className="topology-editor__status topology-editor__status--ok">{deployStatus.message}</span>}
          {deployStatus.kind === 'error' && <span className="topology-editor__status topology-editor__status--error">{deployStatus.message}</span>}
          <div className="topology-editor__toolbar-spacer" />
          <button
            className="topology-editor__panel-toggle"
            onClick={() => setConsolePanelDocked(!consolePanelDocked)}
            title="トポロジを見ながら統合コンソールを操作できます"
          >
            🖥 コンソール{consolePanelDocked ? 'を隠す' : 'パネル'}
          </button>
        </div>
        <div className="topology-editor__canvas" ref={canvasRef} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={(c) => c.source !== c.target}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            onPaneClick={closeContextMenu}
            onMoveStart={closeContextMenu}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{ type: 'floating' }}
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
              {!contextMenuIsAnnotation && <button onClick={() => renameNode(contextMenu.nodeId)}>名前を変更</button>}
              {!contextMenuIsAnnotation && (
                <button
                  onClick={() => openNodeConsole(contextMenu.nodeId)}
                  disabled={!contextMenuCanOpenConsole}
                  title={contextMenuCanOpenConsole ? undefined : 'このノードはまだdeployされていません'}
                >
                  コンソールを開く
                </button>
              )}
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
