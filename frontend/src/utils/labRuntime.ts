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
  getLabTopologyYaml,
  putLabAnnotations,
  putLabTopologyYaml,
  startNode,
  stopNode,
  type ApplyResponse,
} from '../api/client'
import { ensureFrrConfig } from '../api/ovsHelperClient'
import { serializeAnnotations } from './annotations'
import { assertExecOk, buildNodeSyncCommands, buildTopologyContent, parseImportedTopology, topologyToYaml } from './labTopology'

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

// ルーターのbind mount先（frr-config/<router>/）をapplyより前に用意する。既存ファイルは上書きされない
export async function prepareRouters(labName: string, routerNames: string[]) {
  await Promise.all(routerNames.map((name) => ensureFrrConfig(labName, name)))
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
  // 古い形式（ovs-bridgeのスイッチ）のラボはここで今の形式に書き直してから起動する
  await putLabTopologyYaml(labName, topologyToYaml(built.topologyContent))
  await putLabAnnotations(labName, serializeAnnotations(nodes, built.portAnnotations, built.switchOriginalIds))
  await prepareRouters(labName, built.routerClabNames)
  try {
    await applyLab(labName)
  } catch (e) {
    console.warn('applyに失敗したため、破棄してから起動し直します', e)
    await destroyLab(labName).catch(() => undefined)
    await applyLab(labName)
  }
  const commands = buildNodeSyncCommands(built)
  const { succeeded, failures } = await runNodeSyncs(labName, commands, commands.keys())
  return { commands, synced: succeeded, failures }
}

// ノード単位の起動/停止。nodeNameは短いノード名でよい（2026-10-14実機確認。コンテナの
// フルネームでも通る）。containerlabの「seamless dataplane」でリンクは保たれる
export const startLabNode = (labName: string, nodeName: string) => startNode(labName, nodeName)
export const stopLabNode = (labName: string, nodeName: string) => stopNode(labName, nodeName)
