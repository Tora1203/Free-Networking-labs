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

## 9. 実測の結果（2026-10-21）

8章の最初の一歩を行った。`fnl/l3switch:0`（`fnl/l2switch:6`に`apk add frr frr-pythontools`だけ足した実験用）を2台動かし、手作業で確認した。

| 項目 | 結果 |
| --- | --- |
| イメージの大きさ | 123MB（L2スイッチ86.6MB、FRR分は約36MB） |
| メモリ | FRR一式（zebra・ospfd・bgpd・staticd・mgmtd・watchfrr）でコンテナ全体約24MiB。見込み（100〜150MB）より大幅に小さい |
| FRRの起動 | 約0.5秒（`frrinit.sh start`） |
| OSPF | 2台のあいだでFullまで成立（`daemons`で`ospfd=yes`、`frr.conf`に`router ospf`だけ） |

- 未確認：`swcli`・mstpd・FRRを同時に動かした時の起動時間（実験ではFRRだけ動かした）、SVI（`vlanN`）とルーテッドポート上でのOSPF。段階1・2で確認する。
- 要確認：Dockerの既定では`net.ipv4.ip_forward`を書き換えられなかった（読み取り専用）。`ip routing`で確実に1にする方法
  （ルーターの`ip_forward`の扱いに合わせる、またはlabのYAMLの`sysctls`）を段階1で決める。

## 10. 段階1の実装メモ（2026-10-21、be/l3-switch）

`backend/l2switch/l3.py`（プラグイン）＋`Dockerfile.l3`（`fnl/l3switch:1`）。swcliには最小の拡張点（`PLUGINS`、文法の追加、`running-config`の3か所、エージェントのtick、
`bridge_ports`からルーテッドポートを外す）だけを足した。コマンド・実装の注意は`backend/l2switch/README.md`。設計メモからの変更点：

- **静的経路は`startup.json`の`frr`キーではなく、設定の`routes`に持つ**（段階1にFRRの`show running-config`を保存する仕組みは要らないため）。
  OSPF（段階2）でFRRの設定を持つ時に、3章の`frr`キーの案に移す。
- **`no ip routing`はnftablesで転送を止める**（`ip_forward`がコンテナから切り替えられないため）。
- **ノードの権限は`NET_ADMIN`・`NET_RAW`・`SYS_ADMIN`**（zebraのため）。フロントの`CONTAINER_CAPABILITIES`に`l3-switch`を足す時に、ルーターと同じにする。
- 確かめたこと（コンテナの中、ネットワーク名前空間で2台のホストをVLAN10・20につないだ）：`no ip routing`では同じVLANは通りVLAN間は止まる／`ip routing`でVLAN間が通る／
  静的経路が`show ip route`に出る／ルーテッドポートにアドレスが付く。**未確認**：`write memory`で戻した時の起動、ルーテッドポート越しの疎通、containerlabのラボとして起動した場合。

## 11. 段階2の実装メモ（2026-10-21、be/l3-ospf）

- **パススルーの形**：`router ospf/bgp/rip` のモード（`config-router`）では、`<line>`の文法で何でも受けてFRRの`vtysh -c 'configure terminal' -c 'router ospf' -c '<コマンド>'`に渡す。
  swcliが解釈するのは、設定モードのコマンド（`interface …`等）かどうかと、Cisco風の書き方の翻訳（`network`のワイルドカード、`router-id`、`redistribute … subnets`、`vlan 10`）だけ。
  FRRのコマンドが何でも通るので、OSPFだけでなくBGP・RIPのコマンドも渡せる（翻訳と確認は段階3）。
- **設定の持ち方**：段階1の案（3章：`frr`キーに`show running-config`の全文）を、**必要な塊だけ**に絞った。FRRの`show running-config`から`router …`・`interface …`・`route-map`・`prefix-list`等の塊だけを
  `cfg['frr']`（行のリスト）に写す。`ip route`はswcliの`routes`が持つので除く（持ち主が二重にならない）。設定コマンドを1つ渡すたびに写し、`write memory`で`startup.json`に入る。
  FRRの起動のたびに、`frr.conf`をこの行から作り直す（`render_frr_conf`）。
