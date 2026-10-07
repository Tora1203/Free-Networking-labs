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
import { fnv1aHash } from './hash'

export function toClabBridgeName(username: string, labName: string, nodeName: string): string {
  return `sw-${fnv1aHash(`${username}/${labName}/${nodeName}`)}`
}

// ブリッジ名だけでなく、ブリッジに挿さる各リンクのポート名（＝containerlabのlinksで
// ブリッジ側に指定するインターフェース名）もホスト全体でグローバルな名前空間であることが
// containerlab公式ドキュメント（ovs-bridge kind）で判明（2026-10-06）：
// 「リンクのブリッジ側エンドポイントで指定した名前が、そのままホストのOVSポート名になる」。
// つまり今まで使っていた"eth1"のような分かりやすい名前をそのまま送ると、別ユーザー・別ラボの
// L2スイッチが同じ"eth1"を使った瞬間に衝突してしまう（ブリッジ名の衝突と同種の問題）。
// ブリッジ名と同様にハッシュ化した名前をAPIには送り、UI上は元の名前（eth1等）を表示したまま
// にする。VLAN設定（backend/ovs-helper/）もこの実名を使ってポートを指定する必要があるため、
// 同じ入力からは常に同じ名前が決定的に出るようにしている（呼び出し側で別途記憶しなくてよい）
export function toClabPortName(username: string, labName: string, switchNodeName: string, iface: string): string {
  return `p-${fnv1aHash(`${username}/${labName}/${switchNodeName}/${iface}`)}`
}
