// clab-api-server の GET /api/v1/labs レスポンス形状を想定した型
// （実サーバー未接続のため containerlab inspect の一般的なフィールドから推定）
export type NodeState = 'running' | 'exited' | 'created'

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

export interface PaletteNodeConfig {
  kind: PaletteNodeKind
  label: string
  // containerlab kind（api-contract.md 3章、ルーターの実kindはTODO(kawase3)未確定）
  clabKind: string
  image: string
}

export const PALETTE_NODE_CONFIGS: Record<PaletteNodeKind, PaletteNodeConfig> = {
  router: { kind: 'router', label: 'ルーター', clabKind: 'linux', image: 'quay.io/frrouting/frr:TODO' },
  'l2-switch': { kind: 'l2-switch', label: 'L2スイッチ', clabKind: 'ovs-bridge', image: '' },
  pc: { kind: 'pc', label: 'PC', clabKind: 'linux', image: 'alpine:TODO' },
}
