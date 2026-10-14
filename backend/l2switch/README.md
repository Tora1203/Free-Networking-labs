# l2switch（L2スイッチ用コンテナイメージ）

L2スイッチを、ホストのOVS（`ovs-bridge` kind）ではなく**普通のコンテナ**として動かすためのイメージ
（2026-10-13決定、経緯は `docs/direction.md`）。スイッチ機能はコンテナ内のVLAN対応Linuxブリッジ
（`br0`、`vlan_filtering 1`）で実現する。

| タグ | 中身 |
| --- | --- |
| `fnl/l2switch:1`（2026-10-13） | alpine + iproute2。VLANはGUIの設定をexecで`bridge vlan`投入 |
| `fnl/l2switch:2`（2026-10-14〜） | alpine + iproute2 + python3。**Cisco風CLI（`swcli`）で設定**し、エージェントがbr0に反映 |

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
| 設定 | `interface ethN`、`interface range eth1-3,eth5`、`vlan <list>`、`no vlan <list>`、`hostname`、`do ...`、`end`、`exit` |
| VLAN | `name WORD`、`no name` |
| インターフェース | `switchport mode access/trunk`、`switchport access vlan N`、`switchport trunk allowed vlan <list>/add/remove/all/none`、`switchport trunk native vlan N`、`shutdown`、`description`、各`no`形 |

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
docker build -t fnl/l2switch:2 backend/l2switch
```

## 実機確認

- 2026-10-13（:1）：動いているラボにスイッチ＋リンクを`apply`で追加でき、既存ノードは作り直されない。
  アクセスポートでVLAN分離、トランク＋ルーターのサブインターフェースでVLAN間ルーティング
- 2026-10-14（:2）：CLIでaccess/trunkを設定し、`fnl/frr:1`のルーターのサブインターフェース経由で
  VLAN10↔20の疎通を確認。`wr`→ノード停止/起動で保存した設定だけが戻る（保存していない変更は消える）。
  `?`ヘルプ・Tab補完・省略形（`sw mo acc`、`sh vl br`）を端末で確認
