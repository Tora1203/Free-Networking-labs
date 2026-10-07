import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { toClabBridgeName, toClabPortName } from '../utils/clabNaming'
import { applyVlanConfig, ensureBridge, resetPort, type VlanConfig } from '../api/ovsHelperClient'
import { getLabDisplayName, isSafeLabName, rememberLabDisplayName, toSafeLabName } from '../utils/labName'
import { parseTopologyYaml } from '../utils/topologyFromYaml'
import { applyAnnotations, serializeAnnotations } from '../utils/annotations'
import {
  ApiError,
  deployLab,
  execInLab,
  getLabAnnotations,
  getLabTopologyYaml,
  putLabAnnotations,
  type TopologyContent,
} from '../api/client'
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
  // L2スイッチ側のポートにだけ意味がある（PC/ルーター側は常にundefined）。
  // VLAN設定自体はcontainerlabのトポロジYAMLには無く、deploy後にbackend/ovs-helper/
  // 経由でovs-vsctlを叩いて別途投入する（2026-10-06追加、docs/direction.md参照）
  sourceVlan?: VlanConfig
  targetVlan?: VlanConfig
  // PC/ルーター側にだけ意味がある（L2スイッチ側は常にundefined。スイッチはL2なのでIPは持たない）。
  // "10.0.0.1/24"形式のCIDR文字列。アドレス設定もトポロジYAMLには無く、deploy後に
  // clab-api-serverのexec経由で`ip addr add`して別途投入する（2026-10-07追加、
  // 「PCのアドレシングが面倒」指摘対応。docs/direction.md参照）
  sourceAddress?: string
  targetAddress?: string
  [key: string]: unknown
}

// VLANモードの選択肢。トランクは「全VLAN許可」と「指定VLANのみ許可」を分ける
// （2026-10-06指摘：最初はトランク＝常に指定リスト必須だったが、
// OVSの「tag/trunksどちらも設定しない＝全VLAN許可のトランク」という挙動に合わせて選べるようにした）
type VlanMode = 'none' | 'access' | 'trunk-all' | 'trunk-list'

// VLAN入力欄の文字列をVlanConfigに変換する。modeが'none'なら未設定として扱う
function parseVlanInput(mode: VlanMode, value: string): { config?: VlanConfig; error?: string } {
  if (mode === 'none') return {}
  const isValidVlanId = (n: number) => Number.isInteger(n) && n >= 1 && n <= 4094
  if (mode === 'access') {
    const n = Number(value)
    if (!isValidVlanId(n)) return { error: 'VLAN IDは1〜4094の整数で指定してください' }
    return { config: { mode: 'access', vlan: n } }
  }
  if (mode === 'trunk-all') return { config: { mode: 'trunk', vlans: 'all' } }
  const vlans = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
  if (vlans.length === 0 || vlans.some((n) => !isValidVlanId(n))) {
    return { error: 'VLAN IDはカンマ区切りで1〜4094の整数を指定してください（例: 10,20,30）' }
  }
  return { config: { mode: 'trunk', vlans } }
}

// IPv4アドレス入力欄の文字列を検証する。空文字は「未設定」として扱う（PC/ルーター側は
// 配線だけしてアドレスは後で、という使い方もできるようにするため必須にしない）
function parseIpv4Cidr(value: string): { address?: string; error?: string } {
  const trimmed = value.trim()
  if (trimmed === '') return {}
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(trimmed)
  if (!m) return { error: 'IPv4アドレスは「10.0.0.1/24」の形式で指定してください' }
  const octets = m.slice(1, 5).map(Number)
  const prefix = Number(m[5])
  if (octets.some((n) => n > 255) || prefix > 32) {
    return { error: 'IPv4アドレスは「10.0.0.1/24」の形式で指定してください' }
  }
  return { address: trimmed }
}

function makeNodeData(kind: PaletteNodeKind, shortLabel: string): TopoNodeData {
  const config = PALETTE_NODE_CONFIGS[kind]
  return { kind, clabKind: config.clabKind, image: config.image, shortLabel }
}

