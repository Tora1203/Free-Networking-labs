// ラボの起動・ノード設定の投入（2026-10-14、自動保存＋差分反映への移行で追加）。
// トポロジエディタとホーム画面の「起動」で共通に使う。
//
// 起動はPOST /apply で行う：一度も起動していないラボはdeploy、停止中のラボは起動、
// 動いているラボは差分だけ反映する（containerlab apply、api-contract.md 2.7）。
// どの場合もコンテナ内の設定（スイッチのVLAN・PCのアドレス等）はトポロジYAMLに無いので、
// 起動後にノードごとの設定コマンド（labTopology.tsのbuildNodeSyncCommands）を流す。
import {
  ApiError,
  applyLab,
  deleteLabFile,
  destroyLab,
  execInLab,
  getLabAnnotations,
  getLabs,
  getLabTopologyFiles,
  getLabTopologyYaml,
  putLabAnnotations,
  putLabTopologyYaml,
  resetNetem,
  restartNode,
  setNetem,
  showNetem,
  startNode,
  stopNode,
  type ApplyResponse,
  type TopologyContent,
} from '../api/client'
import { ensureFrrConfig, ensureSwitchConfig } from '../api/ovsHelperClient'
import { readLabTitle, serializeAnnotations } from './annotations'
import type { PaletteNodeKind } from '../types/lab'
import { assertExecOk, buildNodeSyncCommands, buildTopologyContent, buildWipeCommand, parseImportedTopology, topologyToYaml } from './labTopology'
import { netemKey, netemKeyFromShow } from './linkCondition'
import { getLabDisplayName, labTitleKey } from './labName'
import {
  SNAPSHOT_LIMIT,
  buildReadConfigCommand,
  buildSnapshotFiles,
  buildWriteConfigCommand,
  decodeConfigOutput,
  isSnapshotLabName,
  parseSnapshotLabName,
  readSnapshotMeta,
  snapshotLabName,
  stripSnapshotMeta,
  type NodeConfig,
  type SnapshotMeta,
} from './snapshot'

type BuiltTopology = ReturnType<typeof buildTopologyContent>

export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError || e instanceof Error ? e.message : fallback
}

// 指定ノードに設定コマンドを流す。成功したノードと失敗の説明を返す（失敗しても他は続ける）
export async function runNodeSyncs(
  labName: string,
  commands: Map<string, string>,
  nodeIds: Iterable<string>,
): Promise<{ succeeded: Map<string, string>; failures: string[] }> {
  const targets = [...new Set(nodeIds)].filter((id) => commands.has(id))
  const results = await Promise.allSettled(
    targets.map(async (id) => {
      const command = commands.get(id) as string
      assertExecOk(await execInLab(labName, id, command), '設定の投入に失敗しました')
      return command
    }),
  )
  const succeeded = new Map<string, string>()
  const failures: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') succeeded.set(targets[i], r.value)
    else failures.push(`${targets[i]}: ${errorMessage(r.reason, '設定の投入に失敗しました')}`)
  })
  return { succeeded, failures }
}

// applyの結果のうち、コンテナが新しく作られた/起動し直した（＝中の設定が空の）ノード
export function freshNodesOf(result: ApplyResponse): string[] {
  return [...(result.addedNodes ?? []), ...(result.recreatedNodes ?? []), ...(result.startedNodes ?? []), ...(result.restartedNodes ?? [])]
}

// ルーター・スイッチのbind mount先（frr-config/<router>/、switch-config/<switch>/）をapplyより前に
// 用意する。既存のファイルは上書きされない
export async function prepareNodeConfigs(labName: string, built: { routerClabNames: string[]; switchClabNames: string[] }) {
  await Promise.all([
    ...built.routerClabNames.map((name) => ensureFrrConfig(labName, name)),
    ...built.switchClabNames.map((name) => ensureSwitchConfig(labName, name)),
  ])
}

