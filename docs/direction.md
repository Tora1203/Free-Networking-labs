# 卒業制作 方向性メモ

## テーマ
Containerlabをバックエンドにした「CML(Cisco Modeling Labs)のオープンソース版」を作る。
教員/学生のような役割分けや授業運営機能は対象外。CMLの一般的な使用感（GUI＋マルチユーザー）をOSSで再現することが目的。

## 決定事項（2026-09-10時点、最新）
- 目的：ContainerlabベースでCML相当のGUI体験を持つOSSツールを作る。
- 教育機関向けのクラス管理機能（課題配布・提出回収・進捗ダッシュボード）は**不要**。役割はフラットな「マルチユーザー」でよい。
- **外部ネットワークへのブリッジ接続（External Connector相当）は今回は実装しない**（スコープ外）。
- ホスティング環境：研究室/学校の1台の共有サーバーに全員が同居する構成。
- **対応ノードタイプ：ルーター＝FRR、L2スイッチ＝Containerlabの`ovs-bridge`kind、PC/ホスト＝`linux`kind（Alpine等軽量イメージ）**（リソース制約のため）。
  - FRRはvrnetlab等のVMラップが不要なネイティブコンテナで、1ノードあたりの消費リソースが軽く、共有サーバーでの同時起動数を確保しやすい。BGP/OSPF/ISIS等の検証に対応可能。
  - L2スイッチは`ovs-bridge`kindを採用。Open vSwitchはVLANタグ付け（アクセスポート/トランクポート、`ovs-vsctl`の`tag`/`trunks`オプション）が確立された機能として使え、VLAN対応のスイッチを実現できる。素のLinux `bridge`kindはVLAN対応が公式ドキュメント上不明確なため見送り。
  - `linux`kindはFRRよりさらに軽量な汎用Linuxコンテナで、PC/ホスト役として使う。
  - これによりCMLと同様に「ルーター/L2スイッチ/PC」の3種類のノードでトポロジを組める（ルーティングOSの選択肢をFRRのみに絞る、という当初の決定とは矛盾しない）。
  - **L3スイッチ（FRR＋VLAN対応ブリッジの組み合わせでSVI相当を実現する構成）は今回は見送り、将来の拡張候補としてメモに残す**。実現は技術的に可能（Cumulus Linux等のホワイトボックススイッチと同じ発想）だが、VLAN間ルーティングの自動化など実装コストがL2スイッチ/PCより一段高いため、GUI開発を優先する現方針とは切り離した。
- **認証方式：Linuxアカウンティング（clab-api-serverのPAM認証をそのまま利用）を採用**。独自DB/自作認証は不要と決定。
  - 各人に個別のLinuxアカウントを作成し、`clab_api`/`clab_admins`グループに所属させる
  - clab-api-serverがラボを`$CLAB_LABS_ROOT/<username>/`に自動でユーザーごとに分離・所有権管理してくれるため、追加実装なしで「各自が自分のラボを持てる」を実現できる
  - サーバーリソース面では、認証方式の違い（個別アカウント vs 共有アカウント vs 独自DB）自体はCPU/メモリ負荷にほぼ影響しない（負荷を左右するのは同時起動ノード数であり、認証方式ではない）と整理済み
- 卒論として最優先で作り込む核：**GUIの使い勝手**（CMLの操作感の再現）
  - ドラッグ&ドロップのトポロジエディタ
  - ノード/リンクのライブ状態可視化
  - ブラウザ統合コンソール（xterm.js等でノードにSSH/exec）
  - ノードのライフサイクル操作（起動/停止/wipe/削除）のGUI化
- マルチユーザー基盤は自作せず、**clab-api-server**を採用し、その上に独自GUIフロントエンドを構築する方針。
- **フロントエンド技術を確定：React + React Flow (xyflow)（トポロジエディタ）+ xterm.js（統合コンソール）**。比較検討の詳細はoverview.md参照。
- **GitHubにリポジトリ作成済み**。以降の実装はこのリポジトリで進める。
- **サーバー構築を開始**：Proxmox VE（無料版、メモリ動的融通なし）上にUbuntu Server 24.04 LTS、メモリ12GB固定のVM「lab-server」を作成し、Claude Codeを導入・稼働中。GitHub認証はSSH鍵方式で解決済み。

## 再現対象：CMLの主要機能棚卸し
- ドラッグ&ドロップのトポロジエディタ
- ノードのライフサイクル管理（起動/停止/wipe/削除）
- ブラウザ統合コンソール（コンソール/SSH）
- ~~外部ネットワークへのブリッジ接続~~（今回はスコープ外）
- ラボの保存・複製・インポート/エクスポート
- ノード/リンクの状態可視化
- マルチユーザーで各自が自分のラボを持てる（Linuxアカウント単位で実現）

## 比較対象と差別化ポイント
- **CML Free**：単一ユーザー専用、同時ノード数上限5台、対応イメージも限定的。今回はマルチユーザー・ノード数上限なしを差別化点にする。
- **Containerlab公式GUIエコシステム（TopoViewer / VS Code拡張 / containerlab-app）**：clab-api-server経由のWeb GUIはすでに存在するため、単純な「Web GUI化」だけでは新規性が薄い。差別化はCML相当の操作感（ライフサイクル管理、統合コンソールの完成度）の作り込みに置く。
- **netlab**：Containerlabの設定自動生成（BGP/OSPF/EVPN）を担う上位ツール。今回のスコープでは直接は使わないが、将来的な連携候補。

