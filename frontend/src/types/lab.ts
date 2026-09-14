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