// 保存済みのトポロジでラボを起動し、全ノードに設定を流す（ホーム画面の「起動」用。
// エディタは自分の編集内容から同じことをする）。
// 2026-10-13以前に作ったラボはスイッチがovs-bridgeのまま他ノードのコンテナが残っていることがあり、
// その場合はapplyが種別の不一致で失敗するため、一度破棄してからapplyし直す
// （停止中のラボの破棄なので、write memoryしたルーター設定はfrr-configに残る）
export async function startSavedLab(labName: string): Promise<{ commands: Map<string, string>; synced: Map<string, string>; failures: string[] }> {
  const yamlText = await getLabTopologyYaml(labName)
  const annotationsText = await getLabAnnotations(labName).catch(() => null)
  const { nodes, edges } = parseImportedTopology(yamlText, annotationsText)
  const built = buildTopologyContent(nodes, edges, labName)
  // 古い形式（ovs-bridgeのスイッチ、設定の保存先の無いスイッチ等）のラボはここで今の形式に書き直してから起動する
  const normalizedYaml = topologyToYaml(built.topologyContent)
  const isOldFormat = normalizedYaml !== yamlText
  await putLabTopologyYaml(labName, normalizedYaml)
  await putLabAnnotations(
    labName,
    serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds, readLabTitle(annotationsText)),
  )
  await prepareNodeConfigs(labName, built)
  // 停止中のコンテナが古い定義のままだと、applyはそれをそのまま起動するだけのことがある
  // （例：switch-configのbind mountが付かず、スイッチのwrite memoryがホストに残らない）。
  // 停止中のラボを破棄しても失うものは無い（ルーターのwrite memoryはfrr-configに残る）ので作り直す
  if (isOldFormat) await destroyLab(labName).catch(() => undefined)
  try {
    await applyLab(labName)
  } catch (e) {
    console.warn('applyに失敗したため、破棄してから起動し直します', e)
    await destroyLab(labName).catch(() => undefined)
    await applyLab(labName)
  }
  const commands = buildNodeSyncCommands(built)
  const { succeeded, failures } = await runNodeSyncs(labName, commands, commands.keys())
  const allNodes = [...built.neighbors.keys(), ...commands.keys()]
  const linkFailures = await applyLinkConditions(labName, built, new Set(allNodes), allNodes, newLinkRuntimeState())
  return { commands, synced: succeeded, failures: [...failures, ...linkFailures] }
}

// ---------------------------------------------------------------------------
// リンクの品質（netem）とケーブルの抜き差し（2026-10-14追加、utils/linkCondition.ts）
// ---------------------------------------------------------------------------

// 最後に入れたリンクの状態。netem：`${node}:${iface}`→netemKey（''＝設定なし）、
// routerUnplugged：downにしたルーターの端（`${node}:${iface}`）
export interface LinkRuntimeState {
  netem: Map<string, string>
  routerUnplugged: Set<string>
}

export function newLinkRuntimeState(): LinkRuntimeState {
  return { netem: new Map(), routerUnplugged: new Set() }
}

function splitPortKey(key: string): [string, string] {
  const i = key.lastIndexOf(':')
  return [key.slice(0, i), key.slice(i + 1)]
}

function routerUnpluggedOf(built: BuiltTopology): Set<string> {
  const routers = new Set(built.routerClabNames)
  const result = new Set<string>()
  for (const [node, ifaces] of built.unpluggedByNode) {
    if (routers.has(node)) for (const iface of ifaces) result.add(`${node}:${iface}`)
  }
  return result
}

// clab-api-serverはnetemの操作をラボごとに1つずつしか受け付けず、同時に呼ぶと
// 「Lab 'x' is busy with netem operation.」で断られる（2026-10-14、ブラウザでの確認で判明）。
// そのためnetemの呼び出しは1つずつ順番に行い、別のタブ等と重なって断られた時は少し待って呼び直す
const NETEM_BUSY_RETRIES = 8
async function netemCall<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (e) {
      if (attempt >= NETEM_BUSY_RETRIES || !/busy/i.test(errorMessage(e, ''))) throw e
      await new Promise((resolve) => setTimeout(resolve, 300 + attempt * 200))
    }
  }
}