## Containerlab自体の既知の弱点（背景整理）
1. Linuxホスト＋Docker（多くの場合root）が前提で、Windows/macOSネイティブ非対応
2. 商用ベンダーイメージの準備コストが高い（vrnetlabビルド等）※今回はFRRのみでこの問題を回避
3. コンフィグ自動生成機能がない（配線のみ、プロトコル設定は手動）
4. トラフィック生成・検証・学習支援の標準機能がない
5. マルチユーザー/教室運用の仕組みが薄い（clab-api-serverで解消）
6. リソース使用量の事前見積り・可視化がない

## 決定事項（2026-09-16追記）

- **状態管理ライブラリ：Zustandに決定**。ボイラープレートが少なくReact Flowのローカル状態とも共存しやすい。
  トポロジエディタ＋ラボ一覧程度の規模ではReduxのaction/reducer/Providerの構成は過剰と判断。
- **同時起動ノード数の上限：設けない**。実測（4 vCPU / メモリ約11.7GBのサーバーで、
  FRR(kind:linuxコンテナ)がアイドル時約13.7MB、linux(alpine)が約0.7MBと非常に軽量）から、
  当面のノード数では現実的なリソース逼迫は起きにくいと判断。CML Freeとの差別化点（ノード数無制限）
  にも合致する。clab-api-server自体にもユーザーごとのノード数/ラボ数クォータ機能は無い（README確認済み）。
  将来リソース逼迫の兆候が見えたら、ハードな上限ではなくFE側の目安警告表示などから検討する。
- **ovs-bridgeのブリッジ名衝突対策：`<username>_<labname>_<ノード名>` を実際のcontainerlabノード名として使う**。
  M2/M3で判明した「ovs-bridgeのブリッジ名・インターフェース名がホスト全体でグローバルな名前空間」問題への対応。
  UI上の表示名は自由に付けられるが、FEが`POST /api/v1/labs`に送るJSON内の`ovs-bridge`kindノード名だけ、
  送信直前にこの形式へ自動変換する（同一ユーザーが同名ラボ・同名ノードを再利用する場合の衝突も回避）。
  実装はFE側の送信直前ロジックで完結する想定。詳細は`docs/api-contract.md`セクション3に追記。
  → **実装済み（2026-09-17）**：`frontend/src/utils/clabNaming.ts`の`toClabBridgeName()`。呼び出し箇所（実際のAPI送信処理）への組み込みはM7で対応。
  → **⚠️ 2026-09-24 訂正**：`<username>_<labname>_<ノード名>`という連結方式そのものが誤りだった。
  実機検証で、**Linuxのネットワークインターフェース名は15文字まで**（`IFNAMSIZ`、カーネルの制約。
  `ovs-vsctl add-br`で16文字以上を渡すと「Invalid argument」で失敗することを確認）という制限に
  引っかかることが判明。現実的なusername/labname/ノード名の組み合わせは簡単に15文字を超えるため、
  この方式は実運用に耐えない。**方式を変更**：username/labName/nodeNameの組み合わせを
  軽量なハッシュ（FNV-1a 32bit）にかけ、`sw-` + 8桁16進数（合計11文字）を使う方式に修正した。
  ブリッジ名から人間には元の名前が読み取れなくなるトレードオフはあるが、このプロジェクトの
  想定利用規模（数人×数ラボ）では衝突確率は無視できるレベル。実装は`toClabBridgeName()`を修正、
  実機で実際にL2疎通するところまで確認済み（`docs/api-contract.md`参照）。

## 決定事項（2026-09-24追記）：アーキテクチャに`console-proxy`を追加

当初のアーキテクチャ（overview.md参照）は「BE = clab-api-serverのみ」を想定していたが、
統合コンソール機能の実装にあたり、**軽量なWebSocket中継プロキシをもう1つ追加する**ことにした。

- **理由**：`clab-api-server`の統合コンソール用WebSocket
  （`GET /api/v1/terminal-sessions/{id}/stream`）は`Authorization`ヘッダーでしか認証できない
  （ソースコード・実機確認済み。クエリパラメータ/Cookie等の代替は無い）。一方、ブラウザの
  `WebSocket` APIはハンドシェイク時にカスタムヘッダーを一切設定できない（回避不可能な仕様上の制約）。
  → ブラウザから直接`clab-api-server`のこのエンドポイントには接続できない
- **対応**：ブラウザ⇄`console-proxy`⇄`clab-api-server`という構成にする。`console-proxy`は
  ブラウザからは（URLではなく最初のWSメッセージとして）トークンを受け取り、代わりに
  `Authorization`ヘッダー付きで`clab-api-server`に接続し、以降はメッセージをそのまま中継するだけの
  薄いレイヤー。実装は`backend/console-proxy/`（Node.js + `ws`ライブラリ、`dev-tools/echo-server.js`と
  同系統の小さなサービス）
