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
import { PALETTE_NODE_CONFIGS, isSwitchKind, type PaletteNodeKind } from '../types/lab'
import { startPacketCapture } from '../api/captureClient'
import { getLabDisplayName, isSafeLabName, labTitleKey, rememberLabDisplayName, toSafeLabName } from '../utils/labName'
import { readLabTitle, serializeAnnotations } from '../utils/annotations'
import { fetchRemoteState, type RemoteState } from '../utils/remoteSync'
import { mergeTopology } from '../utils/topologyMerge'
import ShareButton from './ShareButton'
import { getLabVersion, watchLab, type VersionEvent } from '../api/collabClient'
import {
  buildNodeSyncCommands,
  hasSwitchWithoutConfigBind,
  buildTopologyContent,
  hasContainer,
  parseImportedTopology,
  topologyToYaml,
  type EdgeIfaceData,
} from '../utils/labTopology'
import { describeHistoryChange } from '../utils/historyDiff'
import { conditionSummary, normalizeCondition, type LinkCondition } from '../utils/linkCondition'
import LinkConditionDialog from './LinkConditionDialog'
import SnapshotDialog from './SnapshotDialog'
import { NodeRuntimeContext, type NodeRunStatus } from './nodeRuntimeContext'
import {
  applyLinkConditions,
  createLabFromSnapshot,
  createLabSnapshot,
  errorMessage,
  listLabNames,
  loadLabSnapshot,
  restoreNodeConfigs,
  freshNodesOf,
  newLinkRuntimeState,
  prepareNodeConfigs,
  readLinkRuntimeState,
  runNodeSyncs,
  startLabNode,
  stopLabNode,
  wipeLabNode,
  type SnapshotEntry,
} from '../utils/labRuntime'
import {
  ApiError,
  applyLab,
  destroyLab,
  getLabAnnotations,
  getLabs,
  getLabTopologyYaml,
  putLabAnnotations,
  putLabTopologyYaml,
  stopLab,
  type CaptureTarget,
  getShareRoute,
} from '../api/client'
import { useConsoleStore } from '../store/consoleStore'
import { useUiStore } from '../store/uiStore'
import { useAuthStore } from '../store/authStore'
import './TopologyEditor.css'

// パレットの種別ごとに「R1」「SW1」「PC1」のような短い表示名を振るための接頭辞とカウンター
const SHORT_LABEL_PREFIX: Record<PaletteNodeKind, string> = { router: 'R', 'l2-switch': 'SW', 'l3-switch': 'L3SW', pc: 'PC' }

const nodeTypes = { topoNode: TopologyNode, labelNode: LabelNode, areaNode: AreaNode }
const edgeTypes = { floating: FloatingEdge }

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


// デフォルトゲートウェイ入力欄の検証。プレフィックス無しの単純なIPv4アドレスのみ
// （2026-10-07追加。「ラボ内の宛先が自動的に外部に飛んでしまう」指摘対応：
// containerlabはmgmt用のeth0に`default via <docker bridge gw>`を自動設定するため、
// ラボ内で意図していない宛先向けの経路が無いと、そのままeth0経由で実際の外部ネットワークに
// 出てしまうことが実機で確認された。デフォルトゲートウェイを明示設定できるようにし、
// 併せてeth0の自動デフォルトルートはdeploy後に削除する）
function parseIpv4Gateway(value: string): { gateway?: string; error?: string } {
  const trimmed = value.trim()
  if (trimmed === '') return {}
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed)
  if (!m || m.slice(1, 5).map(Number).some((n) => n > 255)) {
    return { error: 'ゲートウェイは「10.0.0.254」のようなIPv4アドレスで指定してください' }
  }
  return { gateway: trimmed }
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
const initialCounters: Record<PaletteNodeKind, number> = { router: 0, 'l2-switch': 0, 'l3-switch': 0, pc: 0 }

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

// ルーターのコンソールで最初に自動実行するコマンド。単に`vtysh`を1回打つだけだと、
// vtyshのトップレベルで`exit`/`quit`やCtrl-Dを入力すると裏のコンテナのLinuxシェルに
// 落ちてしまい、ルーターの抽象化を破って任意のシェル操作ができてしまう（2026-10-07指摘、
// 脆弱性として報告）。clab-api-serverのterminal-sessions APIにはshell以外の起動コマンドを
// 指定する手段が無いため（protocolはssh/shell/telnetのみ）、サーバー側では止められない。
// 代わりに「vtyshが終了したら即座に再起動するループ」をシェルに打ち込むことで、
// 生シェルのプロンプトが実質出てこないようにする（実機確認済み：exit直後にvtyshが
// 再起動し、シェルコマンドはvtyshに「Unknown command」として拒否される）
const ROUTER_CONSOLE_AUTO_COMMAND = 'while true; do vtysh; done'
// L2スイッチも同じ仕組みでCisco風CLI（backend/l2switch/swcli.py）だけを使わせる（2026-10-14）
const SWITCH_CONSOLE_AUTO_COMMAND = 'while true; do swcli; done'

function consoleAutoCommand(kind: PaletteNodeKind | undefined): string | undefined {
  if (kind === 'router') return ROUTER_CONSOLE_AUTO_COMMAND
  if (isSwitchKind(kind)) return SWITCH_CONSOLE_AUTO_COMMAND
  return undefined
}

