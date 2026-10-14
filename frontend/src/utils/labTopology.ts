// トポロジ（React Flowのnodes/edges）とcontainerlabのトポロジ・各ノードの設定コマンドの相互変換。
// 元はTopologyEditor.tsxの中にあったが、自動保存＋差分反映（2026-10-14）でホーム画面の「起動」からも
// 同じ設定投入を行う必要が出たため切り出した（utils/labRuntime.ts参照）。
import type { Node, Edge } from '@xyflow/react'
import { dump as dumpYaml } from 'js-yaml'
import type { TopoNodeData } from '../components/TopologyNode'
import { PALETTE_NODE_CONFIGS, type PaletteNodeKind } from '../types/lab'
import { parseTopologyYaml } from './topologyFromYaml'
import { applyAnnotations, applyPortAnnotations, restoreSwitchIdentities } from './annotations'
import type { ExecResponse, TopologyContent } from '../api/client'

// リンクの両端に割り当てるインターフェース名。エッジの `data` にノードごとの
// 実際のインターフェース名を保持する（CMLのようにユーザーが接続時に選べるようにするため、
// 配列の並び順から機械的に決めるのではなく、エッジ自身のデータとして持たせる）。
export interface EdgeIfaceData {
  sourceIface: string
  targetIface: string
  // スイッチのVLANは2026-10-14からスイッチのCLI（swcli）で設定する。それ以前に作ったラボの
  // エッジにはsourceVlan/targetVlanが残っていることがあるが、使わない
  // PC/ルーター側にだけ意味がある（L2スイッチ側は常にundefined。スイッチはL2なのでIPは持たない）。
  // "10.0.0.1/24"形式のCIDR文字列。アドレス設定もトポロジYAMLには無く、deploy後に
  // clab-api-serverのexec経由で`ip addr add`して別途投入する（2026-10-07追加、
  // 「PCのアドレシングが面倒」指摘対応。docs/direction.md参照）
  sourceAddress?: string
  targetAddress?: string
  // PC側だけ意味がある。デフォルトゲートウェイ（単純なIPv4アドレス、プレフィックス無し）。設定するとdeploy後に
  // `ip route add default via <gateway>`を実行する（2026-10-07追加。「ラボ内の宛先が
  // 自動的に外部に飛んでしまう」指摘対応。docs/direction.md参照）
  sourceGateway?: string
  targetGateway?: string
  [key: string]: unknown
}

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
export const CONTAINER_CAPABILITIES: Partial<Record<PaletteNodeKind, { privileged: false; capAdd: string[] }>> = {
  pc: { privileged: false, capAdd: ['NET_ADMIN'] },
  router: { privileged: false, capAdd: ['NET_ADMIN', 'NET_RAW', 'SYS_ADMIN'] },
  // L2スイッチ（コンテナ内のLinuxブリッジ、2026-10-13〜）はブリッジ/VLANの操作にNET_ADMINが要る
  'l2-switch': { privileged: false, capAdd: ['NET_ADMIN'] },
}

// コンテナを持つノードか。L2スイッチは2026-10-13からコンテナになったが、それ以前に作られた
// ラボを開いた直後はまだホストのOVS（ovs-bridge kind）のままでコンテナが無い
// （次にdeployした時点でコンテナのスイッチに置き換わる。buildTopologyContent参照）
export function hasContainer(data: Partial<TopoNodeData> | undefined): boolean {
  return !(data?.kind === 'l2-switch' && data.clabKind === 'ovs-bridge')
}

// React Flowのノード/エッジから、POST /api/v1/labs に渡す topologyContent を組み立てる。
// L2スイッチはコンテナになったため（2026-10-13）、ovs-bridge時代のようなホスト全体で共有の
// ブリッジ名・ポート名のハッシュ化は不要になり、全ノードともnode.idとUI上のI/F名をそのまま使う。

export interface AddressTask {
  nodeName: string
  iface: string
  address: string
}

// デプロイ後、トポロジYAMLをGETして再構築する時に備えて、ハッシュ化された実名（L2スイッチの
// ブリッジ名・ポート名）から、UI上で使っていた分かりやすい名前・VLAN・アドレス設定を
// 引き戻すためのマップ。`${実際にYAMLに書かれるclabName}:${実際のポート名}`をキーにする
// （endpointsの文字列そのものと同じ形なので、再読み込み時にそのまま突き合わせられる）。
// containerlabのトポロジYAML自体にはこれらの情報を置けないため、annotations.tsの保存先に
// 載せて一緒に永続化する（2026-10-07追加。再読み込み後にL2スイッチ接続のI/F名が
// 文字化けのように見える・VLAN/アドレス設定が消える、の両方の修正）
export interface PortAnnotation {
  iface: string
  address?: string
  // デフォルトゲートウェイ（2026-10-07追加）
  gateway?: string
}