- 実機で認証込みの通しの動作を確認済み（トークン検証→シェル起動→入出力の中継まで）
- `docs/overview.md`のアーキテクチャ図に`console-proxy`を追記済み（2026-09-24対応済み）
- **追記（2026-09-30）：中継時にBufferをそのまま`send()`してはいけない**。`ws`ライブラリの
  `message`イベントはペイロードを`Buffer`で渡してくるが、そのまま`send(buffer)`すると
  元のフレーム種別に関わらずバイナリフレームとして送られてしまい、ブラウザ側の`WebSocket`は
  既定でバイナリメッセージを`Blob`として渡す。このプロトコルは常にJSONテキストしか
  やり取りしないため、フロント側の`JSON.parse(event.data)`が`Blob`相手に毎回失敗し、
  統合コンソールが実質一度も繋がっていなかった（開発者ツールのコンソールエラーで発見）。
  `data.toString('utf8')`してから中継するよう修正。詳細は`docs/STATUS.md`参照

## 決定事項（2026-09-28追記）：ノードへのSSH直接ログインは見送り

- **検討したこと**：ブラウザの統合コンソールとは別に、TeraTerm等のSSHクライアントから各ノード
  （コンテナ）へ直接ログインできるようにできないか検討した
- **分かったこと**
  - containerlabの管理ネットワーク（`172.20.20.0/24`、dockerブリッジ）は他のLAN端末から
    直接は届かない。クライアント側に経路を1本足せば到達自体は可能
  - ルーター(FRRイメージ)・PC(alpine)は中身がいずれもAlpine Linuxで、sshdは入っていない
    （実機確認）。containerlabの`exec:`機能で`apk add openssh-server`等をdeploy時に
    自動実行すれば導入自体は可能
  - 「ホストのLinuxアカウントのパスワードをそのままSSH認証に使えないか」を検討したが、
    `/etc/shadow`をコンテナにマウントする方式は却下：コンテナ内はどうせroot権限で
    自由にコマンドが打てるため、sshdの`AllowUsers`で制限してもマウントした`/etc/shadow`の
    中身（＝全ユーザーのパスワードハッシュ）が読めてしまい、他ユーザーへの漏洩経路になる
  - 代替として「ログイン時のパスワードをブラウザのメモリにだけ保持し、deploy時にコンテナの
    rootパスワードとして設定する」方式（ホスト側のアカウント情報には一切触れない）も検討したが、
    今回は見送りとした
- **結論**：SSHでの直接ログインは一旦やらない。代わりに統合コンソール（ブラウザ内xterm.js）を
  タブ化し、同一ラボ内の複数ノードを同時に開けるようにする方向で進める（`docs/STATUS.md`参照）

## 決定事項（2026-10-05追記）：ナビゲーションを「ホーム→トポロジエディタ」の一方向にする

- **経緯**：トポロジエディタを常時表示のタブにしていたため、「今エディタに出ているトポロジが
  どのラボなのか」が不明確になり、既存ラボ（例: `test`）のノードとエディタの初期デモノードを
  混同して誤操作する事態が起きた
- **決定**：トポロジエディタは常時タブではなく、ホーム画面（ラボ一覧＋新規作成の入口）から
  「新規作成」または各ラボの「エディタで開く」のどちらかを選んで入る専用画面にする。
  常にホーム→エディタの一方向の遷移にすることで、エディタの対象が常に一意に決まるようにした
- **既存ラボを開く手段**：clab-api-serverのSwagger仕様（`GET /swagger/doc.json`で確認）に
  `GET /api/v1/labs/{labName}/topology/yaml`（デプロイ済みラボのトポロジYAMLを返す）が
  存在することを確認し、これを使って既存ラボのトポロジをエディタに読み込めるようにした。
  ノード座標は保持していないため、読み込み時は簡易グリッドレイアウトで配置している
  （座標保存用に見えるSwagger上の`GET/PUT .../topology/annotations`というエンドポイントも
  見つけたが、実際のフォーマットは未確認。座標保存は次の検討課題）
- ロゴ画像クリックでホームに戻れるようにした（`components/Brand.tsx`）

## 決定事項（2026-10-06追記）：L2スイッチにVLAN設定、L3スイッチは保留

- **L2スイッチに「ちゃんとした」VLAN設定（アクセス/トランク）を追加**：
  `CLAUDE.md`で「VLANタグ付け＝アクセス/トランクポートは`ovs-vsctl`の`tag`/`trunks`で
  対応可能」と書いていた部分を、今回実際にUIから設定できるようにした
  - **新しい発見（重要）**：containerlab公式ドキュメント（ovs-bridge kind）で、
    リンクのブリッジ側エンドポイントに指定したインターフェース名が、そのまま
    ホストのOVSポート名になることが判明。これは**ブリッジ名と同じくホスト全体で
    グローバルな名前空間**であるため、今まで使っていた"eth1"等の分かりやすい名前を
    そのまま送ると、別ユーザー・別ラボのL2スイッチが同じ名前を使った瞬間に衝突する
    （ブリッジ名衝突と同種の既存バグ）。ブリッジ名（`toClabBridgeName()`）と同じ方式で
    ポート名もハッシュ化する`toClabPortName()`を追加して解消した
  - VLAN設定自体はcontainerlabのトポロジYAMLには存在せず、deploy後に`ovs-vsctl`を
    ホスト側で実行する必要がある。しかしclab-api-serverの`exec`系APIはコンテナ単位でしか
    実行できず、`ovs-bridge` kindのノードはコンテナを持たないため届かない
    （Swagger仕様で確認：`NodeInterfaceInfo.name`が「container node」と明記）
  - そのため新しい特権ヘルパー`backend/ovs-helper/`を追加した。`console-proxy`と同じ発想で、
    JWTを受け取り`GET /api/v1/labs`をclab-api-server自身に問い合わせて「本人が所有する
    ラボか」を確認してから`ovs-vsctl`を代行実行する。OVSへの非root権限は既にkawase3の
    アカウントに設定済み（本ファイル内の過去の決定事項参照）なので、追加の権限設定は不要
