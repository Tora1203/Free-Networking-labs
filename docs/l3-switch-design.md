# L3スイッチの設計メモ（2026-10-15、実装前の案）

> **これは案であって決定ではない。** 採用が決まったら `direction.md` に日付つきで記録する。
> 背景：バックログ（`backlog.md`）の「L3スイッチ」。当初は「実装コスト大」として見送ったが、L2スイッチの
> CLI（`swcli`）とエージェントが育ったので、FRRを同居させる形なら少ない工数で作れそうだと見直した（2026-10-15）。

## 1. 目指す姿

実機のL3スイッチ（Catalyst 9300 の Network Advantage、Arista、Aruba CX など）の**上位機種に合わせる**。
学生がCiscoの感覚で次を打てるようにする。

```
sw1(config)# ip routing
sw1(config)# interface vlan 10
sw1(config-if)# ip address 10.0.10.1 255.255.255.0
sw1(config)# router ospf 1
sw1(config-router)# network 10.0.10.0 0.0.0.255 area 0
sw1(config)# router bgp 65001
sw1# show ip route
sw1# show ip ospf neighbor
```

「L2スイッチ」と別のノード種別（`l3-switch`）としてパレットに並べる。**L2スイッチのコードは壊さない**
（L3の機能はあとから足せる「プラグイン」の形にする。4章）。

## 2. 方針：swcli が窓口、FRR が計算役

| 役割 | 担当 | 理由 |
| --- | --- | --- |
| L2（VLAN・STP・EtherChannel・ポートセキュリティ・SVI・LLDP/CDP） | 今の`swcli`とエージェント | 既にある。そのまま使う |
| L3の経路制御（静的経路・OSPF・BGP など） | **FRR**（zebra・ospfd・bgpd ほか）を同じコンテナで動かす | ルーター用のFRRと同じ。自作しない |
| 入力の窓口 | `swcli`（Cisco風CLIの1か所） | 学生は1つのCLIで全部を設定する |

`swcli`は`router ospf`・`router bgp`・`ip route`・`show ip route`などを**自分で解釈せず、FRRのvtyshに渡す**
（パススルー）。FRRのCLIはCisco風なので、そのまま使える。`swcli`が受け持つのは「どのコマンドをvtyshに渡すか」の
振り分けと、表示の整形だけ。

### 2.1 SVI とアドレスの持ち主

- **IPアドレスとshutdownは`swcli`**（今のSVIの実装のまま。カーネルの`vlanN`デバイスに付ける）。
- FRRは`vlanN`をカーネルから見つけて、アドレスから「つながっているネットワーク」を知る（ルーターでも同じ）。
- OSPFのコスト・認証・パッシブなど、**経路制御の設定は`interface vlan N`の下でもFRR側**に入れる
  （`ip ospf cost`など）。`swcli`は`interface vlan N`の中で、自分の知らないコマンドをvtyshの
  `interface vlanN`に渡す。

### 2.2 `ip routing`

- `no ip routing`（既定）：FRRは動かさず、`net.ipv4.ip_forward=0`。今のL2スイッチ＋管理用SVIと同じ。
- `ip routing`：`ip_forward=1`にして、FRR（zebra）を起動する。SVI間のルーティングが効く。
  実機のCatalystも`ip routing`を入れるまでL3スイッチとして動かないので、同じ感覚になる。

### 2.3 ルーテッドポート（`no switchport`）

L3スイッチらしい機能として、**物理ポートをL3インターフェースにする**。

```
sw1(config)# interface eth1
sw1(config-if)# no switchport
sw1(config-if)# ip address 10.1.1.1 255.255.255.252
```

- ブリッジ（`br0`）から外して、`ethN`に直接アドレスを付ける。ブリッジから外れるので、STP・VLAN・ポート
  セキュリティの対象から外れる（今の`channel-group`のメンバーと同じ扱いにできる：`bridge_ports()`）。
- STPエージェントの`port_keys`は、ブリッジから外れたポートを捨てる（PR #29で対応済み）。

## 3. 設定の保存（write memory）

**`startup.json`に1本化する案を推す。** FRRの設定を別のファイルにしない。

```
startup.json = { ...今のL2の設定..., "frr": "<vtysh show running-config の全文>" }
```

- `write memory`：今の保存に加えて、`vtysh -c 'show running-config'`の出力を`frr`キーに入れる。
- 起動時：`startup.json`の`frr`を`/etc/frr/frr.conf`に書いてからFRRを起動する。
- 利点：**保存先が1つ**（`switch-config/<名前>/`のbind mountだけ）なので、フロントのbind mount、ovs-helperの
  ディレクトリ作成、wipe（`startup.json*`を消す）、将来のスナップショット（`snapshot-design.md`）が、
  **今のL2スイッチのまま使える**。FRR用に`frr-config/`を足さずに済む。
- 欠点：`startup.json`にFRRの全文が入るので、人が読みにくい（`show startup-config`で整形して見せる）。

別案（FRRに`frr-config/<名前>/frr.conf`を別にbind mountする）は、ルーターと同じ仕組みで分かりやすいが、
フロント・ovs-helper・wipe・スナップショットのすべてに「スイッチだけ2か所」の分岐が増える。

## 4. プラグインの形（拡張点）