// containerlabのトポロジYAML（＋任意でannotations JSON）からReact Flowのnodes/edgesを復元する。
// 「既存ラボをエディタで開く」（サーバーから取得）と「YAMLファイルをインポート」（ローカルの
// ファイルを読む）の両方で同じ復元ロジックを使うため共通化した（2026-10-08追加、YAML
// export/import機能）。annotationsが無い場合は座標・VLAN/アドレス設定の復元をスキップし、
// グリッド配置のまま進める（他ユーザーが作ったYAMLをインポートする場合、annotationsは
// 無いのが普通）
export function parseImportedTopology(
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

// execInLab()の結果を見てエラーなら投げる。execはコマンド自体が失敗してもHTTPとしては200で
// 返ってくるため`return-code`で判定する必要がある（ノードごとの設定コマンド等/
// routeResultsで共通して必要なロジックなのでまとめた、2026-10-08レビュー指摘対応）。
// 対象ノードが見つからず`result`が空オブジェクトになるケース（firstResultがundefined）も
// 「結果が取れなかった＝失敗」として扱う（以前はここが抜けていて、execが実質的に
// 何も実行できなかった場合でも静かに成功扱いになっていた）
export function assertExecOk(result: ExecResponse, failureMessage: string) {
  const [firstResult] = Object.values(result).flat()
  if (!firstResult || firstResult['return-code'] !== 0) {
    throw new Error((firstResult?.stderr ?? '').trim() || failureMessage)
  }
}

export function buildTopologyContent(
  nodes: Node[],
  edges: Edge[],
  labName: string,
): {
  topologyContent: TopologyContent
  addressTasks: AddressTask[]
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
  // ovs-bridge時代はスイッチ名をハッシュ化していたため、node.id→実名の対応をannotationsに保存して
  // 再読み込み時に戻していた（restoreSwitchIdentities）。今は実名＝node.idだが、古いラボの
  // 読み込みと形式を揃えるため引き続き保存する（中身は恒等写像）
  const switchOriginalIds: Record<string, string> = {}

  // ラベル（labelNode）はトポロジ上のメモに過ぎずcontainerlabのノードではないため除外する
  const deviceNodes = nodes.filter((n) => n.type === 'topoNode')

  for (const node of deviceNodes) {
    const data = node.data as Partial<TopoNodeData>
    if (!data.kind || !data.clabKind) {
      throw new Error(`ノード「${node.id}」の種別情報が無く、deployできません（パレットから配置し直してください）`)
    }
    const clabName = node.id
    // L2スイッチとルーターは常に現在のパレット定義のイメージで起動する。古いラボのovs-bridgeの
    // スイッチ（2026-10-13〜）や、エージェントの無いFRR公式イメージのルーター（2026-10-14〜）もここで置き換わる
    const kindConfig =
      data.kind === 'l2-switch' || data.kind === 'router' ? PALETTE_NODE_CONFIGS[data.kind] : { clabKind: data.clabKind, image: data.image }
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
      kind: kindConfig.clabKind,
      ...(kindConfig.image ? { image: kindConfig.image } : {}),
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

  const addressTasks: AddressTask[] = []
  const gatewayByNode = new Map<string, string>()
  const portAnnotations: Record<string, PortAnnotation> = {}

  const links = edges.map((edge) => {
    const sourceName = clabNodeNames.get(edge.source)
    const targetName = clabNodeNames.get(edge.target)
    const iface = edge.data as Partial<EdgeIfaceData> | undefined
    if (!sourceName || !targetName || !iface?.sourceIface || !iface?.targetIface) {
      throw new Error(`リンク「${edge.id}」のインターフェース情報が見つかりません`)
    }

    const sourceIsSwitch = nodeKinds.get(edge.source) === 'l2-switch'
    const targetIsSwitch = nodeKinds.get(edge.target) === 'l2-switch'
    const sourcePort = iface.sourceIface
    const targetPort = iface.targetIface

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

    portAnnotations[`${sourceName}:${sourcePort}`] = {
      iface: iface.sourceIface,
      address: iface.sourceAddress,
      gateway: iface.sourceGateway,
    }
    portAnnotations[`${targetName}:${targetPort}`] = {
      iface: iface.targetIface,
      address: iface.targetAddress,
      gateway: iface.targetGateway,
    }

    return { endpoints: [`${sourceName}:${sourcePort}`, `${targetName}:${targetPort}`] as [string, string] }
  })

  return {
    topologyContent: { name: labName, topology: { nodes: nodesMap, links } },
    addressTasks,
    linuxNodeNames,
    gatewayByNode,
    routerClabNames,
    portAnnotations,
    switchOriginalIds,
  }
}

// containerlabのトポロジYAML（PUT /topology/yaml で保存する本文）。
// cap-addの配列を複数ノードで共有しているため、noRefsを付けないとYAMLアンカー（&ref_0）になる
export function topologyToYaml(content: TopologyContent): string {
  return dumpYaml(content, { noRefs: true })
}

// ---------------------------------------------------------------------------
// ノードごとの設定コマンド（2026-10-14、自動保存＋差分反映のため追加）
//
// 以前はdeploy直後にだけ「アドレス追加」「eth0のデフォルトルート削除」等
// を個別にexecしていた。差分反映ではノードを作り直さないため、
// 設定が変わったノードにだけ「あるべき状態」を入れ直す必要がある。そこでノードごとに
// 何度実行しても同じ結果になる1本のコマンドにまとめ、前回投入したコマンドと文字列が
// 違うノード（＋新しく作られた/起動し直したノード）にだけ流す。
// ノードの停止→起動ではリンクは保たれるがコンテナ内の設定（アドレス）は消えるため
// （2026-10-14 CLIで確認）、起動後も同じコマンドを流し直す。
//
// execはシェルを介さず引数分割されるので`sh -c '...'`で包む。中に`'`を入れてはいけない
// I/F名・アドレスは入力時に形式を検証済みで、ここでも形式を確かめてから埋め込む。
// L2スイッチ（2026-10-14〜）とルーターのサブインターフェースは、それぞれのイメージ内のエージェントが
// CLIの設定から作るので、ここでは何もしない（backend/l2switch/、backend/frr-router/）。
// ---------------------------------------------------------------------------

const IFACE_PATTERN = /^eth[0-9]+$/
const CIDR_PATTERN = /^[0-9]{1,3}(\.[0-9]{1,3}){3}\/[0-9]{1,2}$/
const IPV4_PATTERN = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/

// PC：リンクのI/Fのアドレスを入れ直し、デフォルトルートを設定し直す。
// containerlabがeth0に付けるデフォルトルート（mgmt経由で本物の外部に出てしまう、2026-10-07）も
// ここで消える。PCのイメージ（alpine）のipはbusybox版なので`-f inet`で書く
function buildPcSyncCommand(ifaces: { iface: string; address?: string }[], gateway?: string): string {
  const lines = ['set -e', 'while ip route del default 2>/dev/null; do :; done']
  for (const { iface, address } of ifaces) {
    if (!IFACE_PATTERN.test(iface)) continue
    lines.push(`ip -f inet addr flush dev ${iface}`)
    if (address && CIDR_PATTERN.test(address)) lines.push(`ip addr add ${address} dev ${iface}`)
  }
  if (gateway && IPV4_PATTERN.test(gateway)) lines.push(`ip route add default via ${gateway}`)
  return `sh -c '${lines.join('; ')}'`
}

// ルーター：containerlabがeth0に付けるデフォルトルートの削除だけ。アドレス・ルート・
// VLANサブインターフェースはすべて学生がvtyshで設定する（2026-10-14〜。サブインターフェースの
// デバイスはルーターのイメージ内のエージェントが作る、backend/frr-router/）。
// `dev eth0`に限定するのは、vtyshで設定した別のデフォルトルートを消さないため（2026-10-08レビュー指摘）
const ROUTER_SYNC_COMMAND = `sh -c 'ip route del default dev eth0 2>/dev/null || true'`

// buildTopologyContent()の結果から、ノード（node.id）ごとの設定コマンドを作る
export function buildNodeSyncCommands(built: ReturnType<typeof buildTopologyContent>): Map<string, string> {
  const commands = new Map<string, string>()
  const routers = new Set(built.routerClabNames)
  for (const name of routers) {
    commands.set(name, ROUTER_SYNC_COMMAND)
  }
  for (const name of built.linuxNodeNames) {
    if (routers.has(name)) continue
    const ifaces = Object.entries(built.portAnnotations)
      .filter(([key]) => key.startsWith(`${name}:`))
      .map(([, port]) => ({ iface: port.iface, address: port.address }))
    commands.set(name, buildPcSyncCommand(ifaces, built.gatewayByNode.get(name)))
  }
  return commands
}