- **L3スイッチ（インターVLANルーティング）は今回も保留**：方式としては「FRRノード＋OVS
  ブリッジを内部でセットにして1つのノードとして見せる」方向で合意したが、着手してみると
  前提として「ノードにIPアドレスを割り当てるUI」「VLANごとのSVI/ルーティング設定の生成」が
  丸ごと未実装だと判明し、L2 VLANとは規模が一段違うことが分かった。`CLAUDE.md`の
  「将来の拡張候補」のまま保留を継続する。先にIPアドレッシングの設計が必要
- 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。実機でのVLAN投入確認は
  まだ（`backend/ovs-helper/`をsystemdサービス化してから次回確認予定）

## 決定事項（2026-10-07追記）：PC/ルーターのコンテナをprivileged:false + 最小capabilityに縮小

- **発覚の経緯**：「PCコンソールでeth0を触れてしまう」という指摘の対応を検討中、より深刻な
  問題を発見した。`docker inspect`で確認したところ、containerlabの`linux` kindは**デフォルトで
  Dockerの`--privileged`相当（全capability付与、AppArmor/seccompともに無効）でコンテナを
  起動していた**（`Privileged: true`、`CapEff`が全capability、`SecurityOpt`で
  AppArmor/SELinuxラベルも無効化）。これはPC・ルーター両方（`kind: linux`）に該当。
  コンソールは単なるroot権限シェルなので、privilegedコンテナ特有のホスト侵害手法
  （cgroup `release_agent`経由のエスケープ等、広く知られた手法）を理論上試みられる状態だった。
  マルチユーザー前提のこのプロジェクトでは、1ユーザーのラボからホストやりとり他ユーザーの
  ラボまで侵害されうる、というのは本来のスコープを超える重大リスクと判断
- **対応**：containerlabの公式ドキュメント（`privileged: false` + `cap-add`でcapabilityを
  個別指定可能）を確認し、トポロジ生成時にPC/ルーターへ以下を付与するよう変更
  （`frontend/src/components/TopologyEditor.tsx`の`CONTAINER_CAPABILITIES`）：
  - PC（`linux`kind、ip addr/link操作のみ）：`cap-add: [NET_ADMIN]`
  - ルーター（FRR）：`cap-add: [NET_ADMIN, NET_RAW, SYS_ADMIN]`
    （実機確認：NET_ADMIN+NET_RAWだけではzebra/ospfdが
    `privs_init: initial cap_set_proc failed: Operation not permitted`で起動せず、
    SYS_ADMINもFRR自身が要求していることが判明。SYS_ADMINは軽い権限ではないが、
    `--privileged`全体（host deviceへの直接アクセス・AppArmor/seccomp無効化等）とは別物で、
    それらは引き続き防げる）
  - L2スイッチ（`ovs-bridge`kind）はコンテナを持たないため対象外
- **実機検証（一時的なテストラボで確認、本番トポロジには影響なし）**：
  - PC: `privileged:false`でもIPアドレス設定・ping成功、`/dev`への host device直接アクセス不可
  - ルーター: OSPF隣接形成（2-Way/DROther）・loopback間ping（0% loss）まで成功。
    既存のvtysh・コンソール機能にも影響なし
- **残存リスク（意図的に受け入れる範囲）**：SYS_ADMINは依然軽くない権限のため、完全な
  ホスト分離を保証するものではない（あくまでsoft improvement）。将来さらに絞りたい場合は
  FRRをdaemon単位で分離する、またはFRR以外のルーティングスタックを検討する必要がある

## 決定事項（2026-10-07追記）：deploy後にeth0のデフォルトルートを削除＋ゲートウェイ設定UI追加

- **発覚の経緯**：router on a stickの実機テスト中、ラボ内に存在しない宛先IPへ`traceroute`したら
  本物のISP（homenoc.ad.jp）まで到達してしまった。原因は、containerlabが各ノードのmgmt用
  `eth0`に自動で`default via <dockerブリッジのgw>`を設定しており、ラボ内に意図した宛先への
  経路が無い場合、そのままeth0経由で実際の外部ネットワークに出てしまうため（実機確認）。
  これはcontainerlab自体の既定動作で今回の機能が原因ではないが、「PCのアドレシングUI」には
  デフォルトゲートウェイ/ルートの設定項目が無く、router on a stickを含むルーティングの
  検証が正しくできない状態だった
