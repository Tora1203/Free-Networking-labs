# l2switch（L2スイッチ用コンテナイメージ）

L2スイッチを、ホストのOVS（`ovs-bridge` kind）ではなく**普通のコンテナ**として動かすためのイメージ
（2026-10-13決定、経緯は `docs/direction.md`）。スイッチ機能はコンテナ内のVLAN対応Linuxブリッジ
（`br0`、`vlan_filtering 1`）で実現する。

| タグ | 中身 |
| --- | --- |
| `fnl/l2switch:1`（2026-10-13） | alpine + iproute2。VLANはGUIの設定をexecで`bridge vlan`投入 |
| `fnl/l2switch:2`（2026-10-14） | alpine + iproute2 + python3。**Cisco風CLI（`swcli`）で設定**し、エージェントがbr0に反映 |
| `fnl/l2switch:3`（2026-10-14） | alpine 3.22（iproute2 6.15、MST対応）＋ mstpd。STP/RSTP/MSTP |
| `fnl/l2switch:4`（2026-10-14） | GUIの「ケーブルを抜く」に対応（`/run/fnl-switch/unplugged`に書かれたポートをdownのままにし、notconnectと表示）。非特権コンテナでmstpdが応答できずSTPが動いていなかった不具合を修正 |
| `fnl/l2switch:6`（2026-10-14〜） | ログ（コンソールに流れる）、`show interfaces`の詳細・カウンタ、MACテーブルの操作、管理用SVI・`ping`・パスワード、LLDP/CDP（lldpd）、EtherChannel（bond）、ポートセキュリティ、`| include`等の絞り込み |

## Cisco風CLI（swcli）

コンソールを開くと`swcli`だけが動く（ルーターのvtyshと同じく、終了しても再起動されシェルには落ちない）。
表示は英語（2026-10-14：日本語は端末で文字化けしたため）。Ciscoと同じ操作感を目指している：

- 省略形：各キーワードは一意に決まる範囲で省略できる（`conf t`、`int e1`、`int eth 1`、`sw mo acc`、`sh vl br`）。
  完全一致のキーワードは前方一致より優先し、複数に一致すれば`% Ambiguous command`
- `?`：打った瞬間に次の候補と説明を出す（`sw ?`）。語の途中なら一致するキーワード名だけ（`conf?`）
- Tab：一意なら補完して空白を足す。複数なら候補を一覧する。インターフェース名（eth1…）も補完する
- 間違えた位置を`^`で示す（`% Invalid input detected at '^' marker.`）。途中までなら`% Incomplete command.`
- Ctrl+Z：入力中の行を実行して特権モードに戻る。Ctrl+C：入力を捨てて特権モードに戻る
- interface/vlanモードのままで別の`interface`等、設定モードのコマンドを打てる。`do show ...`も可

```
sw#conf t
sw(config)#vlan 10
sw(config-vlan)# name Sales
sw(config-vlan)#int eth1
sw(config-if)# sw mo acc
sw(config-if)# sw acc vl 10
sw(config-if)#int eth3
sw(config-if)# sw mo tr
sw(config-if)# sw tr al vl 10,20
sw(config-if)#end
sw#sh vlan br / sh int status / sh int trunk / sh mac add / sh run
sw#wr
```

| モード | コマンド |
| --- | --- |
| 特権 | `show running-config / startup-config / vlan [brief] / interfaces status / interfaces trunk / mac address-table`、`configure terminal`、`write [memory]`、`copy running-config startup-config`、`exit` |
| 設定 | `interface ethN`、`interface range eth1-3,eth5`（`eth1 - 3 , eth5`も可）、`vlan <list>`、`no vlan <list>`、`hostname`、`do ...`、`end`、`exit` |
| VLAN | `name WORD`、`no name` |
| インターフェース | `switchport mode access/trunk`、`switchport access vlan N`、`switchport trunk allowed vlan <list>/add/remove/all/none`、`switchport trunk native vlan N`、`shutdown`、`description`、各`no`形 |

### 運用・管理の機能（2026-10-14〜、`fnl/l2switch:6`）

