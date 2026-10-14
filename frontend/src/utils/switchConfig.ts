// L2スイッチ（コンテナ、backend/l2switch/）の設定コマンドを組み立てる（2026-10-13、ovs-bridgeから移行）。
//
// スイッチはコンテナ内のVLAN対応Linuxブリッジ（br0）で実現する。設定はclab-api-serverのexecで
// このコマンドを実行して投入する。毎回「ポートの全VLANを消してから、あるべき設定を入れ直す」ので、
// 何度実行しても同じ結果になる（deploy直後・差分反映後・VLAN変更時のどれでも同じものを流せばよい）。
//
// VLANの意味はovs-bridge時代（ovs-vsctlのtag/trunks）と揃えている：
// - 未設定／トランク（全VLAN許可）：VLAN1〜4093はタグ付きで通し、タグなしは内部用の
//   ネイティブVLAN（4094）として通す（OVSの「tagもtrunksも無いポート」と同じく、
//   未設定のポート同士はそのまま通信できる）
// - アクセス：指定VLANのタグなしポート
// - トランク（指定VLANのみ）：指定VLANだけタグ付きで通す（タグなしは通さない）
//
// 当初はタグなしをVLAN1として扱っていたが、そうするとVLAN1がトランク上でタグなしになり、
// ルーターのeth1.1（VLAN1のサブインターフェース）に届かなかった（2026-10-14実機で発生）。
// OVSではタグなし（VLAN0）とVLAN1は別物だったため、ネイティブ用に4094を予約して揃えた。
// そのためGUIで指定できるVLAN IDは1〜4093（MAX_USER_VLAN）。
//
// execはシェルを介さず引数分割されるため、全体を`sh -c '...'`で包む（2026-10-13 CLIで確認）。
// そのためコマンド内に`'`を含めてはいけない。インターフェース名とVLAN IDは形式を検証してから埋め込む。

// ポートのVLAN設定。未設定（undefined）はトランク（全VLAN許可）と同じ扱い
export type VlanConfig = { mode: 'access'; vlan: number } | { mode: 'trunk'; vlans: number[] | 'all' }

export interface SwitchPort {
  iface: string
  vlan?: VlanConfig
}

// ユーザーが指定できるVLAN IDの上限。4094はタグなし（ネイティブ）用に予約している
export const MAX_USER_VLAN = 4093
const NATIVE_VLAN = 4094

const IFACE_PATTERN = /^eth[0-9]+$/

export function isUserVlanId(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_USER_VLAN
}

function vlanCommands(iface: string, vlan?: VlanConfig): string[] {
  if (vlan?.mode === 'access' && isUserVlanId(vlan.vlan)) {
    return [`bridge vlan add dev ${iface} vid ${vlan.vlan} pvid untagged`]
  }
  if (vlan?.mode === 'trunk' && vlan.vlans !== 'all') {
    return vlan.vlans.filter(isUserVlanId).map((v) => `bridge vlan add dev ${iface} vid ${v}`)
  }
  return [
    `bridge vlan add dev ${iface} vid ${NATIVE_VLAN} pvid untagged`,
    `bridge vlan add dev ${iface} vid 1-${MAX_USER_VLAN}`,
  ]
}

export function buildSwitchSyncCommand(ports: SwitchPort[]): string {
  const valid = ports.filter((p) => IFACE_PATTERN.test(p.iface))
  const lines = [
    'set -e',
    'ip link show br0 >/dev/null 2>&1 || ip link add br0 type bridge vlan_filtering 1',
    'ip link set br0 up',
  ]
  for (const { iface, vlan } of valid) {
    lines.push(
      `ip link set ${iface} master br0`,
      `ip link set ${iface} up`,
      `bridge vlan del dev ${iface} vid 1-4094 2>/dev/null || true`,
      ...vlanCommands(iface, vlan),
    )
  }
  return `sh -c '${lines.join('; ')}'`
}