- **対応方針の検討**：「eth0のデフォルトルートを削除すると、動いている機能（コンソール・exec等）が
  壊れないか」という懸念が出たため、まず一時テストコンテナで実機検証した：
  - コンソール（`terminal-sessions`）・exec機能は`docker exec`相当（Dockerデーモン経由、
    コンテナのネットワークスタックを使わない）のため、デフォルトルート削除後も**問題なく動作**
    することを確認（`docker exec`は通常どおり成功、`hostname`取得も成功）
  - 削除後、外部（8.8.8.8）への通信は`Network unreachable`で**ブロック**されることを確認
  - 管理ネットワーク内（dockerブリッジgateway）への到達性は維持されることを確認
  - これは元々`CLAUDE.md`で「外部ネットワークへのブリッジ接続は実装しない（スコープ外）」と
    決めていた方針とも整合する（むしろ今まで塞がっていなかったのが漏れだった）
- **実装**：
  1. 接続ポップアップのプレーンなアドレス設定（router on a stickでない場合）に
     「デフォルトゲートウェイ（任意）」入力欄を追加（単純なIPv4アドレス、プレフィックス無し）
  2. deploy後、全PC/ルーターで`ip route del default`を実行（既に無ければ`No such process`で
     失敗するだけなので無視）。ゲートウェイが設定されているノードだけ、続けて
     `ip route add default via <gateway>`を実行
  3. アドレス/サブインターフェース設定が終わった**後**にこのルート処理を行う
     （ゲートウェイの接続先サブネットがまだ無いとroute addが失敗するため、順序が重要）
- **実機検証（一時テストラボ：PC-ルーター間でゲートウェイ設定）**：
  - PC→ルーター（ゲートウェイ経由）の通信は成功（0% loss）
  - PCから未定義の宛先（203.0.113.99）への通信は100% lossで外部に漏れないことを確認
  - `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア

## 決定事項（2026-10-07追記）：ルーターの設定はGUIではなくCLI（vtysh）で行う方針に変更

- **発覚の経緯**：test2ラボでの実機テストで、PC側にゲートウェイを設定してもGUIでルーター側の
  アドレス設定を忘れていたためping が通らず、ユーザーから「学習ツールとしては不適かも」という
  指摘があった。根本的な懸念は「GUIが代わりに設定してしまうと、本来CLIで学ぶべき操作が
  身につかない」という点。これを受けて、ユーザーから「FRRの機能としてVLANサブインターフェースを
  CLIで設定できないか？ルーターはCLIで設定しないと意味がない」という要望が出た
- **技術的な制約の確認（実機確認済み）**：vtyshで`interface eth1.10`→`ip address ...`と打つと
  `running-config`には記録されるが、**カーネル上には実際のVLANデバイスが作られない**。
  VLANタグ付きインターフェースの作成はLinuxカーネルの操作（`ip link add ... type vlan`）であり、
  FRR/zebraはルーティング・既存インターフェースへのアドレス設定等を行うソフトウェアで、
  リンクレイヤーのデバイス作成自体はスコープ外（vtysh自身が実装していない）。
  つまり「VLANサブインターフェースの存在」はGUI/バックエンド側で用意するしかないが、
  **一度デバイスが存在すれば、そこへのアドレス設定はvtyshのCLIで問題なく行える**
  （zebraはカーネルのnetlinkイベントを監視しており、どうやって作られたデバイスかに関係なく
  自動で認識してルーティングに使う）
- **FRR設定の永続化を実機検証**：vtyshで設定して`write memory`すると`/etc/frr/frr.conf`に
  書き込まれる。このファイルをホスト側にbind mountして永続化すれば、**コンテナを完全に
  破棄・再作成する再deployを越えてCLI設定が残る**ことを一時テストラボで確認した
  （書き込み直後はホスト側のファイル所有者がコンテナ内部のFRRデーモンのUIDに変わり
  `labuser`では読めなくなるが、`existsSync`/`statSync`による存在確認は引き続き可能なことを確認。
  containerlab自体はbind mount元のファイルが事前に存在しないとdeploy自体を
  `Failed to verify bind path`で拒否するため、初回だけ最小構成のファイルを用意する必要がある）
- **決定した役割分担**：
  - **ルーター（FRR）**：IPアドレス設定・ルーティング設定は**100%CLI（vtysh）で行う**。
    GUIからのプレーンな「IPv4アドレス/デフォルトゲートウェイ」入力欄は廃止（PCのみ残す）。
    router on a stickのVLANサブインターフェースも、GUIが用意するのは**VLAN IDに基づく
    「空のデバイス」のみ**（`ip link add ... type vlan` + `ip link set ... up`、アドレスは
    設定しない）。アドレス設定は学生がデプロイ後にコンソールのvtyshで行う
  - **PC（alpine）**：元々CLI学習の対象ではない（単純なエンドホスト役）ため、GUIでの
    アドレス/ゲートウェイ設定はそのまま維持
  - **FRR設定の永続化**：全ルーターに`frr-config/<routerClabName>/{daemons,frr.conf,vtysh.conf}`
    をbind mount。初回のみ`backend/ovs-helper/`の新エンドポイント`POST /frr-config`で
    最小構成を用意する（既存ファイルは上書きしない＝学生の設定を保護）。daemonsは学生が
    自分で編集できない（コンソールはvtysh専用に制限済み）ため、大学の講義で扱う主要な
    ルーティングプロトコル（zebra/staticd/ospfd/ospf6d/ripd/isisd/bgpd）を最初から
    有効にしておく
- **影響**：この変更により、deployは「トポロジの配線（物理リンク・VLANデバイスの存在）を
  整える1回限りの操作」に近づき、実際のルーター設定作業はCLIで継続的に行える
  （以前は`ip addr add`等をGUI側がexecで毎回再投入していたため、設定を変える度に
  deployが必要だった）
- 実機での最終確認（ルーターのVLANサブインターフェース作成→vtyshでのアドレス設定→
  write memory→再deployでの設定保持の一連の流れ）は次回

## 決定事項（2026-10-08追記）：VLANサブインターフェースの作成はGUIで完結させる（CLI分離は撤回）

- ユーザーから「FRR自体がLinuxカーネルを使ってrouting出来てるから、VLANサブインターフェースの
  作成もFRRの一部として取り込めないか」という提案があり、FRR公式ドキュメント
  （docs.frrouting.org）で確認した。zebraは**VRFもVXLANもVLANサブインターフェースも
  一切作成しない**（"FRR neither creates VRFs... FRR simply uses whatever is provided by
  the OS"、VXLANも"must be done externally"と明記）。インターフェース作成は常に`ip link`等の
  外部ツールに委ねる設計であることが公式に確定した
- これにより「デバイス作成はGUI必須、アドレス設定だけCLI」という2026-10-07の方針は技術的には
  可能だが、ユーザーから「2段階に分かれた今のやり方は煩雑すぎて誤解を生みかねない」という
  判断があり、**サブインターフェース作成時に限り、VLAN ID＋アドレスの両方をGUIで一度に設定する
  方式に戻した**（撤回）。実機テスト（test2）で「ルーター側の設定を忘れてping が通らない」
  事象が実際に発生したことも、この判断の裏付けになっている
- **現在の役割分担（最終）**：
  - ルーターの**通常のアドレス設定（「プレーン」モード）は引き続きvtyshのCLIで行う**
    （2026-10-07の決定は維持）
  - **router on a stickのVLANサブインターフェースは、VLAN ID＋アドレスをGUIで一度に設定**
    （2026-10-08で元に戻した部分）。デバイス作成＋アドレス設定を`ip link add`→
    `ip link set up`→`ip addr add`の3段階でexec実行する
  - FRR設定ファイルの永続化機構（`backend/ovs-helper/`の`POST /frr-config`）はそのまま維持
    （プレーンモードのCLI設定や、OSPF/BGP等のルーティング設定の永続化に引き続き使う）

## 決定事項（2026-10-08追記）：パケットキャプチャ機能のためEdgeSharkを導入

- CMLのような「リンクを右クリックしてパケットキャプチャ」機能を検討。clab-api-server側には
  既にAPI（`POST /api/v1/labs/{labName}/capture/wireshark-vnc-sessions`でブラウザに
  Wireshark GUIをnoVNC経由で表示、`/capture/packetflix`でローカルWireshark連携）が
  実装されていたが、裏で動く[Siemens EdgeShark](https://github.com/siemens/edgeshark)
  （`ghostwire`＋`packetflix`の2コンテナ構成）が無いと`503`になることが判明
- clab-api-serverのソース（`internal/config/config.go`）を確認し、`CAPTURE_PACKETFLIX_PORT`の
  デフォルト値（5001）がEdgeShark公式のデフォルトポートと一致していることを確認。
  **clab-api-server側の設定変更は不要**と判断
- 公式docker-compose（`backend/edgeshark/docker-compose.yaml`に保存）で導入。
  `labuser`が`docker`グループに入っているため**sudo不要で起動できた**（実機確認済み：
  `curl http://127.0.0.1:5001/version`が正常応答）