CCNA系の演習でよく使う機能。すべて非特権のコンテナ（GUIと同じ`privileged: false`＋`NET_ADMIN`）で動作確認済み。

| 機能 | コマンド | 実装 |
| --- | --- | --- |
| ログ | `show logging`、`clear logging`、`[no] logging console`。`%LINK-3-UPDOWN`、`%LINEPROTO-5-UPDOWN`、`%LINK-5-CHANGED`、`%SYS-5-CONFIG_I`、`%SPANTREE-2-BLOCK_BPDUGUARD`、`%PM-4-ERR_DISABLE`、`%EC-5-BUNDLE`、`%PORT_SECURITY-2-PSECURE_VIOLATION` | エージェントとCLIが`/run/fnl-switch/log`に追記し、CLIが入力中の行を壊さずにコンソールへ流す（readlineの`rl_forced_update_display`） |
| インターフェース | `show interfaces [ethN / port-channel N / vlan N]`（状態・MAC・BW・5秒間の送受信レート・カウンタ）、`show interfaces counters`、`clear counters [ethN]`、`show ip interface brief` | `/sys/class/net/*/statistics`。BWはGUIのリンクの品質（netem）の帯域（既定100Mbps）で、STPのコストにも使う（100Mbps→19） |
| MACテーブル | `show mac address-table [dynamic/static] [address M / interface X / vlan N] / count / aging-time`、`clear mac address-table dynamic [...]`、`mac address-table aging-time N`、`mac address-table static M vlan N interface X` | `bridge fdb`、ブリッジの`ageing_time` |
| 管理用SVI | `interface vlan N`（→ `ip address A M`、`[no] shutdown`）、`ip default-gateway A`、`ping A [repeat N / size N]` | ブリッジ上のVLANデバイス（vlanN）。作った直後はshutdown（Ciscoと同じ）。管理ネットワーク（eth0）のデフォルトルートは消す |
| パスワード | `enable secret`（type 9＝scrypt）、`enable password`、`service password-encryption`（type 7）、`line con 0`（→ `password`、`login`、`logging synchronous`）、`disable` | enable secret/passwordがあるとユーザーモード（`>`）から始まる。無ければ従来どおり特権モードから |
| LLDP/CDP | `[no] lldp run`（既定は無効）、`[no] cdp run`（既定は有効）、インターフェースの`[no] lldp transmit/receive`・`[no] cdp enable`、`show lldp [neighbors [detail]]`、`show cdp [neighbors [detail]]` | lldpd（`-ccc -l -H 0`）。止める時は出口のtcでフレームを捨て、受信は表示しない。CDPはブリッジが転送しないよう入口で捨てる（lldpdはその手前で受け取る）。ルーター（`fnl/frr:3`）もLLDP/CDPを送る。lldpdが送らなくなったら（75秒）エージェントが起動し直す |
| EtherChannel | `channel-group N mode active/passive/on`（desirable/autoはPAgPなので非対応）、`interface port-channel N`、`show etherchannel summary`、`show lacp neighbor` | Linuxのbond（802.3ad／balance-xor）。VLAN・STPはport-channelの設定が効く。BPDUはbondに届けてから捨てる |
| ポートセキュリティ | `switchport port-security [maximum N / violation protect/restrict/shutdown / mac-address [sticky] [M]]`、`show port-security [interface X / address]`、`clear port-security dynamic/sticky/all` | ブリッジポートの`locked`＋`mab`。知らない送信元MACはエージェントが上限以内なら固定のエントリにして通し、超えたら違反として扱う |
| 出力の絞り込み | `show ... \| include/exclude/begin/section 正規表現` | |

注意：`shutdown`→`no shutdown`を続けて打ってもerr-disabledから戻るよう、`shutdown`の時点でCLIが解除する。
PVST・PAgP・DHCPスヌーピング・SPANは無い。ポートセキュリティはaccessポートだけ（Ciscoと同じ）。

### スパニングツリー（2026-10-14〜、`fnl/l2switch:3`）

