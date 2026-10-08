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
import { applyVlanConfig, ensureBridge, ensureFrrConfig, resetPort, type VlanConfig } from '../api/ovsHelperClient'
import { startPacketCapture } from '../api/captureClient'
import type { CaptureTarget } from '../api/client'
import { getLabDisplayName, isSafeLabName, rememberLabDisplayName, toSafeLabName } from '../utils/labName'
import { parseTopologyYaml } from '../utils/topologyFromYaml'
import { applyAnnotations, applyPortAnnotations, restoreSwitchIdentities, serializeAnnotations } from '../utils/annotations'
import {
  ApiError,
  deployLab,
  execInLab,
  getLabAnnotations,
  getLabTopologyYaml,
  putLabAnnotations,
  type ExecResponse,
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
  // PC/ルーターがプレーンなアドレス設定（router on a stickではない）の時だけ意味がある。
  // デフォルトゲートウェイ（単純なIPv4アドレス、プレフィックス無し）。設定するとdeploy後に
  // `ip route add default via <gateway>`を実行する（2026-10-07追加。「ラボ内の宛先が
  // 自動的に外部に飛んでしまう」指摘対応。docs/direction.md参照）
  sourceGateway?: string
  targetGateway?: string
  // ルーター側がL2スイッチのトランクポートに接続している時だけ意味がある（router on a stick、
  // 2026-10-07追加）。物理I/F自体にはアドレスを持たせず、VLANごとのサブインターフェース
  // （例: eth1.10）を作ってそれぞれにアドレスを振る。sourceAddress/targetAddressとは
  // 排他（モードで切り替える。UI側のpendingSourceMode/pendingTargetMode参照）
  sourceSubInterfaces?: SubInterfaceConfig[]
  targetSubInterfaces?: SubInterfaceConfig[]
  [key: string]: unknown
}

