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
import { startPacketCapture } from '../api/captureClient'
import { getLabDisplayName, isSafeLabName, rememberLabDisplayName, toSafeLabName } from '../utils/labName'
import { serializeAnnotations } from '../utils/annotations'
import {
  buildNodeSyncCommands,
  buildTopologyContent,
  hasContainer,
  parseImportedTopology,
  topologyToYaml,
  type EdgeIfaceData,
} from '../utils/labTopology'
import { errorMessage, freshNodesOf, prepareRouters, runNodeSyncs, startLabNode, stopLabNode } from '../utils/labRuntime'
import {
  ApiError,
  applyLab,
  destroyLab,
  getLabAnnotations,
  getLabs,
  getLabTopologyFiles,
  getLabTopologyYaml,
  putLabAnnotations,
  putLabTopologyYaml,
  stopLab,
  type CaptureTarget,
} from '../api/client'
import { useConsoleStore } from '../store/consoleStore'
import { useUiStore } from '../store/uiStore'
import './TopologyEditor.css'

// パレットの種別ごとに「R1」「SW1」「PC1」のような短い表示名を振るための接頭辞とカウンター
const SHORT_LABEL_PREFIX: Record<PaletteNodeKind, string> = { router: 'R', 'l2-switch': 'SW', pc: 'PC' }

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
  if (kind === 'l2-switch') return SWITCH_CONSOLE_AUTO_COMMAND
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
  '古い形式のラボのため、編集は保存のみで反映されません。「作り直す」で今の形式にできます（write memoryしていないルーター設定は消え、GUIで入れていたスイッチのVLANは引き継がれません）'