- **`show running-config`の合成**（7章で一番手間と見ていたところ）：`interface vlan N`とルーテッドポートの塊は、swcliの`interface`の下に混ぜて出す（`ip address`の後、`shutdown`の前）。
  `router ospf`は`router ospf 1`、`network A/L`は`network A W`、`ospf router-id`は`router-id`で出す。それ以外の塊はFRRの書き方のまま。
- **デーモン**：`ospfd`・`bgpd`・`ripd`をイメージの`/etc/frr/daemons`で有効にした（`fnl/l3switch:2`）。FRR一式のメモリは測定済みで約24MiB（設計メモ9章、ospfd・bgpd込み）。
- **確かめたこと**（コンテナ2台をDockerのネットワークで`eth1`同士つないだ）：`ip routing`→ルーテッドポート（10.0.0.0/30）とSVI（末端）→`router ospf`でワイルドカードの`network`、`passive-interface vlan 10`→隣接がFull、
  相手の末端が`O>*`で学習され、末端どうしのpingが通る／`write memory`→コンテナ再起動で、startup-configだけからOSPFがFullまで戻り、pingも通る。
- **未確認・未対応**：BGPの翻訳（`network A mask M`→`network A/L`、`ebgp-requires-policy`の扱い）、RIP、`?`ヘルプ・Tab補完、Ciscoの`passive-interface`での表示、
  複数インスタンスの`router ospf 2`、VRF。containerlabのラボとして起動した場合。

## 12. 段階3の実装メモ（2026-10-21、be/l3-bgp）

- **BGP・RIP**：段階2のパススルーに、翻訳を足しただけ（`network A mask M`→`A/L`、`aggregate-address`、`address-family ipv4`→`ipv4 unicast`、RIPのクラスフルの`network`、`no auto-summary`は無視）。
  表示は`running-config`で元の形（`network … mask …`、クラスフルの`network`）に戻す（再入力して同じ設定になる形のときだけ）。
- **`address-family`の入れ子**：vtyshは1コマンドずつ起動し直すので、`address-family`の中にいることは`cli.frr_af`に覚え、以降のコマンドを`router bgp N` → `address-family ipv4 unicast`の文脈で渡す。`exit`／`exit-address-family`で抜ける。
- **`ebgp-requires-policy`**（設計メモ6章で「先に決める」とした点）：**FRRの既定のまま**にした。ルーターのノードと挙動をそろえ、`direction.md`（2026-10-09）の方針（FRRの仕様として周知）に従う。
  eBGPの経路交換には`no bgp ebgp-requires-policy`が要る。Ciscoと違う点なのでマニュアルに書く。
- **確かめたこと**（コンテナ2台、`eth1`同士）：eBGP（AS65001⇔65002）がEstablished、相手の末端を`B>*`で学習、pingが通る。`write memory`→再起動で復元。
  RIP（`router rip`、`version 2`、`network 10.0.0.0`）で`R>*`を学習、pingが通る。
- **未対応**：route-map・prefix-list・access-listの設定コマンド（設定モードのトップレベル。`frr`キーには保存できる形だが入力の文法が無い）、iBGP・ルートリフレクタの確認、
  BGPの`show`の翻訳、VRRP・DHCPリレー・ACL（段階4）。

## 13. ポリシー系の実装メモ（2026-10-21、be/l3-policy）

- **渡し方**：`router_line`を一般化し、`router …`と`route-map NAME permit|deny SEQ`のどちらも「今の文脈（`cli.frr_router`）＋ `address-family`」でvtyshに渡す。route-mapは専用モード
  （`config-route-map`、`SUB_MODES`に追加）。`ip prefix-list`・`ip as-path`・`ip community-list`は設定モードのトップレベルの1行をそのまま渡す。翻訳は不要（Ciscoと同じ書き方）。
- **保存**：`parse_frr_config`の`KEEP_PREFIXES`に既に入れていたので、`frr`キーに写る。`show running-config`では、1行の設定は`!`を挟まず続けて出す。
- **`access-list`は先送り**：Ciscoの番号付きACL（`access-list 10 permit …`）は、`distribute-list`・`route-map`の`match ip address`（経路）と、`ip access-group`（パケット）の両方に使う。FRRの`access-list`は経路用だけ。
  段階4で、swcli側にACLを持ち、パケット用はnftablesに、`match ip address N`用の標準ACLは同じ内容をFRRにも入れる形にする。
