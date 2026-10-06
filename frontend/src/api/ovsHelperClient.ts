// backend/ovs-helper/ のクライアント。L2スイッチ(ovs-bridge kind)のポートにVLAN設定
// （アクセス/トランク）を投入するための専用サービス。containerlabのトポロジYAMLには
// VLAN設定が無く、deploy後にホスト側で`ovs-vsctl`を実行する必要があるため、新設した
// （2026-10-06追加、docs/direction.md参照）。
//
// clab-api-serverの`exec`系APIはコンテナ単位でしか実行できず、ovs-bridge kindのノードは
// そもそもコンテナを持たないためホストのOVSデータベースには届かない。そのため
// console-proxyと同様に、JWTで認証してから「そのユーザーが所有するラボかどうか」を
// clab-api-server自身に問い合わせて確認する専用の薄いヘルパーを別途立てている。
import { ApiError, getAuthToken } from './client'

const OVS_HELPER_BASE_URL = import.meta.env.VITE_OVS_HELPER_URL ?? 'http://localhost:8083'

export type VlanConfig = { mode: 'access'; vlan: number } | { mode: 'trunk'; vlans: number[] }

export async function applyVlanConfig(labName: string, port: string, config: VlanConfig): Promise<void> {
  const token = getAuthToken()
  if (!token) throw new Error('ログインしていません')

  const res = await fetch(`${OVS_HELPER_BASE_URL}/vlan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ labName, port, ...config }),
  })
  const text = await res.text()
  const body = text.length > 0 ? JSON.parse(text) : undefined
  if (!res.ok) {
    const message = (body && typeof body === 'object' && 'error' in body ? body.error : undefined) ?? `HTTP ${res.status}`
    throw new ApiError(res.status, message)
  }
}