- **権限についての整理**：`ghostwire`/`edgeshark`コンテナは、ホスト上の全コンテナの
  ネットワーク名前空間を覗き見る必要があるため、`pid: host`・`CAP_SYS_PTRACE`・
  `CAP_DAC_READ_SEARCH`等、学生が触るラボ用コンテナ（今回`privileged:false`に絞り込んだもの）
  とは別次元の広い権限で動く。ただし`--privileged`ではなく具体的に列挙されたcapabilityのみ
  （`cap_drop: ALL`→必要な分だけ`cap_add`）＋非root（uid 65534）＋読み取り専用rootfsという
  設計（公式docker-compose自体がこの形）。これは「管理者が運用するホスト側の可視化・計測
  インフラ」であり、学生が触る対象とは明確に別物という位置づけなので、学生向けコンテナの
  権限を絞る方針とは矛盾しないと判断
- **未確認**：EdgeShark自体の起動・`packetflix`の応答は確認したが、clab-api-server経由の
  実際のキャプチャAPI（実ユーザーのJWTでの呼び出し）・フロントエンドのUIはまだ無い。次回対応

## 決定事項（2026-10-08追記）：パケットキャプチャ機能のフロントエンドUI＋中継プロキシ実装

- 右クリック（リンクのコンテキストメニュー）→「パケットキャプチャ」→別タブでWiresharkの
  noVNC画面を開く、という流れで実装（CMLと同じ操作感）