// router on a stick用のVLANサブインターフェース。
// ルーターの通常のアドレス設定（「プレーン」モード）はvtyshのCLIで行う方針のままだが、
// サブインターフェースの作成はVLAN ID＋アドレスの両方をGUIで一度に設定する方式に戻した
// （2026-10-08再変更：デバイス作成はCLIでは不可能なためGUI必須、かつ「デバイスだけGUIで
// 作ってアドレスは別途CLIで」という2段階の運用は煩雑で誤解を生みやすいという指摘を受けて、
// サブインターフェース作成時はGUIで完結させることにした。詳細はdocs/direction.md参照）
interface SubInterfaceConfig {
  vlan: number
  address: string
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

// parseVlanInput()の逆変換。既存接続を編集する時、保存済みのVlanConfigから
// モード選択＋入力欄の文字列を復元するために使う（2026-10-07追加）
function vlanConfigToModeAndValue(config: VlanConfig | undefined): { mode: VlanMode; value: string } {
  if (!config) return { mode: 'none', value: '' }
  if (config.mode === 'access') return { mode: 'access', value: String(config.vlan) }
  if (config.vlans === 'all') return { mode: 'trunk-all', value: '' }
  return { mode: 'trunk-list', value: config.vlans.join(',') }
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

// router on a stick用：VLANサブインターフェースの行（VLAN ID＋アドレス）をまとめて検証する。
// 行が0件なら「未設定」として扱う（2026-10-08再変更：デバイス作成がGUI必須な以上、
// 同じタイミングでアドレスも設定してしまう方がシンプルで誤解が無いという判断）
function parseSubInterfaceRows(rows: { vlan: string; address: string }[]): { configs?: SubInterfaceConfig[]; error?: string } {
  if (rows.length === 0) return {}
  const isValidVlanId = (n: number) => Number.isInteger(n) && n >= 1 && n <= 4094
  const configs: SubInterfaceConfig[] = []
  const seenVlans = new Set<number>()
  for (const row of rows) {
    const vlan = Number(row.vlan)
    if (!isValidVlanId(vlan)) return { error: 'VLAN IDは1〜4094の整数で指定してください' }
    if (seenVlans.has(vlan)) return { error: `VLAN ${vlan} が重複しています` }
    seenVlans.add(vlan)
    const { address, error } = parseIpv4Cidr(row.address)
    if (error) return { error }
    if (!address) return { error: 'サブインターフェースにはIPv4アドレスが必要です' }
    configs.push({ vlan, address })
  }
  return { configs }
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

// containerlabの`linux` kindはデフォルトでDockerの`--privileged`相当（全capability付与・
// AppArmor/seccomp無効）でコンテナを起動することが判明（2026-10-07実機確認：
// `docker inspect`で`Privileged: true`、`CapEff`が全capability）。PC/ルーターのコンソールは
// 単なるroot権限のシェルなので、このままだとコンソールから特権コンテナ由来のホスト侵害
// （release_agent等のcgroup経由のコンテナエスケープ手法等）を試みられてしまう
// （「PCでeth0を触れる」指摘から発覚した、より深刻な問題）。
// `privileged: false` + 必要最小限の`cap-add`に絞ることで、host deviceへのアクセスや
// AppArmor/seccomp無効化は解消される。実機検証の結果：
// - PC（ip addr/link操作のみ）: NET_ADMINのみで十分（ping含め動作確認済み）
// - ルーター（FRR）: zebra/ospfdがNET_ADMIN+NET_RAWだけでは
//   `privs_init: initial cap_set_proc failed: Operation not permitted`で起動せず、
//   SYS_ADMINも追加して初めて起動した（FRR自体が要求するcapability）。
//   SYS_ADMIN自体は軽くはないが、`--privileged`全体（host device直接アクセス・
//   AppArmor/seccomp無効化等）とは別物で、それらは引き続き防げる。
//   OSPF隣接形成・loopback間pingまで実機確認済み
const CONTAINER_CAPABILITIES: Partial<Record<PaletteNodeKind, { privileged: false; capAdd: string[] }>> = {
  pc: { privileged: false, capAdd: ['NET_ADMIN'] },
  router: { privileged: false, capAdd: ['NET_ADMIN', 'NET_RAW', 'SYS_ADMIN'] },
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

// router on a stick用：VLANサブインターフェース（例: eth1.10）の作成タスク。
// デバイス作成（`ip link add ... type vlan`→`ip link set ... up`）とアドレス設定
// （`ip addr add`）の両方をここで行う（2026-10-08再変更：デバイス作成はvtyshでは
// 不可能なためGUI側で用意するしかなく、「デバイスだけGUIで作ってアドレスは別途CLIで」という
// 2段階運用は煩雑で誤解を生みやすいという指摘を受けて、サブインターフェース作成時は
// GUIで完結させる方式に戻した。ルーターの通常のアドレス設定（「プレーン」モード）は
// 引き続きvtyshのCLIで行う。docs/direction.md参照）
interface SubInterfaceTask {
  nodeName: string
  parentIface: string
  vlan: number
  address: string
}

// デプロイ後、トポロジYAMLをGETして再構築する時に備えて、ハッシュ化された実名（L2スイッチの
// ブリッジ名・ポート名）から、UI上で使っていた分かりやすい名前・VLAN・アドレス設定を
// 引き戻すためのマップ。`${実際にYAMLに書かれるclabName}:${実際のポート名}`をキーにする
// （endpointsの文字列そのものと同じ形なので、再読み込み時にそのまま突き合わせられる）。
// containerlabのトポロジYAML自体にはこれらの情報を置けないため、annotations.tsの保存先に
// 載せて一緒に永続化する（2026-10-07追加。再読み込み後にL2スイッチ接続のI/F名が
// 文字化けのように見える・VLAN/アドレス設定が消える、の両方の修正）
interface PortAnnotation {
  iface: string
  vlan?: VlanConfig
  address?: string
  // デフォルトゲートウェイ（2026-10-07追加）
  gateway?: string
  // router on a stick用のVLANサブインターフェース一覧（2026-10-07追加）
  subInterfaces?: SubInterfaceConfig[]
}

// containerlabのトポロジYAML（＋任意でannotations JSON）からReact Flowのnodes/edgesを復元する。
// 「既存ラボをエディタで開く」（サーバーから取得）と「YAMLファイルをインポート」（ローカルの
// ファイルを読む）の両方で同じ復元ロジックを使うため共通化した（2026-10-08追加、YAML
// export/import機能）。annotationsが無い場合は座標・VLAN/アドレス設定の復元をスキップし、
// グリッド配置のまま進める（他ユーザーが作ったYAMLをインポートする場合、annotationsは
// 無いのが普通）
function parseImportedTopology(
  yamlText: string,
  annotationsText: string | null,
): { nodes: Node[]; edges: Edge[]; counters: Record<PaletteNodeKind, number> } {
  const parsed = parseTopologyYaml(yamlText)
  let nodes = parsed.nodes
  let edges = parsed.edges
  if (annotationsText) {
    try {
      // 順序の理由はuseEffect側の読み込み処理と同じ（restoreSwitchIdentitiesより先にport
      // annotationsを引く、座標復元は最後）
      edges = applyPortAnnotations(edges, annotationsText)
      ;({ nodes, edges } = restoreSwitchIdentities(nodes, edges, annotationsText))
      nodes = applyAnnotations(nodes, annotationsText)
    } catch {
      // 想定外のフォーマットの場合は無視してグリッド配置のまま進める
    }
  }
  return { nodes, edges, counters: parsed.counters }
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

// execInLab()の結果を見てエラーなら投げる。execはコマンド自体が失敗してもHTTPとしては200で
// 返ってくるため`return-code`で判定する必要がある（addressTasks/subInterfaceTasks/
// routeResultsで共通して必要なロジックなのでまとめた、2026-10-08レビュー指摘対応）。
// 対象ノードが見つからず`result`が空オブジェクトになるケース（firstResultがundefined）も
// 「結果が取れなかった＝失敗」として扱う（以前はここが抜けていて、execが実質的に
// 何も実行できなかった場合でも静かに成功扱いになっていた）
function assertExecOk(result: ExecResponse, failureMessage: string) {
  const [firstResult] = Object.values(result).flat()
  if (!firstResult || firstResult['return-code'] !== 0) {
    throw new Error((firstResult?.stderr ?? '').trim() || failureMessage)
  }
}

function buildTopologyContent(
  nodes: Node[],
  edges: Edge[],
  username: string,
  labName: string,
): {
  topologyContent: TopologyContent
  vlanTasks: VlanTask[]
  switchPorts: string[]
  addressTasks: AddressTask[]
  subInterfaceTasks: SubInterfaceTask[]
  // PC/ルーター（L2スイッチ以外）の全clabName。containerlabが自動設定するeth0の
  // デフォルトルートはmgmtネットワークのゲートウェイを指しており、ラボ内に存在しない
  // 宛先への経路が無いとそのまま実際の外部ネットワークに出てしまう（2026-10-07実機確認）。
  // deploy後に全ノードでこのデフォルトルートを削除する
  linuxNodeNames: string[]
  // ノードごとに設定されたデフォルトゲートウェイ。削除後、該当ノードだけ
  // `ip route add default via <gateway>`で明示的に設定し直す
  gatewayByNode: Map<string, string>
  // deployより前にensureFrrConfig()を呼ぶ対象の全ルーターのclabName（2026-10-07追加）
  routerClabNames: string[]
  portAnnotations: Record<string, PortAnnotation>
  switchOriginalIds: Record<string, string>
} {
  const clabNodeNames = new Map<string, string>()
  const nodeKinds = new Map<string, PaletteNodeKind>()
  const nodesMap: TopologyContent['topology']['nodes'] = {}
  // L2スイッチのブリッジ名は node.id をハッシュ化して作る。再読み込み後にnode.idが元の値に
  // 戻せていないと、ハッシュ済みの名前をさらにハッシュしてしまい、再deployのたびにブリッジ名・
  // ポート名がズレていく（2026-10-07レビュー指摘）。ここでnode.id→ブリッジ名の対応を記録して
  // annotationsに保存し、再読み込み時に元のnode.idへ戻せるようにする
  const switchOriginalIds: Record<string, string> = {}

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
    const caps = CONTAINER_CAPABILITIES[data.kind]
    // ルーターはCLI（vtysh）での設定を永続化するため、daemons/frr.conf/vtysh.confを
    // bind mountする（2026-10-07追加。「ルーターはCLIで設定しないと意味がない」指摘対応。
    // 相対パスはlabのトポロジYAML自身からの相対位置になる、M1のテストラボと同じ流儀）。
    // このパスにファイルが事前に存在していないとdeploy自体が失敗するため、deployより前に
    // ensureFrrConfig()で用意する必要がある（buildTopologyContentのroutersから収集する）
    const frrBinds =
      data.kind === 'router'
        ? [
            `frr-config/${clabName}/daemons:/etc/frr/daemons`,
            `frr-config/${clabName}/frr.conf:/etc/frr/frr.conf`,
            `frr-config/${clabName}/vtysh.conf:/etc/frr/vtysh.conf`,
          ]
        : undefined
    nodesMap[clabName] = {
      kind: data.clabKind,
      ...(data.image ? { image: data.image } : {}),
      ...(caps ? { privileged: caps.privileged, 'cap-add': caps.capAdd } : {}),
      ...(frrBinds ? { binds: frrBinds } : {}),
    }
    if (data.kind === 'l2-switch') switchOriginalIds[clabName] = node.id
  }

  // deployより前にensureFrrConfig()を呼ぶ対象（router on a stickのVLANサブインターフェースが
  // 無いルーターも含め、全ルーターに対して必要。デフォルトのdaemons/frr.conf/vtysh.confを
  // 用意しないとbind mount先が存在せずdeploy自体が失敗する、2026-10-07実機確認）
  const routerClabNames = deviceNodes
    .filter((n) => (n.data as Partial<TopoNodeData>).kind === 'router')
    .map((n) => clabNodeNames.get(n.id))
    .filter((name): name is string => !!name)

  // PC/ルーター（コンテナを持つノード）の全clabName。deploy後、全ノードで
  // containerlab自動設定のeth0デフォルトルートを削除する対象（2026-10-07追加）
  const linuxNodeNames = deviceNodes
    .filter((n) => (n.data as Partial<TopoNodeData>).kind !== 'l2-switch')
    .map((n) => clabNodeNames.get(n.id))
    .filter((name): name is string => !!name)

  const vlanTasks: VlanTask[] = []
  const switchPorts: string[] = []
  const addressTasks: AddressTask[] = []
  const subInterfaceTasks: SubInterfaceTask[] = []
  const gatewayByNode = new Map<string, string>()
  const portAnnotations: Record<string, PortAnnotation> = {}

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

    // ルーターの通常のアドレス設定はvtyshのCLIで行う方針（2026-10-07決定）のため、GUIの
    // プレーンなアドレス/ゲートウェイ入力欄はルーターには出していない。ただし古い保存データ
    // （方針変更前にルーター側へ設定されたsourceAddress/sourceGateway）が再読み込み時に
    // 復元されてしまう可能性があり、それを律義に毎回execで再投入すると、学生がvtyshで
    // `write memory`した設定と静かに競合してしまう（2026-10-08レビュー指摘）。
    // ルーター側は常にスキップする（PCのみ対象）
    const sourceIsRouter = nodeKinds.get(edge.source) === 'router'
    const targetIsRouter = nodeKinds.get(edge.target) === 'router'

    // PC側のIPv4アドレスは、L2スイッチと違ってコンテナを持つのでclab-api-serverの
    // execで直接`ip addr add`できる（ovs-helperを経由しない。2026-10-07追加）
    if (!sourceIsSwitch && !sourceIsRouter && iface.sourceAddress) {
      addressTasks.push({ nodeName: sourceName, iface: iface.sourceIface, address: iface.sourceAddress })
    }
    if (!targetIsSwitch && !targetIsRouter && iface.targetAddress) {
      addressTasks.push({ nodeName: targetName, iface: iface.targetIface, address: iface.targetAddress })
    }
    // デフォルトゲートウェイ（2026-10-07追加）。プレーンなアドレス設定の時だけ意味がある
    if (!sourceIsSwitch && !sourceIsRouter && iface.sourceGateway) gatewayByNode.set(sourceName, iface.sourceGateway)
    if (!targetIsSwitch && !targetIsRouter && iface.targetGateway) gatewayByNode.set(targetName, iface.targetGateway)
    for (const sub of iface.sourceSubInterfaces ?? []) {
      subInterfaceTasks.push({ nodeName: sourceName, parentIface: iface.sourceIface, vlan: sub.vlan, address: sub.address })
    }
    for (const sub of iface.targetSubInterfaces ?? []) {
      subInterfaceTasks.push({ nodeName: targetName, parentIface: iface.targetIface, vlan: sub.vlan, address: sub.address })
    }

    portAnnotations[`${sourceName}:${sourcePort}`] = {
      iface: iface.sourceIface,
      vlan: iface.sourceVlan,
      address: iface.sourceAddress,
      gateway: iface.sourceGateway,
      subInterfaces: iface.sourceSubInterfaces,
    }
    portAnnotations[`${targetName}:${targetPort}`] = {
      iface: iface.targetIface,
      vlan: iface.targetVlan,
      address: iface.targetAddress,
      gateway: iface.targetGateway,
      subInterfaces: iface.targetSubInterfaces,
    }

    return { endpoints: [`${sourceName}:${sourcePort}`, `${targetName}:${targetPort}`] as [string, string] }
  })

  return {
    topologyContent: { name: labName, topology: { nodes: nodesMap, links } },
    vlanTasks,
    switchPorts,
    addressTasks,
    subInterfaceTasks,
    linuxNodeNames,
    gatewayByNode,
    routerClabNames,
    portAnnotations,
    switchOriginalIds,
  }
}

type DeployStatus = { kind: 'idle' } | { kind: 'deploying' } | { kind: 'success'; message: string } | { kind: 'error'; message: string }
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
  // プレーンなアドレス設定の時だけ表示するデフォルトゲートウェイの入力欄（2026-10-07追加）
  const [pendingSourceGateway, setPendingSourceGateway] = useState('')
  const [pendingTargetGateway, setPendingTargetGateway] = useState('')
  // ルーターがL2スイッチのトランクポートに接続している時だけ表示するrouter on a stick設定
  // （2026-10-07追加）。'plain'ならpendingSource/targetAddressのプレーンなアドレス設定、
  // 'vlan-subif'ならVLANごとのサブインターフェース一覧を使う（排他）
  const [pendingSourceMode, setPendingSourceMode] = useState<'plain' | 'vlan-subif'>('plain')
  const [pendingTargetMode, setPendingTargetMode] = useState<'plain' | 'vlan-subif'>('plain')
  const [pendingSourceSubIfaces, setPendingSourceSubIfaces] = useState<{ vlan: string; address: string }[]>([])
  const [pendingTargetSubIfaces, setPendingTargetSubIfaces] = useState<{ vlan: string; address: string }[]>([])
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
        const { nodes, edges, counters: parsedCounters } = parseImportedTopology(yamlText, annotationsText)
        setNodes(nodes)
        setEdges(edges)
        counters.current = parsedCounters
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
          openConsole(targetLabName, autoOpenConsoleNode, kind === 'router' ? ROUTER_CONSOLE_AUTO_COMMAND : undefined)
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
      setPendingSourceGateway('')
      setPendingTargetGateway('')
      setPendingSourceMode('plain')
      setPendingTargetMode('plain')
      setPendingSourceSubIfaces([])
      setPendingTargetSubIfaces([])
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
  const sourceGatewayResult = useMemo(() => parseIpv4Gateway(pendingSourceGateway), [pendingSourceGateway])
  const targetGatewayResult = useMemo(() => parseIpv4Gateway(pendingTargetGateway), [pendingTargetGateway])
  const sourceSubIfacesResult = useMemo(
    () => (pendingSourceMode === 'vlan-subif' ? parseSubInterfaceRows(pendingSourceSubIfaces) : {}),
    [pendingSourceMode, pendingSourceSubIfaces],
  )
  const targetSubIfacesResult = useMemo(
    () => (pendingTargetMode === 'vlan-subif' ? parseSubInterfaceRows(pendingTargetSubIfaces) : {}),
    [pendingTargetMode, pendingTargetSubIfaces],
  )

  const confirmConnection = useCallback(() => {
    if (!pendingConnection) return
    const { source, target, sourceHandle, targetHandle, editingEdgeId } = pendingConnection
    const newData: EdgeIfaceData = {
      sourceIface: pendingSourceIface,
      targetIface: pendingTargetIface,
      sourceVlan: sourceVlanResult.config,
      targetVlan: targetVlanResult.config,
      // router on a stick（'vlan-subif'）の時はプレーンなアドレス/ゲートウェイは設定しない（排他）
      sourceAddress: pendingSourceMode === 'plain' ? sourceAddressResult.address : undefined,
      targetAddress: pendingTargetMode === 'plain' ? targetAddressResult.address : undefined,
      sourceGateway: pendingSourceMode === 'plain' ? sourceGatewayResult.gateway : undefined,
      targetGateway: pendingTargetMode === 'plain' ? targetGatewayResult.gateway : undefined,
      sourceSubInterfaces: pendingSourceMode === 'vlan-subif' ? sourceSubIfacesResult.configs : undefined,
      targetSubInterfaces: pendingTargetMode === 'vlan-subif' ? targetSubIfacesResult.configs : undefined,
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
    sourceVlanResult,
    targetVlanResult,
    sourceAddressResult,
    targetAddressResult,
    sourceGatewayResult,
    targetGatewayResult,
    pendingSourceMode,
    pendingTargetMode,
    sourceSubIfacesResult,
    targetSubIfacesResult,
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
  // router on a stickのUIは「ルーター側が、L2スイッチに接続している時だけ」出す
  // （PC側には出さない。PCは通常インターVLANルーティングをしないため、2026-10-07追加）
  const sourceIsRouterOnStick = pendingConnection ? nodeKind(pendingConnection.source) === 'router' && targetIsSwitch : false
  const targetIsRouterOnStick = pendingConnection ? nodeKind(pendingConnection.target) === 'router' && sourceIsSwitch : false
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

  // パケットキャプチャ（WiresharkのnoVNCセッション）を開始する（2026-10-08追加）。
  // L2スイッチ側はコンテナを持たないため対象外（両端ともスイッチなら何もできない）。
  // deploy済みのノードでないとコンテナが無いので、deployedLabに含まれる側だけが対象
  const [captureStatus, setCaptureStatus] = useState<{ kind: 'idle' | 'starting' | 'error'; message?: string }>({
    kind: 'idle',
  })
  const onCaptureEdge = useCallback(
    async (edgeId: string) => {
      setContextMenu(null)
      const edge = edges.find((e) => e.id === edgeId)
      if (!edge || !deployedLab) return
      const data = (edge.data ?? {}) as Partial<EdgeIfaceData>
      const nodeInfo = (id: string) => nodes.find((n) => n.id === id)?.data as Partial<TopoNodeData> | undefined
      const shortLabelOf = (id: string) => (nodeInfo(id)?.shortLabel as string | undefined) ?? id
      const targets: CaptureTarget[] = []
      const labelsByContainer: Record<string, string> = {}
      if (nodeInfo(edge.source)?.kind !== 'l2-switch' && data.sourceIface && deployedLab.nodeIds.has(edge.source)) {
        targets.push({ containerName: edge.source, interfaceName: data.sourceIface })
        labelsByContainer[edge.source] = `${shortLabelOf(edge.source)}(${data.sourceIface}) ↔ ${shortLabelOf(edge.target)}`
      }
      if (nodeInfo(edge.target)?.kind !== 'l2-switch' && data.targetIface && deployedLab.nodeIds.has(edge.target)) {
        targets.push({ containerName: edge.target, interfaceName: data.targetIface })
        labelsByContainer[edge.target] = `${shortLabelOf(edge.target)}(${data.targetIface}) ↔ ${shortLabelOf(edge.source)}`
      }
      setCaptureStatus({ kind: 'starting' })
      try {
        await startPacketCapture(deployedLab.labName, targets, labelsByContainer)
        setCaptureStatus({ kind: 'idle' })
      } catch (e) {
        const message = e instanceof ApiError || e instanceof Error ? e.message : 'キャプチャの開始に失敗しました'
        setCaptureStatus({ kind: 'error', message })
      }
    },
    [edges, nodes, deployedLab],
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
      const sourceVlan = vlanConfigToModeAndValue(data.sourceVlan)
      const targetVlan = vlanConfigToModeAndValue(data.targetVlan)
      setPendingSourceVlanMode(sourceVlan.mode)
      setPendingSourceVlanValue(sourceVlan.value)
      setPendingTargetVlanMode(targetVlan.mode)
      setPendingTargetVlanValue(targetVlan.value)
      setPendingSourceAddress(data.sourceAddress ?? '')
      setPendingTargetAddress(data.targetAddress ?? '')
      setPendingSourceGateway(data.sourceGateway ?? '')
      setPendingTargetGateway(data.targetGateway ?? '')
      const sourceHasSubIfaces = !!data.sourceSubInterfaces?.length
      const targetHasSubIfaces = !!data.targetSubInterfaces?.length
      setPendingSourceMode(sourceHasSubIfaces ? 'vlan-subif' : 'plain')
      setPendingTargetMode(targetHasSubIfaces ? 'vlan-subif' : 'plain')
      // 保存済みannotationsが想定外の形式（配列でない等）だった場合にクラッシュしないよう
      // Array.isArray()で確認する（`??`はnull/undefinedしか拾わないため、2026-10-08レビュー指摘対応）
      setPendingSourceSubIfaces(
        (Array.isArray(data.sourceSubInterfaces) ? data.sourceSubInterfaces : []).map((s) => ({
          vlan: String(s.vlan),
          address: s.address,
        })),
      )
      setPendingTargetSubIfaces(
        (Array.isArray(data.targetSubInterfaces) ? data.targetSubInterfaces : []).map((s) => ({
          vlan: String(s.vlan),
          address: s.address,
        })),
      )
      setContextMenu(null)
    },
    [edges],
  )

  // トポロジエディタから直接、統合コンソールをワンタッチで開く（ラボ一覧に行かなくて済むように）。
  // deployedLabに載っているノード＝直近のdeployに含まれていたノードのみ開ける
  const openNodeConsole = useCallback(
    (nodeId: string) => {
      if (!deployedLab || !deployedLab.nodeIds.has(nodeId)) return
      // ルーターはCMLのように最初からvtyshを開いた状態にしておく
      const kind = (nodes.find((n) => n.id === nodeId)?.data as Partial<TopoNodeData> | undefined)?.kind
      openConsole(deployedLab.labName, nodeId, kind === 'router' ? ROUTER_CONSOLE_AUTO_COMMAND : undefined)
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
      const {
        topologyContent,
        vlanTasks,
        switchPorts,
        addressTasks,
        subInterfaceTasks,
        linuxNodeNames,
        gatewayByNode,
        routerClabNames,
        portAnnotations,
        switchOriginalIds,
      } = buildTopologyContent(nodes, edges, username, safeName)

      // containerlabはovs-bridge kindのブリッジを自動生成しないため、deploy前に
      // 自分でovs-vsctl add-brしておく必要がある（2026-10-06実機確認：
      // 「bridge "..." referenced in topology but does not exist」で失敗することが判明）。
      // 既に存在していてもエラーにならないので、reconfigure時も毎回呼んで問題ない
      const bridgeNames = nodes
        .filter((n) => n.type === 'topoNode' && (n.data as Partial<TopoNodeData>).kind === 'l2-switch')
        .map((n) => toClabBridgeName(username, safeName, n.id))
      await Promise.all(bridgeNames.map((bridge) => ensureBridge(bridge)))

      // ルーターのFRR設定ファイル（daemons/frr.conf/vtysh.conf）をbind mount先に用意する
      // （2026-10-07追加）。無いとdeploy自体がbind先不在で失敗する（実機確認済み）。
      // 既に存在する場合は上書きしない（学生がvtyshで`write memory`した設定を保つため）
      await Promise.all(routerClabNames.map((name) => ensureFrrConfig(safeName, name)))

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
      // （2026-10-06追加）。1件でも失敗したら成功メッセージにその旨を添える。
      // ensureBridge/resetPortと同じくPromise.allで並列実行する（2026-10-07レビュー指摘：
      // 直列だとポート数が増えるほどdeployが線形に遅くなっていた）
      const vlanResults = await Promise.allSettled(vlanTasks.map((task) => applyVlanConfig(safeName, task.port, task.config)))
      const vlanFailures = vlanResults
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason instanceof ApiError || r.reason instanceof Error ? r.reason.message : 'VLAN設定に失敗しました'))

      // PC/ルーターのIPv4アドレスもトポロジYAMLには無いため、deploy成功後にclab-api-serverの
      // execで`ip addr add`して別途投入する（2026-10-07追加。「PCのアドレシングが面倒」指摘対応）
      const addressResults = await Promise.allSettled(
        addressTasks.map(async (task) => {
          const result = await execInLab(safeName, task.nodeName, `ip addr add ${task.address} dev ${task.iface}`)
          assertExecOk(result, 'アドレス設定に失敗しました')
          return task
        }),
      )
      const addressFailures = addressResults.flatMap((r, i) => {
        if (r.status !== 'rejected') return []
        const task = addressTasks[i]
        const message = r.reason instanceof ApiError || r.reason instanceof Error ? r.reason.message : 'アドレス設定に失敗しました'
        return [`${task.nodeName}:${task.iface} ${message}`]
      })

      // router on a stick：VLANサブインターフェースのデバイス作成＋アドレス設定を
      // まとめてここで行う（2026-10-08再変更。vtyshにはカーネルのVLANデバイスを作成する
      // 機能が無いため作成自体はGUI側で必須だが、「デバイスだけGUIで作ってアドレスは
      // 別途CLIで」という2段階運用は煩雑で誤解を生みやすいという指摘を受けて、
      // GUIで完結させる方式に戻した。ルーターの通常のアドレス設定（「プレーン」モード）は
      // 引き続きvtyshのCLIで行う。docs/direction.md参照）。
      // execエンドポイントはシェルとして`&&`等を解釈するか未確認のため、安全側に倒して
      // 1コマンドずつ順番にexecする（タスクをまたいだ並列化はPromise.allSettledで行う）
      const subIfaceResults = await Promise.allSettled(
        subInterfaceTasks.map(async (task) => {
          const subIface = `${task.parentIface}.${task.vlan}`
          const runStep = async (command: string) => {
            const result = await execInLab(safeName, task.nodeName, command)
            assertExecOk(result, 'サブインターフェース設定に失敗しました')
          }
          await runStep(`ip link add link ${task.parentIface} name ${subIface} type vlan id ${task.vlan}`)
          await runStep(`ip link set ${subIface} up`)
          await runStep(`ip addr add ${task.address} dev ${subIface}`)
          return task
        }),
      )
      const subIfaceFailures = subIfaceResults.flatMap((r, i) => {
        if (r.status !== 'rejected') return []
        const task = subInterfaceTasks[i]
        const message = r.reason instanceof ApiError || r.reason instanceof Error ? r.reason.message : 'サブインターフェース設定に失敗しました'
        return [`${task.nodeName}:${task.parentIface}.${task.vlan} ${message}`]
      })

      // containerlabはmgmt用のeth0に`default via <docker bridge gw>`を自動設定するため、
      // ラボ内に意図した宛先への経路が無いと、そのままeth0経由で実際の外部ネットワークに
      // 出てしまう（2026-10-07実機確認：`traceroute`が本物のISPまで到達した）。
      // deploy後に全PC/ルーターでこのデフォルトルートを削除し、ゲートウェイが設定されている
      // ノードだけ明示的に`ip route add default via <gateway>`で設定し直す。
      // アドレス設定（上のaddressTasks/subInterfaceTasks）が先に終わっている必要がある
      // （ゲートウェイの接続先サブネットがまだ無いとadd defaultが失敗するため）。
      // `dev eth0`を明示して削除対象を絞る（2026-10-08レビュー指摘対応：`ip route del default`
      // だけだと、ルーターがvtyshのCLI＋`write memory`で設定した別デバイス経由のデフォルトルート
      // （FRR設定はdeploy時にzebraが読み込んで再設定する）まで誤って消してしまう恐れがあった。
      // `dev eth0`を付けてもcontainerlab自動設定のmgmtルートだけを狙い撃ちできることを実機確認済み）
      const routeResults = await Promise.allSettled(
        linuxNodeNames.map(async (name) => {
          // execは失敗してもHTTPとしては200で返ってくる（`return-code`で判定する必要がある、
          // addressTasks/subInterfaceTasksと同じ仕組み）。「既にデフォルトルートが無い」場合は
          // `ip route del default`が`No such process`で失敗するのが正常なので無視する
          const delResult = await execInLab(safeName, name, 'ip route del default dev eth0')
          const [delFirst] = Object.values(delResult).flat()
          if (!delFirst || (delFirst['return-code'] !== 0 && !(delFirst.stderr ?? '').includes('No such process'))) {
            throw new Error((delFirst?.stderr ?? '').trim() || 'デフォルトルートの削除に失敗しました')
          }
          const gateway = gatewayByNode.get(name)
          if (gateway) {
            const addResult = await execInLab(safeName, name, `ip route add default via ${gateway}`)
            assertExecOk(addResult, 'ゲートウェイ設定に失敗しました')
          }
          return name
        }),
      )
      const routeFailures = routeResults.flatMap((r, i) => {
        if (r.status !== 'rejected') return []
        const name = linuxNodeNames[i]
        const message = r.reason instanceof ApiError || r.reason instanceof Error ? r.reason.message : 'ルート設定に失敗しました'
        return [`${name}: ${message}`]
      })

      const failureSuffixes = [
        vlanFailures.length > 0 ? `VLAN設定に失敗: ${vlanFailures.join(' / ')}` : '',
        addressFailures.length > 0 ? `アドレス設定に失敗: ${addressFailures.join(' / ')}` : '',
        subIfaceFailures.length > 0 ? `サブインターフェース設定に失敗: ${subIfaceFailures.join(' / ')}` : '',
        routeFailures.length > 0 ? `ルート設定に失敗: ${routeFailures.join(' / ')}` : '',
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
      putLabAnnotations(safeName, serializeAnnotations(nodes, portAnnotations, switchOriginalIds)).catch((err: unknown) => {
        console.warn('ノード配置の保存に失敗しました', err)
      })
    } catch (e) {
      const message = e instanceof ApiError || e instanceof Error ? e.message : 'deployに失敗しました'
      setDeployStatus({ kind: 'error', message })
    }
  }, [nodes, edges, username, labName, isRedeploy])

  // デプロイ済みラボのYAML（＋annotations）をダウンロードする（2026-10-08追加、
  // 「授業で使うテンプレートを配布しやすく」指摘対応）。サーバーから改めて取得することで、
  // 今の編集中の未deploy変更ではなく「実際にdeployされている内容」を正確にエクスポートする
  const [exportStatus, setExportStatus] = useState<{ kind: 'idle' | 'exporting' | 'error'; message?: string }>({
    kind: 'idle',
  })
  const onExport = useCallback(async () => {
    if (!deployedLab) return
    setExportStatus({ kind: 'exporting' })
    try {
      const yamlText = await getLabTopologyYaml(deployedLab.labName)
      const annotationsText = await getLabAnnotations(deployedLab.labName).catch(() => null)
      downloadTextFile(`${deployedLab.labName}.clab.yml`, yamlText)
      if (annotationsText) downloadTextFile(`${deployedLab.labName}.clab.yml.annotations.json`, annotationsText)
      setExportStatus({ kind: 'idle' })
    } catch (e) {
      const message = e instanceof ApiError || e instanceof Error ? e.message : 'エクスポートに失敗しました'
      setExportStatus({ kind: 'error', message })
    }
  }, [deployedLab])

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
            title="他の人がエクスポートしたYAML（＋annotations）を読み込んで新規ラボとして編集を始めます"
          >
            インポート
          </button>
          <button
            onClick={onExport}
            disabled={!deployedLab || exportStatus.kind === 'exporting'}
            title={deployedLab ? 'deploy済みのYAML（＋annotations）をダウンロードします' : 'deployしてから使えます'}
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
              <button onClick={() => editEdge(contextMenu.edgeId)}>設定を編集</button>
              <button
                onClick={() => void onCaptureEdge(contextMenu.edgeId)}
                disabled={!deployedLab || captureStatus.kind === 'starting'}
                title={deployedLab ? 'このリンクのパケットキャプチャを別タブで開きます（L2スイッチ側は対象外）' : 'deployしてから使えます'}
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
                  {!sourceIsSwitch && sourceIsRouterOnStick && (
                    <div className="topology-editor__modal-vlan">
                      <select value={pendingSourceMode} onChange={(e) => setPendingSourceMode(e.target.value as 'plain' | 'vlan-subif')}>
                        <option value="plain">プレーン（追加設定なし、IPはCLIで）</option>
                        <option value="vlan-subif">VLANサブインターフェース（router on a stick）</option>
                      </select>
                    </div>
                  )}
                  {!sourceIsSwitch && !sourceIsRouter && pendingSourceMode === 'plain' && (
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
                  {!sourceIsSwitch && sourceIsRouterOnStick && pendingSourceMode === 'vlan-subif' && (
                    <div className="topology-editor__modal-vlan">
                      {pendingSourceSubIfaces.map((row, i) => (
                        <div key={i} className="topology-editor__modal-subif-row">
                          <input
                            value={row.vlan}
                            onChange={(e) =>
                              setPendingSourceSubIfaces((rows) => rows.map((r, j) => (j === i ? { ...r, vlan: e.target.value } : r)))
                            }
                            placeholder="VLAN ID"
                          />
                          <input
                            value={row.address}
                            onChange={(e) =>
                              setPendingSourceSubIfaces((rows) => rows.map((r, j) => (j === i ? { ...r, address: e.target.value } : r)))
                            }
                            placeholder="10.10.0.1/24"
                          />
                          <button onClick={() => setPendingSourceSubIfaces((rows) => rows.filter((_, j) => j !== i))}>×</button>
                        </div>
                      ))}
                      <button onClick={() => setPendingSourceSubIfaces((rows) => rows.concat({ vlan: '', address: '' }))}>
                        + サブインターフェースを追加
                      </button>
                      {sourceSubIfacesResult.error && <span className="topology-editor__modal-warn">{sourceSubIfacesResult.error}</span>}
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
                  {!targetIsSwitch && targetIsRouterOnStick && (
                    <div className="topology-editor__modal-vlan">
                      <select value={pendingTargetMode} onChange={(e) => setPendingTargetMode(e.target.value as 'plain' | 'vlan-subif')}>
                        <option value="plain">プレーン（追加設定なし、IPはCLIで）</option>
                        <option value="vlan-subif">VLANサブインターフェース（router on a stick）</option>
                      </select>
                    </div>
                  )}
                  {!targetIsSwitch && !targetIsRouter && pendingTargetMode === 'plain' && (
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
                  {!targetIsSwitch && targetIsRouterOnStick && pendingTargetMode === 'vlan-subif' && (
                    <div className="topology-editor__modal-vlan">
                      {pendingTargetSubIfaces.map((row, i) => (
                        <div key={i} className="topology-editor__modal-subif-row">
                          <input
                            value={row.vlan}
                            onChange={(e) =>
                              setPendingTargetSubIfaces((rows) => rows.map((r, j) => (j === i ? { ...r, vlan: e.target.value } : r)))
                            }
                            placeholder="VLAN ID"
                          />
                          <input
                            value={row.address}
                            onChange={(e) =>
                              setPendingTargetSubIfaces((rows) => rows.map((r, j) => (j === i ? { ...r, address: e.target.value } : r)))
                            }
                            placeholder="10.10.0.2/24"
                          />
                          <button onClick={() => setPendingTargetSubIfaces((rows) => rows.filter((_, j) => j !== i))}>×</button>
                        </div>
                      ))}
                      <button onClick={() => setPendingTargetSubIfaces((rows) => rows.concat({ vlan: '', address: '' }))}>
                        + サブインターフェースを追加
                      </button>
                      {targetSubIfacesResult.error && <span className="topology-editor__modal-warn">{targetSubIfacesResult.error}</span>}
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
                      (pendingSourceMode === 'plain'
                        ? !!sourceAddressResult.error || !!sourceGatewayResult.error
                        : !!sourceSubIfacesResult.error) ||
                      (pendingTargetMode === 'plain'
                        ? !!targetAddressResult.error || !!targetGatewayResult.error
                        : !!targetSubIfacesResult.error)
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