// 動いているノードのリンクの端に、品質の設定を入れる（前回入れた値と違う端だけ）。
// freshは中身が初期状態に戻ったノード（新しく作られた・起動し直した）で、その隣のノードも
// リンクの相手側の端が作り直されていることがあるので一緒に入れ直す。
// ケーブルのdownはノードごとの設定コマンド（buildNodeSyncCommands）が入れるので、ここでは
// ルーターの端を差し直した時に上げるだけ。stateは呼び出し側が持ち続け、ここで更新する
export async function applyLinkConditions(
  labName: string,
  built: BuiltTopology,
  running: Set<string>,
  fresh: Iterable<string>,
  state: LinkRuntimeState,
): Promise<string[]> {
  const freshSet = new Set<string>()
  for (const node of fresh) {
    freshSet.add(node)
    for (const neighbor of built.neighbors.get(node) ?? []) freshSet.add(neighbor)
  }
  // netemは1つずつ順番に（netemCall参照）、ルーターの差し直し（exec）はまとめて並行に行う
  const netemJobs: (() => Promise<void>)[] = []
  const tasks: Promise<void>[] = []
  const failures: string[] = []
  const linkPorts = new Set(Object.keys(built.portAnnotations))
  for (const key of state.netem.keys()) {
    if (!linkPorts.has(key) || !running.has(splitPortKey(key)[0])) state.netem.delete(key)
  }
  for (const key of linkPorts) {
    const [node, iface] = splitPortKey(key)
    if (!running.has(node)) continue
    const params = built.netemByNode.get(node)?.[iface] ?? null
    const wanted = netemKey(params)
    const previous = freshSet.has(node) ? '' : (state.netem.get(key) ?? '')
    if (previous === wanted) {
      state.netem.set(key, wanted)
      continue
    }
    netemJobs.push(async () => {
      try {
        if (params) {
          await netemCall(() => setNetem(labName, node, iface, params))
        } else {
          // 何も設定されていないI/Fのresetはエラーになるので、busy以外の失敗は無視する
          await netemCall(() => resetNetem(labName, node, iface)).catch((e) => {
            if (/busy/i.test(errorMessage(e, ''))) throw e
          })
        }
        state.netem.set(key, wanted)
      } catch (e) {
        failures.push(`${node} ${iface}: ${errorMessage(e, 'リンクの品質を設定できませんでした')}`)
      }
    })
  }
  const routerUnplugged = routerUnpluggedOf(built)
  for (const key of state.routerUnplugged) {
    const [node, iface] = splitPortKey(key)
    if (routerUnplugged.has(key) || !running.has(node) || freshSet.has(node) || !/^eth[0-9]+$/.test(iface)) continue
    tasks.push(
      // assertExecOkが投げた時も失敗の一覧に入れる（then の第2引数では拾えず、保存全体の失敗になっていた）
      execInLab(labName, node, `sh -c 'ip link set ${iface} up'`)
        .then((r) => assertExecOk(r, 'ケーブルを差し直せませんでした'))
        .catch((e) => void failures.push(`${node} ${iface}: ${errorMessage(e, 'ケーブルを差し直せませんでした')}`)),
    )
  }
  state.routerUnplugged = routerUnplugged
  tasks.push(
    (async () => {
      for (const job of netemJobs) await job()
    })(),
  )
  await Promise.all(tasks)
  return failures
}

