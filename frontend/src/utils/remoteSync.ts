// 同じラボを別の画面（別のタブ・別のブラウザ）で開いている時の、変更の検知（2026-10-16）。
// サーバーに保存されているトポロジのYAMLとannotationsを「最後に見た内容」と比べる。
// 自分の保存のあとにも取り直して基準にするので、サーバーが整形し直して返しても食い違わない。
import { getLabAnnotations, getLabTopologyYaml } from '../api/client'

export interface RemoteState {
  yaml: string
  annotations: string | null
}

export async function fetchRemoteState(labName: string): Promise<RemoteState> {
  const yaml = await getLabTopologyYaml(labName)
  // 保存されていない（404等）時はnull
  const annotations = await getLabAnnotations(labName).catch(() => null)
  return { yaml, annotations }
}

// 基準が無い（まだ取れていない）時は「変わった」とは言わない
export function remoteChanged(baseline: RemoteState | null, current: RemoteState): boolean {
  if (!baseline) return false
  return baseline.yaml !== current.yaml || baseline.annotations !== current.annotations
}
