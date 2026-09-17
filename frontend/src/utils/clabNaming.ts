// ovs-bridge のブリッジ名（＝L2スイッチノード名）はホスト全体でグローバルな名前空間のため、
// 複数ユーザーが同時にL2スイッチノードを使うと衝突する（docs/api-contract.md セクション3）。
// 2026-09-16決定：APIに送る直前に `<username>_<labname>_<ノード名>` 形式へ変換して衝突を避ける
// （docs/direction.md参照）。
export function toClabBridgeName(username: string, labName: string, nodeName: string): string {
  return `${username}_${labName}_${nodeName}`
}