// エディタでラボを開いた時に、今入っている品質の設定を読む（ラボの外でノードが起動し直されて
// 消えている等の食い違いを、続くapplyLinkConditionsで直すため）。品質を設定したリンクがある
// ノードだけ問い合わせ、それ以外のノードは設定なしとみなす
export async function readLinkRuntimeState(labName: string, built: BuiltTopology, running: Set<string>): Promise<LinkRuntimeState> {
  const state = newLinkRuntimeState()
  state.routerUnplugged = routerUnpluggedOf(built)
  for (const key of Object.keys(built.portAnnotations)) {
    if (running.has(splitPortKey(key)[0])) state.netem.set(key, '')
  }
  // showも同じくラボごとに1つずつしか受け付けないので順番に呼ぶ
  for (const node of built.netemByNode.keys()) {
    if (!running.has(node)) continue
    try {
      const result = await netemCall(() => showNetem(labName, node))
      for (const info of Object.values(result).flat()) {
        if (info) state.netem.set(`${node}:${info.interface}`, netemKeyFromShow(info))
      }
    } catch {
      // 読めなければ設定なしとみなす（入れ直しになるだけ）
    }
  }
  return state
}

// ノード単位の起動/停止。nodeNameは短いノード名でよい（2026-10-14実機確認。コンテナの
// フルネームでも通る）。containerlabの「seamless dataplane」でリンクは保たれる
export const startLabNode = (labName: string, nodeName: string) => startNode(labName, nodeName)
export const stopLabNode = (labName: string, nodeName: string) => stopNode(labName, nodeName)

// 使われているラボのIDと、自分のラボの表示名（新しいラボの名前・表示名の変更が重ならないかを見る用、2026-10-15）。
// ids：保存済みのラボと、見えている動いているラボ（管理者には他のユーザーのものも見える）のID。
// titles：表示名（labTitleKeyで揃えたもの）→ そのラボのID
export async function listLabNames(): Promise<{ ids: Set<string>; titles: Map<string, string> }> {
  const [files, labs] = await Promise.all([getLabTopologyFiles(), getLabs()])
  const ids = new Set([...files.map((f) => f.labName), ...Object.keys(labs)])
  const titles = new Map<string, string>()
  const read = await Promise.all(
    files.map(async (f) => {
      const title = f.hasAnnotations ? await getLabAnnotations(f.labName).then(readLabTitle).catch(() => undefined) : undefined
      return [f.labName, title ?? getLabDisplayName(f.labName)] as const
    }),
  )
  // スナップショットのラボは元のラボの表示名を引き継ぐので、表示名の重なりの判定には入れない
  for (const [id, title] of read) if (!isSnapshotLabName(id)) titles.set(labTitleKey(title), id)
  return { ids, titles }
}

// ノードを初期状態に戻す（CMLのwipe）：保存した設定（write memory）を消し、コンテナを作り直す。
// 他のノードとリンクはそのまま。作り直したノードと、その隣のノードの設定（アドレス・ケーブル・リンクの品質）は
// 呼び出し側で流し直す（隣のノードも、つながっていたvethが作り直されるため、中の設定が消える）。
//
// 1. 止まっているノードは先に起動する（設定を消すコマンドを流すため）
// 2. 保存した設定を消す（labTopology.buildWipeCommand）
// 3. そのノードを除いたトポロジをapplyして、コンテナとリンクを消す
// 4. 元のトポロジに戻してapplyし、作り直す
// 3→4にするのは、POST /labs?reconfigure=true&nodeFilter=<ノード>（9/24に確認した方法）がAPI v0.6.0では
// 「ノードを消した後で、デプロイ済みのラボだとして失敗する」ため（2026-10-15確認。ノードが消えたまま残る）。
// 3の途中で失敗しても、元のトポロジは必ず保存し直す
export async function wipeLabNode(
  labName: string,
  built: BuiltTopology,
  nodeId: string,
  kind: PaletteNodeKind | undefined,
  running: boolean,
): Promise<ApplyResponse> {
  const command = buildWipeCommand(kind, nodeId)
  if (command) {
    if (!running) await startNode(labName, nodeId)
    assertExecOk(await execInLab(labName, nodeId, command), '保存した設定を消せませんでした')
  }
  // 設定の保存先が消えていないことを確かめてから作り直す（無いとbind mountでdeployが失敗する）
  await prepareNodeConfigs(labName, built)

  const full = built.topologyContent
  const without: TopologyContent = {
    ...full,
    topology: {
      ...full.topology,
      nodes: Object.fromEntries(Object.entries(full.topology.nodes).filter(([id]) => id !== nodeId)),
      links: full.topology.links.filter((l) => !l.endpoints.some((e) => e.split(':')[0] === nodeId)),
    },
  }
  try {
    await putLabTopologyYaml(labName, topologyToYaml(without))
    await applyLab(labName)
  } finally {
    await putLabTopologyYaml(labName, topologyToYaml(full))
  }
  return applyLab(labName)
}