- **確かめたこと**（コンテナ2台）：sw1がeBGPで2つのネットワークを広告し、sw2が`ip prefix-list ONLY10`＋`route-map IN`（`match ip address prefix-list`、`set local-preference 200`）を`neighbor … route-map IN in`で適用 →
  受け取ったのは許可した`10.10.1.0/24`だけ（LocPrf 200）、`10.20.1.0/24`は暗黙の拒否で入らない。
- ビルドの注意：`swcli.py`を変えたら`fnl/l2switch`のタグを上げて作り直し、その上に`fnl/l3switch`を作る（土台のswcliが古いまま`<rmaction>`の引数チェックが無く、エラーになった）。

## 14. 段階4（VRRP・DHCPリレー）の実装メモ（2026-10-21、be/l3-vrrp-dhcp）

ACLは別に設計する（次のPR）。

- **VRRP**：`vrrp …`を`interface`の中でvrrpdに渡す。**FRRはmacvlanを作らない**ので、エージェント（`sync_vrrp`）が`vrrp4-<ifindex>-<VRID>`を作り、仮想アドレスを付ける
  （`vrrp autoconfigure`はmacvlanを作る機能ではなく、既にあるmacvlanからインスタンスを作る機能。最初に取り違えた）。仮想アドレスをmacvlanに付けたままにし、Backupの間はvrrpdがprotodownにして無効にする。
  Ciscoの`timers advertise`（秒）はFRRの`advertisement-interval`（ミリ秒）に翻訳。FRRの`vrrp version`というグローバルコマンドは無い（版は既定の3）。
- **DHCPリレー**：Alpineの`dhcp-helper`（Simon Kelley製の小さなリレー）を、エージェントが管理する。`ip helper-address`はswcliの設定に持つ（FRRの設定ではない）。
- **確かめたこと**（コンテナ）：VRRP＝2台でMaster（優先度120）／Backupに分かれ、仮想アドレスはMasterのmacvlanだけがUP、Backupに宛てたpingがMasterに届き、Masterを落とすとBackupがMasterになる。
  DHCPリレー＝VLAN10のクライアントが、リレー経由でdnsmasqからアドレスを取得（DISCOVER→OFFER→REQUEST→ACK）。
- **未対応**：VRRPの認証・トラッキング、`show vrrp brief`の1行表示、HSRP、DHCPのオプション82、インターフェースごとのDHCPサーバーの振り分け。
- **VRRPの制約の実測（2026-10-21）**：切り替え約3.8秒／版の食い違い（版3と版2）で両方Master／SVIを`shutdown`した側の`show vrrp`がMasterのまま（macvlanを管理上落としても変わらない）／再起動後は約9秒で復元。詳細は`backend/l2switch/README.md`。

## 15. ACLの実装メモ（2026-10-21、be/l3-acl）

- **構成**：`acl.py`（入力の解釈・nftablesへの変換・FRRへの写し。副作用なしの純粋な関数）と、`l3.py`（コマンド・適用）に分けた。
- **経路用の`access-list`との両立**（13章で「ACLと一緒に設計」とした点）：入力は一つ（Ciscoの`access-list`／`ip access-list`）。パケット用はnftablesに、**標準ACLだけ**FRRの`access-list`にも写す（`route-map`の`match ip address N`用）。
  FRRの設定（`frr`キー）は`access-list`を保存しない（`KEEP_PREFIXES`から外した）。ACL側（`acls`）が唯一の持ち主で、エージェントが5秒ごとにFRRと突き合わせる。
- **nftablesの形**：`permit`は`return`（呼び出し元に戻る）にした。`accept`にすると、同じ`forward`チェーンの後ろにある`out`のACLが評価されない。最後は`counter drop`（暗黙の拒否）。
  一致回数は規則のコメント（`"<ACL> <seq>"`）をキーに`nft list`から読む。
- **確かめたこと**（コンテナ、ネットワーク名前空間で2台のホストをVLAN10・20に）：拡張ACLの`in`で、ホストAからBへのicmp echoが止まる（逆向きは通る）／tcp 8080は止まりtcp 9090は通る／
  `show access-lists`に一致回数が出る／`no ip access-group`でnftablesの表が消えて通る／標準ACLがFRRの`access-list`に写る。
- **未確認**：`out`の向き、ルーテッドポートでの適用、`established`・`range`・`neq`の実機の挙動（nftの規則の文字列はテスト済み）、`write memory`→再起動での復元（設定は他と同じ経路で保存される）。