今の`swcli.py`は3300行の1ファイル。L3を足すのに合わせて、**最小限の拡張点**だけ作る。
全面的な分割は別の機会にする（今回やらない）。

| 拡張点 | 内容 | 今ある仕組み |
| --- | --- | --- |
| エージェントのtick | `tick(cfg, ports, changed)`を毎秒呼ぶ | `StpAgent`・`LldpAgent`・`PsecAgent`が同じ形 |
| CLIコマンド | コマンドの木にノードを足す（`(['router', 'ospf', '<id>'], func, '説明')`の表） | `Cli`のコマンド表（`mac_show_entries()`のような「表を返す関数」の形） |
| running-configの出力 | 設定の行を返す関数を足す | `running_config()`が各機能の行をつなげている |
| 保存・復元 | `write memory`と起動時の入出力 | `startup.json`の読み書き |
| `show`コマンド | 表示を返す関数を足す | `show_*`関数群 |

形：`l3.py`（新規）に`class L3Plugin`を置き、`fnl/l3switch`のイメージだけに入れる（環境変数
`FNL_L3=1`、または`l3.py`が存在する時だけ`swcli`が読み込む）。**L2スイッチのイメージには`l3.py`が
無いので、動きは今のまま**。

```python
# swcli.py の末尾あたり（イメージ）
try:
    import l3
    PLUGINS = [l3.L3Plugin()]
except ImportError:
    PLUGINS = []
```

## 5. イメージとノード種別

- **`fnl/l3switch:1`**：`fnl/l2switch`のイメージを土台に、`apk add frr`（Alpine 3.22のfrrは10.2.2。ルーター用の
  FRR 10.2.1とほぼ同じ）と`l3.py`を足す。mstpdのビルドは再利用する。
- メモリの目安：L2スイッチ（20〜100MB）＋ zebra・ospfd・bgpd（実測が必要。ルーターのFRRは40〜45MB）。
  **100〜150MB程度になる見込み**。台数が多いラボでは効いてくるので実測する。
- フロント：`NODE_KINDS`に`l3-switch`を足す（`frontend/src/types/lab.ts`）。ほぼL2スイッチと同じ扱い
  （bind mount・`write memory`の同期コマンド・wipe・ポート名`eth1…`）。`l2-switch`と書いている箇所は約25か所（テストを除く）
  あるので、**種別の判定を`isSwitchKind()`にまとめる**リファクタが先に要る。
- FRRのデーモンは`daemons`ファイルで切り替える。既定は`zebra`・`ospfd`・`bgpd`・`staticd`を有効に。
  上位機種に合わせて、段階的に`vrrpd`（HSRP/VRRPの代わり）・`isisd`・`bfdd`なども足せる。

## 6. 段階

| 段階 | 内容 | 目安 |
| --- | --- | --- |
| 1 | `ip routing`、SVI間ルーティング、静的経路（`ip route`）、`show ip route`、`show ip interface brief`の拡張、ルーテッドポート | 小 |
| 2 | OSPF（`router ospf`、`network … area`、`passive-interface`、`show ip ospf neighbor/interface/database`）、`interface vlan N`下の`ip ospf …` | 中 |
| 3 | BGP（`router bgp`、`neighbor`、`show ip bgp …`）。**`ebgp-requires-policy`の扱いを先に決める**（ルーターと同じ説明が要る） | 中 |
| 4 | VRRP、DHCPリレー（`ip helper-address`、`dhcrelay`が要る）、ACL（`ip access-list`、nftablesに変換） | 中〜大 |
| — | EIGRP | **やらない**（FRRのeigrpdは未完成。Catalystと完全には合わない旨を説明する） |

段階1・2までで、授業の定番（inter-VLAN、静的経路、OSPF）はCatalystの感覚で一通りできる。

## 7. リスク・要確認

- **FRRとswcliの競合**：SVIのアドレスは`swcli`のエージェントが入れ直す。FRRが同じインターフェースを
  触らないこと（FRRは`ip address`を設定させない。vtyshの`ip address`は`swcli`に回す）。
- **管理用インターフェース`eth0`**：zebraがコンテナの管理ネットワークの経路を拾う。ルーターで既に
  `eth0`を除いている（`lldpd`の`!eth0`と同様）ので、同じ考え方で除外する。
- **`show running-config`の合成**：`swcli`の行とFRRの行を、Ciscoの並び（`interface vlan N`の下に
  アドレスとOSPFの設定が両方出る）に揃える必要がある。これが一番手間がかかる所。
- **vtyshの出力のCisco風との差**：`show ip route`の凡例など、FRR独自の表示がある。ルーター（FRR）と
  同じなので許容する（マニュアルにも既にある）。
- **起動順**：zebraの起動前にSVIを作る。FRRが落ちたら`swcli`のエージェントが起動し直す（lldpdと同じ監視）。
- **未検証**：FRRとmstpdと`swcli`の3つを1コンテナに入れた時の起動時間とメモリ。段階1の前に、
  手作業で1台作って実測する。

## 8. 最初の一歩（提案）

1. `fnl/l3switch:0`（実験用）を作り、コンテナの中で手作業で`ip_forward=1`＋`zebra`＋`ospfd`を動かして、
   2台のL3スイッチ間でOSPFが張れることと、メモリ・起動時間を確認する。
2. 問題がなければ、`isSwitchKind()`のリファクタ（フロント）→ 段階1の実装。