// ---------------------------------------------------------------------------
// スナップショット（2026-10-18、utils/snapshot.ts・docs/snapshot-design.md）
// ---------------------------------------------------------------------------

export interface SnapshotEntry {
  // スナップショットのラボ名（`<ラボ>-snap-<日時>`）
  labName: string
  yamlFileName: string
  annotationsFileName: string
  meta: SnapshotMeta
}

// 元のラボのスナップショットを新しい順に返す。読めないもの（途中で失敗して壊れた等）は含めない
export async function listLabSnapshots(parentLab: string): Promise<SnapshotEntry[]> {
  const files = await getLabTopologyFiles()
  const mine = files.filter((f) => f.hasAnnotations && parseSnapshotLabName(f.labName)?.parent === parentLab)
  const entries = await Promise.all(
    mine.map(async (f): Promise<SnapshotEntry | null> => {
      const meta = readSnapshotMeta(await getLabAnnotations(f.labName).catch(() => null))
      return meta ? { labName: f.labName, yamlFileName: f.yamlFileName, annotationsFileName: f.annotationsFileName, meta } : null
    }),
  )
  return entries.filter((e): e is SnapshotEntry => e !== null).sort((a, b) => b.meta.createdAt.localeCompare(a.meta.createdAt))
}

export async function deleteLabSnapshot(entry: Pick<SnapshotEntry, 'labName' | 'yamlFileName' | 'annotationsFileName'>): Promise<void> {
  if (entry.annotationsFileName) await deleteLabFile(entry.labName, entry.annotationsFileName).catch(() => undefined)
  await deleteLabFile(entry.labName, entry.yamlFileName)
}

// 元のラボを消す時に、そのスナップショットもまとめて消す（保存済みラボの一覧から探す。中身は読まない）
export async function deleteSnapshotsOf(parentLab: string, files: { labName: string; yamlFileName: string; annotationsFileName: string; hasAnnotations: boolean }[]) {
  const mine = files.filter((f) => parseSnapshotLabName(f.labName)?.parent === parentLab)
  await Promise.all(
    mine.map((f) => deleteLabSnapshot({ labName: f.labName, yamlFileName: f.yamlFileName, annotationsFileName: f.hasAnnotations ? f.annotationsFileName : '' })),
  )
}

// 動いているルーター・スイッチに write memory 相当を代行させ、保存された設定の全文を集める。
// 取れなかったノード（停止中など）はskippedに入れる。PCには保存する設定が無い
export async function readNodeConfigs(
  labName: string,
  built: Pick<BuiltTopology, 'routerClabNames' | 'switchClabNames'>,
): Promise<{ configs: Record<string, NodeConfig>; skipped: string[] }> {
  const targets = [
    ...built.routerClabNames.map((name) => ({ name, kind: 'router' as const })),
    ...built.switchClabNames.map((name) => ({ name, kind: 'l2-switch' as const })),
  ]
  const configs: Record<string, NodeConfig> = {}
  const skipped: string[] = []
  const results = await Promise.allSettled(
    targets.map(async ({ name, kind }) => {
      const result = await execInLab(labName, name, buildReadConfigCommand(kind))
      assertExecOk(result, '設定を読めませんでした')
      const stdout = decodeConfigOutput(Object.values(result).flat()[0]?.stdout ?? '')
      // ルーターのfrr.confが空なのは異常（write memoryが走っていない）。スイッチの空は初期状態
      if (kind === 'router' && stdout.trim() === '') throw new Error('設定が空でした')
      return stdout
    }),
  )
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') configs[targets[i].name] = { kind: targets[i].kind, text: r.value }
    else skipped.push(targets[i].name)
  })
  return { configs, skipped }
}

