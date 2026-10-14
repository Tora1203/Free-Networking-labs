# frr-router（ルーター用コンテナイメージ）

FRR公式イメージ（`quay.io/frrouting/frr:10.2.1`）に、**VLANサブインターフェースをvtyshの設定から自動で作る
エージェント**（`fnl-subif-agent`）を足したもの（2026-10-14、経緯は `docs/direction.md`）。

FRRはVLANデバイス（`eth1.10`）を自分では作れないが、存在しないインターフェースにも設定は入れられ、
デバイスができた時点でアドレス等を適用する。エージェントは1秒ごとに`show running-config`を見て、

- `interface ethN.V` があり、カーネルにデバイスが無ければ `ip link add link ethN name ethN.V type vlan id V` で作る
- running-configから消えた（`no ip address`等で設定が空になった）サブインターフェースはデバイスも削除する

これで学生はCiscoと同じ感覚でサブインターフェースを設定できる（省略形も通る）。

```
conf t
int eth1.10
 ip add 10.10.0.1/24
```

`write memory` しておけば、再起動後もfrr.confの設定から同じように作り直される。
注意：FRRは動いているインターフェースを`no interface`で消せない（`only inactive interfaces can be deleted`）。
消すときは`no ip address ...`で設定を空にする。VLAN IDは名前の「.」の後ろ（1〜4094）で決まる。

## ビルド

```sh
docker build -t fnl/frr:1 backend/frr-router
```

## 実機確認（2026-10-14、containerlab CLI）

- `int eth1.10` / `ip add` で約1秒後にeth1.10が作られ、トランク越しのVLAN間ルーティングが通る
- `sh run`に出る。`write memory`→ノード停止/起動でも作り直される
- `no ip add` でデバイスも消える
