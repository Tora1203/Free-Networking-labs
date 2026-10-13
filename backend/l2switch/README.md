# l2switch（L2スイッチ用コンテナイメージ）

L2スイッチを、ホストのOVS（`ovs-bridge` kind）ではなく**普通のコンテナ**として動かすためのイメージ
（2026-10-13決定、経緯は `docs/direction.md`）。中身は alpine + iproute2 のみ（約16MB）。

スイッチ機能はコンテナ内のVLAN対応Linuxブリッジ（`br0`、`vlan_filtering 1`）で実現する。

```sh
ip link add br0 type bridge vlan_filtering 1 && ip link set br0 up
ip link set eth1 master br0 && ip link set eth1 up && bridge vlan del dev eth1 vid 1
bridge vlan add dev eth2 vid 10 pvid untagged     # アクセスポート（VLAN10）
bridge vlan add dev eth1 vid 10; bridge vlan add dev eth1 vid 20   # トランク（10,20をtagged）
```

## ビルド

```sh
docker build -t fnl/l2switch:1 backend/l2switch
```

## 実機確認（2026-10-13、containerlab 0.79 CLI）

- 動いているラボにスイッチ＋リンクを`apply`（差分反映）で追加でき、既存ノードは作り直されない
- アクセスポートでVLAN分離（同VLANは疎通、別VLANは不通）、VLAN変更はその場で反映
- トランク＋ルーターのサブインターフェース（router on a stick）でVLAN間ルーティングが通る
