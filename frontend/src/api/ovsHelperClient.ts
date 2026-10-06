// backend/ovs-helper/ のクライアント。L2スイッチ(ovs-bridge kind)のブリッジ作成・
// ポートへのVLAN設定（アクセス/トランク）を行うための専用サービス。
// containerlabはovs-bridge kindのブリッジを自動生成しない（事前に`ovs-vsctl add-br`が必要、
// 2026-10-06実機確認）うえ、VLAN設定自体もトポロジYAMLには無くdeploy後に別途投入が必要。
//
// clab-api-serverの`exec`系APIはコンテナ単位でしか実行できず、ovs-bridge kindのノードは
// そもそもコンテナを持たないためホストのOVSデータベースには届かない。そのため
// console-proxyと同様に、JWTで認証してから専用の薄いヘルパーを別途立てている
// （docs/direction.md参照）。
import { ApiError, getAuthToken } from './client'

const OVS_HELPER_BASE_URL = import.meta.env.VITE_OVS_HELPER_URL ?? 'http://localhost:8083'

export type VlanConfig = { mode: 'access'; vlan: number } | { mode: 'trunk'; vlans: number[] }

async function postToHelper(path: string, body: Record<string, unknown>): Promise<void> {
  const token = getAuthToken()
  if (!token) throw new Error('ログインしていません')

  const res = await fetch(`${OVS_HELPER_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const resBody = text.length > 0 ? JSON.parse(text) : undefined
  if (!res.ok) {
    const message = (resBody && typeof resBody === 'object' && 'error' in resBody ? resBody.error : undefined) ?? `HTTP ${res.status}`
    throw new ApiError(res.status, message)
  }
}

// deployより前に呼ぶ。ブリッジが既に存在していてもエラーにならない（--may-exist）ので、
// 再deploy時に毎回呼んでも安全
export function ensureBridge(bridge: string): Promise<void> {
  return postToHelper('/bridge', { bridge })
}

export function applyVlanConfig(labName: string, port: string, config: VlanConfig): Promise<void> {
  return postToHelper('/vlan', { labName, port, ...config })
}