// 以前はデモ用にr1/r2/r3のルーター3台を最初から置いていたが、既存の動いているラボの
// コンテナ名（例: `test`ラボの`r1`等）とたまたま一致することがあり、デモノードを
// 実際のラボのノードと誤解して右クリックしてしまう事故につながっていた（2026-10-05指摘）。
// 今はホームから「新規作成」で入った時だけこの空の状態を使う（「エディタで開く」で入った時は
// 下のuseEffectで既存ラボのYAMLから復元するので、このinitialNodes/initialEdgesは使われない）
const initialNodes: Node[] = []
const initialEdges: Edge[] = []
const initialCounters: Record<PaletteNodeKind, number> = { router: 0, 'l2-switch': 0, pc: 0 }

// ラベル・エリアのid採番。crypto.randomUUID()はセキュアコンテキスト（https/localhost）でしか
// 使えず、LANのIPに http:// でアクセスする運用（docs/api-contract.md参照）があるため使わない
function randomAnnotationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// 新規作成モードでは、deployするためだけに毎回ラボ名を考えて入力する手間を省くため、
// YYYYMMDDHH形式の名前を自動で入れておく（そのまま使ってもいいし、書き換えてもよい）
// （2026-10-05指摘）
function defaultLabName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}`
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
interface VlanTask {
  port: string
  config: VlanConfig
}

interface AddressTask {
  nodeName: string
  iface: string
  address: string
}

function buildTopologyContent(
  nodes: Node[],
  edges: Edge[],
  username: string,
  labName: string,
): { topologyContent: TopologyContent; vlanTasks: VlanTask[]; switchPorts: string[]; addressTasks: AddressTask[] } {
  const clabNodeNames = new Map<string, string>()
  const nodeKinds = new Map<string, PaletteNodeKind>()
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
    nodeKinds.set(node.id, data.kind)
    nodesMap[clabName] = data.image ? { kind: data.clabKind, image: data.image } : { kind: data.clabKind }
  }

  const vlanTasks: VlanTask[] = []
  const switchPorts: string[] = []
  const addressTasks: AddressTask[] = []

  const links = edges.map((edge) => {
    const sourceName = clabNodeNames.get(edge.source)
    const targetName = clabNodeNames.get(edge.target)
    const iface = edge.data as Partial<EdgeIfaceData> | undefined
    if (!sourceName || !targetName || !iface?.sourceIface || !iface?.targetIface) {
      throw new Error(`リンク「${edge.id}」のインターフェース情報が見つかりません`)
    }

    // L2スイッチ側のポート名は、ブリッジ名と同じ理由（ホスト全体でグローバルな名前空間）で
    // ハッシュ化した実名を使う。UI上はeth1等の分かりやすい名前のまま見せる
    // （2026-10-06発見、docs/direction.md参照）。VLAN設定も同じ実名を使って後段で投入する
    const sourceIsSwitch = nodeKinds.get(edge.source) === 'l2-switch'
    const targetIsSwitch = nodeKinds.get(edge.target) === 'l2-switch'
    const sourcePort = sourceIsSwitch ? toClabPortName(username, labName, edge.source, iface.sourceIface) : iface.sourceIface
    const targetPort = targetIsSwitch ? toClabPortName(username, labName, edge.target, iface.targetIface) : iface.targetIface

    if (sourceIsSwitch) switchPorts.push(sourcePort)
    if (targetIsSwitch) switchPorts.push(targetPort)
    // trunkの「全VLAN許可」はovs-helperに送る必要がない（resetPort後のポートは
    // デフォルトで全VLAN許可のトランクになっているため、何もしなくてよい）
    const isAllTrunk = (v?: VlanConfig) => v?.mode === 'trunk' && v.vlans === 'all'
    if (iface.sourceVlan && !isAllTrunk(iface.sourceVlan)) vlanTasks.push({ port: sourcePort, config: iface.sourceVlan })
    if (iface.targetVlan && !isAllTrunk(iface.targetVlan)) vlanTasks.push({ port: targetPort, config: iface.targetVlan })

    // PC/ルーター側のIPv4アドレスは、L2スイッチと違ってコンテナを持つのでclab-api-serverの
    // execで直接`ip addr add`できる（ovs-helperを経由しない。2026-10-07追加）
    if (!sourceIsSwitch && iface.sourceAddress) {
      addressTasks.push({ nodeName: sourceName, iface: iface.sourceIface, address: iface.sourceAddress })
    }
    if (!targetIsSwitch && iface.targetAddress) {
      addressTasks.push({ nodeName: targetName, iface: iface.targetIface, address: iface.targetAddress })
    }

    return { endpoints: [`${sourceName}:${sourcePort}`, `${targetName}:${targetPort}`] as [string, string] }
  })

  return { topologyContent: { name: labName, topology: { nodes: nodesMap, links } }, vlanTasks, switchPorts, addressTasks }
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
  // 新規作成モードなら最初からYYYYMMDDHHの名前を入れておく（既存ラボを開く時はuseEffectで上書きする）
  const [labName, setLabName] = useState(() => (useUiStore.getState().editorTarget.mode === 'new' ? defaultLabName() : ''))
  const [deployStatus, setDeployStatus] = useState<DeployStatus>({ kind: 'idle' })
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null)
  const [pendingConnection, setPendingConnection] = useState<PendingConnection>(null)
  const [pendingSourceIface, setPendingSourceIface] = useState('')
  const [pendingTargetIface, setPendingTargetIface] = useState('')
  // L2スイッチ側のポートにだけ表示するVLAN設定の入力欄（2026-10-06追加）
  const [pendingSourceVlanMode, setPendingSourceVlanMode] = useState<VlanMode>('none')
  const [pendingSourceVlanValue, setPendingSourceVlanValue] = useState('')
  const [pendingTargetVlanMode, setPendingTargetVlanMode] = useState<VlanMode>('none')
  const [pendingTargetVlanValue, setPendingTargetVlanValue] = useState('')
  // PC/ルーター側にだけ表示するIPv4アドレスの入力欄（2026-10-07追加）
  const [pendingSourceAddress, setPendingSourceAddress] = useState('')
  const [pendingTargetAddress, setPendingTargetAddress] = useState('')
  // 直近にdeployできたラボ名と、その時点でコンソールを開けるノード（l2-switch以外の
  // デバイスノード）のid集合。トポロジエディタからワンタッチでコンソールを開けるようにするため、
  // deploy成功時にここへ記録しておく（deploy前のノードやdeploy後に追加したノードは無効化する）
  const [deployedLab, setDeployedLab] = useState<{ labName: string; nodeIds: Set<string> } | null>(null)
  // 既存ラボをエディタで開く時のYAML取得状態（ホームからの「エディタで開く」導線、2026-10-05追加）
  const [loadStatus, setLoadStatus] = useState<{ kind: 'idle' | 'loading' | 'error'; message?: string }>({ kind: 'idle' })
  const { screenToFlowPosition } = useReactFlow()
  const username = useAuthStore((s) => s.username)
  const openConsole = useConsoleStore((s) => s.openConsole)
  const closeAllConsoles = useConsoleStore((s) => s.closeAllConsoles)
  const editorTarget = useUiStore((s) => s.editorTarget)
  const setView = useUiStore((s) => s.setView)
  // ConsolePane自体はApp.tsx側に1つだけマウントされている。ここで管理するのは
  // 「トポロジエディタの右側にドッキング表示するか」というフラグだけ（詳細はstore/uiStore.ts参照）
  const consolePanelDocked = useUiStore((s) => s.consolePanelDocked)
  const setConsolePanelDocked = useUiStore((s) => s.setConsolePanelDocked)

  // ホームの「エディタで開く」から来た場合、デプロイ済みのトポロジYAMLを取得してキャンバスに復元する。
  // エディタはホームから「新規作成」/「既存ラボを開く」のどちらかでしか入れない専用画面で、
  // 入る度にTopologyEditorInnerが新たにマウントされるため、マウント時に一度だけ行えばよい
  // （2026-10-05決定、docs/direction.md参照）
  useEffect(() => {
    // エディタに入る度（新規作成/既存ラボを開くのどちらでも）、前にいたラボのコンソールタブは
    // もう無関係なので閉じる（2026-10-05指摘：ラボを切り替えても前のラボのコンソールが残っていた）。
    // ドッキングパネルの開閉状態も一旦リセットし、必要ならautoOpenConsoleNodeで開き直す
    closeAllConsoles()
    setConsolePanelDocked(false)

    if (editorTarget.mode !== 'edit') return
    const targetLabName = editorTarget.labName
    const autoOpenConsoleNode = editorTarget.autoOpenConsoleNode
    setLoadStatus({ kind: 'loading' })
    getLabTopologyYaml(targetLabName)
      .then(async (yamlText) => {
        const parsed = parseTopologyYaml(yamlText)
        // 座標・ラベル/エリアの保存データがあれば復元する。保存されていない（404）、
        // または想定外のフォーマットの場合は無視してグリッド配置のまま進める
        // （座標が無いことを理由にエディタが開けなくなることは避けたいため）
        let nodes = parsed.nodes
        try {
          const annotationsText = await getLabAnnotations(targetLabName)
          nodes = applyAnnotations(nodes, annotationsText)
        } catch {
          // 保存データが無い場合（404等）はそのまま
        }
        setNodes(nodes)
        setEdges(parsed.edges)
        counters.current = parsed.counters
        setLabName(getLabDisplayName(targetLabName))
        const consoleNodeIds = new Set(
          nodes
            .filter((n) => n.type === 'topoNode' && (n.data as Partial<TopoNodeData>).kind !== 'l2-switch')
            .map((n) => n.id),
        )
        setDeployedLab({ labName: targetLabName, nodeIds: consoleNodeIds })
        setLoadStatus({ kind: 'idle' })

        // ホームの🖥ボタンから来た場合、読み込み完了後にそのノードのコンソールを自動で開く
        if (autoOpenConsoleNode && consoleNodeIds.has(autoOpenConsoleNode)) {
          const targetNode = nodes.find((n) => n.id === autoOpenConsoleNode)
          const kind = (targetNode?.data as Partial<TopoNodeData> | undefined)?.kind
          openConsole(targetLabName, autoOpenConsoleNode, kind === 'router' ? 'vtysh' : undefined)
          setConsolePanelDocked(true)
        }
      })
      .catch((e: unknown) => {
        const message = e instanceof ApiError || e instanceof Error ? e.message : 'トポロジの取得に失敗しました'
        setLoadStatus({ kind: 'error', message })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- マウント時に一度だけ実行する（上のコメント参照）
  }, [])

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
      setPendingSourceVlanMode('none')
      setPendingSourceVlanValue('')
      setPendingTargetVlanMode('none')
      setPendingTargetVlanValue('')
      setPendingSourceAddress('')
      setPendingTargetAddress('')
    },
    [edges],
  )

  const sourceVlanResult = useMemo(
    () => parseVlanInput(pendingSourceVlanMode, pendingSourceVlanValue),
    [pendingSourceVlanMode, pendingSourceVlanValue],
  )
  const targetVlanResult = useMemo(
    () => parseVlanInput(pendingTargetVlanMode, pendingTargetVlanValue),
    [pendingTargetVlanMode, pendingTargetVlanValue],
  )
  const sourceAddressResult = useMemo(() => parseIpv4Cidr(pendingSourceAddress), [pendingSourceAddress])
  const targetAddressResult = useMemo(() => parseIpv4Cidr(pendingTargetAddress), [pendingTargetAddress])

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
        data: {
          sourceIface: pendingSourceIface,
          targetIface: pendingTargetIface,
          sourceVlan: sourceVlanResult.config,
          targetVlan: targetVlanResult.config,
          sourceAddress: sourceAddressResult.address,
          targetAddress: targetAddressResult.address,
        } satisfies EdgeIfaceData,
      }),
    )
    setPendingConnection(null)
  }, [
    pendingConnection,
    pendingSourceIface,
    pendingTargetIface,
    sourceVlanResult,
    targetVlanResult,
    sourceAddressResult,
    targetAddressResult,
  ])

  const cancelConnection = useCallback(() => setPendingConnection(null), [])

  const sourceIfaceConflict = pendingConnection
    ? usedInterfaces(pendingConnection.source, edges).has(pendingSourceIface)
    : false
  const targetIfaceConflict = pendingConnection
    ? usedInterfaces(pendingConnection.target, edges).has(pendingTargetIface)
    : false

  const nodeKind = (id: string) => (nodes.find((n) => n.id === id)?.data as Partial<TopoNodeData> | undefined)?.kind
  const sourceIsSwitch = pendingConnection ? nodeKind(pendingConnection.source) === 'l2-switch' : false
  const targetIsSwitch = pendingConnection ? nodeKind(pendingConnection.target) === 'l2-switch' : false

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

    const vlanLabel = (v?: VlanConfig) =>
      v ? (v.mode === 'access' ? `VLAN${v.vlan}` : `trunk(${v.vlans === 'all' ? 'all' : v.vlans.join(',')})`) : ''

    return edges.map((edge) => {
      const iface = edge.data as Partial<EdgeIfaceData> | undefined
      const pairKey = [edge.source, edge.target].sort().join('|')
      const parallelIndex = pairSeen.get(pairKey) ?? 0
      pairSeen.set(pairKey, parallelIndex + 1)
      const parallelCount = pairCounts.get(pairKey) ?? 1
      const sourceVlanLabel = vlanLabel(iface?.sourceVlan) || iface?.sourceAddress || ''
      const targetVlanLabel = vlanLabel(iface?.targetVlan) || iface?.targetAddress || ''
      const vlanSuffix = sourceVlanLabel || targetVlanLabel ? ` [${[sourceVlanLabel, targetVlanLabel].filter(Boolean).join('/')}]` : ''

      return {
        ...edge,
        type: edge.type ?? 'floating',
        label: iface?.sourceIface && iface.targetIface ? `${iface.sourceIface}↔${iface.targetIface}${vlanSuffix}` : undefined,
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
      const { topologyContent, vlanTasks, switchPorts, addressTasks } = buildTopologyContent(nodes, edges, username, safeName)

      // containerlabはovs-bridge kindのブリッジを自動生成しないため、deploy前に
      // 自分でovs-vsctl add-brしておく必要がある（2026-10-06実機確認：
      // 「bridge "..." referenced in topology but does not exist」で失敗することが判明）。
      // 既に存在していてもエラーにならないので、reconfigure時も毎回呼んで問題ない
      const bridgeNames = nodes
        .filter((n) => n.type === 'topoNode' && (n.data as Partial<TopoNodeData>).kind === 'l2-switch')
        .map((n) => toClabBridgeName(username, safeName, n.id))
      await Promise.all(bridgeNames.map((bridge) => ensureBridge(bridge)))

      // ポート名は(username,labName,switchNodeId,iface)から決定的に決まるため、再deployすると
      // 必ず同じ名前になる。前回のdeployで作られたOVS側のインターフェースが残っていると、
      // containerlabが「already exists」で失敗する（2026-10-06実機確認）ため、
      // deploy前に一度消してから作り直させる（存在しなければ何もしない）
      await Promise.all(switchPorts.map((port) => resetPort(port)))

      // 同じラボ名に対する2回目以降のdeployは「新規」ではなく「変更を反映」（reconfigure）として送る。
      // reconfigureを付けずに既存のラボ名へPOSTすると「既に存在する」エラーになり、
      // deploy後にトポロジを直せなくなってしまうため（2026-09-30指摘）
      await deployLab(topologyContent, { reconfigure: isRedeploy })
      rememberLabDisplayName(safeName, displayName)

      // VLAN設定（アクセス/トランク）はcontainerlabのトポロジYAMLには無いため、
      // deploy成功後にbackend/ovs-helper/経由でovs-vsctlを実行して別途投入する
      // （2026-10-06追加）。1件でも失敗したら成功メッセージにその旨を添える
      const vlanFailures: string[] = []
      for (const task of vlanTasks) {
        try {
          await applyVlanConfig(safeName, task.port, task.config)
        } catch (e) {
          vlanFailures.push(e instanceof ApiError || e instanceof Error ? e.message : 'VLAN設定に失敗しました')
        }
      }

      // PC/ルーターのIPv4アドレスもトポロジYAMLには無いため、deploy成功後にclab-api-serverの
      // execで`ip addr add`して別途投入する（2026-10-07追加。「PCのアドレシングが面倒」指摘対応）
      const addressFailures: string[] = []
      for (const task of addressTasks) {
        try {
          const result = await execInLab(safeName, task.nodeName, `ip addr add ${task.address} dev ${task.iface}`)
          const [firstResult] = Object.values(result).flat()
          if (firstResult && firstResult['return-code'] !== 0) {
            addressFailures.push(`${task.nodeName}:${task.iface} ${firstResult.stderr.trim() || 'アドレス設定に失敗しました'}`)
          }
        } catch (e) {
          const message = e instanceof ApiError || e instanceof Error ? e.message : 'アドレス設定に失敗しました'
          addressFailures.push(`${task.nodeName}:${task.iface} ${message}`)
        }
      }

      const failureSuffixes = [
        vlanFailures.length > 0 ? `VLAN設定に失敗: ${vlanFailures.join(' / ')}` : '',
        addressFailures.length > 0 ? `アドレス設定に失敗: ${addressFailures.join(' / ')}` : '',
      ].filter(Boolean)

      setDeployStatus({
        kind: 'success',
        message:
          (isRedeploy ? `ラボ「${displayName}」の変更を反映しました` : `ラボ「${displayName}」をdeployしました`) +
          (failureSuffixes.length > 0 ? `（ただし${failureSuffixes.join(' / ')}）` : ''),
      })
      // l2-switchはコンテナを起動しないkindなのでコンソールの対象から除く
      const consoleNodeIds = new Set(
        nodes
          .filter((n) => n.type === 'topoNode' && (n.data as Partial<TopoNodeData>).kind !== 'l2-switch')
          .map((n) => n.id),
      )
      setDeployedLab({ labName: safeName, nodeIds: consoleNodeIds })
      // ノード座標・ラベル/エリアを保存しておく（次回「エディタで開く」時に復元するため）。
      // 失敗してもdeploy自体は成功しているので、ここはログに残すだけで握りつぶす
      putLabAnnotations(safeName, serializeAnnotations(nodes)).catch((err: unknown) => {
        console.warn('ノード配置の保存に失敗しました', err)
      })
    } catch (e) {
      const message = e instanceof ApiError || e instanceof Error ? e.message : 'deployに失敗しました'
      setDeployStatus({ kind: 'error', message })
    }
  }, [nodes, edges, username, labName, isRedeploy])

  const nodeLabel = (id: string) => (nodes.find((n) => n.id === id)?.data as Partial<TopoNodeData> | undefined)?.shortLabel ?? id

  // コンテキストメニューの対象が注釈（ラベル/エリア）かデバイスかで出す項目を変える
  const contextMenuNode = contextMenu?.kind === 'node' ? nodes.find((n) => n.id === contextMenu.nodeId) : undefined
  const contextMenuIsAnnotation = contextMenuNode?.type === 'labelNode' || contextMenuNode?.type === 'areaNode'
  // L2スイッチ（ovs-bridge kind）はコンテナを持たないためそもそもコンソールが無い（2026-10-07指摘）
  const contextMenuIsSwitch = (contextMenuNode?.data as Partial<TopoNodeData> | undefined)?.kind === 'l2-switch'
  const contextMenuCanOpenConsole =
    contextMenu?.kind === 'node' &&
    !contextMenuIsAnnotation &&
    !contextMenuIsSwitch &&
    !!deployedLab?.nodeIds.has(contextMenu.nodeId)

  return (
    <div className="topology-editor">
      <NodePalette />
      <div className="topology-editor__main">
        <div className="topology-editor__toolbar">
          <button className="topology-editor__back" onClick={() => setView('home')} title="ホームに戻る">
            ← ホーム
          </button>
          <input
            className="topology-editor__lab-name"
            placeholder="ラボ名"
            value={labName}
            onChange={(e) => setLabName(e.target.value)}
            disabled={loadStatus.kind === 'loading'}
          />
          {loadStatus.kind === 'loading' && <span className="topology-editor__status">トポロジを読み込み中...</span>}
          {loadStatus.kind === 'error' && <span className="topology-editor__status topology-editor__status--error">{loadStatus.message}</span>}
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
              {!contextMenuIsAnnotation && !contextMenuIsSwitch && (
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
                  {sourceIsSwitch && (
                    <div className="topology-editor__modal-vlan">
                      <select value={pendingSourceVlanMode} onChange={(e) => setPendingSourceVlanMode(e.target.value as VlanMode)}>
                        <option value="none">VLAN未設定</option>
                        <option value="access">アクセス</option>
                        <option value="trunk-all">トランク（全VLAN許可）</option>
                        <option value="trunk-list">トランク（指定VLANのみ許可）</option>
                      </select>
                      {pendingSourceVlanMode === 'access' || pendingSourceVlanMode === 'trunk-list' ? (
                        <input
                          value={pendingSourceVlanValue}
                          onChange={(e) => setPendingSourceVlanValue(e.target.value)}
                          placeholder={pendingSourceVlanMode === 'access' ? 'VLAN ID（例: 10）' : 'VLAN ID（例: 10,20,30）'}
                        />
                      ) : null}
                      {sourceVlanResult.error && <span className="topology-editor__modal-warn">{sourceVlanResult.error}</span>}
                    </div>
                  )}
                  {!sourceIsSwitch && (
                    <div className="topology-editor__modal-vlan">
                      <input
                        value={pendingSourceAddress}
                        onChange={(e) => setPendingSourceAddress(e.target.value)}
                        placeholder="IPv4アドレス（任意、例: 10.0.0.1/24）"
                      />
                      {sourceAddressResult.error && <span className="topology-editor__modal-warn">{sourceAddressResult.error}</span>}
                    </div>
                  )}
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
                  {targetIsSwitch && (
                    <div className="topology-editor__modal-vlan">
                      <select value={pendingTargetVlanMode} onChange={(e) => setPendingTargetVlanMode(e.target.value as VlanMode)}>
                        <option value="none">VLAN未設定</option>
                        <option value="access">アクセス</option>
                        <option value="trunk-all">トランク（全VLAN許可）</option>
                        <option value="trunk-list">トランク（指定VLANのみ許可）</option>
                      </select>
                      {pendingTargetVlanMode === 'access' || pendingTargetVlanMode === 'trunk-list' ? (
                        <input
                          value={pendingTargetVlanValue}
                          onChange={(e) => setPendingTargetVlanValue(e.target.value)}
                          placeholder={pendingTargetVlanMode === 'access' ? 'VLAN ID（例: 10）' : 'VLAN ID（例: 10,20,30）'}
                        />
                      ) : null}
                      {targetVlanResult.error && <span className="topology-editor__modal-warn">{targetVlanResult.error}</span>}
                    </div>
                  )}
                  {!targetIsSwitch && (
                    <div className="topology-editor__modal-vlan">
                      <input
                        value={pendingTargetAddress}
                        onChange={(e) => setPendingTargetAddress(e.target.value)}
                        placeholder="IPv4アドレス（任意、例: 10.0.0.2/24）"
                      />
                      {targetAddressResult.error && <span className="topology-editor__modal-warn">{targetAddressResult.error}</span>}
                    </div>
                  )}
                </div>
                <div className="topology-editor__modal-actions">
                  <button onClick={cancelConnection}>キャンセル</button>
                  <button
                    onClick={confirmConnection}
                    disabled={
                      sourceIfaceConflict ||
                      targetIfaceConflict ||
                      (pendingSourceVlanMode !== 'none' && !sourceVlanResult.config) ||
                      (pendingTargetVlanMode !== 'none' && !targetVlanResult.config) ||
                      !!sourceAddressResult.error ||
                      !!targetAddressResult.error
                    }
                  >
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
