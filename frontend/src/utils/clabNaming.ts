// ovs-bridge のブリッジ名（＝L2スイッチノード名）はホスト全体でグローバルな名前空間のため、
// 複数ユーザーが同時にL2スイッチノードを使うと衝突する（docs/api-contract.md セクション3）。
//
// 2026-09-16決定：`<username>_<labname>_<ノード名>` 形式へ変換して衝突を避ける方針だったが、
// 2026-09-24の実機検証で **Linuxのネットワークインターフェース名は15文字まで**（`IFNAMSIZ`、
// カーネルの制約）という制限に引っかかることが判明した（16文字目以降は`ovs-vsctl add-br`が
// "Invalid argument" で失敗する）。現実的なusername/labname/ノード名の組み合わせでは
// 15文字を簡単に超えてしまうため、方式を変更する（docs/direction.md 2026-09-24追記を参照）。
//
// 変更後：username/labName/nodeNameの組み合わせを短いハッシュ値に変換し、
// `sw-` + 8桁の16進数（合計11文字、15文字制限に収まる）を使う。
// 暗号学的な強度は不要（このプロジェクトの想定利用規模は数人×数ラボ）なので、
// 軽量なFNV-1a(32bit)で十分。

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function toClabBridgeName(username: string, labName: string, nodeName: string): string {
  return `sw-${fnv1aHash(`${username}/${labName}/${nodeName}`)}`
}
