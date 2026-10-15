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
| `fnl/l2switch:5`（2026-10-14〜） | ログ（コンソールに流れる）、`show interfaces`の詳細・カウンタ、MACテーブルの操作、管理用SVI・`ping`・パスワード、LLDP/CDP（lldpd）、EtherChannel（bond）、ポートセキュリティ、`| include`等の絞り込み |

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

### 運用・管理の機能（2026-10-14〜、`fnl/l2switch:5`）

CCNA系の演習でよく使う機能。すべて非特権のコンテナ（GUIと同じ`privileged: false`＋`NET_ADMIN`）で動作確認済み。

| 機能 | コマンド | 実装 |
| --- | --- | --- |
| ログ | `show logging`、`clear logging`、`[no] logging console`。`%LINK-3-UPDOWN`、`%LINEPROTO-5-UPDOWN`、`%LINK-5-CHANGED`、`%SYS-5-CONFIG_I`、`%SPANTREE-2-BLOCK_BPDUGUARD`、`%PM-4-ERR_DISABLE`、`%EC-5-BUNDLE`、`%PORT_SECURITY-2-PSECURE_VIOLATION` | エージェントとCLIが`/run/fnl-switch/log`に追記し、CLIが入力中の行を壊さずにコンソールへ流す（readlineの`rl_forced_update_display`） |
| インターフェース | `show interfaces [ethN / port-channel N / vlan N]`（状態・MAC・BW・5秒間の送受信レート・カウンタ）、`show interfaces counters`、`clear counters [ethN]`、`show ip interface brief` | `/sys/class/net/*/statistics`。BWはGUIのリンクの品質（netem）の帯域（既定100Mbps）で、STPのコストにも使う（100Mbps→19） |
| MACテーブル | `show mac address-table [dynamic/static] [address M / interface X / vlan N] / count / aging-time`、`clear mac address-table dynamic [...]`、`mac address-table aging-time N`、`mac address-table static M vlan N interface X` | `bridge fdb`、ブリッジの`ageing_time` |
| 管理用SVI | `interface vlan N`（→ `ip address A M`、`[no] shutdown`）、`ip default-gateway A`、`ping A [repeat N / size N]` | ブリッジ上のVLANデバイス（vlanN）。作った直後はshutdown（Ciscoと同じ）。管理ネットワーク（eth0）のデフォルトルートは消す |
| パスワード | `enable secret`（type 9＝scrypt）、`enable password`、`service password-encryption`（type 7）、`line con 0`（→ `password`、`login`、`logging synchronous`）、`disable` | enable secret/passwordがあるとユーザーモード（`>`）から始まる。無ければ従来どおり特権モードから |
| LLDP/CDP | `[no] lldp run`（既定は無効）、`[no] cdp run`（既定は有効）、インターフェースの`[no] lldp transmit/receive`・`[no] cdp enable`、`show lldp [neighbors [detail]]`、`show cdp [neighbors [detail]]` | lldpd（`-ccc -l -H 0`）。止める時は出口のtcでフレームを捨て、受信は表示しない。CDPはブリッジが転送しないよう入口で捨てる（lldpdはその手前で受け取る）。ルーター（`fnl/frr:2`）もLLDP/CDPを送る。lldpdが送らなくなったら（75秒）エージェントが起動し直す |
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
docker build -t fnl/l2switch:5 backend/l2switch   # mstpdをGitHubから取ってビルドするのでネットワークが要る
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
