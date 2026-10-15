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
  destroyLab,
  execInLab,
  getLabAnnotations,
  getLabs,
  getLabTopologyFiles,
  getLabTopologyYaml,
  putLabAnnotations,
  putLabTopologyYaml,
  resetNetem,
  setNetem,
  showNetem,
  startNode,
  stopNode,
  wipeNode,
  type ApplyResponse,
} from '../api/client'
import { ensureFrrConfig, ensureSwitchConfig } from '../api/ovsHelperClient'
import { readLabTitle, serializeAnnotations } from './annotations'
import type { PaletteNodeKind } from '../types/lab'
import { assertExecOk, buildNodeSyncCommands, buildTopologyContent, buildWipeCommand, parseImportedTopology, topologyToYaml } from './labTopology'
import { netemKey, netemKeyFromShow } from './linkCondition'
import { getLabDisplayName, labTitleKey } from './labName'

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
  for (const [id, title] of read) titles.set(labTitleKey(title), id)
  return { ids, titles }
}

// ノードを初期状態に戻す（CMLのwipe）：保存した設定（write memory）を消し、コンテナを作り直す。
// 他のノードとリンクはそのまま。作り直したノードの設定（アドレス・ケーブル・リンクの品質）は呼び出し側で流し直す。
// 1. 止まっているノードは先に起動する（設定を消すコマンドを流すため）
// 2. 保存した設定を消す（labTopology.buildWipeCommand）
// 3. POST /labs?reconfigure=true&nodeFilter=<ノード>で、そのノードだけ作り直す（api-contract.md 2.4）
export async function wipeLabNode(
  labName: string,
  built: BuiltTopology,
  nodeId: string,
  kind: PaletteNodeKind | undefined,
  running: boolean,
) {
  const command = buildWipeCommand(kind, nodeId)
  if (command) {
    if (!running) await startNode(labName, nodeId)
    assertExecOk(await execInLab(labName, nodeId, command), '保存した設定を消せませんでした')
  }
  // 設定の保存先が消えていないことを確かめてから作り直す（無いとbind mountでdeployが失敗する）
  await prepareNodeConfigs(labName, built)
  await wipeNode(built.topologyContent, nodeId)
}