// 今の状態のスナップショットを取る。呼び出し側は、取る前に編集内容の保存を済ませておく（保存済みのYAMLを写すため）。
// 上限に達していたら、autoなら自動で取った古いものを1つ消して入れ、そうでなければ断る
export async function createLabSnapshot(
  labName: string,
  built: Pick<BuiltTopology, 'routerClabNames' | 'switchClabNames'>,
  input: { title: string; note: string; auto?: boolean },
): Promise<SnapshotEntry> {
  const existing = await listLabSnapshots(labName)
  if (existing.length >= SNAPSHOT_LIMIT) {
    const oldestAuto = input.auto ? [...existing].reverse().find((e) => e.meta.auto) : undefined
    if (!oldestAuto) {
      throw new Error(`スナップショットは1つのラボに${SNAPSHOT_LIMIT}個までです。不要なものを削除してください`)
    }
    await deleteLabSnapshot(oldestAuto)
  }
  const [yamlText, annotationsText] = await Promise.all([getLabTopologyYaml(labName), getLabAnnotations(labName).catch(() => null)])
  const { configs, skipped } = await readNodeConfigs(labName, built)
  const name = snapshotLabName(labName)
  const files = buildSnapshotFiles(name, yamlText, annotationsText, { ...input, configs, skipped })
  await putLabTopologyYaml(name, files.yaml)
  try {
    await putLabAnnotations(name, files.annotations)
  } catch (e) {
    // 設定を持たない半端なスナップショットを残さない
    await deleteLabFile(name, `${name}.clab.yml`).catch(() => undefined)
    throw e
  }
  return { labName: name, yamlFileName: `${name}.clab.yml`, annotationsFileName: `${name}.clab.yml.annotations.json`, meta: files.meta }
}

// スナップショットのYAMLとannotations（snapshotキーを除く）を読む
export async function loadLabSnapshot(entry: SnapshotEntry): Promise<{ yaml: string; annotations: string }> {
  const [yaml, annotations] = await Promise.all([getLabTopologyYaml(entry.labName), getLabAnnotations(entry.labName)])
  return { yaml, annotations: stripSnapshotMeta(annotations) }
}

// 動いているノードに、スナップショットの設定を書き戻して再起動する（実機の電源を入れ直すのと同じ。
// ルーターはfrr.conf、スイッチはstartup.json→running.jsonを起動時に読む）。
// 設定を取れなかったノード（meta.configsに無いもの）には触らない。戻したノードのclabNameを返す
export async function restoreNodeConfigs(
  labName: string,
  configs: Record<string, NodeConfig>,
  running: Set<string>,
): Promise<{ restored: string[]; failures: string[] }> {
  const targets = Object.entries(configs).filter(([name]) => running.has(name))
  const restored: string[] = []
  const failures: string[] = []
  await Promise.all(
    targets.map(async ([name, config]) => {
      try {
        assertExecOk(await execInLab(labName, name, buildWriteConfigCommand(config.kind, config.text)), '設定を書き戻せませんでした')
        await restartNode(labName, name)
        restored.push(name)
      } catch (e) {
        failures.push(`${name}: ${errorMessage(e, '設定を戻せませんでした')}`)
      }
    }),
  )
  return { restored, failures }
}