// 今のパレット定義と違う古い形式のノードか（ovs-bridge/CLI無しのスイッチ、エージェント無しのルーター）
function needsUpgrade(node: Node): boolean {
  if (node.type !== 'topoNode') return false
  const data = node.data as Partial<TopoNodeData>
  if (data.kind === 'l2-switch') return data.image !== PALETTE_NODE_CONFIGS['l2-switch'].image
  if (data.kind === 'router') return data.image !== PALETTE_NODE_CONFIGS.router.image
  return false
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
  const [contextMenu, setContextMenu] = useState<ContextMenu>(null)
  const [pendingConnection, setPendingConnection] = useState<PendingConnection>(null)
  // 接続ダイアログを開いている間はCtrl+Zで裏のトポロジを戻さない（キー処理から参照する）
  const pendingConnectionRef = useRef<PendingConnection>(null)
  pendingConnectionRef.current = pendingConnection
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
  const runStateRef = useRef<LabRunState>(runState)
  const lastSavedYaml = useRef<string | null>(null)
  const lastSavedAnnotations = useRef<string | null>(null)
  const lastAppliedYaml = useRef<string | null>(null)
  // ノードごとに最後に投入できた設定コマンド（これと違うノードにだけ流し直す）
  const lastSynced = useRef(new Map<string, string>())
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const syncQueuedRef = useRef(false)
  // 未保存の変更があるか（ホームに戻る・タブを閉じる時の確認用）
  const dirtyRef = useRef(false)
  // 古い形式のまま動いているラボは、作り直すまで保存だけして反映しない（反映するとルーターが
  // 黙って作り直され、write memoryしていない設定が消えるため）
  const applyBlockedRef = useRef(false)
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
    const safeName = toSafeLabName(displayName)
    const [files, labs] = await Promise.all([getLabTopologyFiles(), getLabs()])
    if (files.some((f) => f.labName === safeName) || safeName in labs) {
      setSyncStatus({ kind: 'error', message: `「${displayName}」という名前のラボが既にあります。名前を変えると保存されます` })
      return null
    }
    rememberLabDisplayName(safeName, displayName)
    savedNameRef.current = safeName
    setSavedLabName(safeName)
    updateRunState({ kind: 'none', nodeStates: {} })
    return safeName
  }, [updateRunState])

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
    const annotationsText = serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds)
    try {
      if (yamlText !== lastSavedYaml.current) {
        setSyncStatus({ kind: 'busy', message: '保存中...' })
        await putLabTopologyYaml(name, yamlText)
        lastSavedYaml.current = yamlText
      }
      if (annotationsText !== lastSavedAnnotations.current) {
        await putLabAnnotations(name, annotationsText)
        lastSavedAnnotations.current = annotationsText
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
        await prepareRouters(name, built.routerClabNames)
        const result = await applyLab(name)
        lastAppliedYaml.current = yamlText
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
  }, [claimLabName, refreshRunState])

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
    }, 1000)
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
  // ボタンの有効/無効の表示用（履歴そのものはhistoryRefにある）
  const [historyCounts, setHistoryCounts] = useState({ past: 0, future: 0 })
  const syncHistoryCounts = useCallback(() => {
    const h = historyRef.current
    setHistoryCounts({ past: h.past.length, future: h.future.length })
  }, [])

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

  const restoreSnapshot = useCallback((snap: Snapshot) => {
    historyRef.current.current = snap
    setNodes(snap.nodes)
    setEdges(snap.edges)
    setContextMenu(null)
  }, [])

  const undo = useCallback(() => {
    const { nodes, edges } = latestRef.current
    commitHistory(nodes, edges)
    const h = historyRef.current
    const prev = h.past.pop()
    if (!prev || !h.current) return
    h.future.push(h.current)
    restoreSnapshot(prev)
    syncHistoryCounts()
  }, [commitHistory, restoreSnapshot, syncHistoryCounts])

  const redo = useCallback(() => {
    const h = historyRef.current
    const next = h.future.pop()
    if (!next || !h.current) return
    h.past.push(h.current)
    restoreSnapshot(next)
    syncHistoryCounts()
  }, [restoreSnapshot, syncHistoryCounts])

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（Macは⌘）。入力欄やコンソール（xterm）の中では奪わない
  // （コンソールのCtrl+Zはルーター・スイッチのCLIで「特権モードに戻る」に使うため）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, [contenteditable="true"], .xterm')) return
      if (pendingConnectionRef.current) return
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
      await prepareRouters(name, built.routerClabNames)
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
      await refreshRunState(name)
      lastSynced.current.clear()
      const commands = buildNodeSyncCommands(built)
      const { succeeded, failures } = await runNodeSyncs(name, commands, commands.keys())
      for (const [id, command] of succeeded) lastSynced.current.set(id, command)
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
      }
    })
  }, [enqueue, syncOnce, startWholeLab, refreshRunState])

  const onStopLab = useCallback(() => {
    if (!window.confirm('ラボを停止します。write memoryしていないルーターの設定は消えます。よろしいですか？')) return
    void enqueue(async () => {
      const name = savedNameRef.current
      if (!name) return
      setLabBusy(true)
      setSyncStatus({ kind: 'busy', message: 'ラボを停止中...' })
      try {
        await stopLab(name)
        lastSynced.current.clear()
        await refreshRunState(name)
        setSyncStatus({ kind: 'ok', message: 'ラボを停止しました' })
      } catch (e) {
        setSyncStatus({ kind: 'error', message: errorMessage(e, '停止に失敗しました') })
      } finally {
        setLabBusy(false)
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
        try {
          await (action === 'start' ? startLabNode : stopLabNode)(name, nodeId)
          lastSynced.current.delete(nodeId)
          await refreshRunState(name)
          let failures: string[] = []
          if (action === 'start') {
            const { nodes, edges } = latestRef.current
            const commands = buildNodeSyncCommands(buildTopologyContent(nodes, edges, name))
            const result = await runNodeSyncs(name, commands, [nodeId])
            for (const [id, command] of result.succeeded) lastSynced.current.set(id, command)
            failures = result.failures
          }
          setSyncStatus(
            failures.length > 0
              ? { kind: 'error', message: `起動しました（設定の反映に失敗: ${failures.join(' / ')}）` }
              : { kind: 'ok', message: action === 'start' ? `${nodeId}を起動しました` : `${nodeId}を停止しました` },
          )
        } catch (e) {
          setSyncStatus({ kind: 'error', message: errorMessage(e, action === 'start' ? '起動に失敗しました' : '停止に失敗しました') })
        }
      })
    },
    [enqueue, refreshRunState],
  )

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
      void Promise.all([getLabTopologyFiles(), getLabs()])
        .then(([files, labs]) => {
          const taken = new Set([...files.map((f) => f.labName), ...Object.keys(labs)])
          const base = defaultLabName()
          let candidate = base
          for (let i = 2; taken.has(candidate); i++) candidate = `${base}-${i}`
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
        const parsed = parseImportedTopology(yamlText, annotationsText)
        const { edges, counters: parsedCounters } = parsed
        // 古い形式のノード（2026-10-13以前のovs-bridgeのスイッチ、2026-10-14以前のエージェント無しの
        // ルーター）は、キャンバス上は今の形式として扱い、次の保存で書き直す。
        // 動いているラボは作り直さないと反映できないので、「作り直す」まで自動反映を止める
        const isOldFormat = parsed.nodes.some((n) => needsUpgrade(n))
        const nodes = parsed.nodes.map((n) => {
          const kind = (n.data as Partial<TopoNodeData>).kind
          if (!needsUpgrade(n) || !kind) return n
          const config = PALETTE_NODE_CONFIGS[kind]
          return { ...n, data: { ...n.data, clabKind: config.clabKind, image: config.image } }
        })
        setNodes(nodes)
        setEdges(edges)
        counters.current = parsedCounters
        setLabName(getLabDisplayName(targetLabName))
        savedNameRef.current = targetLabName
        setSavedLabName(targetLabName)

        // 開いた時点の内容は保存・反映済みとみなす（開いただけで全ノードに設定を流し直さないため）。
        // 古い形式のラボだけは、次の保存で今の形式に書き直す
        let commands = new Map<string, string>()
        try {
          const built = buildTopologyContent(nodes, edges, targetLabName)
          const normalizedYaml = topologyToYaml(built.topologyContent)
          commands = buildNodeSyncCommands(built)
          if (!isOldFormat) {
            lastSavedYaml.current = normalizedYaml
            lastAppliedYaml.current = normalizedYaml
            lastSavedAnnotations.current = serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds)
          }
        } catch {
          // 種別情報の無いノード等。次の保存でエラーとして表示される
        }
        const state = await refreshRunState(targetLabName).catch(() => runStateRef.current)
        for (const [id, command] of commands) {
          if (state.nodeStates[id] === 'running') lastSynced.current.set(id, command)
        }
        loadedRef.current = true
        historyRef.current = { past: [], future: [], current: takeSnapshot(nodes, edges) }
        setLoadStatus({ kind: 'idle' })
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
  const sourceIsSwitch = pendingConnection ? nodeKind(pendingConnection.source) === 'l2-switch' : false
  const targetIsSwitch = pendingConnection ? nodeKind(pendingConnection.target) === 'l2-switch' : false
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
          <button className="topology-editor__back" onClick={goHome} title="ホームに戻る（編集内容は自動保存されています）">
            ← ホーム
          </button>
          <button onClick={undo} disabled={historyCounts.past === 0} title="元に戻す（Ctrl+Z）">
            ↶
          </button>
          <button onClick={redo} disabled={historyCounts.future === 0} title="やり直す（Ctrl+Shift+Z / Ctrl+Y）">
            ↷
          </button>
          <input
            className="topology-editor__lab-name"
            placeholder="ラボ名"
            value={labName}
            onChange={(e) => setLabName(e.target.value)}
            disabled={loadStatus.kind === 'loading'}
            readOnly={!!savedLabName}
            title={savedLabName ? '保存済みのラボの名前は変更できません' : '最初のノードを置いた時点でこの名前で保存されます'}
          />
          {loadStatus.kind === 'loading' && <span className="topology-editor__status">トポロジを読み込み中...</span>}
          {loadStatus.kind === 'error' && <span className="topology-editor__status topology-editor__status--error">{loadStatus.message}</span>}
          {labName.trim() && !isSafeLabName(labName.trim()) && (
            <span className="topology-editor__status" title="ラボ名は英数字・ハイフン・アンダースコアのみAPIが受け付けるため、実際には自動生成した名前で保存されます">
              実際の名前: {toSafeLabName(labName)}
            </span>
          )}
          {savedLabName && runState.kind !== 'unknown' && (
            <span className={`topology-editor__run-state topology-editor__run-state--${runState.kind}`}>
              {runState.kind === 'running' ? '● 起動中' : runState.kind === 'stopped' ? '● 停止中' : '● 未起動'}
            </span>
          )}
          {runState.kind === 'running' ? (
            <button
              onClick={onStopLab}
              disabled={labBusy}
              title="ラボ全体を停止します（実機の電源断と同じく、write memoryしていないルーター設定は消えます）"
            >
              ■ 停止
            </button>
          ) : (
            <button
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
          {syncStatus.kind === 'error' && syncStatus.canRebuild && (
            <button onClick={onRebuildLab} disabled={labBusy} title="ラボを破棄して今の内容で起動し直します">
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
              <button onClick={() => deleteNode(contextMenu.nodeId)}>削除</button>
            </div>
          )}
          {contextMenu?.kind === 'edge' && (
            <div className="topology-editor__context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
              <button onClick={() => editEdge(contextMenu.edgeId)}>設定を編集</button>
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