- clab-api-serverのソース（`internal/api/capture_handlers.go`、`internal/api/middleware.go`）を
  確認し、以下を把握：
  - `POST /labs/{labName}/capture/wireshark-vnc-sessions`のリクエストボディは
    `{"targets":[{"containerName":"...","interfaceName":"..."}]}`。`containerName`は
    `resolveCaptureContainer()`がノード名の曖昧一致も受け付けるため、execInLab()と違って
    **短いノード名のままで通る**（フルコンテナ名への変換は不要と判断）
  - 作成直後は`ready:false`のことがあるため`GET /capture/wireshark-vnc-sessions/{id}/ready`を
    ポーリングし、`ready:true`になったら返ってくる`url`を使って
    `GET /capture/wireshark-vnc-sessions/{id}/vnc/{proxyPath}`を開く、という2段階が必要
  - **この`/vnc/{proxyPath}`も含め、clab-api-serverの`AuthMiddleware`は
    `Authorization: Bearer <jwt>`ヘッダーでしか認証できず、クエリパラメータ等の代替は
    一切無い**（ソース確認済み）。一方`/vnc/{proxyPath}`はnoVNCのHTML/JS/CSS資産＋
    VNC用WebSocketを中継する、複数ファイルからなる通常のWebアプリであり、ブラウザの
    新規タブ（`window.open()`）やそこから発生するアセット読み込み・WebSocket接続は
    カスタムヘッダーを一切設定できない。これは統合コンソール機能（`console-proxy`）で
    既に経験した壁と同じ構造の問題
  - L2スイッチはコンテナを持たないため、スイッチ側の接続端はキャプチャ対象から除外
    （PC/ルーター側のみ対象。両端ともスイッチのリンクは今回は非対応）
- **対応**：`console-proxy`と同じ発想で`backend/capture-proxy/`という新しい中継プロキシを
  新設。ただしトークンの受け渡し方式は変えた：
  - `console-proxy`は「WebSocket接続後、最初の1メッセージでトークンを送る」方式だが、
    noVNCは素のGETで複数ファイルを読みに行く通常のWebアプリなので、そのハンドシェイクが
    使えない
  - 代わりに`capture-proxy`は**トークンをURLのパスに埋め込む**方式にした：
    `http://<capture-proxy>/capture/<sessionId>/<jwt>/<相対パス>`を開くと、`<相対パス>`を
    clab-api-serverの`/vnc/{proxyPath}`にAuthorizationヘッダー付きで転送する
    （WebSocketアップグレードも同じパスパターンで中継。RFBプロトコルの生バイナリフレームを
    そのまま双方向に流すだけでJSON等の解釈はしない）
  - ポート8084（`console-proxy`=8082、`ovs-helper`=8083、`edgeshark`/packetflix=5001との
    重複を避けた番号）。`console-proxy`と同じく`systemctl --user`での常駐を想定
- **未確認・次回やること**：noVNC自身が生成するリンク/WebSocket接続先が、
  この`/capture/<sessionId>/<jwt>/`というパス配下に正しく収まるかは実機確認がまだ。
  noVNCが絶対パス（`/`始まり）でアセットを参照している場合、このプレフィックスが
  落ちてしまい404になる可能性があり、その場合はHTMLレスポンスのbody rewriting等の
  追加対応が必要になる見込み（`backend/capture-proxy/README.md`に明記済み）

## 決定事項（2026-10-08追記）：パケットキャプチャ機能の実機テストで見つかった不具合・制約

- **初回のWiresharkイメージpullが45秒タイムアウトに引っかかる**：clab-api-serverの
  `CreateWiresharkVncSessionsHandler`は45秒の固定タイムアウトを持つが、初回の
  `ghcr.io/srl-labs/wireshark-vnc-docker:latest`のpullはそれより時間がかかることがあり、
  `signal: killed`で失敗する。**対応**：`docker pull`で事前にイメージをキャッシュしておけば
  2回目以降は問題にならない。READMEに明記した方が良さそう（次回検討）
- **noVNCのHTML/JS/CSS資産読み込み自体は想定通り動いた**：心配していた「noVNCが絶対パスで
  アセットを参照していて404になる」問題は発生しなかった（capture-proxyのログで全資産が
  200で返っていることを確認）
- **肝心のVNC用WebSocket（`/vnc/websockify`）が`400 Bad Request`で拒否される不具合を発見・修正**：
  Wireshark VNCコンテナ（ベースイメージ`jlesage/baseimage-gui`）内のnginxは、
  `websockify_pass`という専用ディレクティブでVNCソケットに直結しており、**`ws`ライブラリが
  デフォルトでは送らない`Sec-WebSocket-Protocol: binary`ヘッダーが無いとハンドシェイクを
  拒否する**ことが実機確認で判明（curlで手動ヘッダーを全部指定した場合は101で通ったことから
  特定）。capture-proxy側で、ブラウザ（noVNC）が送ってきた`Sec-WebSocket-Protocol`を
  そのまま上流への接続にも伝える（`ws`の`protocols`引数として渡す）ように修正して解決
- **「どこをキャプチャしてるか分からない」指摘への対応**：noVNCの画面は`window.open()`で
  別タブに開くだけだとタブタイトルが汎用的（"noVNC"等）で、複数タブを開くと見分けがつかない。
  capture-proxy側で、クエリパラメータ`?label=...`を受け取ったら、上流から返ってきたHTMLの
  `<title>`をその場で書き換える（レスポンスボディをバッファして文字列置換→Content-Length再計算）
  という対応を実装。フロントエンド側は「R1(eth1) ↔ SW1」のような、ノードの短縮表示名＋
  インターフェース名＋相手ノード名の形式でラベルを組み立てて渡す
