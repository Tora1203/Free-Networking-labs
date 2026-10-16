// 同じラボを別の画面（別のタブ・別のブラウザ）で開いている時の、変更の検知（2026-10-16）。
// サーバーに保存されているトポロジのYAMLとannotationsを取る。変わったかどうかは、まず軽い「版」
// （api/collabClient.ts getLabVersion）で見て、版が違う時だけここで中身を取って意味を比べる。
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
