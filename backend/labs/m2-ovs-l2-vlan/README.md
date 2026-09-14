# M2: FRR / ovs-bridge / linux の3種混在トポロジ、VLAN確認

`docs/STATUS.md` の M2（backend Next 1〜3）に対応。3タスクとも検証済み。

## 前提：OVSへの非rootアクセス設定（恒久対応・完了）

`ovs-bridge` kind は `ovs-vsctl` でホストのOVSデータベースソケット
(`/var/run/openvswitch/db.sock`) に直接アクセスする。デフォルトでは
このソケットは `root:root` (`srwxr-x---`) で作られ、sudoパスワードなしでは
`labuser` から触れなかった。以下の恒久対応を実施済み（要sudo、再起動しても保持される設定ファイル）：

- `/etc/default/openvswitch-switch` に `OVS_CTL_OPTS="--ovs-user=root:clab_admins"`
- `/etc/systemd/system/ovsdb-server.service.d/override.conf` に `UMask=0007`
- `root` ユーザーを `clab_admins` グループに追加（`--ovs-user` の制約で必須。
  rootは元々全権限を持つため追加のリスクはない）

結果：`db.sock` が `root:clab_admins` (`srwxrwx---`) になり、`clab_admins` に
所属する各ユーザーが sudo なしで `ovs-vsctl` / containerlab の ovs-bridge 操作を実行可能。
`labuser` は元々 `clab_admins` に所属済みだったため追加作業は不要だった。

## 重要な発見（設計への影響あり）

1. **`ovs-bridge` kind はブリッジを自動生成しない**。トポロジをdeployする前に
   ホスト側で `ovs-vsctl add-br <ノード名>`（ノード名＝ブリッジ名）を実行しておく必要がある。
   VLANのtag/trunks設定もトポロジYAMLには書けず、deploy後に `ovs-vsctl set port ... tag=/trunks=`
   で設定する（→ 将来API化する場合、ラボのdeploy/destroyフックにこれらのコマンドを
   組み込む必要がある）。
2. **ovs-bridgeノードのインターフェース名（`eth1`等）は、そのブリッジ内だけでなく
   トポロジ全体でユニークである必要がある**（ホスト側のroot namespaceで名前が競合するため）。
   複数のovs-bridgeノードを1トポロジに置く場合、`sw1:eth1/eth2`, `sw2:eth3/eth4` のように
   通し番号で命名する必要がある。
3. **OVSブリッジ名はホスト全体でグローバルな名前空間**（`ovs-vsctl add-br sw1` は
   コンテナのnetnsではなくホストに作られる）。→ **マルチユーザー化（M3以降）で
   複数ユーザーが同時に「L2スイッチ」ノードを使う場合、ブリッジ名の衝突を避ける
   命名規則（例: `<username>-<labname>-<nodename>`）が必要**。これは今回の卒論の
   核心的な差別化点（マルチユーザー対応）に直接関わる制約なので、M3で
   clab-api-server導入時に必ず確認すること。

## task1-l2-basic: ovs-bridge基本のL2疎通

`sw1`(ovs-bridge) に `pc1`/`pc2`(linux/alpine) を接続し、疎通確認。

```
ovs-vsctl add-br sw1
containerlab deploy -t task1-l2-basic/m2-task1.clab.yml
# pc1/pc2 に同一サブネットのIPを振ってping
containerlab destroy -t task1-l2-basic/m2-task1.clab.yml --cleanup
ovs-vsctl del-br sw1
```

**結果**: pc1 ⇄ pc2, 3/3 (0% loss)

## task2-vlan: VLANアクセス/トランクポート検証

`sw1` に4ノード接続：`pc1`(VLAN10 access) / `pc2`(VLAN20 access) /
`pc3`(VLAN10 access) / `trunk`(VLAN10+20 trunk、802.1Qサブインターフェースで両方に参加)。

`task2-vlan/setup-vlan.sh` で ブリッジ作成→deploy→VLAN設定→IP設定を一括実行。

**結果**（すべて期待通り）：
| 経路 | VLAN関係 | 結果 |
|---|---|---|
| pc1 → pc3 | 同一VLAN10（access同士） | 3/3 到達 |
| pc1 → pc2 | 別VLAN（10 vs 20） | 3/3 到達不可（分離成功） |
| trunk.10 → pc1 | トランク→VLAN10 access | 3/3 到達 |
| trunk.20 → pc2 | トランク→VLAN20 access | 3/3 到達 |

→ `ovs-vsctl`の`tag`（アクセス）/`trunks`（トランク）でVLAN分離・トランキングが
期待通り機能することを確認。

## task3-mixed: FRR + ovs-bridge + linux 混在トポロジ

```
pc1 -- sw1(ovs-bridge) -- r1(FRR) === eth1, OSPF area0 === r2(FRR) -- sw2(ovs-bridge) -- pc2
```

- r1/r2はOSPFで直接リンク(10.0.0.0/30)と各自のLAN(10.0.10.0/24 / 10.0.20.0/24)を広報
- pc1/pc2はルーターを経由してのみ相手に到達可能（pc自体はOSPFを喋らず静的経路のみ）

手順：
```
ovs-vsctl add-br sw1
ovs-vsctl add-br sw2
containerlab deploy -t task3-mixed/m2-task3.clab.yml
# pc1/pc2にIPと対向ネットワークへの経路を追加、OSPF収束待ち(~30秒)
containerlab destroy -t task3-mixed/m2-task3.clab.yml --cleanup
ovs-vsctl del-br sw1 && ovs-vsctl del-br sw2
```

**結果**：
- r1-r2 OSPF隣接：Full/DR（収束まで約30秒。broadcastネットワークタイプでのDR選出を含むため）
- pc1 ⇄ pc2（別ルーター配下のLAN間）: 3/3 到達
- pc1 → r2 loopback, pc2 → r1 loopback: 3/3 到達

→ ルーター(FRR)・L2スイッチ(ovs-bridge)・PC/ホスト(linux)の3種類のノードタイプを
1トポロジに混在させ、動的ルーティング越しにエンドツーエンドで疎通することを確認。M2完了。

## 補足：pc(linuxコンテナ)のデフォルトルートについて

`linux`kindのコンテナはDocker管理ネットワーク用に `eth0` 側の default route を
最初から持っている。ラボ内の対向ネットワークへは `ip route add <対向網> via <ルーターIP> dev eth1`
のように**個別経路を追加する**（default routeを上書きしない）のが安全。
