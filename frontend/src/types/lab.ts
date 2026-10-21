// clab-api-server の GET /api/v1/labs レスポンス形状を想定した型
// （実サーバー未接続のため containerlab inspect の一般的なフィールドから推定）
export type NodeState = 'running' | 'exited' | 'created' | 'paused'

export interface LabNode {
  name: string
  kind: string
  image: string
  state: NodeState
  ipv4_address?: string
}

export interface Lab {
  name: string
  owner: string
  nodes: LabNode[]
}

// パレットのノード種別。containerlab kind / image との対応は
// docs/api-contract.md セクション3の対応表を参照。
export type PaletteNodeKind = 'router' | 'l2-switch' | 'pc'

// スイッチ系のノード種別（swcliのCLIと、startup-configをホストに残す仕組みを持つもの）。
// 「スイッチなら」という判定は `=== 'l2-switch'` と書かず、これを使う（L3スイッチを足す時に直す所をここに集める）
export type SwitchKind = 'l2-switch'

export function isSwitchKind(kind: string | undefined): kind is SwitchKind {
  return kind === 'l2-switch'
}

export interface PaletteNodeConfig {
  kind: PaletteNodeKind
  label: string
  // containerlab kind（api-contract.md 3章参照）
  clabKind: string
  image: string
}

export const PALETTE_NODE_CONFIGS: Record<PaletteNodeKind, PaletteNodeConfig> = {
  // ルーターはFRR公式イメージ＋サブインターフェース自動作成エージェント（backend/frr-router/、2026-10-14〜）
  router: { kind: 'router', label: 'ルーター', clabKind: 'linux', image: 'fnl/frr:3' },
  // L2スイッチはコンテナ内のLinuxブリッジ（backend/l2switch/、2026-10-13にovs-bridgeから変更）。
  // :2（2026-10-14〜）はCisco風CLI（swcli）入り。VLANはCLIで設定する。:3（同日〜）はmstpdでSTP/RSTP/MSTP
  'l2-switch': { kind: 'l2-switch', label: 'L2スイッチ', clabKind: 'linux', image: 'fnl/l2switch:6' },
  pc: { kind: 'pc', label: 'PC', clabKind: 'linux', image: 'alpine:3.20' },
}