- **未対応・今後の検討事項**：「コピペができない」という指摘は、noVNCが画面を転送している
  だけ（VNC自体の構造的な制約）であり、クリップボード同期機能が無いと解決しない。
  noVNCやVNCサーバー側がクリップボード同期をサポートしているか別途調査が必要
  （優先度は要相談。パケットを読むだけなら必須ではないが、BPFフィルタ文字列を貼り付けたい
  等のニーズがあれば対応を検討する）

## 決定事項（2026-10-09追記）：パケットキャプチャ機能のタイトル不具合修正とHTTPS化

- **タブタイトルが反映されない不具合を発見・修正**：実機確認したところ、単に`<title>`タグを
  書き換えるだけでは効かなかった。原因は、Wireshark VNCコンテナのベースイメージ
  （`jlesage/baseimage-gui`）のnoVNCアプリが、ページ読み込み後にJSで`document.title`を
  `APP_NAME`（"Wireshark"）に上書きしてしまうこと。**対応**：`setInterval`で定期的に
  `document.title`を強制的に書き戻すスクリプトをHTMLレスポンスに埋め込むよう修正
- **「コピペが面倒」という指摘を受けてcapture-proxyをHTTPS化**：調査の結果、
  noVNC（`jlesage/baseimage-gui`ベース）には**ブラウザのClipboard APIを使った
  「ホストクリップボード自動同期」機能が標準で既に入っている**ことが判明
  （`UI.webData.hostClipboardSync`、`RFB.isClipboardAutoSyncSupported()`）。
  Wireshark側でコピーすると自動的にOS/ブラウザのクリップボードに反映される仕組みだが、
  Clipboard APIの非同期read/writeは「secure context」（HTTPS、またはlocalhost）を要求する
  仕様のため、capture-proxyが平文HTTPのままだとこの自動同期機能自体が有効化されなかった。
  `certs/`に自己署名証明書を生成し`https.createServer`化して解決（自己署名のため
  初回アクセス時にブラウザの警告は出る。他の自己署名TLSサービス（clab-api-server等）と
  同様の割り切り）
  - 手動での代替手段（noVNCサイドバーのクリップボードテキストエリア経由）も引き続き使える
  - フロントエンドの`VITE_CAPTURE_PROXY_URL`も`https://`に変更

## 次に決めること
1. ~~フロントエンド技術の最終確定~~ → **決定済み（React + React Flow + xterm.js）**
2. ~~状態管理ライブラリ（Zustand/Reduxなど）~~ → **決定済み（Zustand）**
3. ~~同時起動ノード数の上限を入れるか~~ → **決定済み（上限を設けない）**
4. 企画・設計書のチーム情報（サイクル/チーム名/メンバー欄）の記入 ※コード外の提出物側のタスク、要対応

## リポジトリ構成（提案）
```
repo/
├── CLAUDE.md          ← プロジェクト概要（overview.md/direction.mdの要約）
├── backend/           ← clab-api-serverの設定、Containerlab関連スクリプト
├── frontend/          ← React + React Flow + xterm.jsアプリ
└── docs/              ← 設計メモ（direction.md等のコピー）
```

## 作業分担（並行して進められる構成）

clab-api-serverはSwagger UI（`https://<server>:8090/swagger/index.html`）とGitHub Pagesの
API仕様書を公開しているため、バックエンドの構築完了を待たずにフロントエンドは仕様書ベースで
先に作り始められる。この前提で2人が同時にスタートしてブロックし合わないように分担する。

**バックエンド/インフラ担当（kawase3）**
1. サーバーにDocker導入・動作確認
2. Containerlab＋FRRイメージを入れ、CLIで2ノードのトポロジを手動デプロイして疎通確認
3. clab-api-serverを導入し、Linuxアカウントを2つ作成してPAM認証を通す
4. API経由でラボのデプロイ/削除ができるか、所有権分離（他人のラボが見えないか）が機能するかを確認
5. 確認できたAPIの実際の挙動（認証ヘッダーの付け方、レスポンス形式の実例）をdocsにメモしてフロント担当に共有

**フロントエンド担当（Bさん）**
1. React（Vite等）プロジェクトの雛形作成、React Flow導入
2. ノードパレットに「ルーター(FRR)」「L2スイッチ(ovs-bridge)」「PC(linux/Alpine)」の3種類を用意
3. clab-api-serverのSwagger UI / GitHub PagesのAPI仕様書を見ながら、モックデータでラボ一覧・トポロジ表示のUIを組む
4. xterm.js導入、ローカルのダミーWebSocket（echoサーバーなど）に繋いで表示確認
5. バックエンド環境が動き出し次第、モックを実際のAPIエンドポイントに繋ぎ変える

**共通/どちらか**
- リポジトリへの`CLAUDE.md`設置（済み）
- 状態管理ライブラリの選定はフロント担当がプロトタイプを作りながら決める

## サーバー運用メモ
- サーバー上でClaude Codeを使う場合、各自が自分のLinuxアカウントと自分のAnthropicアカウントでログインする（アカウントは共有しない）
- `CLAUDE.md`はリポジトリ直下にあるため、誰のLinuxアカウントで`claude`を起動しても同じプロジェクト文脈が自動で読み込まれる
- GitHub認証はSSH鍵方式（HTTPSパスワード認証は廃止済みのため）