[mstpd](https://github.com/mstpd/mstpd)（RSTP/MSTPのデーモン）をソースからビルドして入れ、
**STP（802.1D）/ RSTP（802.1w）/ MSTP（802.1s）**を動かす。既定は `rapid-stp` で有効（2026-10-14にstpから変更。最近の機種はRSTP系が既定のため。
STPなしでループを組むと1ポートあたり毎秒約29万パケットのストームになり、共有サーバーのload averageが
0.5→3に上がるのを実測したため）。モード名はCiscoのpvst/rapid-pvstではなく `stp / rapid-stp / mstp`
（PVSTはCisco独自でLinuxでは動かず、名前が混ざると紛らわしいため）。

| モード | コマンド |
| --- | --- |
| 特権 | `show spanning-tree`、`show spanning-tree mst [N]`、`show spanning-tree mst configuration` |
| 設定 | `spanning-tree mode stp/rapid-stp/mstp`、`[no] spanning-tree vlan <list> [priority N / root primary / root secondary / hello-time / forward-time / max-age]`、`spanning-tree mst <0-4093> priority N / root primary/secondary`、`spanning-tree mst hello-time/forward-time/max-age`、`spanning-tree portfast default`、`spanning-tree portfast bpduguard default`、`spanning-tree mst configuration`（→ `name`、`revision`、`instance N vlan <list>`、`no instance N`、`show`） |
| インターフェース | `spanning-tree portfast [disable]`、`spanning-tree bpduguard enable/disable`、`spanning-tree bpdufilter enable`、`spanning-tree guard root/none`、`spanning-tree cost N`、`spanning-tree port-priority N`（各`no`形） |

コンテナで動かすための仕組み（`mstpd/fnl.patch`、mstpdのコミット`2e747d8`に当てる）：
- カーネルがmstpdにポートを任せる「ユーザーSTPモード」はホストの名前空間でしか使えない。そこでカーネルのSTPは
  切り（`stp_state 0`）、ブリッジを`mst_enabled 1`にして、mstpdの決めた状態を**カーネルのMSTのポート状態**
  （`bridge mst set dev ethN msti M state S`）として入れる（パッチの`driver_set_new_state`）。カーネルのMSTI 0は
  設定できないので、CISTはカーネルのMSTI 4094に対応させる（利用者のMSTIは1〜4093）
- STP無効のブリッジはBPDUを普通に転送してしまうので、各ポートの入口（`tc ... flower dst_mac 01:80:c2:00:00:00
  action drop`）で捨てる。mstpdはパケットソケットを`ETH_P_ALL`にしてその手前で受け取る（パッチ）
- mstpd本体の不具合（`brmon.c`がnetlinkの通知を1バイトしか読まず、ポートの追加に気づくのが遅れる）も直している
- エージェント（`swcli --agent`）は、VLANをカーネルのMSTIに割り当て（MSTI 0のままだと常に転送でループする）、
  設定をmstpctlで入れ、5秒ごとにmstpdの状態とカーネルの状態を突き合わせる
- BPDU Guardで止まったポートはmstpdがdownにする。エージェントは`err-disabled`として落としたままにし、
  `shutdown` → `no shutdown` で戻す（Ciscoと同じ）
- パスコストは stp/rapid-stp ではCiscoの既定（short：10G=2）、mstp では長いコスト（10G=2000）

制約：PVST/Rapid-PVST（VLANごとに独立したSTP）は無い。portfastでないポートはCiscoと同じく自動でエッジにしない
（rapid-stpでもPCのポートはportfastを入れないと約30秒待つ）。

実測（スイッチ3台のループ＋PC2台）：stp はルート側のリンク断から約49秒で迂回、rapid-stp は0.2秒間隔のpingが
1つも欠けずに迂回。MSTPでインスタンスごとにルートとブロックされるポートが分かれることを確認。
エージェントのCPUはスイッチ1台あたり約0.6%（全VLAN許可のトランクの確認を間引いた後）。

VLANの意味はCiscoに合わせている：
- 何も設定していないポートは access VLAN 1
- trunk は allowed vlan（既定は全VLAN）をタグ付きで通し、**native vlan（既定1）だけタグなし**で通す。
  そのためルーターでVLAN1をサブインターフェース（eth1.1）にしたい場合は、native vlanを別の番号にする
  （Ciscoで`encapsulation dot1Q 1 native`が要るのと同じ）
- `interface`/`vlan`モードのままでも、設定モードのコマンド（別の`interface`等）を打てる

設定の保存：
- running-config：`/run/fnl-switch/running.json`。起動のたびにstartup-configから作り直す
- startup-config：`/etc/fnl-switch/startup.json`（`write memory`で保存）。2026-10-14夕方から、GUIはこの
  ディレクトリをホストのラボ配下`switch-config/<スイッチ名>/`にbind mountする（ルーターのfrr-configと同じ。
  ディレクトリはovs-helperの`POST /switch-config`がdeploy前に用意する）。そのためラボの「作り直す」でも残る。
  bind mountしていない場合（CLIで直接deployしたラボ等）はコンテナ内に置かれ、コンテナを作り直すと消える

エージェント（`swcli --agent`、コンテナのメインプロセス）は1秒ごとにrunning-configと`bridge vlan show`を
比べ、違うポートだけ設定し直す。後から追加されたポート（ethN）もbr0に参加させる。

## ビルド

```sh
docker build -t fnl/l2switch:6 backend/l2switch   # mstpdをGitHubから取ってビルドするのでネットワークが要る
```

## テスト

```sh
cd backend/l2switch && python3 -m unittest -v test_swcli
```

CLIの解釈（略語・`interface range`・エラーの`^`・`| include`等）、パスワード（type 7/9）、
running-configを流し込み直すと同じ設定になるか、`write memory`を確かめる。設定の置き場所を一時ディレクトリに、
ポートの一覧を固定の値に差し替えるので、コンテナの外（ホストのPython 3）でも動く。ブリッジ・mstpd・lldpdを
実際に動かす部分は対象外（実機確認）。

## 実機確認

- 2026-10-13（:1）：動いているラボにスイッチ＋リンクを`apply`で追加でき、既存ノードは作り直されない。
  アクセスポートでVLAN分離、トランク＋ルーターのサブインターフェースでVLAN間ルーティング
- 2026-10-14（:2）：CLIでaccess/trunkを設定し、`fnl/frr:1`のルーターのサブインターフェース経由で
  VLAN10↔20の疎通を確認。`wr`→ノード停止/起動で保存した設定だけが戻る（保存していない変更は消える）。
  `?`ヘルプ・Tab補完・省略形（`sw mo acc`、`sh vl br`）を端末で確認

## L3スイッチ（fnl/l3switch、2026-10-21〜、段階1）

L2スイッチのイメージ（`fnl/l2switch:10`〜）に、FRR（zebra・staticd）とnftablesと`l3.py`（swcliのプラグイン）を足したもの
（`Dockerfile.l3`）。`swcli`は起動時に同じディレクトリの`l3.py`を読み込むので、L2スイッチのイメージ（`l3.py`なし）の動きは変わらない。
設計は`docs/l3-switch-design.md`。

```
docker build -t fnl/l2switch:10 backend/l2switch
docker build -t fnl/l3switch:6 -f backend/l2switch/Dockerfile.l3 backend/l2switch
```

| コマンド | 内容 |
| --- | --- |
| `ip routing` / `no ip routing` | 経路制御を動かす／止める。既定は`no ip routing`（実機のCatalystと同じく、入れるまでL3として動かない） |
| `interface vlan N` ＋ `ip address` | SVI。`ip routing`の間、SVI同士のあいだでルーティングされる |
| `ip route <宛先> <マスク> <次のホップ>` / `no ip route …` | 静的経路（FRRのstaticdに入れる） |
| `interface ethN` → `no switchport` ＋ `ip address` | ルーテッドポート（ブリッジから外れる）。`switchport`で戻すとアドレスは消える |
| `show ip route` | FRRの経路表（`vtysh`の出力のまま。管理用のeth0の経路も出る＝ルーターと同じ） |

実装の注意（実機で確かめた）：
- **`SYS_ADMIN`が要る**：zebraが`CAP_SYS_ADMIN`を要求する（無いと`privs_init: initial cap_set_proc failed`で起動しない）。ルーターと同じ`NET_ADMIN`・`NET_RAW`・`SYS_ADMIN`。
- **`no ip routing`の止め方**：コンテナの`net.ipv4.ip_forward`は非特権では書き換えられず、既定で1。そこでnftables（`inet fnl_l3`）で、SVI（`vlan*`）とルーテッドポートから入るパケットの転送だけを落とす。ブリッジの中のL2転送には触れない。
- **FRRの起動はパイプで待たない**：`frrinit.sh start`が起動したデーモンが出力の口を握り続け、パイプで受けると30秒固まる（エージェント全体が止まる）。出力はファイル（`/run/fnl-switch/frr-init.log`）に逃がす。
- **静的経路の入れ方**：経路は設定（running-config）に持ち、エージェントが5秒ごとにFRRと突き合わせる（FRRが再起動して経路を失っても戻る）。FRRの設定ファイルは起動のたびに作り直す。
- **ラボを起動した直後**は、STP（rapid-stp）がポートを転送状態にするまで数秒かかる。ping等はその後に確かめる。

### 段階2：OSPF（BGP・RIPも同じ仕組み、`fnl/l3switch:2`）

`router ospf` / `router bgp <AS>` / `router rip` に入ると、中のコマンドをFRRの`vtysh`に渡す（`?`ヘルプとTab補完はFRRのコマンドには効かない）。
Ciscoの書き方は翻訳して渡す。FRRの設定は`write memory`で`startup.json`の`frr`キーに入り、FRRの起動のたびに`frr.conf`へ書き戻される。

| コマンド | 内容 |
| --- | --- |
| `router ospf [1]` | OSPFのモードに入る（インスタンス番号は無視） |
| `router-id 1.1.1.1` | → FRRの`ospf router-id` |
| `network 10.0.0.0 0.0.0.255 area 0` | → `network 10.0.0.0/24 area 0`（ワイルドカードマスクをプレフィックスに。連続しないマスクは断る） |
| `passive-interface vlan 10` / `default` | `vlan 10`は`vlan10`に直して渡す |
| `redistribute connected subnets` | `subnets`は取って渡す |
| `default-information originate [always]` ほか | そのまま渡す |
| `interface vlan N`／ルーテッドポート → `ip ospf cost N` ほか | FRRの`interface`に渡す。`ip ospf 1 area 0`は`ip ospf area 0`に |
| `show ip ospf neighbor` / `interface` / `database` / `show ip protocols` | vtyshの出力のまま |

- `no ip routing`の間は`router …`・`show ip ospf …`を断る（`% IP routing not enabled`）。FRRの設定は残り、`ip routing`で戻る。
- routerモードの中でも、`interface …`・別の`router …`・`ip route …`などの設定モードのコマンドは、そのまま通る（Ciscoと同じ）。
- `show running-config`では、FRRの`interface`の設定をswcliの`interface`の下に混ぜて出し、`network`はワイルドカード形式、`router ospf 1`で出す。FRRの`ip ospf passive`は、Ciscoの`passive-interface`ではなくFRRの書き方のまま出る。
- 起動後、OSPFの隣接（Full）まで約40秒（hello 10秒・dead 40秒）。

### 段階3：BGP・RIP（`fnl/l3switch:3`）

段階2と同じパススルー。Ciscoの書き方の翻訳を足した。

| コマンド | 内容 |
| --- | --- |
| `router bgp <AS>` | BGPのモード |
| `bgp router-id`, `neighbor A remote-as N`, `neighbor A activate` ほか | そのままFRRへ |
| `network 10.10.1.0 mask 255.255.255.0` | → `network 10.10.1.0/24`（`mask`なしのクラスフルは断る） |
| `aggregate-address A M [summary-only]` | → `aggregate-address A/L …` |
| `address-family ipv4` … `exit-address-family` | → `address-family ipv4 unicast`。入れ子の中にいることはswcliが覚える（vtyshは1コマンドずつ起動し直すため）。`exit`でrouterに戻る |
| `router rip` / `version 2` / `network 10.0.0.0` | クラスフルの`network`はクラスに合う長さのプレフィックスにして渡す（10.0.0.0→/8）。表示は元のクラスフルの形 |
| `no auto-summary` | FRRのRIPには無いので、何もしない（エラーにしない） |
| `show ip bgp summary` / `show ip bgp` / `show ip rip` / `show ip route bgp|rip|ospf` | vtyshの出力のまま |

- **`ebgp-requires-policy`はFRRの既定のまま**（ルーターのノードと同じ。`docs/direction.md` 2026-10-09の「FRRの仕様として周知する」）。eBGPで経路を交換するには、`router bgp` の中で `no bgp ebgp-requires-policy` を入れる（またはroute-mapを使う。route-mapの設定コマンドは未対応）。
- `neighbor` の `activate` は、`address-family` の中でも外でも通る（FRRの既定でIPv4 unicastは有効）。

### ポリシー（route-map・prefix-list ほか、`fnl/l3switch:4`）

設定モードのトップレベルから、FRRに渡す。書き方はCiscoとほぼ同じなので翻訳はしない。`ip routing`の間だけ使える（FRRの設定）。

| コマンド | 内容 |
| --- | --- |
| `ip prefix-list NAME [seq N] permit|deny A.B.C.D/L [ge N] [le N]` | プレフィックスリスト（`no ip prefix-list …`で削除） |
| `route-map NAME permit|deny [SEQ]` | route-mapのモード（`config-route-map`）。中の `match …`・`set …`（`match ip address prefix-list X`、`set local-preference N` 等）をFRRに渡す。SEQ省略は10。`no route-map …`で削除 |
| `ip as-path access-list …`、`ip community-list …` | そのままFRRへ |
| `neighbor A route-map NAME in|out`、`neighbor A prefix-list NAME in|out`、`redistribute … route-map NAME` | router の中でそのままFRRへ（段階2・3の仕組み） |
| `show ip prefix-list [NAME]`、`show route-map [NAME]` | vtyshの出力のまま |

- `show running-config`では、`ip prefix-list`等の1行の設定は続けて、`route-map`はFRRの書き方のまま出る。
- **`access-list`（番号付き）は未対応**：Ciscoでは経路用とパケット用で同じ名前を使うが、FRRの`access-list`は経路用。パケット用のACLは段階4（nftables）で、同じ入力を両方に反映する形を設計する。

### VRRP・DHCPリレー（`fnl/l3switch:5`、段階4の一部）

| コマンド | 内容 |
| --- | --- |
| `vrrp 1 ip 10.10.0.1` / `vrrp 1 priority 120` / `vrrp 1 preempt` ほか | `interface vlan N`・ルーテッドポートの中。FRRのvrrpdに渡す（`no vrrp …`で削除） |
| `vrrp 1 timers advertise 3` | → `vrrp 1 advertisement-interval 3000`（Ciscoは秒、FRRはミリ秒） |
| `show vrrp` / `show vrrp brief` | vtyshの出力のまま（`brief`も同じ詳細表示） |
| `ip helper-address A.B.C.D` / `no ip helper-address [A.B.C.D]` | DHCPリレー。`interface vlan N`・ルーテッドポートの中。何個でも。`show running-config`では`ip address`の次に出る |

- **VRRPの仕組み**：FRRのvrrpdは、仮想ルーター用のmacvlan（`vrrp4-<ifindex>-<VRID>`、MAC `00:00:5e:00:01:<VRID>`）を**作らない**。設定（`frr`キー）に合わせてエージェントが作り、
  仮想アドレス（`vrrp N ip`のアドレス、プレフィックス長はSVIと同じ）を付ける。Backupの間はvrrpdがmacvlanをprotodownにして無効にする。`no ip routing`の間はmacvlanを消す。
- **VRRPの版は3**（FRRの既定）。Ciscoの旧VRRP（版2）とは混在しない。同じ種類のスイッチ同士なら問題ない。
- **既知の制限**：VRRPの入っているSVIを`shutdown`しても、そのスイッチの`show vrrp`は`Master`のままになる（隔離されるので、もう一方が引き継ぐ動作には影響しない）。
- **DHCPリレーの仕組み**：`ip helper-address`はswcliの設定（SVIは`svi`、ルーテッドポートは`interfaces`の`helpers`）に持つ。エージェントが`dhcp-helper -s <サーバー> -i <インターフェース>`を動かす
  （サーバーは全インターフェースの分をまとめる。インターフェースごとに別のサーバーに振り分けることはしない）。設定が変われば作り直し、無くなれば止める。
- **`ip routing`直後のコマンド**：FRRの起動を最大10秒待ってから渡す（打ってすぐ「起動中」で失敗しない）。ただし`vrrp 1 ip`はSVIにアドレスが付いてからでないと受け付けられない
  （アドレスはエージェントが1秒ごとに反映するので、続けて貼り付けると失敗することがある）。

### ACL（`fnl/l3switch:6`、段階4の残り）

パケットフィルタ。入力の解釈とnftablesへの変換は`acl.py`（コンテナの外でもテストできる純粋な関数）、コマンドと適用は`l3.py`。

| コマンド | 内容 |
| --- | --- |
| `ip access-list standard|extended NAME` | 名前付きACLのモード（`config-std-nacl`／`config-ext-nacl`）。`no ip access-list standard|extended NAME`で削除 |
| `[SEQ] permit|deny …` | エントリ。SEQ省略は10刻みで末尾に。`no SEQ`または`no permit …`で削除。`remark`は無視 |
| `access-list N permit|deny …` | 番号付き（標準1-99・1300-1999、拡張100-199・2000-2699）。`no access-list N`で削除 |
| `ip access-group NAME in|out` | `interface vlan N`・ルーテッドポートの中。`no ip access-group [NAME] in|out`で外す |
| `show access-lists [NAME]`、`show ip access-lists [NAME]` | エントリと一致回数（`(N matches)`） |

- **標準**：`permit|deny any|host A|A WILDCARD`（単独のアドレスはhost）。**拡張**：`permit|deny ip|icmp|tcp|udp 送信元 [ポート] 宛先 [ポート] [icmpの種類|established]`。
  アドレスは`any`・`host A`・`A WILDCARD`（連続しないワイルドカードも可）。ポートは`eq|neq|gt|lt|range`（`www`・`domain`・`ssh`等の名前も可）。icmpの種類は`echo`・`echo-reply`・`unreachable`・`ttl-exceeded`。
- **nftablesへの変換**：ACLごとにチェーン（`acl_<名前>`）を作り、`permit`は`return`、`deny`は`drop`、最後に暗黙の拒否（`drop`）。適用は`forward`（`in`＝入るインターフェース、`out`＝出るインターフェース）と、`in`だけ`input`（スイッチ宛、SVIへのping等）。
  IPv4だけ（`table ip fnl_acl`）。ブリッジの中のL2転送には効かない（`iifname`がSVI・ルーテッドポートなので）。設定が変わった時だけ表を作り直す。存在しないACLを指す`ip access-group`は無視（Ciscoと同じく全部通す）。
- **経路用との両立**：標準ACLは、FRRの`access-list`（`seq N permit|deny 10.0.0.0/24`）にも写す（`route-map`の`match ip address N`や`distribute-list`で使うため）。FRRの設定（`frr`キー）には保存せず、ACL側が持ち主。
  連続しないワイルドカードはFRRに写せないので飛ばす。
- **`show running-config`**：名前付きは`ip access-list …`の下に番号付きで、番号付きは`access-list N …`で出る。`ip access-group`はインターフェースの下に出る。
- **ルーティングを使っていなくても効く**（`no ip routing`の間はVLAN間の転送自体が止まっているので、効果が見えるのは`ip routing`の間）。
- **未対応**：`log`（無視する）、`ip access-class`（VTY）、時間指定、`object-group`、IPv6のACL、`fragments`・`dscp`等のオプション。

