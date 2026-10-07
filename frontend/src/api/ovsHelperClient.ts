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

// トランクの'all'（全VLAN許可）はovs-helper側には送らない。OVSのポートはtag/trunksを
// どちらも設定しなければデフォルトで全VLANを通すトランクになるため、deploy前のポートリセット
// （resetPort、ovs-vsctl --if-exists del-port）だけで既にこの状態になっており、
// 追加の呼び出しが不要（TopologyEditor.tsx参照、2026-10-06指摘対応）
export type VlanConfig = { mode: 'access'; vlan: number } | { mode: 'trunk'; vlans: number[] | 'all' }

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

// deployより前に呼ぶ。ポート名は(username,labName,switchNodeId,iface)から決定的に決まるため、
// 再deployすると同じ名前になり、前回のOVS側インターフェースが残っているとcontainerlabが
// 「already exists」で失敗する（2026-10-06実機確認）。存在しなければ何もしない
export function resetPort(port: string): Promise<void> {
  return postToHelper('/port/reset', { port })
}

// ルーターのFRR設定（daemons/frr.conf/vtysh.conf）をdeployより前に用意する（2026-10-07追加）。
// 「ルーターはCLIで設定しないと意味がない」指摘対応：元々はGUIがexec経由で直接
// `ip addr add`していたが、deployのたびに再投入が必要だった。この仕組みでは、
// ホスト側にbind mountするFRR設定ファイルを用意するだけで、実際のアドレス設定等は
// 学生がvtyshで行い`write memory`すれば再deployを越えて残るようにする（実機確認済み）。
// 既に存在するファイルは上書きしない（学生の設定を消さないため）ので、再deploy時も毎回呼んで安全
export function ensureFrrConfig(labName: string, routerName: string): Promise<void> {
  return postToHelper('/frr-config', { labName, routerName })
}