// excludeEdgeIdは「このエッジ自身の既存のI/F割り当て」を使用中として数えないために使う
// （既存接続を編集する時、自分自身のI/Fを「既に使用中」と誤検知してしまうのを防ぐ、2026-10-07追加）
function usedInterfaces(nodeId: string, edges: Edge[], excludeEdgeId?: string): Set<string> {
  const used = new Set<string>()
  for (const e of edges) {
    if (e.id === excludeEdgeId) continue
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

// 文字列をブラウザでファイルとしてダウンロードさせる（2026-10-08追加、YAML export機能）
function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const OLD_FORMAT_MESSAGE =
  '古い形式のラボのため、編集は保存のみで反映されません。「作り直す」で今の形式にできます（write memoryしていないルーター設定と、スイッチの設定は消えます）'

// 今のパレット定義と違う古い形式のノードか（ovs-bridge/CLI無しのスイッチ、エージェント無しのルーター）
function needsUpgrade(node: Node): boolean {
  if (node.type !== 'topoNode') return false
  const data = node.data as Partial<TopoNodeData>
  if (isSwitchKind(data.kind)) return data.image !== PALETTE_NODE_CONFIGS[data.kind].image
  if (data.kind === 'router') return data.image !== PALETTE_NODE_CONFIGS.router.image
  return false
}

// 一部のノードだけ止めている時は「起動中（3/4）」のように数を添える
function runningSummary(state: LabRunState): string {
  const states = Object.values(state.nodeStates)
  const running = states.filter((s) => s === 'running').length
  return running < states.length ? `（${running}/${states.length}）` : ''
}

function runStateTitle(state: LabRunState): string {
  const entries = Object.entries(state.nodeStates)
  if (entries.length === 0) return 'まだ一度も起動していません'
  return entries.map(([id, s]) => `${id}: ${s === 'running' ? '起動中' : '停止中'}`).join('\n')
}

function runningNodesOf(nodeStates: Record<string, string>): Set<string> {
  return new Set(Object.entries(nodeStates).filter(([, s]) => s === 'running').map(([id]) => id))
}

// 元に戻すの履歴の上限
const HISTORY_LIMIT = 100

// 履歴に積む状態。選択中・ドラッグ中・サイズ計測の結果は見た目だけの情報なので外す
// （keyで「意味のある変更か」を比べる）
function takeSnapshot(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[]; key: string } {
  const cleanNodes = nodes.map((n) => ({ ...n, selected: false, dragging: false }))
  const cleanEdges = edges.map((e) => ({ ...e, selected: false }))
  const key = JSON.stringify([
    cleanNodes.map(({ measured: _measured, ...rest }) => rest),
    cleanEdges,
  ])
  return { nodes: cleanNodes, edges: cleanEdges, key }
}

// ラボの実行状態（GET /api/v1/labs から判定）。none＝一度も起動していない（コンテナが無い）
type LabRunState = { kind: 'unknown' | 'none' | 'stopped' | 'running'; nodeStates: Record<string, string> }
// 自動保存・差分反映・起動/停止の状態表示
type SyncStatus =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string; canRebuild?: boolean }
type ContextMenu =
  | { x: number; y: number; kind: 'node'; nodeId: string }
  | { x: number; y: number; kind: 'edge'; edgeId: string }
  | null
// editingEdgeIdが設定されている時は「新規接続」ではなく「既存接続の設定編集」モード
// （2026-10-07追加。「IPはGUIで設定できるのにDGWを設定できないのはナンセンス」指摘対応：
// 元々は新規接続時のポップアップにしかI/F・VLAN・アドレス・ゲートウェイの入力欄が無く、
// 既存の接続を後から変更する手段が無かった）
type PendingConnection =
  | { source: string; target: string; sourceHandle: string | null; targetHandle: string | null; editingEdgeId?: string }
  | null

function TopologyEditorInner() {
  const canvasRef = useRef<HTMLDivElement>(null)
  const counters = useRef<Record<PaletteNodeKind, number>>({ ...initialCounters })
  const [nodes, setNodes] = useState<Node[]>(initialNodes)
  const [edges, setEdges] = useState<Edge[]>(initialEdges)
  // 新規作成モードなら最初からYYYYMMDDHHの名前を入れておく（既存ラボを開く時はuseEffectで上書きする）
  const [labName, setLabName] = useState(() => (useUiStore.getState().editorTarget.mode === 'new' ? defaultLabName() : ''))
  // サーバーに保存済みのラボ名（APIで使う安全な名前）。新規作成では最初の自動保存で決まり、以降は変えない
  const [savedLabName, setSavedLabName] = useState<string | null>(null)
  const [runState, setRunState] = useState<LabRunState>({ kind: 'unknown', nodeStates: {} })
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ kind: 'idle' })
  const [labBusy, setLabBusy] = useState(false)
  // 起動・停止の処理中のノード（'all'＝ラボ全体の起動/停止/作り直し中）。キャンバスのランプを点滅させる
  const [busyNodes, setBusyNodes] = useState<'all' | string[]>([])
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null)
  const [pendingConnection, setPendingConnection] = useState<PendingConnection>(null)
  // 接続ダイアログを開いている間はCtrl+Zで裏のトポロジを戻さない（キー処理から参照する）
  const pendingConnectionRef = useRef<PendingConnection>(null)
  pendingConnectionRef.current = pendingConnection
  // リンクの品質ダイアログを開いている接続（2026-10-14追加）
  const [conditionEdgeId, setConditionEdgeId] = useState<string | null>(null)
  // スナップショットのダイアログ（2026-10-18）
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const conditionEdgeIdRef = useRef<string | null>(null)
  conditionEdgeIdRef.current = conditionEdgeId
  const [pendingSourceIface, setPendingSourceIface] = useState('')
  const [pendingTargetIface, setPendingTargetIface] = useState('')
  // PC/ルーター側にだけ表示するIPv4アドレスの入力欄（2026-10-07追加）
  const [pendingSourceAddress, setPendingSourceAddress] = useState('')
  const [pendingTargetAddress, setPendingTargetAddress] = useState('')
  // プレーンなアドレス設定の時だけ表示するデフォルトゲートウェイの入力欄（2026-10-07追加）
  const [pendingSourceGateway, setPendingSourceGateway] = useState('')
  const [pendingTargetGateway, setPendingTargetGateway] = useState('')
  // 既存ラボをエディタで開く時のYAML取得状態（ホームからの「エディタで開く」導線、2026-10-05追加）
  const [loadStatus, setLoadStatus] = useState<{ kind: 'idle' | 'loading' | 'error'; message?: string }>({ kind: 'idle' })
  const { screenToFlowPosition } = useReactFlow()
  const openConsole = useConsoleStore((s) => s.openConsole)
  const closeAllConsoles = useConsoleStore((s) => s.closeAllConsoles)
  const editorTarget = useUiStore((s) => s.editorTarget)
  const setView = useUiStore((s) => s.setView)
  // ConsolePane自体はApp.tsx側に1つだけマウントされている。ここで管理するのは
  // 「トポロジエディタの右側にドッキング表示するか」というフラグだけ（詳細はstore/uiStore.ts参照）
  const consolePanelDocked = useUiStore((s) => s.consolePanelDocked)
  const setConsolePanelDocked = useUiStore((s) => s.setConsolePanelDocked)

  // ---------------------------------------------------------------------------
  // 自動保存＋差分反映（2026-10-14、CML風。deployボタンを廃止）
  //
  // 編集するたびに（1秒の間を置いて）トポロジYAMLとannotationsをサーバーに保存する。
  // ラボが動いていれば、トポロジが変わった時はPOST /apply で差分だけ反映し（既存ノードは
  // 作り直さないので、ルーターの設定もwrite memoryなしで残る）、続けて設定が変わったノード
  // （＋新しく作られたノード）にだけノードごとの設定コマンドを流す（utils/labTopology.ts）。
  // 保存・反映・起動・停止はすべてqueueRefで1本の列に並べ、同時に走らないようにする。
  // ---------------------------------------------------------------------------
  const latestRef = useRef({ nodes, edges, labName })
  const savedNameRef = useRef<string | null>(null)
  // 保存済みの表示名（表示名を変えた時に、自分の他のラボと重ならないかを見るため）
  const savedTitleRef = useRef<string | null>(null)
  // 10秒ごとの確認（別の画面の変更を取り込む。実体は下のcheckRemoteChange）
  // 別の画面の変更を、自分の未保存の編集と統合する（定義はreloadFromRemoteの近く。syncOnceから呼ぶためrefで渡す）
  const mergeRemoteRef = useRef<(name: string, remote: RemoteState, version: string | null) => Promise<boolean>>(async () => false)
  const checkRemoteChangeRef = useRef<(labName: string, knownVersion?: string | null, knownRemote?: RemoteState) => Promise<void>>(async () => undefined)
  // 通知で届いた最新の版と中身（順番が来たら使う）
  const latestEventRef = useRef<VersionEvent | null>(null)
  const runStateRef = useRef<LabRunState>(runState)
  const lastSavedYaml = useRef<string | null>(null)
  const lastSavedAnnotations = useRef<string | null>(null)
  // 別の画面（同じラボを開いている別のタブ等）による変更の検知用：サーバーで最後に見た内容と、食い違いの有無
  const baselineVersionRef = useRef<string | null>(null)
  const [remoteConflict, setRemoteConflict] = useState(false)
  const overwriteRemoteRef = useRef(false)
  const lastAppliedYaml = useRef<string | null>(null)
  // ノードごとに最後に投入できた設定コマンド（これと違うノードにだけ流し直す）
  const lastSynced = useRef(new Map<string, string>())
  // リンクの品質（netem）・ケーブルの抜き差しを最後に入れた状態（utils/labRuntime.ts applyLinkConditions）
  const linkStateRef = useRef(newLinkRuntimeState())
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const syncQueuedRef = useRef(false)
  // 未保存の変更があるか（ホームに戻る・タブを閉じる時の確認用）
  const dirtyRef = useRef(false)
  // 古い形式のまま動いているラボは、作り直すまで保存だけして反映しない（反映するとルーターが
  // 黙って作り直され、write memoryしていない設定が消えるため）
  const applyBlockedRef = useRef(false)
  // 開いたラボが古い形式だったか。停止中なら起動時に一度破棄して今の定義で作り直す（labRuntime.startSavedLab参照）
  const oldFormatRef = useRef(false)
  // 既存ラボを開く時は、読み込みが終わるまで自動保存しない（空のキャンバスで上書きしないため）
  const loadedRef = useRef(editorTarget.mode === 'new')

  const enqueue = useCallback((task: () => Promise<void>) => {
    const next = queueRef.current.then(task).catch((e: unknown) => console.error(e))
    queueRef.current = next
    return next
  }, [])

  const updateRunState = useCallback((next: LabRunState) => {
    runStateRef.current = next
    setRunState(next)
  }, [])

  // ラボが動いているか・ノードごとの状態をGET /api/v1/labs から取り直す
  const refreshRunState = useCallback(
    async (name: string) => {
      const raw = (await getLabs())[name] ?? []
      const nodeStates: Record<string, string> = {}
      for (const n of raw) nodeStates[n.nodeName] = n.state
      const states = Object.values(nodeStates)
      const next: LabRunState = {
        kind: states.length === 0 ? 'none' : states.includes('running') ? 'running' : 'stopped',
        nodeStates,
      }
      updateRunState(next)
      return next
    },
    [updateRunState],
  )

  // 新規作成：最初の保存でラボ名を確定する。既存のラボを上書きしないよう、同名があれば保存しない
  const claimLabName = useCallback(async (): Promise<string | null> => {
    const displayName = latestRef.current.labName.trim()
    if (!displayName) {
      setSyncStatus({ kind: 'error', message: 'ラボ名を入力すると自動保存されます' })
      return null
    }
    // IDは先頭にユーザー名を付ける（別のユーザーと重ならないように、utils/labName.ts）。
    // 自分のラボと表示名が同じ場合も保存しない（ホームの一覧で見分けられないため、2026-10-15）
    const safeName = toSafeLabName(displayName, useAuthStore.getState().username)
    const { ids, titles } = await listLabNames()
    if (ids.has(safeName) || titles.has(labTitleKey(displayName))) {
      setSyncStatus({ kind: 'error', message: `「${displayName}」という名前のラボが既にあります。名前を変えると保存されます` })
      return null
    }
    savedTitleRef.current = displayName
    rememberLabDisplayName(safeName, displayName)
    savedNameRef.current = safeName
    setSavedLabName(safeName)
    updateRunState({ kind: 'none', nodeStates: {} })
    return safeName
  }, [updateRunState])

  // サーバーの内容が、最後に保存・読み込みした内容と意味が同じか。deploy/applyでサーバー側が書式を
  // 整え直しても、「別の画面の変更」と取り違えないための確認（読み込み時と同じ整形をして比べる）
  const remoteSameAsSaved = useCallback((name: string, remote: RemoteState) => {
    try {
      const parsed = parseImportedTopology(remote.yaml, remote.annotations)
      const title = readLabTitle(remote.annotations) ?? getLabDisplayName(name)
      const built = buildTopologyContent(parsed.nodes, parsed.edges, name)
      return (
        topologyToYaml(built.topologyContent) === lastSavedYaml.current &&
        serializeAnnotations(parsed.nodes, built.portAnnotations, built.switchOriginalIds, title) === lastSavedAnnotations.current
      )
    } catch {
      return false
    }
  }, [])

  // サーバーのラボが、最後に見た内容から変わったか。まず軽い版で見て、同じなら終わり。違う時だけ中身を取って
  // 「意味が最後に保存・読み込みした内容と違うか」を確かめる（版だけの違い＝書式の整え直しは変更としない）
  const detectRemoteChange = useCallback(
    async (name: string, knownVersion?: string | null, knownRemote?: RemoteState) => {
      const version = knownVersion !== undefined ? knownVersion : await getLabVersion(name)
      if (version && version === baselineVersionRef.current) return { changed: false, version, remote: null }
      // 通知に中身が付いていれば、取り直さずにそれを使う
      const remote = knownRemote ?? (await fetchRemoteState(name).catch(() => null))
      if (!remote) return { changed: false, version, remote: null }
      if (remoteSameAsSaved(name, remote)) {
        if (version) baselineVersionRef.current = version
        return { changed: false, version, remote }
      }
      return { changed: true, version, remote }
    },
    [remoteSameAsSaved],
  )
  // 自分の保存・反映のあとの版を基準にし直す（軽い問い合わせ1本。見ている画面にもすぐ通知される）
  const rebaseVersion = useCallback(async (name: string) => {
    baselineVersionRef.current = await getLabVersion(name, true)
  }, [])

  const syncOnce = useCallback(async () => {
    dirtyRef.current = false
    const { nodes, edges } = latestRef.current
    let name = savedNameRef.current
    if (!name) {
      // デバイスを1台も置いていない新規ラボはまだ保存しない（空のラボが一覧に溜まらないように）
      if (!nodes.some((n) => n.type === 'topoNode')) return
      name = await claimLabName()
      if (!name) return
    }
    let built: ReturnType<typeof buildTopologyContent>
    try {
      built = buildTopologyContent(nodes, edges, name)
    } catch (e) {
      setSyncStatus({ kind: 'error', message: errorMessage(e, '保存できません') })
      return
    }
    const yamlText = topologyToYaml(built.topologyContent)
    // 表示名（ラボ名欄）。保存後も変えられ、annotationsに入るだけなのでラボの作り直しは起きない
    let title = latestRef.current.labName.trim() || name
    // 表示名を変えた時は、自分の他のラボと重ならないか確かめる。重なれば表示名は前のままで保存する
    let titleConflict: string | null = null
    if (savedTitleRef.current !== null && title !== savedTitleRef.current) {
      const owner = (await listLabNames()).titles.get(labTitleKey(title))
      if (owner && owner !== name) {
        titleConflict = title
        title = savedTitleRef.current
      }
    }
    const annotationsText = serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds, title)
    const conflictMessage = titleConflict ? `「${titleConflict}」という名前のラボが既にあるため、表示名は「${title}」のままです` : null
    try {
      const willWrite = yamlText !== lastSavedYaml.current || annotationsText !== lastSavedAnnotations.current
      if (willWrite && loadedRef.current && !overwriteRemoteRef.current) {
        // 保存の前に、別の画面が先に変更していないか確かめる（黙って上書きしない）。通常は軽い版の確認1本で済む
        const detected = await detectRemoteChange(name)
        if (detected.changed) {
          // ノード単位で統合できれば、統合した内容を次の保存で書く。決められない時だけ、保存を止めて選んでもらう
          if (detected.remote && (await mergeRemoteRef.current(name, detected.remote, detected.version))) return
          dirtyRef.current = true
          setRemoteConflict(true)
          setSyncStatus({ kind: 'error', message: '別の画面でこのラボが変更されたため、保存を止めました' })
          return
        }
      }
      overwriteRemoteRef.current = false
      const writeYaml = yamlText !== lastSavedYaml.current
      const writeAnnotations = annotationsText !== lastSavedAnnotations.current
      if (writeYaml) setSyncStatus({ kind: 'busy', message: '保存中...' })
      // 2つの保存は互いに待たずに行う
      await Promise.all([
        writeYaml ? putLabTopologyYaml(name, yamlText) : undefined,
        writeAnnotations ? putLabAnnotations(name, annotationsText) : undefined,
      ])
      if (writeYaml) lastSavedYaml.current = yamlText
      if (writeAnnotations) {
        lastSavedAnnotations.current = annotationsText
        savedTitleRef.current = title
        rememberLabDisplayName(name, title)
      }
      if (willWrite) await rebaseVersion(name) // 自分の保存のあとの版を基準にし直す
      setRemoteConflict(false)
      if (conflictMessage) {
        setSyncStatus({ kind: 'error', message: conflictMessage })
        if (runStateRef.current.kind !== 'running') return
      }
      if (runStateRef.current.kind !== 'running') {
        setSyncStatus({ kind: 'ok', message: '保存済み' })
        return
      }
      if (applyBlockedRef.current) {
        setSyncStatus({ kind: 'error', message: `保存済み（${OLD_FORMAT_MESSAGE}）`, canRebuild: true })
        return
      }

      let fresh: string[] = []
      if (yamlText !== lastAppliedYaml.current) {
        setSyncStatus({ kind: 'busy', message: '動いているラボに反映中...' })
        await prepareNodeConfigs(name, built)
        const result = await applyLab(name)
        lastAppliedYaml.current = yamlText
        await rebaseVersion(name) // 反映でサーバー側が書式を整え直すことがあるので、基準を取り直す
        fresh = freshNodesOf(result)
        for (const id of result.deletedNodes ?? []) lastSynced.current.delete(id)
        await refreshRunState(name)
      }
      const commands = buildNodeSyncCommands(built)
      const nodeStates = runStateRef.current.nodeStates
      const targets = [...commands]
        .filter(([id, command]) => nodeStates[id] === 'running' && (fresh.includes(id) || lastSynced.current.get(id) !== command))
        .map(([id]) => id)
      if (targets.length > 0) setSyncStatus({ kind: 'busy', message: '設定を反映中...' })
      const { succeeded, failures } = await runNodeSyncs(name, commands, targets)
      for (const [id, command] of succeeded) lastSynced.current.set(id, command)
      failures.push(...(await applyLinkConditions(name, built, runningNodesOf(nodeStates), fresh, linkStateRef.current)))
      setSyncStatus(
        failures.length > 0
          ? { kind: 'error', message: `保存済み（設定の反映に失敗: ${failures.join(' / ')}）` }
          : { kind: 'ok', message: '保存・反映済み' },
      )
    } catch (e) {
      setSyncStatus({
        kind: 'error',
        message: errorMessage(e, '保存に失敗しました'),
        canRebuild: runStateRef.current.kind === 'running',
      })
    }
  }, [claimLabName, refreshRunState, detectRemoteChange, rebaseVersion])

  // 編集のたびに1秒待って保存する（ドラッグ中など連続した変更は1回にまとめる）
  useEffect(() => {
    latestRef.current = { nodes, edges, labName }
    if (!loadedRef.current) return
    dirtyRef.current = true
    const timer = setTimeout(() => {
      if (syncQueuedRef.current) return
      syncQueuedRef.current = true
      void enqueue(async () => {
        syncQueuedRef.current = false
        await syncOnce()
      })
    }, 300) // 連続した編集（ドラッグ等）は1回にまとめる。短いほど別の画面への反映が早い
    return () => clearTimeout(timer)
  }, [nodes, edges, labName, enqueue, syncOnce])

  // 未保存の変更がある・保存中のままタブを閉じようとしたら確認を出す
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current || syncQueuedRef.current) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  const goHome = useCallback(() => {
    // 間を置いている途中の変更も保存してから戻る
    void enqueue(syncOnce).then(() => setView('home'))
  }, [enqueue, syncOnce, setView])

  // ---------------------------------------------------------------------------
  // 元に戻す／やり直す（2026-10-14、テスターの要望「Ctrl+Zで1つ戻したい」）
  //
  // ノード・接続の状態のスナップショットを履歴に積む。ドラッグ等の連続した変更は0.3秒の間を置いて
  // 1件にまとめる。選択状態などの見た目だけの変化は履歴にしない。戻した結果も通常の編集と同じく
  // 自動保存され、ラボが動いていれば反映される（削除したノードを戻すと新しく作られる）。
  // ---------------------------------------------------------------------------
  type Snapshot = { nodes: Node[]; edges: Edge[]; key: string }
  const historyRef = useRef<{ past: Snapshot[]; future: Snapshot[]; current: Snapshot | null }>({
    past: [],
    future: [],
    current: editorTarget.mode === 'new' ? takeSnapshot(initialNodes, initialEdges) : null,
  })
  // ボタンの有効/無効と、押すと何が起きるか（ツールチップ）の表示用（履歴そのものはhistoryRefにある）
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0, undoHint: '', redoHint: '' })
  const syncHistoryCounts = useCallback(() => {
    const h = historyRef.current
    const hint = (target: Snapshot | undefined) => {
      if (!target || !h.current) return ''
      const { lines } = describeHistoryChange(h.current, target)
      return lines.slice(0, 3).join('\n') + (lines.length > 3 ? `\nほか${lines.length - 3}件` : '')
    }
    setHistoryCounts({
      past: h.past.length,
      future: h.future.length,
      undoHint: hint(h.past[h.past.length - 1]),
      redoHint: hint(h.future[h.future.length - 1]),
    })
  }, [])
  // 戻した／やり直した直後に、何がどう変わったかをキャンバス上部に数秒出す（2026-10-14）
  const [historyNotice, setHistoryNotice] = useState<{ action: 'undo' | 'redo'; lines: string[]; seq: number } | null>(null)
  useEffect(() => {
    if (!historyNotice) return
    const timer = setTimeout(() => setHistoryNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [historyNotice])

  // 今の状態が履歴の最新と違えば積む（undo直前に、まだ積まれていない直近の変更を拾うためにも使う）
  const commitHistory = useCallback((nodes: Node[], edges: Edge[]) => {
    const h = historyRef.current
    if (!h.current) return
    const snap = takeSnapshot(nodes, edges)
    if (snap.key === h.current.key) return
    h.past.push(h.current)
    if (h.past.length > HISTORY_LIMIT) h.past.shift()
    h.future = []
    h.current = snap
    syncHistoryCounts()
  }, [syncHistoryCounts])

  useEffect(() => {
    const timer = setTimeout(() => commitHistory(nodes, edges), 300)
    return () => clearTimeout(timer)
  }, [nodes, edges, commitHistory])

  // 変わったノード・接続は選択状態にして場所を示す（選択は履歴の比較対象外なので履歴は増えない）
  const restoreSnapshot = useCallback((from: Snapshot, snap: Snapshot, action: 'undo' | 'redo') => {
    const change = describeHistoryChange(from, snap)
    const changedNodes = new Set(change.nodeIds)
    const changedEdges = new Set(change.edgeIds)
    historyRef.current.current = snap
    setNodes(snap.nodes.map((n) => (changedNodes.has(n.id) ? { ...n, selected: true } : n)))
    setEdges(snap.edges.map((e) => (changedEdges.has(e.id) ? { ...e, selected: true } : e)))
    setContextMenu(null)
    setHistoryNotice((prev) => ({ action, lines: change.lines, seq: (prev?.seq ?? 0) + 1 }))
  }, [])

  const undo = useCallback(() => {
    const { nodes, edges } = latestRef.current
    commitHistory(nodes, edges)
    const h = historyRef.current
    const current = h.current
    const prev = h.past.pop()
    if (!prev || !current) return
    h.future.push(current)
    restoreSnapshot(current, prev, 'undo')
    syncHistoryCounts()
  }, [commitHistory, restoreSnapshot, syncHistoryCounts])

  const redo = useCallback(() => {
    const h = historyRef.current
    const current = h.current
    const next = h.future.pop()
    if (!next || !current) return
    h.past.push(current)
    restoreSnapshot(current, next, 'redo')
    syncHistoryCounts()
  }, [restoreSnapshot, syncHistoryCounts])

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（Macは⌘）。入力欄やコンソール（xterm）の中では奪わない
  // （コンソールのCtrl+Zはルーター・スイッチのCLIで「特権モードに戻る」に使うため）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], .xterm')) return
      if (pendingConnectionRef.current || conditionEdgeIdRef.current) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [undo, redo])

  // ラボ全体を起動する（未起動ならdeploy、停止中なら起動）。起動後は全ノードに設定を流す
  const startWholeLab = useCallback(
    async (name: string, allowRebuild: boolean) => {
      const { nodes, edges } = latestRef.current
      const built = buildTopologyContent(nodes, edges, name)
      await prepareNodeConfigs(name, built)
      if (oldFormatRef.current && runStateRef.current.kind === 'stopped') {
        await destroyLab(name).catch(() => undefined)
      }
      try {
        await applyLab(name)
      } catch (e) {
        // 2026-10-13以前のラボ（スイッチがovs-bridge）等、停止中のコンテナと今の定義が合わず
        // applyできない場合は、一度破棄してから起動する（停止中なので失うものはない。
        // write memoryしたルーター設定はfrr-configに残る）
        if (!allowRebuild) throw e
        console.warn('applyに失敗したため、破棄してから起動し直します', e)
        await destroyLab(name).catch(() => undefined)
        await applyLab(name)
      }
      lastAppliedYaml.current = topologyToYaml(built.topologyContent)
      applyBlockedRef.current = false
      oldFormatRef.current = false
      await refreshRunState(name)
      lastSynced.current.clear()
      const commands = buildNodeSyncCommands(built)
      const { succeeded, failures } = await runNodeSyncs(name, commands, commands.keys())
      for (const [id, command] of succeeded) lastSynced.current.set(id, command)
      const running = runningNodesOf(runStateRef.current.nodeStates)
      linkStateRef.current = newLinkRuntimeState()
      failures.push(...(await applyLinkConditions(name, built, running, running, linkStateRef.current)))
      return failures
    },
    [refreshRunState],
  )

  const onStartLab = useCallback(() => {
    void enqueue(async () => {
      await syncOnce() // まず今の編集内容を保存する
      const name = savedNameRef.current
      if (!name) return
      setLabBusy(true)
      setBusyNodes('all')
      setSyncStatus({ kind: 'busy', message: 'ラボを起動中...（初回はしばらくかかります）' })
      try {
        const failures = await startWholeLab(name, runStateRef.current.kind === 'stopped')
        setSyncStatus(
          failures.length > 0
            ? { kind: 'error', message: `起動しました（設定の反映に失敗: ${failures.join(' / ')}）` }
            : { kind: 'ok', message: 'ラボを起動しました' },
        )
      } catch (e) {
        setSyncStatus({ kind: 'error', message: errorMessage(e, '起動に失敗しました') })
        await refreshRunState(name).catch(() => undefined)
      } finally {
        setLabBusy(false)
        setBusyNodes([])
      }
    })
  }, [enqueue, syncOnce, startWholeLab, refreshRunState])

  const onStopLab = useCallback(() => {
    if (!window.confirm('ラボを停止します。write memoryしていないルーターの設定は消えます。よろしいですか？')) return
    void enqueue(async () => {
      const name = savedNameRef.current
      if (!name) return
      setLabBusy(true)
      setBusyNodes('all')
      setSyncStatus({ kind: 'busy', message: 'ラボを停止中...' })
      try {
        await stopLab(name)
        lastSynced.current.clear()
        linkStateRef.current = newLinkRuntimeState()
        await refreshRunState(name)
        setSyncStatus({ kind: 'ok', message: 'ラボを停止しました' })
      } catch (e) {
        setSyncStatus({ kind: 'error', message: errorMessage(e, '停止に失敗しました') })
      } finally {
        setLabBusy(false)
        setBusyNodes([])
      }
    })
  }, [enqueue, refreshRunState])

  // 差分反映できない状態になった時の最終手段：ラボを破棄して今の内容で起動し直す
  const onRebuildLab = useCallback(() => {
    if (!window.confirm('ラボを作り直します。write memoryしていないルーターの設定は消えます。よろしいですか？')) return
    void enqueue(async () => {
      const name = savedNameRef.current
      if (!name) return
      setLabBusy(true)
      setBusyNodes('all')
      setSyncStatus({ kind: 'busy', message: 'ラボを作り直し中...' })
      try {
        await destroyLab(name).catch(() => undefined)
        await refreshRunState(name)
        await syncOnce()
        const failures = await startWholeLab(name, false)
        setSyncStatus(
          failures.length > 0
            ? { kind: 'error', message: `作り直しました（設定の反映に失敗: ${failures.join(' / ')}）` }
            : { kind: 'ok', message: 'ラボを作り直しました' },
        )
      } catch (e) {
        setSyncStatus({ kind: 'error', message: errorMessage(e, '作り直しに失敗しました') })
      } finally {
        setLabBusy(false)
        setBusyNodes([])
      }
    })
  }, [enqueue, syncOnce, startWholeLab, refreshRunState])

  // ノード単位の起動/停止（リンクは保たれる）。起動し直したノードは中の設定が消えているので流し直す
  const onNodePower = useCallback(
    (nodeId: string, action: 'start' | 'stop') => {
      setContextMenu(null)
      void enqueue(async () => {
        const name = savedNameRef.current
        if (!name) return
        setSyncStatus({ kind: 'busy', message: action === 'start' ? 'ノードを起動中...' : 'ノードを停止中...' })
        setBusyNodes((prev) => (prev === 'all' ? prev : [...prev, nodeId]))
        try {
          await (action === 'start' ? startLabNode : stopLabNode)(name, nodeId)
          lastSynced.current.delete(nodeId)
          await refreshRunState(name)
          let failures: string[] = []
          if (action === 'start') {
            const { nodes, edges } = latestRef.current
            const built = buildTopologyContent(nodes, edges, name)
            const commands = buildNodeSyncCommands(built)
            const result = await runNodeSyncs(name, commands, [nodeId])
            for (const [id, command] of result.succeeded) lastSynced.current.set(id, command)
            // 起動し直したノードの端はnetemの設定が消えている（相手側の端は残る）
            const running = runningNodesOf(runStateRef.current.nodeStates)
            failures = [...result.failures, ...(await applyLinkConditions(name, built, running, [nodeId], linkStateRef.current))]
          }
          setSyncStatus(
            failures.length > 0
              ? { kind: 'error', message: `起動しました（設定の反映に失敗: ${failures.join(' / ')}）` }
              : { kind: 'ok', message: action === 'start' ? `${nodeId}を起動しました` : `${nodeId}を停止しました` },
          )
        } catch (e) {
          setSyncStatus({ kind: 'error', message: errorMessage(e, action === 'start' ? '起動に失敗しました' : '停止に失敗しました') })
        } finally {
          setBusyNodes((prev) => (prev === 'all' ? prev : prev.filter((id) => id !== nodeId)))
        }
      })
    },
    [enqueue, refreshRunState],
  )

  // ノードを初期状態に戻す（wipe）：保存した設定（write memory）を消し、コンテナを作り直す。他のノードは触らない
  const onNodeWipe = useCallback(
    (nodeId: string) => {
      setContextMenu(null)
      const label = (latestRef.current.nodes.find((n) => n.id === nodeId)?.data as Partial<TopoNodeData> | undefined)?.shortLabel ?? nodeId
      if (!window.confirm(`「${label}」を初期状態に戻します。write memoryした設定も含め、このノードの設定はすべて消え、元に戻せません。よろしいですか？`)) return
      void enqueue(async () => {
        const name = savedNameRef.current
        if (!name) return
        setSyncStatus({ kind: 'busy', message: `${label}を初期状態に戻しています...` })
        setBusyNodes((prev) => (prev === 'all' ? prev : [...prev, nodeId]))
        try {
          const { nodes, edges } = latestRef.current
          const built = buildTopologyContent(nodes, edges, name)
          const kind = (nodes.find((n) => n.id === nodeId)?.data as Partial<TopoNodeData> | undefined)?.kind
          await wipeLabNode(name, built, nodeId, kind, runStateRef.current.nodeStates[nodeId] === 'running')
          // 隣のノードも、つながっていたvethが作り直されて中の設定（アドレス等）が消えているので流し直す
          const affected = [nodeId, ...(built.neighbors.get(nodeId) ?? [])]
          for (const id of affected) lastSynced.current.delete(id)
          await refreshRunState(name)
          const commands = buildNodeSyncCommands(built)
          const running = runningNodesOf(runStateRef.current.nodeStates)
          const result = await runNodeSyncs(name, commands, affected.filter((id) => running.has(id)))
          for (const [id, command] of result.succeeded) lastSynced.current.set(id, command)
          const failures = [...result.failures, ...(await applyLinkConditions(name, built, running, affected, linkStateRef.current))]
          setSyncStatus(
            failures.length > 0
              ? { kind: 'error', message: `初期状態に戻しました（設定の反映に失敗: ${failures.join(' / ')}）` }
              : { kind: 'ok', message: `${label}を初期状態に戻しました` },
          )
        } catch (e) {
          await refreshRunState(name).catch(() => undefined)
          setSyncStatus({ kind: 'error', message: errorMessage(e, '初期状態に戻せませんでした') })
        } finally {
          setBusyNodes((prev) => (prev === 'all' ? prev : prev.filter((id) => id !== nodeId)))
        }
      })
    },
    [enqueue, refreshRunState],
  )

  // ---------------------------------------------------------------------------
  // スナップショット（2026-10-18、utils/snapshot.ts・docs/snapshot-design.md）
  // 取る：編集内容を保存してから、トポロジと、動いているルーター・スイッチの設定（write memory相当）を保存する。
  // 戻す：戻す前の状態を自動で残し、トポロジを入れ替えて（動いていれば差分反映）、保存した設定を書き戻して
  // そのノードを再起動する（実機の電源を入れ直すのと同じ。MACテーブルやOSPFの隣接は作り直される）
  // ---------------------------------------------------------------------------
  const onSnapshotTake = useCallback(
    (title: string, note: string) =>
      new Promise<void>((resolve, reject) => {
        void enqueue(async () => {
          try {
            await syncOnce() // 編集直後でも最新の内容を写す
            const name = savedNameRef.current
            if (!name) throw new Error('ノードを置いてラボが保存されてから使えます')
            const { nodes, edges } = latestRef.current
            setSyncStatus({ kind: 'busy', message: 'スナップショットを保存中...' })
            const entry = await createLabSnapshot(name, buildTopologyContent(nodes, edges, name), { title, note })
            const skipped = entry.meta.skipped.length
            setSyncStatus({
              kind: 'ok',
              message: `スナップショットを保存しました${skipped > 0 ? `（停止中などで設定を取れなかったノード: ${entry.meta.skipped.join(', ')}）` : ''}`,
            })
            resolve()
          } catch (e) {
            setSyncStatus({ kind: 'error', message: errorMessage(e, 'スナップショットを保存できませんでした') })
            reject(e)
          }
        })
      }),
    [enqueue, syncOnce],
  )

  const onSnapshotRestore = useCallback(
    (entry: SnapshotEntry) => {
      const hasConfigs = Object.keys(entry.meta.configs).length > 0
      const lines = [
        `スナップショット「${entry.meta.title}」の状態に戻します。`,
        '・今のトポロジを置き換えます（動いているラボには差分が反映されます）',
        ...(hasConfigs ? ['・ルーター・スイッチの設定を書き戻し、そのノードを再起動します（ラボが止まっていれば起動します）'] : []),
        '・戻す前の状態は、自動のスナップショットとして残します',
        '',
        'よろしいですか？',
      ]
      if (!window.confirm(lines.join('\n'))) return
      setSnapshotOpen(false)
      void enqueue(async () => {
        const name = savedNameRef.current
        if (!name) return
        setLabBusy(true)
        setBusyNodes('all')
        try {
          await syncOnce()
          setSyncStatus({ kind: 'busy', message: '戻す前の状態を保存中...' })
          const before = latestRef.current
          await createLabSnapshot(name, buildTopologyContent(before.nodes, before.edges, name), {
            title: `「${entry.meta.title}」に戻す前`,
            note: '',
            auto: true,
          })

          setSyncStatus({ kind: 'busy', message: 'トポロジを戻しています...' })
          const snap = await loadLabSnapshot(entry)
          const parsed = parseImportedTopology(snap.yaml, snap.annotations)
          latestRef.current = { nodes: parsed.nodes, edges: parsed.edges, labName: before.labName }
          counters.current = parsed.counters
          setNodes(parsed.nodes)
          setEdges(parsed.edges)
          await syncOnce() // 保存と、動いているラボへの差分反映

          const failures: string[] = []
          let restoredCount = 0
          if (hasConfigs) {
            if (runStateRef.current.kind !== 'running') {
              setSyncStatus({ kind: 'busy', message: 'ラボを起動しています...' })
              failures.push(...(await startWholeLab(name, runStateRef.current.kind === 'stopped')))
            }
            setSyncStatus({ kind: 'busy', message: '設定を書き戻して再起動しています...' })
            await refreshRunState(name)
            const running = runningNodesOf(runStateRef.current.nodeStates)
            const result = await restoreNodeConfigs(name, entry.meta.configs, running)
            failures.push(...result.failures)
            restoredCount = result.restored.length
            // 再起動したノードと隣のノードは中の設定（アドレス・ケーブル・リンクの品質）が消えているので流し直す
            const { nodes, edges } = latestRef.current
            const built = buildTopologyContent(nodes, edges, name)
            const affected = new Set(result.restored)
            for (const id of result.restored) for (const neighbor of built.neighbors.get(id) ?? []) affected.add(neighbor)
            for (const id of affected) lastSynced.current.delete(id)
            await refreshRunState(name)
            const nowRunning = runningNodesOf(runStateRef.current.nodeStates)
            const commands = buildNodeSyncCommands(built)
            const synced = await runNodeSyncs(name, commands, [...affected].filter((id) => nowRunning.has(id)))
            for (const [id, command] of synced.succeeded) lastSynced.current.set(id, command)
            failures.push(...synced.failures)
            failures.push(...(await applyLinkConditions(name, built, nowRunning, affected, linkStateRef.current)))
            const notRestored = Object.keys(entry.meta.configs).filter((id) => !running.has(id))
            if (notRestored.length > 0) failures.push(`停止中のため設定を戻せなかったノード: ${notRestored.join(', ')}`)
          }
          setSyncStatus(
            failures.length > 0
              ? { kind: 'error', message: `「${entry.meta.title}」に戻しました（一部できなかったこと: ${failures.join(' / ')}）` }
              : { kind: 'ok', message: `「${entry.meta.title}」に戻しました${restoredCount > 0 ? `（${restoredCount}台の設定を戻して再起動）` : ''}` },
          )
        } catch (e) {
          await refreshRunState(name).catch(() => undefined)
          setSyncStatus({ kind: 'error', message: errorMessage(e, 'スナップショットに戻せませんでした') })
        } finally {
          setLabBusy(false)
          setBusyNodes([])
        }
      })
    },
    [enqueue, syncOnce, startWholeLab, refreshRunState],
  )

  // スナップショットから新しいラボを作って開く。元のラボには触れないので、編集キューには載せず、
  // 作り終わったらそのラボをエディタで開き直す（今のラボの編集内容は自動保存済み）
  const onSnapshotOpenAsNew = useCallback(
    (entry: SnapshotEntry) => {
      const hasConfigs = Object.keys(entry.meta.configs).length > 0
      const lines = [
        `スナップショット「${entry.meta.title}」から、新しいラボを作って開きます。`,
        '・今のラボはそのまま残ります',
        ...(hasConfigs ? ['・新しいラボを起動し、ルーター・スイッチの設定を書き戻して再起動します（少し時間がかかります）'] : []),
        '',
        'よろしいですか？',
      ]
      if (!window.confirm(lines.join('\n'))) return
      setSnapshotOpen(false)
      void (async () => {
        try {
          await syncOnce()
          const result = await createLabFromSnapshot(
            entry,
            useAuthStore.getState().username,
            labName.trim() || '無題',
            (message) => setSyncStatus({ kind: 'busy', message }),
          )
          if (result.failures.length > 0) window.alert(`「${result.title}」を作りました。一部できなかったこと：\n${result.failures.join('\n')}`)
          useUiStore.getState().openEditor({ mode: 'edit', labName: result.labName })
        } catch (e) {
          setSyncStatus({ kind: 'error', message: errorMessage(e, '新しいラボを作れませんでした') })
        }
      })()
    },
    [syncOnce, labName],
  )

  // キャンバスのノードに出す起動状態（2026-10-14、「on/offが見た目で分からない」指摘対応）
  const nodeRunStatus = useCallback(
    (nodeId: string): NodeRunStatus => {
      if (!savedLabName || runState.kind === 'unknown' || runState.kind === 'none') {
        return busyNodes === 'all' ? 'busy' : 'none'
      }
      if (busyNodes === 'all' || busyNodes.includes(nodeId)) return 'busy'
      const state = runState.nodeStates[nodeId]
      if (state === 'running') return 'running'
      if (state === 'created' || state === 'restarting') return 'busy'
      if (state) return 'stopped'
      // まだコンテナが無いノード：動いているラボなら次の自動反映で作られる
      return runState.kind === 'running' ? 'pending' : 'none'
    },
    [savedLabName, runState, busyNodes],
  )

  // ---------------------------------------------------------------------------
  // 同じラボを別の画面で開いている時（2026-10-16、CMLのように同じユーザーで複数の画面から操作できる）
  //
  // ・保存の前に、サーバーの内容が最後に見た内容から変わっていないか確かめ、変わっていれば保存を止める
  //   （黙って上書きしない。「最新を読み込む」か「自分の内容で上書き」を選ぶ）
  // ・10秒ごとにサーバーの内容を見て、別の画面が変更していて、こちらに未保存の編集が無ければ自動で読み込む
  // ---------------------------------------------------------------------------
  const hasLocalChanges = useCallback((name: string) => {
    const { nodes, edges, labName } = latestRef.current
    try {
      const built = buildTopologyContent(nodes, edges, name)
      const title = labName.trim() || name
      return (
        topologyToYaml(built.topologyContent) !== lastSavedYaml.current ||
        serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds, title) !== lastSavedAnnotations.current
      )
    } catch {
      return true
    }
  }, [])

  const reloadFromRemote = useCallback(
    async (name: string, remote: RemoteState, version: string | null) => {
      const parsed = parseImportedTopology(remote.yaml, remote.annotations)
      const nodes = parsed.nodes.map((n) => {
        const kind = (n.data as Partial<TopoNodeData>).kind
        if (!needsUpgrade(n) || !kind) return n
        const config = PALETTE_NODE_CONFIGS[kind]
        return { ...n, data: { ...n.data, clabKind: config.clabKind, image: config.image } }
      })
      const title = readLabTitle(remote.annotations) ?? getLabDisplayName(name)
      const built = buildTopologyContent(nodes, parsed.edges, name)
      const normalizedYaml = topologyToYaml(built.topologyContent)
      // 読み込んだ内容は保存・反映済みとみなす（別の画面が反映済み。全ノードに設定を流し直さない）
      lastSavedYaml.current = normalizedYaml
      lastAppliedYaml.current = normalizedYaml
      lastSavedAnnotations.current = serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds, title)
      baselineVersionRef.current = version
      savedTitleRef.current = title
      latestRef.current = { nodes, edges: parsed.edges, labName: title }
      counters.current = parsed.counters
      setNodes(nodes)
      setEdges(parsed.edges)
      setLabName(title)
      historyRef.current = { past: [], future: [], current: takeSnapshot(nodes, parsed.edges) }
      syncHistoryCounts()
      dirtyRef.current = false
      setRemoteConflict(false)
      setSyncStatus({ kind: 'ok', message: '別の画面の変更を読み込みました' })
      // 起動状態の取得は重いので、画面の更新を待たせない。取れたら、設定済みのノードを控える
      lastSynced.current.clear()
      void refreshRunState(name)
        .catch(() => runStateRef.current)
        .then((state) => {
          for (const [id, command] of buildNodeSyncCommands(built)) {
            if (state.nodeStates[id] === 'running') lastSynced.current.set(id, command)
          }
        })
    },
    [refreshRunState, syncHistoryCounts],
  )

  // 別の画面の変更を、自分の未保存の編集と統合する（ノード単位、utils/topologyMerge.ts）。
  // 共通の元＝最後に保存・読み込みした内容。統合できたら、画面を統合後の内容にして、次の保存で書く
  // （サーバーにある内容は別の画面のものなので、「保存済み」の基準はそちらにそろえる）。
  // 自動では決められない時（同じインターフェースに別々のリンク、同名のノードを別々に追加）は false を返し、
  // 呼び出し側は従来の「最新を読み込む／自分の内容で上書き」を出す。元に戻す履歴は、統合の前後で連続しないので空にする
  const mergeRemote = useCallback(
    async (name: string, remote: RemoteState, version: string | null): Promise<boolean> => {
      if (lastSavedYaml.current === null || lastSavedAnnotations.current === null) return false
      try {
        const { nodes: localNodes, edges: localEdges, labName } = latestRef.current
        const localBuilt = buildTopologyContent(localNodes, localEdges, name)
        const localTitle = labName.trim() || name
        const remoteTitle = readLabTitle(remote.annotations) ?? getLabDisplayName(name)
        // 3つとも「保存形式を読み込んだ形」にそろえてから比べる
        const base = parseImportedTopology(lastSavedYaml.current, lastSavedAnnotations.current)
        const local = parseImportedTopology(
          topologyToYaml(localBuilt.topologyContent),
          serializeAnnotations(localNodes, localBuilt.portAnnotations, localBuilt.switchOriginalIds, localTitle),
        )
        const theirs = parseImportedTopology(remote.yaml, remote.annotations)
        const result = mergeTopology(
          { nodes: base.nodes, edges: base.edges, title: savedTitleRef.current ?? name },
          { nodes: local.nodes, edges: local.edges, title: localTitle },
          { nodes: theirs.nodes, edges: theirs.edges, title: remoteTitle },
        )
        if (result.hardConflict) return false

        const merged = result.nodes.map((n) => {
          const kind = (n.data as Partial<TopoNodeData>).kind
          if (!needsUpgrade(n) || !kind) return n
          const config = PALETTE_NODE_CONFIGS[kind]
          return { ...n, data: { ...n.data, clabKind: config.clabKind, image: config.image } }
        })
        buildTopologyContent(merged, result.edges, name) // 組み立てられるか（インターフェースの重なり等）を先に確かめる

        // サーバーにある内容（別の画面のもの）を「保存済み・反映済み」の基準にする
        const theirsBuilt = buildTopologyContent(theirs.nodes, theirs.edges, name)
        const theirsYaml = topologyToYaml(theirsBuilt.topologyContent)
        lastSavedYaml.current = theirsYaml
        lastAppliedYaml.current = theirsYaml
        lastSavedAnnotations.current = serializeAnnotations(theirs.nodes, theirsBuilt.portAnnotations, theirsBuilt.switchOriginalIds, remoteTitle)
        baselineVersionRef.current = version
        savedTitleRef.current = remoteTitle

        latestRef.current = { nodes: merged, edges: result.edges, labName: result.title }
        for (const kind of Object.keys(counters.current) as PaletteNodeKind[]) {
          counters.current[kind] = Math.max(counters.current[kind], theirs.counters[kind] ?? 0, local.counters[kind] ?? 0)
        }
        setNodes(merged)
        setEdges(result.edges)
        setLabName(result.title)
        historyRef.current = { past: [], future: [], current: takeSnapshot(merged, result.edges) }
        syncHistoryCounts()
        setRemoteConflict(false)
        setSyncStatus({
          kind: result.conflicts.length > 0 ? 'error' : 'ok',
          message:
            result.conflicts.length > 0
              ? `別の画面の変更を取り込みました。同じ所を両方が変えた所は自分の内容を残しました：${result.conflicts.join('、')}`
              : result.tookRemote
                ? '別の画面の変更を、自分の編集と合わせて取り込みました'
                : '保存します...',
        })
        // 統合後の内容を保存・反映する（編集の列の最後に並べる）
        dirtyRef.current = true
        void enqueue(syncOnce)
        return true
      } catch {
        return false
      }
    },
    [enqueue, syncOnce, syncHistoryCounts],
  )
  useEffect(() => {
    mergeRemoteRef.current = mergeRemote
  }, [mergeRemote])

  const checkRemoteChange = useCallback(
    async (name: string, knownVersion?: string | null, knownRemote?: RemoteState) => {
      if (!loadedRef.current) return
      const { changed, version, remote } = await detectRemoteChange(name, knownVersion, knownRemote)
      if (!changed || !remote) return
      if (hasLocalChanges(name)) {
        // 未保存の編集があっても、ノード単位で統合できれば取り込む。決められない時だけ、選んでもらう
        if (await mergeRemote(name, remote, version)) return
        setRemoteConflict(true)
        setSyncStatus({ kind: 'error', message: '別の画面でこのラボが変更されています' })
        return
      }
      try {
        await reloadFromRemote(name, remote, version)
      } catch (e) {
        setSyncStatus({ kind: 'error', message: errorMessage(e, '別の画面の変更を読み込めませんでした') })
      }
    },
    [hasLocalChanges, reloadFromRemote, detectRemoteChange, mergeRemote],
  )
  useEffect(() => {
    checkRemoteChangeRef.current = checkRemoteChange
  }, [checkRemoteChange])

  const onReloadRemote = useCallback(() => {
    const name = savedNameRef.current
    if (!name) return
    void enqueue(async () => {
      try {
        const version = await getLabVersion(name, true)
        await reloadFromRemote(name, await fetchRemoteState(name), version)
      } catch (e) {
        setSyncStatus({ kind: 'error', message: errorMessage(e, '最新の内容を読み込めませんでした') })
      }
    })
  }, [enqueue, reloadFromRemote])

  const onOverwriteRemote = useCallback(() => {
    overwriteRemoteRef.current = true
    void enqueue(syncOnce)
  }, [enqueue, syncOnce])

  // 他の画面（ホームの起動/停止、別のタブ）での変化や、落ちたノードも映すよう、10秒ごとに状態を取り直す。
  // 保存・反映と同じ列に並べ、処理の途中の状態で上書きしないようにする
  useEffect(() => {
    if (!savedLabName) return
    let queued = false
    const timer = setInterval(() => {
      if (queued || document.hidden) return
      queued = true
      void enqueue(async () => {
        queued = false
        await checkRemoteChangeRef.current(savedLabName)
        await refreshRunState(savedLabName).catch(() => undefined)
      })
    }, 10000)
    return () => clearInterval(timer)
  }, [savedLabName, enqueue, refreshRunState])

  // 別の画面の保存を、サーバーからの通知で1秒ほどで取り込む（2026-10-16、collab-proxyの`/watch`）。
  // 通知が来ない・繋がらない時は、上の10秒ごとの確認がそのまま働く
  useEffect(() => {
    if (!savedLabName) return
    let queued = false
    return watchLab(savedLabName, (event) => {
      // 自分の保存で基準にした版と同じなら、何もしない（自分の保存の通知は、問い合わせなしで終わる）
      if (event.version && event.version === baselineVersionRef.current) return
      latestEventRef.current = event // 続けて届いたら新しい方だけ使う
      if (queued) return
      queued = true
      void enqueue(async () => {
        queued = false
        const ev = latestEventRef.current
        latestEventRef.current = null
        // 中身が付いていれば取り直さない。付いていない時は版だけ渡して中身を取る
        const remote = ev && ev.yaml ? { yaml: ev.yaml, annotations: ev.annotations } : undefined
        await checkRemoteChangeRef.current(savedLabName, ev?.version || undefined, remote)
      })
    })
  }, [savedLabName, enqueue])

  // 保存済みのYAML（＋annotations）をダウンロードする（2026-10-08追加、
  // 「授業で使うテンプレートを配布しやすく」指摘対応）。サーバーから改めて取得する
  const [exportStatus, setExportStatus] = useState<{ kind: 'idle' | 'exporting' | 'error'; message?: string }>({
    kind: 'idle',
  })
  const onExport = useCallback(async () => {
    if (!savedLabName) return
    setExportStatus({ kind: 'exporting' })
    try {
      await enqueue(syncOnce) // 編集直後でも最新の内容を出す
      const yamlText = await getLabTopologyYaml(savedLabName)
      const annotationsText = await getLabAnnotations(savedLabName).catch(() => null)
      downloadTextFile(`${savedLabName}.clab.yml`, yamlText)
      if (annotationsText) downloadTextFile(`${savedLabName}.clab.yml.annotations.json`, annotationsText)
      setExportStatus({ kind: 'idle' })
    } catch (e) {
      const message = e instanceof ApiError || e instanceof Error ? e.message : 'エクスポートに失敗しました'
      setExportStatus({ kind: 'error', message })
    }
  }, [savedLabName, enqueue, syncOnce])

  // ホームの「エディタで開く」から来た場合、保存済みのトポロジYAMLを取得してキャンバスに復元する。
  // エディタはホームから「新規作成」/「既存ラボを開く」のどちらかでしか入れない専用画面で、
  // 入る度にTopologyEditorInnerが新たにマウントされるため、マウント時に一度だけ行えばよい
  // （2026-10-05決定、docs/direction.md参照）
  useEffect(() => {
    // エディタに入る度（新規作成/既存ラボを開くのどちらでも）、前にいたラボのコンソールタブは
    // もう無関係なので閉じる（2026-10-05指摘：ラボを切り替えても前のラボのコンソールが残っていた）。
    // ドッキングパネルの開閉状態も一旦リセットし、必要ならautoOpenConsoleNodeで開き直す
    closeAllConsoles()
    setConsolePanelDocked(false)

    if (editorTarget.mode !== 'edit') {
      // 新規作成：YYYYMMDDHHが既存のラボと同じなら、-2, -3...を付けて空いている名前にする
      // （同じ時間帯に2つ目を作ると最初の保存が「同名あり」で止まってしまうため）
      const username = useAuthStore.getState().username
      void listLabNames()
        .then(({ ids, titles }) => {
          const taken = (c: string) => ids.has(toSafeLabName(c, username)) || titles.has(labTitleKey(c))
          const base = defaultLabName()
          let candidate = base
          for (let i = 2; taken(candidate); i++) candidate = `${base}-${i}`
          setLabName((current) => (current === base ? candidate : current))
        })
        .catch(() => undefined)
      return
    }
    const targetLabName = editorTarget.labName
    const autoOpenConsoleNode = editorTarget.autoOpenConsoleNode
    setLoadStatus({ kind: 'loading' })
    getLabTopologyYaml(targetLabName)
      .then(async (yamlText) => {
        // 座標・VLAN/アドレス設定の保存データがあれば復元する（保存されていない＝404の場合は
        // 無視してグリッド配置のまま進める。座標が無いことを理由にエディタが開けなくなることは
        // 避けたいため）。実際の復元ロジックはparseImportedTopology()に共通化している
        // （YAMLインポート機能と共有、2026-10-08）
        let annotationsText: string | null = null
        try {
          annotationsText = await getLabAnnotations(targetLabName)
        } catch {
          // 保存データが無い場合（404等）はそのまま
        }
        void getLabVersion(targetLabName).then((v) => {
          baselineVersionRef.current = v
        })
        const parsed = parseImportedTopology(yamlText, annotationsText)
        const { edges, counters: parsedCounters } = parsed
        // 古い形式のノード（2026-10-13以前のovs-bridgeのスイッチ、2026-10-14以前のエージェント無しの
        // ルーター）は、キャンバス上は今の形式として扱い、次の保存で書き直す。
        // 動いているラボは作り直さないと反映できないので、「作り直す」まで自動反映を止める
        // スイッチの設定保存先（switch-config）をbind mountしていないラボ（2026-10-14以前）も同じ扱い
        const isOldFormat = parsed.nodes.some((n) => needsUpgrade(n)) || hasSwitchWithoutConfigBind(yamlText)
        const nodes = parsed.nodes.map((n) => {
          const kind = (n.data as Partial<TopoNodeData>).kind
          if (!needsUpgrade(n) || !kind) return n
          const config = PALETTE_NODE_CONFIGS[kind]
          return { ...n, data: { ...n.data, clabKind: config.clabKind, image: config.image } }
        })
        setNodes(nodes)
        setEdges(edges)
        counters.current = parsedCounters
        const title = readLabTitle(annotationsText) ?? getLabDisplayName(targetLabName)
        setLabName(title)
        savedTitleRef.current = title
        latestRef.current = { ...latestRef.current, labName: title }
        savedNameRef.current = targetLabName
        setSavedLabName(targetLabName)

        // 開いた時点の内容は保存・反映済みとみなす（開いただけで全ノードに設定を流し直さないため）。
        // 古い形式のラボだけは、次の保存で今の形式に書き直す
        let commands = new Map<string, string>()
        let built: ReturnType<typeof buildTopologyContent> | null = null
        try {
          built = buildTopologyContent(nodes, edges, targetLabName)
          const normalizedYaml = topologyToYaml(built.topologyContent)
          commands = buildNodeSyncCommands(built)
          if (!isOldFormat) {
            lastSavedYaml.current = normalizedYaml
            lastAppliedYaml.current = normalizedYaml
            lastSavedAnnotations.current = serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds, title)
          }
        } catch {
          // 種別情報の無いノード等。次の保存でエラーとして表示される
        }
        const state = await refreshRunState(targetLabName).catch(() => runStateRef.current)
        for (const [id, command] of commands) {
          if (state.nodeStates[id] === 'running') lastSynced.current.set(id, command)
        }
        // リンクの品質は、今入っている値を読んで、食い違っていれば入れ直す（ラボの外でノードを起動し直した等）
        if (built && state.kind === 'running' && !isOldFormat) {
          const linkBuilt = built
          const running = runningNodesOf(state.nodeStates)
          // netemの問い合わせはノードごとに順番に行うので時間がかかる。エディタの表示は待たせず、保存・反映の列で行う
          void enqueue(async () => {
            linkStateRef.current = await readLinkRuntimeState(targetLabName, linkBuilt, running)
            const failures = await applyLinkConditions(targetLabName, linkBuilt, running, [], linkStateRef.current)
            if (failures.length > 0) setSyncStatus({ kind: 'error', message: `リンクの品質の反映に失敗: ${failures.join(' / ')}` })
          })
        }
        loadedRef.current = true
        historyRef.current = { past: [], future: [], current: takeSnapshot(nodes, edges) }
        setLoadStatus({ kind: 'idle' })
        oldFormatRef.current = isOldFormat
        if (isOldFormat && state.kind === 'running') {
          applyBlockedRef.current = true
          setSyncStatus({ kind: 'error', message: OLD_FORMAT_MESSAGE, canRebuild: true })
        }

        // ホームの🖥ボタンから来た場合、読み込み完了後にそのノードのコンソールを自動で開く
        if (autoOpenConsoleNode && state.nodeStates[autoOpenConsoleNode] === 'running') {
          const targetNode = nodes.find((n) => n.id === autoOpenConsoleNode)
          const kind = (targetNode?.data as Partial<TopoNodeData> | undefined)?.kind
          openConsole(targetLabName, autoOpenConsoleNode, consoleAutoCommand(kind))
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
      setPendingSourceAddress('')
      setPendingTargetAddress('')
      setPendingSourceGateway('')
      setPendingTargetGateway('')
    },
    [edges],
  )

  const sourceAddressResult = useMemo(() => parseIpv4Cidr(pendingSourceAddress), [pendingSourceAddress])
  const targetAddressResult = useMemo(() => parseIpv4Cidr(pendingTargetAddress), [pendingTargetAddress])
  const sourceGatewayResult = useMemo(() => parseIpv4Gateway(pendingSourceGateway), [pendingSourceGateway])
  const targetGatewayResult = useMemo(() => parseIpv4Gateway(pendingTargetGateway), [pendingTargetGateway])

  const confirmConnection = useCallback(() => {
    if (!pendingConnection) return
    const { source, target, sourceHandle, targetHandle, editingEdgeId } = pendingConnection
    const newData: EdgeIfaceData = {
      sourceIface: pendingSourceIface,
      targetIface: pendingTargetIface,
      sourceAddress: sourceAddressResult.address,
      targetAddress: targetAddressResult.address,
      sourceGateway: sourceGatewayResult.gateway,
      targetGateway: targetGatewayResult.gateway,
    }
    if (editingEdgeId) {
      // 既存接続の編集：idはそのまま、dataだけ入れ替える（2026-10-07追加）
      setEdges((eds) => eds.map((e) => (e.id === editingEdgeId ? { ...e, data: newData } : e)))
    } else {
      // idはI/F名から組み立てず、ランダムな値にする（2026-10-08レビュー指摘対応：
      // I/F名から組み立てたidだと、既存接続を編集してI/Fを変更した時にidが古いI/Fの
      // ままになり、後から同じI/F組み合わせで新規接続を作るとidが衝突し、
      // disconnectEdge/editEdgeが両方のエッジを同時に操作してしまう不具合があった）
      const id = randomAnnotationId('edge')
      setEdges((eds) =>
        eds.concat({
          id,
          source,
          target,
          sourceHandle: sourceHandle ?? undefined,
          targetHandle: targetHandle ?? undefined,
          type: 'floating',
          data: newData,
        }),
      )
    }
    setPendingConnection(null)
  }, [
    pendingConnection,
    pendingSourceIface,
    pendingTargetIface,
    sourceAddressResult,
    targetAddressResult,
    sourceGatewayResult,
    targetGatewayResult,
  ])

  const cancelConnection = useCallback(() => setPendingConnection(null), [])

  const sourceIfaceConflict = pendingConnection
    ? usedInterfaces(pendingConnection.source, edges, pendingConnection.editingEdgeId).has(pendingSourceIface)
    : false
  const targetIfaceConflict = pendingConnection
    ? usedInterfaces(pendingConnection.target, edges, pendingConnection.editingEdgeId).has(pendingTargetIface)
    : false

  const nodeKind = (id: string) => (nodes.find((n) => n.id === id)?.data as Partial<TopoNodeData> | undefined)?.kind
  const sourceIsSwitch = pendingConnection ? isSwitchKind(nodeKind(pendingConnection.source)) : false
  const targetIsSwitch = pendingConnection ? isSwitchKind(nodeKind(pendingConnection.target)) : false
  // ルーターはIPアドレス設定をvtyshのCLIで行う方針にしたため、GUIのプレーンなアドレス/
  // ゲートウェイ入力欄はPCにしか出さない（2026-10-07方針変更：「ルーターはCLIで設定しないと
  // 意味がない」指摘対応。docs/direction.md参照）
  const sourceIsRouter = pendingConnection ? nodeKind(pendingConnection.source) === 'router' : false
  const targetIsRouter = pendingConnection ? nodeKind(pendingConnection.target) === 'router' : false

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

  // リンクの品質・ケーブルの抜き差し（2026-10-14追加）。edge.dataに入れるので、自動保存で
  // 動いているラボに反映され、元に戻すの対象にもなる（utils/linkCondition.ts）
  const updateEdgeCondition = useCallback((edgeId: string, update: (c: LinkCondition) => LinkCondition) => {
    setEdges((eds) =>
      eds.map((e) => {
        if (e.id !== edgeId) return e
        const data = (e.data ?? {}) as Partial<EdgeIfaceData>
        const next = normalizeCondition(update({ ...data.condition }))
        const { condition: _old, ...rest } = data
        return { ...e, data: next ? { ...rest, condition: next } : rest }
      }),
    )
  }, [])
  const toggleCable = useCallback(
    (edgeId: string) => {
      setContextMenu(null)
      updateEdgeCondition(edgeId, (c) => ({ ...c, down: !c.down }))
    },
    [updateEdgeCondition],
  )
  const applyEdgeCondition = useCallback(
    (edgeId: string, condition: LinkCondition | undefined) => {
      setConditionEdgeId(null)
      // ケーブルの抜き差しはダイアログでは変えない
      updateEdgeCondition(edgeId, (c) => ({ ...condition, down: c.down }))
    },
    [updateEdgeCondition],
  )

  // ノードのコンテナが動いているか（コンソール・キャプチャを使えるか）
  const isNodeRunning = useCallback((nodeId: string) => runState.nodeStates[nodeId] === 'running', [runState])

  // パケットキャプチャ（WiresharkのnoVNCセッション）を開始する（2026-10-08追加）。
  // 動いているノードの側だけが対象（古い形式のovs-bridgeのスイッチはコンテナが無いので対象外）
  const [captureStatus, setCaptureStatus] = useState<{ kind: 'idle' | 'starting' | 'error'; message?: string }>({
    kind: 'idle',
  })
  const onCaptureEdge = useCallback(
    async (edgeId: string) => {
      setContextMenu(null)
      const edge = edges.find((e) => e.id === edgeId)
      if (!edge || !savedLabName) return
      const data = (edge.data ?? {}) as Partial<EdgeIfaceData>
      const nodeInfo = (id: string) => nodes.find((n) => n.id === id)?.data as Partial<TopoNodeData> | undefined
      const shortLabelOf = (id: string) => (nodeInfo(id)?.shortLabel as string | undefined) ?? id
      const targets: CaptureTarget[] = []
      const labelsByContainer: Record<string, string> = {}
      if (hasContainer(nodeInfo(edge.source)) && data.sourceIface && isNodeRunning(edge.source)) {
        targets.push({ containerName: edge.source, interfaceName: data.sourceIface })
        labelsByContainer[edge.source] = `${shortLabelOf(edge.source)}(${data.sourceIface}) ↔ ${shortLabelOf(edge.target)}`
      }
      if (hasContainer(nodeInfo(edge.target)) && data.targetIface && isNodeRunning(edge.target)) {
        targets.push({ containerName: edge.target, interfaceName: data.targetIface })
        labelsByContainer[edge.target] = `${shortLabelOf(edge.target)}(${data.targetIface}) ↔ ${shortLabelOf(edge.source)}`
      }
      setCaptureStatus({ kind: 'starting' })
      try {
        await startPacketCapture(savedLabName, targets, labelsByContainer)
        setCaptureStatus({ kind: 'idle' })
      } catch (e) {
        const message = e instanceof ApiError || e instanceof Error ? e.message : 'キャプチャの開始に失敗しました'
        setCaptureStatus({ kind: 'error', message })
      }
    },
    [edges, nodes, savedLabName, isNodeRunning],
  )

  // 既存接続の設定（I/F・VLAN・アドレス・ゲートウェイ・サブインターフェース）を編集する
  // ポップアップを開く。新規接続時と同じポップアップを、保存済みのデータで埋めて再利用する
  // （2026-10-07追加。「IPはGUIで設定できるのにDGWを設定できないのはナンセンス」指摘対応）
  const editEdge = useCallback(
    (edgeId: string) => {
      const edge = edges.find((e) => e.id === edgeId)
      if (!edge) return
      const data = (edge.data ?? {}) as Partial<EdgeIfaceData>
      setPendingConnection({
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
        editingEdgeId: edge.id,
      })
      setPendingSourceIface(data.sourceIface ?? '')
      setPendingTargetIface(data.targetIface ?? '')
      setPendingSourceAddress(data.sourceAddress ?? '')
      setPendingTargetAddress(data.targetAddress ?? '')
      setPendingSourceGateway(data.sourceGateway ?? '')
      setPendingTargetGateway(data.targetGateway ?? '')
      setContextMenu(null)
    },
    [edges],
  )

  // トポロジエディタから直接、統合コンソールをワンタッチで開く（ラボ一覧に行かなくて済むように）。
  // 動いているノードだけ開ける
  const openNodeConsole = useCallback(
    (nodeId: string) => {
      if (!savedLabName || !isNodeRunning(nodeId)) return
      // ルーターはCMLのように最初からvtyshを開いた状態にしておく
      const kind = (nodes.find((n) => n.id === nodeId)?.data as Partial<TopoNodeData> | undefined)?.kind
      openConsole(savedLabName, nodeId, consoleAutoCommand(kind))
      setConsolePanelDocked(true)
      setContextMenu(null)
    },
    [savedLabName, isNodeRunning, nodes, openConsole, setConsolePanelDocked],
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
      // PCのアドレスだけをラベルに添える（スイッチのVLANはCLIで設定するのでGUIは知らない、2026-10-14）
      const addressLabels = [iface?.sourceAddress, iface?.targetAddress].filter(Boolean)
      const vlanSuffix = addressLabels.length > 0 ? ` [${addressLabels.join('/')}]` : ''

      // リンクの品質を設定した線は紫、ケーブルを抜いた線は赤の破線にし、ラベルに内容を添える（2026-10-14）
      const condition = iface?.condition
      const summary = conditionSummary(condition)
      const conditionSuffix = condition?.down ? ' ✕ 切断' : summary ? ` ⏱ ${summary}` : ''
      const stroke = condition?.down ? 'var(--edge-down)' : summary ? 'var(--edge-impaired)' : 'var(--edge)'

      return {
        ...edge,
        type: edge.type ?? 'floating',
        label:
          iface?.sourceIface && iface.targetIface
            ? `${iface.sourceIface}↔${iface.targetIface}${vlanSuffix}${conditionSuffix}`
            : undefined,
        style: { stroke, strokeWidth: 2, ...(condition?.down ? { strokeDasharray: '6 4' } : {}) },
        labelStyle: { fill: condition?.down || summary ? stroke : 'var(--ink-soft)', fontSize: 10 },
        labelBgStyle: { fill: 'var(--surface)' },
        data: { ...edge.data, parallelIndex, parallelCount } satisfies FloatingEdgeData,
      }
    })
  }, [edges])


  // YAML（＋任意でannotations）をローカルファイルからインポートしてキャンバスに読み込む
  // （2026-10-08追加）。他の人がexportしたテンプレートを取り込んで新規ラボとして
  // 使い始められるようにする。読み込むだけでdeployはしない（ユーザーが確認してから
  // 自分のアカウントでdeployする）
  const importInputRef = useRef<HTMLInputElement>(null)
  const onImportFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const fileList = Array.from(files)
    const yamlFile = fileList.find((f) => /\.ya?ml$/i.test(f.name))
    const annotationsFile = fileList.find((f) => /\.json$/i.test(f.name))
    if (!yamlFile) {
      setLoadStatus({ kind: 'error', message: 'YAMLファイル（.yml/.yaml）を選んでください' })
      return
    }
    try {
      const yamlText = await yamlFile.text()
      const annotationsText = annotationsFile ? await annotationsFile.text() : null
      const { nodes: importedNodes, edges: importedEdges, counters: importedCounters } = parseImportedTopology(
        yamlText,
        annotationsText,
      )
      setNodes(importedNodes)
      setEdges(importedEdges)
      counters.current = importedCounters
      setLoadStatus({ kind: 'idle' })
    } catch (e) {
      setLoadStatus({ kind: 'error', message: e instanceof Error ? e.message : 'インポートに失敗しました' })
    }
  }, [])

  const nodeLabel = (id: string) => (nodes.find((n) => n.id === id)?.data as Partial<TopoNodeData> | undefined)?.shortLabel ?? id

  // コンテキストメニューの対象が注釈（ラベル/エリア）かデバイスかで出す項目を変える
  const contextMenuNode = contextMenu?.kind === 'node' ? nodes.find((n) => n.id === contextMenu.nodeId) : undefined
  const edgeData = (id: string | null | undefined) =>
    (edges.find((e) => e.id === id)?.data ?? undefined) as Partial<EdgeIfaceData> | undefined
  const contextMenuEdgeDown = contextMenu?.kind === 'edge' && !!edgeData(contextMenu.edgeId)?.condition?.down
  const conditionEdge = conditionEdgeId ? edges.find((e) => e.id === conditionEdgeId) : undefined
  const contextMenuIsAnnotation = contextMenuNode?.type === 'labelNode' || contextMenuNode?.type === 'areaNode'
  // コンテナを持たないノード（古い形式のovs-bridgeのスイッチ。読み込み時に今の形式に置き換えるので
  // 通常は無い）にはコンソールが無い。スイッチのコンソールはCisco風CLI（swcli）
  const contextMenuIsSwitch = !hasContainer(contextMenuNode?.data as Partial<TopoNodeData> | undefined)
  const contextMenuCanOpenConsole =
    contextMenu?.kind === 'node' &&
    !contextMenuIsAnnotation &&
    !contextMenuIsSwitch &&
    isNodeRunning(contextMenu.nodeId)
  // ノード単位の起動/停止は、ラボが一度でも起動していて（コンテナがあり）、そのノードが既にある時だけ。
  // まだコンテナの無い（起動後に追加して反映待ちの）ノードには出さない
  const contextMenuCanPower =
    contextMenu?.kind === 'node' &&
    !contextMenuIsAnnotation &&
    !contextMenuIsSwitch &&
    !labBusy &&
    contextMenu.nodeId in runState.nodeStates

  return (
    <div className="topology-editor">
      <NodePalette />
      <div className="topology-editor__main">
        <div className="topology-editor__toolbar">
          <button className="btn-ghost" onClick={goHome} title="ホームに戻る（編集内容は自動保存されています）">
            ← ホーム
          </button>
          <button
            className="btn-icon"
            aria-label="元に戻す"
            onClick={undo}
            disabled={historyCounts.past === 0}
            title={`元に戻す（Ctrl+Z）${historyCounts.undoHint ? `\n${historyCounts.undoHint}` : ''}`}
          >
            ↶
          </button>
          <button
            className="btn-icon"
            aria-label="やり直す"
            onClick={redo}
            disabled={historyCounts.future === 0}
            title={`やり直す（Ctrl+Shift+Z / Ctrl+Y）${historyCounts.redoHint ? `\n${historyCounts.redoHint}` : ''}`}
          >
            ↷
          </button>
          <input
            className="topology-editor__lab-name"
            placeholder="ラボ名"
            value={labName}
            onChange={(e) => setLabName(e.target.value)}
            disabled={loadStatus.kind === 'loading'}
            title={
              savedLabName
                ? `表示名はいつでも変えられます（ラボのID: ${savedLabName}。IDは最初の保存で決まり変わりません）`
                : '最初のノードを置いた時点でこの名前で保存されます'
            }
          />
          {loadStatus.kind === 'loading' && <span className="topology-editor__status">トポロジを読み込み中...</span>}
          {loadStatus.kind === 'error' && <span className="topology-editor__status topology-editor__status--error">{loadStatus.message}</span>}
          {!savedLabName && labName.trim() && !isSafeLabName(labName.trim()) && (
            <span className="topology-editor__status" title="ラボ名は英数字・ハイフン・アンダースコアのみAPIが受け付けるため、実際には自動生成した名前で保存されます">
              実際の名前: {toSafeLabName(labName, useAuthStore.getState().username)}
            </span>
          )}
          {savedLabName && runState.kind !== 'unknown' && (
            <span
              className={`topology-editor__run-state topology-editor__run-state--${labBusy ? 'busy' : runState.kind}`}
              title={runStateTitle(runState)}
            >
              {labBusy
                ? '● 処理中...'
                : runState.kind === 'running'
                  ? `● 起動中${runningSummary(runState)}`
                  : runState.kind === 'stopped'
                    ? '● 停止中'
                    : '● 未起動'}
            </span>
          )}
          {runState.kind === 'running' ? (
            <button
              className="btn-danger"
              onClick={onStopLab}
              disabled={labBusy}
              title="ラボ全体を停止します（実機の電源断と同じく、write memoryしていないルーター設定は消えます）"
            >
              ■ 停止
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={onStartLab}
              disabled={labBusy || loadStatus.kind === 'loading' || !nodes.some((n) => n.type === 'topoNode')}
              title="ラボを起動します。起動中の編集は自動で反映されます"
            >
              ▶ 起動
            </button>
          )}
          {syncStatus.kind !== 'idle' && (
            <span
              className={`topology-editor__status${syncStatus.kind === 'ok' ? ' topology-editor__status--ok' : syncStatus.kind === 'error' ? ' topology-editor__status--error' : ''}`}
            >
              {syncStatus.message}
            </span>
          )}
          {remoteConflict && (
            <>
              <button onClick={onReloadRemote} title="別の画面で保存された最新の内容を読み込みます（こちらの未保存の編集は捨てます）">
                最新を読み込む
              </button>
              <button className="btn-danger" onClick={onOverwriteRemote} title="別の画面の変更を捨てて、こちらの内容で保存します">
                自分の内容で上書き
              </button>
            </>
          )}
          {syncStatus.kind === 'error' && syncStatus.canRebuild && (
            <button className="btn-danger" onClick={onRebuildLab} disabled={labBusy} title="ラボを破棄して今の内容で起動し直します">
              作り直す
            </button>
          )}
          <input
            ref={importInputRef}
            type="file"
            accept=".yml,.yaml,.json"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              void onImportFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={!!savedLabName}
            title={
              savedLabName
                ? '保存済みのラボを上書きしないよう、インポートは新規作成の画面でだけ使えます'
                : '他の人がエクスポートしたYAML（＋annotations）を読み込んで新規ラボとして編集を始めます'
            }
          >
            インポート
          </button>
          <button
            onClick={onExport}
            disabled={!savedLabName || exportStatus.kind === 'exporting'}
            title={savedLabName ? '保存済みのYAML（＋annotations）をダウンロードします' : 'ノードを置くと保存され、使えるようになります'}
          >
            {exportStatus.kind === 'exporting' ? 'エクスポート中...' : 'エクスポート'}
          </button>
          {exportStatus.kind === 'error' && <span className="topology-editor__status topology-editor__status--error">{exportStatus.message}</span>}
          {savedLabName && !getShareRoute() && (
            <button onClick={() => setSnapshotOpen(true)} disabled={labBusy} title="今の状態を保存したり、保存した状態に戻したりします">
              スナップショット
            </button>
          )}
          {savedLabName && !getShareRoute() && <ShareButton labName={savedLabName} />}
          <div className="topology-editor__toolbar-spacer" />
          <button
            onClick={() => setConsolePanelDocked(!consolePanelDocked)}
            title="トポロジを見ながら統合コンソールを操作できます"
          >
            🖥 コンソール{consolePanelDocked ? 'を隠す' : 'パネル'}
          </button>
        </div>
        <div className="topology-editor__canvas" ref={canvasRef} onDrop={onDrop} onDragOver={onDragOver}>
          {historyNotice && (
            <div key={historyNotice.seq} className="topology-editor__history-notice" role="status" onClick={() => setHistoryNotice(null)}>
              <div className="topology-editor__history-notice-title">
                {historyNotice.action === 'undo' ? '↶ 元に戻しました' : '↷ やり直しました'}
              </div>
              <ul>
                {historyNotice.lines.slice(0, 6).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
                {historyNotice.lines.length > 6 && <li>ほか{historyNotice.lines.length - 6}件</li>}
              </ul>
            </div>
          )}
          <NodeRuntimeContext.Provider value={nodeRunStatus}>
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
          </NodeRuntimeContext.Provider>

          {contextMenu?.kind === 'node' && (
            <div className="topology-editor__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              {!contextMenuIsAnnotation && <button onClick={() => renameNode(contextMenu.nodeId)}>名前を変更</button>}
              {!contextMenuIsAnnotation && !contextMenuIsSwitch && (
                <button
                  onClick={() => openNodeConsole(contextMenu.nodeId)}
                  disabled={!contextMenuCanOpenConsole}
                  title={contextMenuCanOpenConsole ? undefined : 'ノードが起動していません'}
                >
                  コンソールを開く
                </button>
              )}
              {contextMenuCanPower &&
                (isNodeRunning(contextMenu.nodeId) ? (
                  <button onClick={() => onNodePower(contextMenu.nodeId, 'stop')}>ノードを停止</button>
                ) : (
                  <button onClick={() => onNodePower(contextMenu.nodeId, 'start')}>ノードを起動</button>
                ))}
              {contextMenuCanPower && (
                <button onClick={() => onNodeWipe(contextMenu.nodeId)} title="write memoryした設定も消して、コンテナを作り直します">
                  初期状態に戻す（wipe）
                </button>
              )}
              <button onClick={() => deleteNode(contextMenu.nodeId)}>削除</button>
            </div>
          )}
          {contextMenu?.kind === 'edge' && (
            <div className="topology-editor__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <button onClick={() => editEdge(contextMenu.edgeId)}>設定を編集</button>
              <button
                onClick={() => {
                  setContextMenu(null)
                  setConditionEdgeId(contextMenu.edgeId)
                }}
                title="帯域・遅延・パケットロスなどを設定します"
              >
                リンクの品質...
              </button>
              <button
                onClick={() => toggleCable(contextMenu.edgeId)}
                title="ケーブルを抜いた状態にします（両端がリンクダウンします）"
              >
                {contextMenuEdgeDown ? 'ケーブルを差す' : 'ケーブルを抜く'}
              </button>
              <button
                onClick={() => void onCaptureEdge(contextMenu.edgeId)}
                disabled={runState.kind !== 'running' || captureStatus.kind === 'starting'}
                title={runState.kind === 'running' ? 'このリンクのパケットキャプチャを別タブで開きます' : 'ラボを起動してから使えます'}
              >
                {captureStatus.kind === 'starting' ? 'キャプチャ開始中...' : 'パケットキャプチャ'}
              </button>
              <button onClick={() => disconnectEdge(contextMenu.edgeId)}>接続を解除</button>
            </div>
          )}
          {captureStatus.kind === 'error' && (
            <div className="topology-editor__context-menu-status topology-editor__status topology-editor__status--error">
              {captureStatus.message}
            </div>
          )}

          {snapshotOpen && savedLabName && (
            <SnapshotDialog
              labName={savedLabName}
              running={runState.kind === 'running'}
              onTake={onSnapshotTake}
              onRestore={onSnapshotRestore}
          onOpenAsNew={onSnapshotOpenAsNew}
              onClose={() => setSnapshotOpen(false)}
            />
          )}
          {conditionEdge && (
            <LinkConditionDialog
              linkName={`${nodeLabel(conditionEdge.source)} ${edgeData(conditionEdge.id)?.sourceIface ?? ''} ⇔ ${nodeLabel(
                conditionEdge.target,
              )} ${edgeData(conditionEdge.id)?.targetIface ?? ''}`}
              initial={edgeData(conditionEdge.id)?.condition}
              running={runState.kind === 'running'}
              onApply={(c) => applyEdgeCondition(conditionEdge.id, c)}
              onCancel={() => setConditionEdgeId(null)}
            />
          )}

          {pendingConnection && (
            <div className="topology-editor__modal-overlay" onClick={cancelConnection}>
              <div className="topology-editor__modal" onClick={(e) => e.stopPropagation()}>
                <h3>{pendingConnection.editingEdgeId ? '接続の設定を編集' : '接続するインターフェースを選択'}</h3>
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
                  {!sourceIsSwitch && !sourceIsRouter && (
                    <div className="topology-editor__modal-vlan">
                      <input
                        value={pendingSourceAddress}
                        onChange={(e) => setPendingSourceAddress(e.target.value)}
                        placeholder="IPv4アドレス（任意、例: 10.0.0.1/24）"
                      />
                      {sourceAddressResult.error && <span className="topology-editor__modal-warn">{sourceAddressResult.error}</span>}
                      <input
                        value={pendingSourceGateway}
                        onChange={(e) => setPendingSourceGateway(e.target.value)}
                        placeholder="デフォルトゲートウェイ（任意、例: 10.0.0.254）"
                      />
                      {sourceGatewayResult.error && <span className="topology-editor__modal-warn">{sourceGatewayResult.error}</span>}
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
                  {!targetIsSwitch && !targetIsRouter && (
                    <div className="topology-editor__modal-vlan">
                      <input
                        value={pendingTargetAddress}
                        onChange={(e) => setPendingTargetAddress(e.target.value)}
                        placeholder="IPv4アドレス（任意、例: 10.0.0.2/24）"
                      />
                      {targetAddressResult.error && <span className="topology-editor__modal-warn">{targetAddressResult.error}</span>}
                      <input
                        value={pendingTargetGateway}
                        onChange={(e) => setPendingTargetGateway(e.target.value)}
                        placeholder="デフォルトゲートウェイ（任意、例: 10.0.0.1）"
                      />
                      {targetGatewayResult.error && <span className="topology-editor__modal-warn">{targetGatewayResult.error}</span>}
                    </div>
                  )}
                </div>
                <div className="topology-editor__modal-actions">
                  <button onClick={cancelConnection}>キャンセル</button>
                  <button
                    className="btn-primary"
                    onClick={confirmConnection}
                    disabled={
                      sourceIfaceConflict ||
                      targetIfaceConflict ||
                      !!sourceAddressResult.error ||
                      !!sourceGatewayResult.error ||
                      !!targetAddressResult.error ||
                      !!targetGatewayResult.error
                    }
                  >
                    {pendingConnection.editingEdgeId ? '保存' : '接続'}
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
