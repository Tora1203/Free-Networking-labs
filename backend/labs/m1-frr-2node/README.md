# M1: FRR 2ノード疎通ラボ

```
        eth1                         eth1
 r1 ●──────────────10.0.0.0/30──────────────● r2
 lo 10.1.1.1/32                       lo 10.2.2.2/32
       └────────── OSPF area 0 ──────────┘
```

FRR を `kind: linux`（`quay.io/frrouting/frr:10.2.1`）で起動し、`/etc/frr/{daemons,frr.conf,vtysh.conf}`
をバインドマウントして設定を投入する。ルーターノードの最小構成の雛形。

## 前提

- Docker が使えること（`labuser` は `docker` グループ所属。再ログイン後に有効）
- Containerlab 0.79 以降
- FRR イメージ取得済み: `docker pull quay.io/frrouting/frr:10.2.1`

> このサーバーでは `sudo` なしでデプロイできる（docker グループ権限で containerlab が
> netns 操作まで実行できるため）。権限エラーが出る環境では `sudo` を付ける。

## デプロイ

```bash
cd backend/labs/m1-frr-2node
containerlab deploy -t m1-frr-2node.clab.yml
```

## 疎通確認

```bash
# OSPF 隣接（Full になること）
docker exec clab-m1-frr-2node-r1 vtysh -c 'show ip ospf neighbor'

# r2 が学習した r1 のループバックへ ping（送信元も r1 のループバック）
docker exec clab-m1-frr-2node-r2 ping -c3 -I 10.2.2.2 10.1.1.1

# ルーティングテーブル
docker exec clab-m1-frr-2node-r2 vtysh -c 'show ip route ospf'
```

期待結果:
- `show ip ospf neighbor` … State が `Full/DR` または `Full/Backup`
- `ping` … 3/3 success
- `show ip route ospf` … `O>* 10.1.1.1/32` が eth1 経由で入る

## 破棄

```bash
containerlab destroy -t m1-frr-2node.clab.yml --cleanup
```

`--cleanup` でラボディレクトリ（`clab-m1-frr-2node/`）も削除する。
