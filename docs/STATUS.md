# 進捗ステータス（非同期の朝会）

> このファイルが「今どこまで進んでいるか」の唯一の正。
> **セッション開始時に読む**、**セッション終了時に更新してコミット**すること。
> 判断・決定は書かない（それは `direction.md`）。API仕様は書かない（それは `api-contract.md`）。

最終更新: 2026-10-06 / kawase3（ホームタブ削除、L2スイッチのVLAN設定機能＋backend/ovs-helper/を追加）
最終更新: 2026-09-17 / Bさん（M5完了・PR #7作成、ovs-bridgeブリッジ名衝突対策の実装、api-contract.md TODO解消）

---

## 全体マイルストーン

- [x] M1: FRR 2ノードを CLI で deploy し疎通（BE） → `backend/labs/m1-frr-2node/`
- [x] M2: FRR / ovs-bridge / linux の3種を1トポロジで疎通、VLAN 確認（BE） → `backend/labs/m2-ovs-l2-vlan/`
- [x] M3: clab-api-server 導入・PAM 認証・所有権分離の確認（BE） → `docs/api-contract.md` に実機確認結果を記録
- [x] M4: 実 API 挙動を `api-contract.md` に記録（BE → FE のブロッカー解除）
- [x] M5: React + React Flow 雛形、3種ノードパレット、モックでラボ一覧/トポロジ表示（FE）
      （雛形・モックラボ一覧は PR #3 merged / ノードパレット3種のドラッグ&ドロップは今回のPRで完了）
- [x] M6: xterm.js をダミー WebSocket に接続して表示確認（FE） → `frontend/src/components/Console.tsx` + `dev-tools/echo-server.js`（PR #3 merged）
- [ ] M7: FE のモックを実 API に接続（BE/FE 合流）
      （ログイン・ラボ一覧・トポロジのdeploy・統合コンソールの実接続まで先行実装済み[kawase3、Bさん休暇中]。
      ラボ一覧からのstart/stop/destroy操作は未着手）

---

## kawase3（バックエンド/インフラ）

**Done**
- サーバー構築（Proxmox VE / VM「lab-server」/ Ubuntu 24.04 / メモリ12GB）
- Docker 29.8.0 導入
- Containerlab 0.79.0 導入
- `labuser` を `docker` グループに追加、Open vSwitch 3.3.9 導入
- 共同作業スキャフォールド作成（STATUS.md / api-contract.md / .gitignore / CLAUDE.md ルール追記）
- **M1: FRR 2ノード（`kind: linux` + frr:10.2.1）を deploy、OSPF area 0 で loopback 相互疎通（3/3, 0% loss）を確認**
  - トポロジ・設定は `backend/labs/m1-frr-2node/`（daemons / frr.conf / vtysh.conf をバインドマウント）
  - このサーバーは `sudo` なしで `containerlab deploy` 可能（docker グループ権限で netns 操作まで通る）
- **OVSへの非root恒久アクセス設定**：`/etc/default/openvswitch-switch`に`--ovs-user=root:clab_admins`、
  `ovsdb-server.service`にdrop-inで`UMask=0007`、rootを`clab_admins`に追加。
  `labuser`はsudoなしで`ovs-vsctl`／containerlabのovs-bridge操作が可能に（要sudo作業は完了・再起動後も保持）
- **M2完了**：`backend/labs/m2-ovs-l2-vlan/`（詳細はREADME参照）
  - task1: `ovs-bridge` + `linux`×2 でL2疎通（3/3, 0% loss）
  - task2: VLANアクセス(tag)/トランク(trunks)を4ノードで検証。同一VLANは疎通、別VLANは分離、
    トランク経由で両VLANに到達——全て期待通り
  - task3: FRR×2(OSPF)＋ovs-bridge×2＋linux×2 の混在トポロジで、別ルーター配下のpc同士がOSPF越しに疎通
  - **重要な発見（M3以降に影響）**：`ovs-bridge`kindはブリッジを自動生成せず`ovs-vsctl add-br`が事前に必要、
    VLAN設定もdeploy後に`ovs-vsctl`で別途投入が必要。かつ**OVSブリッジ名・インターフェース名はホスト全体で
    グローバルな名前空間**（トポロジ内はもちろん複数ユーザー間でも衝突しうる）。
    マルチユーザー化（M3でclab-api-server導入時）で命名規則の検討が必須

- **M3完了**：clab-api-server (v0.6.0、内蔵containerlab 0.78.0) を導入し、以下を実機確認
  - PAM認証（`POST /login`）で`clab_api`グループの非管理者ユーザーがログインできる
  - **所有権分離を確認**：他ユーザーのラボは一覧にも出ず、名指ししても`404`、ファイルシステムも`drwxr-x---`で本人以外アクセス不可
  - `clab_admins`グループ＝管理者(superuser)。非管理者が管理者専用APIを叩くと`403`
  - ノードの個別ライフサイクル操作API（start/stop/restart/pause）の存在を確認（想定していた「再deployで代替」は不要と判明）
  - CORSはデフォルトで他オリジン拒否。`CORS_ALLOWED_ORIGINS`環境変数でFEのdev origin許可が必要（FEの開発サーバーが立ってから設定）
  - 詳細・実レスポンス例は`docs/api-contract.md`に記録済み

- **M4完了**：統合コンソール・ライブ状態更新のプロトコルを実機確認（`docs/api-contract.md`の2.5/2.6に詳細記録）
  - 統合コンソール：`terminal-sessions`でセッション作成→`stream`にWebSocket接続。
    サーバー→クライアントの出力は`{"type":"output","data":"<base64>"}`（**base64エンコードされている点に注意**）、
    クライアント→サーバーの入力は平文。1セッション1回のみ接続可（切断済みは`410`）
  - ライブ状態更新：`GET /api/v1/events`はWebSocketではなく**接続しっぱなしのNDJSON**。
    ノードのstart/stop/killやインターフェースのstate変化が逐次流れてくる、実データ取得済み

**Doing**
- （なし）

- **【frontend/を編集した理由】** Bさんが休暇中でM7が止まっていたため、進められる範囲を代わりに実装した。
  `frontend/src/{api,store}/`を新規作成、`components/App.tsx`・`LabList.tsx`・`TopologyEditor.tsx`・
  `utils/clabNaming.ts`を編集。作業前に`npm install`でNode.js環境を`labuser`にも用意し（nvm経由、sudo不要）、
  変更のたびに`tsc --noEmit`・`oxlint`・`npm run build`・`npm run dev`起動確認まで実施済み。
  Bさん復帰後にレビューしてもらうこと。

- **M7の一部を先行実装**：ログイン画面（`LoginForm.tsx`）、Zustandでの認証状態管理（`store/authStore.ts`）、
  APIクライアント（`api/client.ts`：login/getLabs/deployLab/destroyLab/start・stop・restartNode/wipeNode）、
  `LabList.tsx`を実APIに接続（モック卒業）、`TopologyEditor.tsx`にラボ名入力+Deployボタンを追加し、
  React Flowのノード/エッジから`topologyContent`を組み立てて実際にdeployできるようにした。
  使い捨てアカウントで実機テストし、生成したJSONで実際にL2スイッチ+PC×2をdeploy→ping疎通→destroyまで確認済み。
  - **重要な訂正（`toClabBridgeName()`）**：9/16決定の`<username>_<labname>_<ノード名>`方式は、
    実機検証で**Linuxのネットワークインターフェース名が15文字までという制約（`IFNAMSIZ`）**に
    引っかかり実運用不可と判明（16文字以上で`ovs-vsctl add-br`が失敗）。ハッシュベースの
    短い名前（`sw-`+8桁16進数、11文字）に変更した。詳細は`docs/direction.md`・`docs/api-contract.md`参照
  - 未着手のまま残っているM7範囲（この後さらに進めた分は下記）：ラボ一覧からのstart/stop/destroy操作、
    wipeボタンのUI化、エラー時のUX磨き込み

- **統合コンソールを実API接続（新規アーキテクチャコンポーネント`console-proxy`を追加）**：
  `clab-api-server`の統合コンソール用WebSocketは`Authorization`ヘッダーでしか認証できないが、
  ブラウザの`WebSocket` APIはハンドシェイク時にカスタムヘッダーを設定できない（実機・ソース確認済み、
  回避不可能な仕様制約）ため、ブラウザから直接は接続できないことが判明。
  `backend/console-proxy/`（Node.js中継プロキシ）を新設して解消した：
  ブラウザ→`console-proxy`（最初のWSメッセージでトークンを渡す）→`clab-api-server`
  （`Authorization`ヘッダー付きで接続）という構成。`Console.tsx`をこの構成で実装し直し、
  実機で認証込みの通し（トークン検証→シェル起動→入出力の中継）を確認済み。
  `docs/direction.md`・`docs/overview.md`のアーキテクチャ図も更新済み。
  - **開発時は`console-proxy`を別途起動する必要がある**（`cd backend/console-proxy && npm install && npm start`）

- **CORS設定完了**：`CORS_ALLOWED_ORIGINS=http://localhost:5173`を設定・`clab-api-server`再起動。
  実機確認済み（`http://localhost:5173`からのpreflightが`204`、`Authorization`ヘッダーも許可）。
  → Bさんの開発サーバーから実APIを叩けるようになりました（M7のブロッカー解消）

- **持ち越しTODOを解消（2026-09-24、連休明け・Bさん休み中に実施）**
  - `/api/v1/events`の複数ユーザー間分離を実機確認：他ユーザーのイベントは一切混ざらないことを確認
  - ログイン失敗時のエラー文言・トークンリフレッシュ手段の有無を確認（リフレッシュ機能は無し、再ログイン必須）
  - wipe相当の操作を確定：`POST /api/v1/labs?reconfigure=true&nodeFilter=<ノード名>`で同一topologyContentを送ると、
    指定ノードだけコンテナを再生成できる（他ノードは無影響）。詳細は`docs/api-contract.md`参照

- **トポロジエディタのUX改善（実際に動かしたkawase3からの指摘6件に対応）**
  - ノード種別ごとに形・色・略称（R=円/青、SW=角丸四角/オレンジ、PC=四角/グレー）で判別できるように
    カスタムノードコンポーネント（`TopologyNode.tsx`）を追加
  - ドロップしたノードに自動で短い表示名（R1, SW1, PC1...）を振るように（種別ごとに独立したカウンター）
  - リンクに接続インターフェース名（例: `eth1↔eth2`）をラベル表示
  - エッジを直線・太め（`type: 'straight'`, 2px）に変更
  - ノードを右クリックすると「名前を変更」「削除」のコンテキストメニューが出るように
  - ダーク/ライトモード切り替えボタンを追加（`theme.css`でCSS変数化、localStorageに保存、
    OS設定の`prefers-color-scheme`にも初期値として追従）
  - **CML寄りの追加改善**：
    - ノード同士を接続すると、CMLのように「どちらのI/Fを使うか」を選ぶポップアップが出るように
      （デフォルトは各ノードの次に空いているI/F、`eth1`〜`eth8`から選択可、既使用I/Fを選ぶと警告して確定不可に）
      エッジの実インターフェース名は`edge.data`に保持し、deploy時の`buildTopologyContent`もそこから直接読む
      （配列の並び順からの自動採番ロジックは廃止、表示とdeploy結果は常に同じデータを見るので食い違わない）
    - ケーブル（エッジ）を右クリックすると「接続を解除」メニューが出るように
  - `npx tsc --noEmit` / `npm run lint` / `npm run build` すべて確認済み。開発中のdevサーバーでHMR確認済み

**Next**
- Bさんの休み明けに、今回のfrontend/・backend/console-proxy/への変更をレビューしてもらう
- **ラボ一覧にstart/stop/destroy操作を追加（2026-09-28）**：`api/client.ts`に`startLab`/`stopLab`/
  `restartLab`（ラボ全体、api-contract.md参照）を追加、`LabList.tsx`の各ラボカードにボタンを設置。
  destroyは確認ダイアログあり、操作後は一覧を自動refresh。使い捨てアカウントで実機のstart/stop/destroyを確認済み
  - **未着手のまま残っているもの**：wipeボタンのUI化（`wipeNode()`は実装済みだが、既存ラボの
    `topologyContent`を取得する手段が無く呼び出せない。`GET /api/v1/labs/{labName}/topology/yaml`等
    から既存トポロジを取得する処理が別途必要）
  - ノード単位（ラボ全体でなく個々のノード）のstart/stop操作はまだUIに出していない
- 残りのM7範囲（wipeボタン、ノード単位操作）を引き続き進める

- **UX修正4件（2026-09-28、実際に使ってみたkawase3からの指摘）**
  - **ノード名変更が1回目の確定で無視される不具合**：`window.prompt`（副作用）を`setNodes`の
    更新関数の中で呼んでいたのが原因。Reactの`StrictMode`は更新関数を2回実行するため、
    プロンプトも2回出て1回目の入力が握りつぶされていた。プロンプトを更新関数の外に出して修正
  - **自己ループ接続（R1-R1等）の禁止**：`onConnect`でsource===targetを弾くガードと、
    ドラッグ中から視覚的に分かるよう`isValidConnection`を追加
  - **ノードのI/F接続点が重なって見づらい**：4方向だったハンドルを8方向に増やし
    （`TopologyNode.tsx`、各辺の途中にもう1点ずつ追加）、重なりを緩和
  - **日本語ラボ名でdeployが失敗する**：`clab-api-server`がラボ名(`topology.name`)の文字種を
    検証しており、日本語等を含めると`{"error":"Invalid characters in topology 'name'."}`で
    拒否されると判明（実機確認）。対策として`utils/labName.ts`を新設：
    安全な名前（英数字/ハイフン/アンダースコア）ならそのまま、そうでなければ決定的なハッシュから
    `lab-xxxxxxxx`を生成してAPIに渡し、元の名前はlocalStorageに保存してラボ一覧で表示名として復元する。
    入力欄にも変換後の実名をプレビュー表示
  - 実機（使い捨てアカウント）で全て確認済み。`npx tsc --noEmit` / `npm run lint` / `npm run build`もエラーなし
  - フォローアップ（同日）：I/F接続点は8方向のままだと接続時に固定の点へ線が張り付き、
    ノードを大きく動かすと逆に不自然に見える指摘があったため、接続点は4方向に戻し、
    線の描画自体を`FloatingEdge.tsx`（毎レンダリング時に2ノードの中心角度から接続点を
    再計算する方式、React Flow公式のFloating Edgesレシピ）に置き換えた。これにより
    どちらのノードを動かしても線が自然に追従する。PR #14に追加（commit `c9a6783`）

- **統合コンソールのタブ化＋ワンタッチ起動（2026-09-28）**
  - `ConsoleSession.tsx`（1ノード分の接続本体）と`ConsolePane.tsx`（タブ管理）に分割し、
    同一ラボ内の複数ノードを同時に開いて操作できるようにした。非アクティブなタブも
    アンマウントせずCSSで隠すだけなので、裏のWebSocket接続・シェルは維持されたまま
  - ラボ一覧の各ノード行に🖥ボタンを追加し、ラボ名/ノード名の手入力なしでワンタッチで
    コンソールを開けるように（`store/consoleStore.ts`・`store/uiStore.ts`新設）。
    ovs-bridge(l2-switch)や停止中ノードはボタンを無効化
  - 画面切り替えでコンソール接続が切れないよう、App.tsx側もConsolePaneを常時マウントする構成に変更
  - `backend/console-proxy/`側は変更不要（元々セッション単位で独立した中継のため）
  - PR #14に追加（commit `983e4db`）。検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ
    （実機での複数タブ同時接続の動作確認はまだ。次回ログイン時に確認予定）
  - SSH（TeraTerm等からの直接ログイン）案は一旦見送り。検討の経緯は`docs/direction.md`参照

- **UX追加4件（2026-09-28、実際に使ってみたkawase3からの指摘）**
  - **LAGのような並列リンクが重なって1本しか見えない**：同一ノードペア間に複数リンクがある場合、
    `FloatingEdge.tsx`側のノード境界交点計算が全リンクで同じ座標になっていたのが原因。
    `TopologyEditor.tsx`の`displayEdges`で同じノードペアの中の並び順・総本数を数えてedge.dataに
    載せ、`FloatingEdge.tsx`側で2本目以降を弧状にオフセットして見分けられるようにした
    （端点は正しいノード境界のまま、中央だけ膨らませる二次ベジェ曲線）
  - **トポロジエディタから統合コンソールを開けない／見ながら操作できない**：ノードの右クリック
    メニューに「コンソールを開く」を追加（直近にdeployしたラボに含まれるノードのみ有効化。
    l2-switchはコンテナが無いため対象外）。さらにトポロジエディタ内にドッキングパネルとして
    `ConsolePane`を表示できるようにし、キャンバスを見ながら複数ノードのコンソールを並行操作できる
    （consoleStoreはApp全体で共有しているので、ラボ一覧から開いたセッションもここに出てくる）
  - **トポロジ図にIPアドレス等をメモする手段がない**：ノードパレットに🏷ラベルを追加。
    ダブルクリックで編集できる自由記述の注記ノード（`LabelNode.tsx`）。containerlabの
    ノードではないため`buildTopologyContent`・deploy可否判定からは除外している
  - **ライトモードなのに一部の色がダークのまま**：`index.css`に`color-scheme: light dark`と
    固定していたのが原因。OSがダーク設定だと、アプリ側でライトを選んでいても`<select>`の
    ネイティブなドロップダウンやスクロールバー等のブラウザ標準UIがOS設定に従ってダーク色の
    まま残ってしまっていた。`theme.css`の各テーマブロックで`color-scheme`をlight/darkに
    明示的に切り替えるよう修正
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。実機での動作確認はまだ

- **上記4件を実際に触ったkawase3からのフィードバック3件に対応（2026-09-29）**
  - **並列リンクが4本以上だとI/Fラベルがケーブルと重なって読めない**：ラベルを常に弧の中心
    (t=0.5)に置いていたのが原因。`FloatingEdge.tsx`でリンクごとに弧の上の位置(t)を少しずつ
    前後にずらすように変更（各ラベルは自分の弧の上に乗ったまま、並列本数が増えても重ならない）。
    ついでに並列リンクの間隔も22px→26pxに拡大
  - **「コンソールを開く」でタブは増えるが反応しない**：`ConsolePane`（xterm.js＋WebSocket接続）を
    App.tsx側とトポロジエディタのドッキングパネル側の2箇所に別々にマウントしていたのが原因。
    同じセッションに対して接続が2重に張られ、見えている方が無反応になっていた。
    `ConsolePane`はApp.tsx直下に1つだけマウントする形に戻し、「フル画面（統合コンソールタブ）／
    トポロジエディタ右側にドッキング／非表示」の3状態をCSSの位置指定だけで切り替えるよう修正
    （表示位置のdocked/fullは`store/uiStore.ts`の`consolePanelDocked`で管理）
  - **図形描画機能が欲しい（エリア/ネットワークを分けて見やすく）**：ノードパレットに
    ▭エリアを追加。ドラッグ&ドロップで配置できるリサイズ可能な枠（`AreaNode.tsx`、
    `@xyflow/react`の`NodeResizer`を使用）。ダブルクリックで名前編集、スウォッチクリックで
    色を巡回できる。デバイスノードの背面(zIndex:-1)に表示されるので、上にノードを置いて
    視覚的にグルーピングできる。containerlabのノードではないためdeploy対象からは除外。
    ノードをまとめてドラッグする親子関係までは今回のスコープ外（見た目だけのグループ化）
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。実機での動作確認はまだ

- **統合コンソールが実際は一度も繋がっていなかった根本原因を発見・修正（2026-09-30）**
  - トポロジエディタ・ラボ一覧どちらの経路でも「コンソールを開く」がタブは増えるが無反応、
    という報告が続いていた件。原因は`backend/console-proxy/server.js`側にあった：
    `ws`ライブラリのmessageイベントはペイロードを`Buffer`として渡してくるが、それを
    そのまま`send(buffer)`すると元がテキストフレームでも**バイナリフレームとして中継**
    されてしまい、ブラウザ側の`WebSocket`は既定でバイナリメッセージを`Blob`として渡す。
    フロント側は`JSON.parse(event.data)`していたため`Blob`を渡されて
    `SyntaxError: Unexpected token 'o', "[object Blob]" is not valid JSON`で毎回失敗していた
    （ブラウザの開発者ツールのエラーメッセージから特定。実機での動作確認済みという
    2026-09-24の記録は、実際にはこの経路まで検証できていなかったと判明）
  - `data.toString('utf8')`してから中継するよう修正し、`console-proxy`を再起動して反映済み
    （このプロトコルは常にJSON文字列しかやり取りしないため、バイナリフレームである必要は無い）
  - 動作確認は次のログイン時にお願いしたい

- **質問2件に対応（2026-09-30）**
  - **「deployしたらもうトポロジ変更できない？」**：これまでは常に新規deployとして送っていたため、
    同じラボ名で再度Deployすると「既に存在する」で失敗し、実質的にトポロジを直せなかった。
    入力欄のラボ名が直近deployしたラボと同じなら`reconfigure=true`を付けて送るように修正
    （`deployLab()`に`{reconfigure}`オプションを追加）。ボタンの表示も新規は「Deploy」、
    2回目以降は「変更を反映」に変わる。`reconfigure=true`単体（nodeFilter無し）でノードの
    追加・削除まで反映されるかは`docs/api-contract.md`に`TODO(kawase3)`として記録、実機確認が必要
  - **「routerは最初からvtyshで開いてほしい」**：clab-api-serverのterminal-sessions APIには
    シェル以外の初期コマンドを指定する手段が無いため、シェル接続完了直後にフロント側から
    `vtysh\n`を通常の入力として自動送信する方式で実現（`consoleStore`の`autoCommand`、
    ルーター判定はトポロジエディタでは`data.kind==='router'`、ラボ一覧では
    `image===PALETTE_NODE_CONFIGS.router.image`で行っている）
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。実機での動作確認はまだ

- **ナビゲーションをホーム起点に再構成＋既存ラボをエディタで開く機能（2026-10-05）**
  - **経緯**：トポロジエディタの初期キャンバスに置いていたデモ用ルーター3台（r1/r2/r3）が、
    既存の動いているラボ（例: `test`ラボのコンテナ名も`r1`/`r2`/`r3`）とたまたま名前が一致し、
    デモノードを実ラボのノードと誤解して右クリック→コンソールを開く、という誤操作に繋がっていた。
    デモノードを消すだけでは「既存ラボをエディタで操作したい」というニーズ自体は解決しないため、
    ナビゲーション構造ごと見直した
  - **新構成**：`ホーム`（ラボ一覧＋「＋新規ラボを作成」）→ `トポロジエディタ`という一方向の
    遷移にした。トポロジエディタは常時表示のタブではなく、ホームから「新規作成」または各ラボの
    「✎エディタで開く」のどちらかを選んで入る専用画面にしたことで、「今エディタに出ている
    トポロジがどのラボなのか」が常に明確になる（`store/uiStore.ts`に`EditorTarget`
    （`{mode:'new'}` / `{mode:'edit',labName}`）を追加、`openEditor()`で画面遷移と対象を同時に確定）
  - **既存ラボの読み込み**：clab-api-serverのSwagger仕様で`GET /api/v1/labs/{labName}/topology/yaml`
    （デプロイ済みラボのトポロジYAMLを返す）の存在を確認。`utils/topologyFromYaml.ts`で
    YAML→React Flowノード/エッジに変換してキャンバスに復元する（`js-yaml`を追加導入）。
    ノード座標は保持していないため簡易グリッドレイアウトで配置。読み込み後は
    `deployedLab`も自動セットされるので、そのままコンソールを開く・変更をDeploy（reconfigure）
    できる
  - **既知の制約**：ノード座標はYAMLに無いため毎回グリッド配置になる（`GET .../topology/annotations`
    というエンドポイントで座標等を保持できる可能性があるが、実際のフォーマット未確認のため
    今回は見送り、`TODO(kawase3)`）。ラベル/エリア注釈もcontainerlab側には存在しないため
    既存ラボを開いた直後は復元されない。l2-switchは元のノード名を保存していないため
    ハッシュ化された名前のまま表示される
  - **ロゴクリックでホームに戻る**：`components/Brand.tsx`に`onClick`を追加、`App.tsx`のナビから渡す
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。実機での動作確認はまだ
    （新規作成・既存の`test`ラボを「エディタで開く」の両方を試してほしい）

- **フィードバック5件に対応（2026-10-05）**
  - **ノード座標・ラベル/エリアを保存したい**：`GET/PUT /api/v1/labs/{labName}/topology/annotations`
    （text/plainで任意の文字列を保存できるだけのエンドポイント、フォーマットはクライアント次第と
    Swagger仕様で確認）に、独自JSON（`utils/annotations.ts`）で座標とラベル/エリアを保存するように
    した。deploy成功時に保存（失敗しても握りつぶす、deploy自体は失敗させない）、
    「エディタで開く」時にYAMLから再構築したノードへ座標を上書き・ラベル/エリアを追加する形で復元。
    保存データが無い（404）/壊れている場合は無視してグリッド配置のまま進める
  - **コンソールタブを閉じると直前のタブが表示されたままになる**：`console-manager__body`内で
    非アクティブなタブをdisplay:noneで隠すだけの構成だったため、タブ切り替え時にxterm.jsの
    canvasが古い内容のまま再表示されることがあった。表示状態に戻った瞬間に`fit()`だけでなく
    `term.refresh()`で明示的に再描画させるように修正。タブを閉じた時にアクティブにする
    タブの選び方も「1つ左（無ければ右）」に変更（`store/consoleStore.ts`）
  - **複数タブで視認性が著しく低下する**：タブのラベルが常に`ラボ名/ノード名`でかなり長かったのが
    原因。同時に開いているラボが1つだけなら`ノード名`だけの表示にした（複数ラボを同時に開いている
    時だけラボ名も出す）。タブ幅にも上限をつけて`...`省略するように
  - **routerをコンソールで開くと「5R」という謎の文字が出る**：シェル接続の`ready`直後すぐに
    `vtysh`を送っていたため、プロンプトがまだ出来上がっていない状態に割り込み、カーソル位置の
    問い合わせ応答の断片等が文字化けして見えていたと推測。実際のシェル出力(`output`)を一度
    受け取ってから少し待って（400ms）vtyshを送るように変更（`ConsoleSession.tsx`）
  - **右側コンソールのサイズが調整できない**：ドッキングパネルの左端にドラッグ用のハンドルを追加。
    幅は`store/uiStore.ts`の`consolePanelWidth`で管理（280〜900pxにクランプ）
  - **labをstop→再起動するとコンソールに接続できなくなる**：既存のコンソールタブは当時の
    WebSocket接続を持ったままで、再度🖥を押しても同じタブを再利用するだけで再接続していなかった
    のが原因。`ConsoleSession.tsx`の接続処理を`connect()`として切り出し、切断後（切断済み/エラー
    表示時）に手動で押せる「🔄再接続」ボタンを追加した
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。実機での動作確認はまだ
  - **運用メモ**：`backend/console-proxy`は今回3度、理由不明のまま落ちていた（「メモリ不足のため」
    という停止通知が出たこともあったが、`free -h`では特に逼迫していなかった。Claude Codeの
    セッション経由でバックグラウンド起動していたプロセスが、セッション/ツール呼び出しの
    ライフサイクルと一緒に終了させられていた可能性がある）。対策として`systemctl --user`で
    userサービス化した（sudo不要）。テンプレートを`backend/console-proxy/console-proxy.service.example`
    として追加、README.mdに手順を記載。このサーバー上では既に`~/.config/systemd/user/`に
    実際のユニットファイルを置いて`enable --now`済み（再起動後も自動起動させたい場合は
    別途`loginctl enable-linger`が必要、今回は未実施）

- **UX修正2件（2026-10-05）**
  - **右側コンソールのタブの文字色が消えて何を開いているか分からない**：`--term-bg`
    （コンソールの背景、ライト/ダーク問わず常に暗い色にしている）に対して、アクティブタブの
    文字色がテーマ追従の`--ink`になっていたのが原因。ライトモードだと`--ink`（文字色）が
    `--term-bg`とほぼ同じ暗さになり、文字が背景に沈んで消えて見えていた。常に明るい固定色
    `--term-ink`/`--term-ink-faint`を`theme.css`に追加し、コンソール関連の文字色をそちらに
    差し替えた（タブだけでなくコンソール上部のラボ名/ノード名表示にも同じ問題があったので
    合わせて修正）
  - **新規ラボ作成時、ラボ名を入れないとDeployできないのが手間**：新規作成モードで最初から
    `YYYYMMDDHH`形式の名前を自動で入れておくようにした（そのまま使ってもいいし書き換えてもよい）
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ

- **統合コンソールの単独タブを廃止（2026-10-05、「統合コンソールタブいる？削除していい」指摘）**
  - コンソールは常にどこかのラボのノードに対して開くものなので、トップナビの「統合コンソール」
    タブ（文脈の無いまま開けてしまう入口）を削除し、トポロジエディタのドッキングパネルとしてしか
    存在しない形にした（`store/uiStore.ts`の`View`から`'console'`を削除）
  - ホームの🖥ボタンも、ラボ一覧からは開けず、裏でそのラボをエディタで開いて
    （`openEditor({mode:'edit', labName, autoOpenConsoleNode})`）読み込み完了後に
    対象ノードのコンソールを自動でドッキング表示する方式に変更
  - **「labを切り替えた時に前のlabの機械のコンソールが残るのは良くない」にも対応**：
    トポロジエディタに入る度（新規作成/既存ラボを開くのどちらでも）、前のラボのコンソール
    タブを全て閉じるようにした（`consoleStore`に`closeAllConsoles()`を追加）。同一ラボ内で
    複数ノードのコンソールを同時に開く（右クリック×複数回）動作は変わらず可能
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ

- **ホームタブを削除（2026-10-06、「ホームタブもいらなくない？」指摘）**
  - ロゴクリックで常にホームに戻れるので、別に「ホーム」ボタンをナビに置くのは冗長だった。
    `App.tsx`のナビから`views`配列（タブボタンのループ）を削除し、ロゴのみに一本化した

- **L2スイッチのVLAN設定（アクセス/トランク）を追加＋ポート名衝突バグを修正（2026-10-06）**
  - 「l2とl3 switchちゃんとしたやつほしい」の指摘のうち、L2 VLANを実装（L3は保留、
    `docs/direction.md`参照）
  - **副産物で見つけた既存バグ**：containerlab公式ドキュメントの確認で、ブリッジ側リンクの
    インターフェース名がそのままホストのOVSポート名になり、ブリッジ名と同じくホスト全体で
    グローバルな名前空間だと判明。今まで"eth1"等をそのまま送っていたため、別ユーザー・
    別ラボ間でポート名が衝突する可能性があった。`utils/clabNaming.ts`に
    `toClabPortName()`を追加し、ブリッジ名と同じ方式でハッシュ化して解消
  - トポロジエディタの接続ポップアップに、L2スイッチ側のポートだけVLAN設定欄
    （未設定/アクセス/トランク、VLAN ID 1〜4094）を追加。エッジラベルにも`[VLAN10]`等を表示
  - **新規サービス`backend/ovs-helper/`を追加**：VLAN設定はcontainerlabのトポロジYAMLに無く
    deploy後に`ovs-vsctl`をホスト側で実行する必要があるが、clab-api-serverの`exec`系APIは
    コンテナ単位でしか実行できず`ovs-bridge` kindには届かない。`console-proxy`と同じ発想で、
    JWTを受け取り`GET /api/v1/labs`で本人のラボか確認してから`ovs-vsctl`を代行実行する
    薄いヘルパーを新設（ポート8083）。OVSへの非root権限は既存の設定がそのまま使える
  - deploy成功後、VLAN設定が1件でも必要なリンクがあれば自動で`ovs-helper`を呼ぶ。失敗しても
    deploy自体は成功扱いのまま、成功メッセージにVLAN設定失敗の旨を添える
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。実機でのVLAN投入確認は
    まだ（`ovs-helper`をsystemdサービス化してから次回確認予定、権限操作が本セッションの
    自動承認で止められたため手動セットアップをkawase3に依頼済み）
  - `ovs-helper`のsystemdサービス化完了（kawase3対応済み）。実機確認の過程で新たな不具合発見：
    **containerlabはovs-bridge kindのブリッジを自動生成しない**ため、事前に
    `ovs-vsctl add-br`していないと`bridge "..." referenced in topology but does not exist`
    でdeployが失敗することが判明（M2時点で分かっていた既知の制約だが、今回自動deployフローに
    ブリッジ作成処理が入っていなかった）。`ovs-helper`に`POST /bridge`を追加し、
    `onDeploy`でdeployLab()を呼ぶ直前に、トポロジ内の各L2スイッチのブリッジ名で呼ぶように
    修正（`--may-exist`で既存ブリッジがあってもエラーにならないので再deployでも安全）
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。ブリッジ作成込みでの
    実機deploy確認は次回

- **実機確認中に見つかった不具合2件を修正（2026-10-06）**
  - **`ovs-vsctl: database connection failed (Permission denied)`**：`systemctl --user`の
    ユーザーマネージャ（`user@1000.service`）が、`labuser`を`clab_admins`グループに
    追加するより前（9/9ログイン時点）から起動し続けていたため、新しいグループ情報を
    拾えていなかった（`/proc/<pid>/status`のGroupsで確認）。`sudo systemctl restart
    user@$(id -u labuser).service`でユーザーマネージャ自体を再起動し解消
    （`console-proxy`・`ovs-helper`は`enabled`なので自動的に正しいグループで再起動された）
  - **「ラボ「fine」は自分の所有ではありません」でVLAN設定が失敗**：deploy成功直後に
    `GET /api/v1/labs`を叩いても、clab-api-server側にまだラボが反映されていない
    タイミングがあったと判明。`ovs-helper`の所有権確認に400msおきの再試行（最大5回）を追加
  - 両方修正後、再テストで3件目の不具合を発見：
    **`interface "..." is defined via topology but already exists`**。ポート名が
    (username,labName,switchNodeId,iface)から決定的に決まるため、同じラボを再deployすると
    毎回同じポート名になり、前回deployでOVS側に作られたインターフェースが残っていて衝突する。
    `ovs-helper`に`POST /port/reset`（`ovs-vsctl --if-exists del-port`）を追加し、
    `onDeploy`でdeployLab()を呼ぶ直前に全L2スイッチ側ポートに対して呼ぶように修正
    （VLAN設定はdeploy後に毎回再投入するので、消しても実質的な影響は無い）
  - 検証は`npx tsc --noEmit` / `npm run lint` / `npm run build`のみ。実機での再テストは次回

- **Vite開発サーバーも理由不明で停止（2026-10-06）**：`console-proxy`・`ovs-helper`と同様に、
  ターミナルで直接`npm run dev`していたVite自体が落ち、フロントに一切アクセスできなくなる
  事象が発生。同じくsystemdのuserサービス化で対応（`frontend/frontend-dev.service.example`
  を追加、このサーバー上では`enable --now`済み）
- **「所有ではありません」の再試行を強化＋デバッグログ追加**：400ms×5回（2秒）では
  解消しなかったため、1秒×15回（最大15秒）に延長。失敗時は実際にGET /api/v1/labsで
  返ってきたラボ名一覧をログに残すようにした（原因切り分け用）
- **トランクVLANの設定方法を改善（2026-10-06、「all allowedか指定VLANだけにするか」指摘）**：
  今までトランクは常に「指定VLANのみ許可」だったが、「全VLAN許可」も選べるようにした。
  OVSはポートにtag/trunksのどちらも設定しないとデフォルトで全VLAN許可のトランクになるため、
  「全VLAN許可」を選んだ場合はovs-helperを呼ぶ必要が無い（resetPort後の状態がそのまま
  該当する）。`VlanConfig`の`trunk`モードは`vlans: number[] | 'all'`に変更
  （`frontend/src/api/ovsHelperClient.ts`・`TopologyEditor.tsx`）
- **「所有ではありません」の真因が判明（2026-10-06）**：15秒まで再試行を延長しても解消しない
  ケースがあり、`ovs-helper`のログに`GET /api/v1/labs`の返り値を出すと常に`{}`（空）だった。
  clab-api-serverのログで突き止めた原因は`Lab deployed successfully ... containerCount=0`——
  **`GET /api/v1/labs`はcontainerlabのinspect結果（＝実行中コンテナ一覧）ベースで、
  コンテナを1台も持たないラボ（スイッチ同士を直結しただけの構成等）は何秒待っても
  一覧に出てこない**。待ち時間の問題ではなかった。
  所有権確認を`GET /api/v1/labs/{labName}/topology/yaml`（保存済みYAMLを読むだけで
  所有権チェック済みの200/404を返す。コンテナ数に依存しない）に切り替えて修正。
  再試行も不要になった分500ms×3回に戻した（`backend/ovs-helper/server.js`の`verifyLabOwnership`）。
  実機での再テストは次回
- **「変更していないのに再Deployでエラーになる」の真因が判明（2026-10-07）**：
  `front-test`ラボで、1回目deploy成功→何も変更せず2回目deployで
  `interface "..." is defined via topology but already exists`が再発。
  `ip -o link show`で確認すると、`resetPort`の`ovs-vsctl --if-exists del-port`を呼んだ後も
  **vethデバイス自体（`p-xxxxxxxx@p-yyyyyyyy`）がカーネルに残っていた**。
  `del-port`はOVSブリッジからの切り離しのみで、veth自体の削除ではなかったため。
  `ip link delete`で削除する対応を追加したが、これにはCAP_NET_ADMINが必要で
  `labuser`権限のovs-helperプロセスからは`Operation not permitted`になることが判明。
  `ovsdb-server`の`root:clab_admins`方式を参考に、`p-xxxxxxxx`形式のdeleteだけを許可する
  専用ラッパー`backend/ovs-helper/link-delete.sh`を追加し、まず`setcap cap_net_admin+ep`で
  試したが**シェルスクリプトにはファイルcapabilityが効かない**（カーネルが実際にexecveするのは
  `/bin/sh`であり、capabilityはスクリプトのinodeに付けてもインタプリタ本体には引き継がれない
  既知の制限。ユーザー実機確認：setcap後も`RTNETLINK answers: Operation not permitted`）ため、
  `/etc/sudoers.d/`での限定NOPASSWD許可（`sudo -n`でこのラッパー1本だけを許可）に方式変更。
  **実機での`sudo`セットアップ・再テストは次回**
- **VLAN動作テスト中にBさん役（kawase3）から4点の指摘（2026-10-07）**：
  1. 変更後deployしないとコンソールが開けない → 仕様（コンテナが無いと入れない）。
     既存ノードは未deployの変更があっても開ける。右クリックメニューはdisabled＋
     「このノードはまだdeployされていません」のツールチップ表示済みで対応は入っていた
  2. **バグ：L2スイッチにも「コンソールを開く」の項目が出る** → `contextMenuCanOpenConsole`が
     ノードのkindをチェックしていなかった。修正し、スイッチの場合はメニュー項目自体を
     出さないようにした（`TopologyEditor.tsx`）
  3. PCのアドレシングが面倒 → IPアドレス設定UIが無く、コンソールで`ip addr add`を
     手打ちするしかなかった。「固定IP設定UIを追加」で対応（本行の次の項目）
  4. PCで`ip a`すると設定済みのi/fが見える → 実機確認したところcontainerlabの管理用
     `eth0`（docker管理ネットワークの172.20.20.x/24、clabが自動付与）だった。
     ラボのトポロジ用リンクは`eth1`以降で、そちらはIPv6 link-localのみの未設定状態
     （バグではなく仕様。ユーザーに説明済み）
- **PCの固定IPアドレス設定UIを追加（2026-10-07）**：接続ポップアップに、L2スイッチ以外の
  ノード側へ「IPv4アドレス（任意）」欄を追加（`10.0.0.1/24`形式、`parseIpv4Cidr()`で検証）。
  L2スイッチがVLANをovs-helper経由で投入するのと同様、PCはコンテナを持つので
  clab-api-serverの`POST /api/v1/labs/{labName}/exec`を直接使い、deploy成功後に
  `ip addr add <addr> dev <iface>`を実行する（`frontend/src/api/client.ts`の`execInLab()`、
  `TopologyEditor.tsx`の`addressTasks`）
- **execのnodeFilterはコンテナのフルネームが必要と判明（2026-10-07実機確認）**：
  `front-test`でユーザー実機テストしたところ、`nodeFilter=pc-1`（短い名前）では
  `500 exec failed: filter did not match any containers`で全滅。execはデプロイ前の
  トポロジ定義を見る`wipeNode()`と違い、デプロイ済みコンテナを対象にするため、
  `terminal-sessions`と同じ`clab-<labName>-<nodeName>`のフルネームが要る。
  `execInLab()`内でフルネームに変換するよう修正。`docs/api-contract.md`も修正
  （フルネーム変換後の成功レスポンス自体の確認は次回）。
  `npx tsc --noEmit`はクリア。**実機テスト済み（2026-10-07）：動作良好**
- **再読み込み時にL2スイッチ接続のI/F名が文字化け・VLAN/アドレス設定が消える、を修正
  （2026-10-07指摘）**：`parseTopologyYaml()`はYAMLに書かれた実名（ハッシュ化されたポート名
  `p-xxxxxxxx`等）をそのまま`sourceIface`/`targetIface`に入れていたため、再読み込み後は
  UIの表示が実名のまま（ユーザーには文字化けのように見える）になっていた。さらにVLAN/IPアドレス
  設定はそもそもトポロジYAMLに書けないため、再読み込みで編集状態から完全に消えていた
  （再deployするとovs-helperの`resetPort`でVLANが初期化され、設定が戻らないまま
  上書きされる潜在バグでもあった）。
  `buildTopologyContent()`が返す`portAnnotations`（`${実名clabName}:${実名ポート}`をキーに
  した「分かりやすい名前・VLAN・アドレス」のマップ）を既存のannotations保存先
  （`topology/annotations`、version 1→2に拡張）に一緒に保存し、再読み込み時に
  `applyPortAnnotations()`で引き戻すようにした（`utils/annotations.ts`）。
  `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア。
  **旧versionのannotations（port情報無し）は無視されるだけで壊れない。次回、front-testで
  一度redeploy→再読み込みして文字化けが直るか確認する**
- **マージ前に`/code-review high`で自己レビュー（2026-10-07）**：最重要の指摘1件を確認・修正、
  他2件も合わせて修正：
  1. **【重要・修正】L2スイッチのブリッジ名/ポート名が再読み込み後の再deployでズレ続ける
     潜在バグ**：`toClabBridgeName(username, labName, node.id)`はnode.idをハッシュ化するが、
     再読み込み直後のnode.idは既にハッシュ化済みの実名（`sw-xxxxxxxx`）になっている
     （元のUI上のidはYAMLに保存されないため）。これをさらにハッシュしてしまうため、
     「開く→redeploy」を繰り返すたびに別のブリッジ名になり、古いブリッジ/vethがホストに
     残骸として残り、VLAN設定も失われる。上の「文字化け」修正で追加した`portAnnotations`の
     仕組みを拡張し、L2スイッチの`clabName→元のnode.id`の対応も`switchOriginalIds`として
     annotationsに保存。再読み込み時、`applyPortAnnotations`の後に
     `restoreSwitchIdentities()`でnode.id・edgeのsource/targetを元のidへ戻すようにした
     （順序が重要：`portAnnotations`のキーはハッシュ化済みclabName基準のため、
     id復元より先にport復元を行う必要がある）
  2. VLAN/アドレス設定の投入が直列await（ポート数が増えるほどdeployが線形に遅くなる）だった
     のを、ブリッジ作成/ポートリセットと同じく`Promise.allSettled`で並列化
  3. アドレス設定失敗時に`firstResult.stderr`が無い場合に`.trim()`が例外を投げる可能性を修正
     （`?? ''`でガード）
  - 指摘のうち2件は意図的に見送り：ブリッジ作成/ポートリセット失敗時にdeploy全体を
    中断する挙動（VLAN/アドレス失敗時は中断しないのと非対称、との指摘）は、
    ブリッジ/ポートが無いとdeploy自体が確実に失敗するので早期中断の方が分かりやすいと判断。
    `deleteLinkIfExists`の`Cannot find device`文字列マッチ（英語決め打ち）も、
    想定外のsudoエラー等を誤って握りつぶさないためにそのまま残した（sudoers未設定問題は
    実際にこの仕組みで発見できた）
  - `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア
- **次の目標（2026-10-07、ユーザーより。2→3→1の順で対応中）**：
  1. VLANを使ったrouter on a stick（FRRのVLANサブインターフェースでルーター1台が複数VLANを
     ルーティングできるか）の検証：**未着手**。FRRコンテナで`ip link add link eth1 name
     eth1.10 type vlan id 10`が実機で通ることは確認済み（CAP_NET_ADMINあり）、技術的には可能
  2. **【対応済み】** ルーターコンソールで`exit`するとvtyshを抜けてコンテナのLinuxシェルに
     落ちてしまう（脆弱性として指摘）：clab-api-serverのterminal-sessions APIには
     shell以外の起動コマンドを指定する手段が無く（protocolはssh/shell/telnetのみ）、
     サーバー側では止められない。接続直後に自動実行するコマンドを`vtysh`単発から
     `while true; do vtysh; done`（vtysh終了時に即座に再起動するループ）に変更
     （`TopologyEditor.tsx`の`ROUTER_CONSOLE_AUTO_COMMAND`）。実機確認済み：`exit`直後に
     vtyshが再起動し、シェルコマンド（`id`等）はvtyshに「Unknown command」として拒否される。
     Ctrl-C/Ctrl-D等の未検証な入力経路もあるため、ハードなセキュリティ境界ではなく
     「誤って/意図的にシェルに落ちるのを防ぐソフトな対策」である点に注意
  3. **【対応済み・想定より大きい問題だった】** PCコンソールで`eth0`を触れてしまう指摘の
     対応を検討中、containerlabの`linux` kind（PC/ルーター両方）が**デフォルトで
     Dockerの`--privileged`相当（全capability・AppArmor/seccomp無効）**で動いていることが
     判明。コンソールはroot shellなので、privilegedコンテナ特有のホスト侵害手法を
     理論上試みられる状態だった（ユーザーの「ホストの権限を取られないか」という懸念が
     まさに正しかった）。`eth0`個別のコマンドブロックではなく、根本原因である特権を
     `privileged: false` + 必要最小限の`cap-add`（PC: `NET_ADMIN`、ルーター: FRRが
     要求する`NET_ADMIN`+`NET_RAW`+`SYS_ADMIN`）に縮小する対応に変更。詳細・実機検証結果は
     `docs/direction.md`の2026-10-07決定事項参照。OSPF隣接形成・ping・コンソール・
     IPアドレス設定機能への影響なしを確認済み
     （`TopologyEditor.tsx`の`CONTAINER_CAPABILITIES`、`api/client.ts`の`TopologyContent`型）。
     **元々の「eth0コマンドをソフトにブロック」は未実装**——host侵害経路を塞いだ分、
     残るリスクは「自分のコンテナのmgmt接続を自分で切る」程度に下がったため、
     追加でやるかは次回確認
- **【対応済み】次の目標の1（router on a stick）**：ルーターが、L2スイッチのトランクポートに
  接続している時だけ、接続ポップアップに「プレーン/VLANサブインターフェース」のモード切替を
  追加。VLANサブインターフェースモードでは、VLAN ID＋アドレスの行を複数追加できるUIにし、
  deploy後にclab-api-serverのexec経由で`ip link add ... type vlan`→`ip link set ... up`→
  `ip addr add`の3段階を順番に実行する（`TopologyEditor.tsx`の`SubInterfaceTask`/
  `CONTAINER_CAPABILITIES`、execは`&&`等のシェル機能に頼らず1コマンドずつ送る設計）。
  再読み込み時の復元も既存の`portAnnotations`機構を拡張して対応（`subInterfaces`フィールド追加）
  - 実機検証（一時テストラボ：ルーター2台をL2スイッチ経由で接続、両方にVLAN10の
    サブインターフェースを作成）：**トランク越しのVLAN10通信を確認（ping 0% loss）**。
    物理I/F自体（eth1）にはIPv4が付かず、意図通り「トランクの運び役」のままであることも確認
  - `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア
- **【対応済み】router on a stick検証中に発覚：ラボ内の未定義宛先が実際の外部ネットワークに
  漏れる問題（2026-10-07）**：ユーザーが`traceroute`で本物のISPまで到達することを発見。
  containerlabがmgmt用`eth0`に自動設定する`default via <dockerブリッジgw>`が原因。
  「このルート自体を消して動いてる機能壊れないか」という懸念に対し一時テストコンテナで実機確認
  （コンソール/execは`docker exec`相当でネットワークスタックを使わないため無影響、削除後は
  外部への通信が`Network unreachable`でブロックされることを確認）。対応：
  1. 接続ポップアップのプレーンなアドレス設定に「デフォルトゲートウェイ（任意）」欄を追加
  2. deploy後、全PC/ルーターでeth0の自動デフォルトルートを削除し、ゲートウェイが設定されている
     ノードだけ明示的に`ip route add default via <gateway>`で設定し直す
     （アドレス/サブインターフェース設定が終わった後に実行、順序が重要）
  - 実機検証（一時テストラボ：PC-ルーター間でゲートウェイ設定）：ゲートウェイ経由の通信は成功
    （0% loss）、未定義の宛先への通信は100% lossで外部に漏れないことを確認
  - 詳細は`docs/direction.md`の2026-10-07決定事項（2つ目）参照
  - `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア
- **【対応済み】既存接続のI/F・VLAN・アドレス・ゲートウェイ・サブインターフェース設定を
  後から編集できるように（2026-10-07指摘）**：router on a stickの実機テストで、
  pc-1/pc-2にゲートウェイが設定されておらずVLAN間通信が失敗する問題を調査中に判明。
  これらの設定項目は**新規接続時のポップアップにしか無く、既存の接続を後から編集する手段が
  無かった**ため、GUIにゲートウェイ欄があっても実質使えなかった（「IPはGUIで設定できるのに
  DGWを設定できないのはナンセンス」指摘）。エッジの右クリックメニューに「設定を編集」を追加し、
  新規接続時と同じポップアップを既存データで埋めて再利用する形で対応
  （`TopologyEditor.tsx`の`editEdge()`、`PendingConnection`に`editingEdgeId`を追加）。
  編集中は自分自身のI/F割り当てを「使用中」と誤検知しないよう`usedInterfaces()`に
  `excludeEdgeId`を追加。`npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア
- **【対応済み】「deployしたのに座標が復元されなかった」バグ修正（2026-10-07）**：
  front-testの実際の保存データ（`*.clab.yml.annotations.json`）を直接確認したところ、
  `positions`のキー（L2スイッチの古いハッシュ名）と`portAnnotations`のキー（最新の
  ハッシュ名）が食い違っていた。原因は読み込み時の処理順序：`applyAnnotations()`
  （座標の復元、node.idをキーに引く）が`restoreSwitchIdentities()`（node.idを
  元の安定した値に戻す処理）より**先に**実行されていたため、L2スイッチの座標復元だけ
  常に失敗してグリッド配置に戻ってしまっていた（PC/ルーターはnode.idがハッシュ化されない
  ため影響なし）。`restoreSwitchIdentities()`→`applyAnnotations()`の順に修正
  （`TopologyEditor.tsx`の読み込みuseEffect）
- **【対応済み】エリア名の変更をワンクリックに変更（2026-10-07指摘）**：
  今までダブルクリックが必要だった（`AreaNode.tsx`の`onDoubleClick`→`onClick`）
- **【対応済み】統合コンソールに「すべて閉じる」ボタンを追加＋タブの×ボタンを拡大
  （2026-10-07指摘：「コンソールタブ閉じたい」「×ボタンが機能していない/見つからない」）**：
  既存の×ボタン自体のロジックは問題なさそうだったが、サイズが小さく見つけにくかった
  可能性があるため、サイズ・当たり判定・hover時のコントラストを強化。タブが2つ以上ある時は
  一括で閉じる「すべて閉じる」ボタンも追加（`ConsolePane.tsx`/`Console.css`）
  - 「取ってこれなかった」については自由記入の内容がこちらに届かなかったため、
    まだ対応できていない。詳細を次回確認する
- **【追加対応】「コンソールタブ自体を消すボタンが欲しい」（2026-10-07再指摘）**：
  元々パネル自体を閉じる手段はトップバーの離れた場所にあるトグルボタンのみで、パネル自体には
  閉じるボタンが無かった。パネルのタブバー（タブが無い時は空状態の画面にも）に
  「✕ パネルを閉じる」ボタンを追加。全セッションを終了してからパネルも隠す動作にした
  （`closeAllConsoles()` + `setConsolePanelDocked(false)`）。トップバーのトグルとは異なり、
  こちらは明示的にセッションも終了する。`npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア
- **【大きな方針変更】ルーターの設定をGUIからCLI（vtysh）主体に変更（2026-10-07）**：
  test2での実機テストで「GUIで設定し忘れるとping が通らない」ことをきっかけに、
  「学習ツールとしてGUIが代わりに設定してしまうのはおかしい、ルーターはCLIで設定しないと
  意味がない」という指摘を受けた。vtyshにVLANサブインターフェースの"デバイス作成"自体は
  できない（カーネルのip link操作はFRRのスコープ外、実機確認済み）ことを前提に、役割分担を
  変更：
  - ルーターのIPアドレス/ルーティング設定は100%CLI（vtysh）。GUIのプレーンな
    「IPv4アドレス/デフォルトゲートウェイ」入力欄はルーターからは廃止（PCのみ残す）
  - router on a stickのVLANサブインターフェースは、GUIが用意するのはVLAN IDに基づく
    「空のデバイス」のみ（`ip link add`+`up`、アドレス設定はしない）
  - FRR設定ファイル（daemons/frr.conf/vtysh.conf）を`frr-config/<router>/`に
    bind mountして永続化。`backend/ovs-helper/`に新エンドポイント`POST /frr-config`を追加
    （既存ファイルは上書きしない＝学生の`write memory`を保護）。daemonsは学生が編集できない
    （コンソールはvtysh専用）ため、主要プロトコル（zebra/staticd/ospfd/ospf6d/ripd/isisd/bgpd）
    を最初から有効化
  - 実機検証：`write memory`で保存したCLI設定が、コンテナを完全に破棄・再作成する
    redeployを越えて残ることを一時テストラボで確認済み。`/frr-config`エンドポイント自体の
    配線（偽トークンでの401応答）も確認済み
  - 詳細は`docs/direction.md`の2026-10-07決定事項（3つ目）、`backend/ovs-helper/README.md`参照
  - `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア。**実機での一連の流れ
    （ルーター配置→VLANサブインターフェース作成→vtyshでアドレス設定→write memory→
    再deployでの保持）の確認は次回**

- **【一部撤回】VLANサブインターフェースの作成はGUIで完結させる方式に戻した（2026-10-08）**：
  「FRR自体がLinuxカーネルで動いてるならVLANサブインターフェース作成も取り込めないか」という
  提案を受けてFRR公式ドキュメントを確認したところ、zebraはVRF/VXLAN/VLANいずれも作成せず、
  インターフェース作成は常に外部ツール（`ip link`等）に委ねる設計であることが公式に確定した
  （詳細は`docs/direction.md`の2026-10-08決定事項参照）。この制約を踏まえ、「デバイス作成は
  GUI必須・アドレス設定だけCLI」という前日の2段階運用について、ユーザーから
  「煩雑すぎて誤解を生みかねない（test2で実際にルーター側の設定を忘れてping が通らない
  事象が発生した）」との判断があり、**サブインターフェース作成時はVLAN ID＋アドレスを
  GUIで一度に設定する方式に戻した**（撤回）。ルーターの通常のアドレス設定（「プレーン」
  モード）・FRR設定の永続化機構はそのまま維持。
  `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア

- **`/code-review high`での自己レビュー対応（2026-10-08）**：`fe-be/router-on-a-stick`ブランチを
  多角的にレビューし、10件の指摘から以下を修正：
  1. **【重要】`ip route del default`が無条件すぎる問題**：ルーターがvtyshのCLI＋
     `write memory`で別デバイス経由のデフォルトルートを設定していた場合、deploy後の
     クリーンアップ処理が誤ってそれを消してしまう恐れがあった。`ip route del default
     dev eth0`とcontainerlabのmgmtインターフェースに明示的に絞るよう修正し、実機で
     「FRRが別デバイス経由で設定した静的デフォルトルートは生き残り、eth0側だけ消える」
     ことを確認した
  2. **execの戻り値が空の時に成功扱いになっていた問題**：対象コンテナが見つからず
     execの結果が空オブジェクトになるケースで、エラー判定が素通りして静かに成功扱いに
     なっていた（`addressTasks`/`subInterfaceTasks`/`routeResults`の4箇所で共通のパターン
     だったため`assertExecOk()`に共通化して修正）
  3. **方針変更前の古いルーター側アドレス/ゲートウェイ設定が再投入され続ける問題**：
     ルーターのプレーンなアドレス設定はvtyshのCLIで行う方針（2026-10-07）にしたが、
     GUIの入力欄を隠しただけで、方針変更前に保存されていた古いデータがあれば
     deployのたびにexecで再投入され、学生がCLIで設定した内容と静かに競合する恐れが
     あった。ルーター側は`addressTasks`/`gatewayByNode`の対象から常に除外するよう修正
  4. 既存接続を編集してI/Fを変更すると、エッジidがI/F名由来のまま古くなり、同じI/F組み合わせの
     新規接続と衝突する恐れがあった→ idをI/F名から組み立てず乱数ベースに変更
  5. `ovs-helper`のユーザー名検証パターンが`.`を含むLinuxユーザー名を拒否してしまう
     問題→ ユーザー名専用のパターンを追加して対応
  6. 保存済みannotationsが想定外の形式だった場合に`editEdge()`がクラッシュする可能性
     →`Array.isArray()`チェックを追加
  - 見送った指摘（優先度が低いと判断）：router on a stick UIがトランク/アクセスの
    実際のポート設定を見ずに出る点、同一ノードに複数ゲートウェイを設定した時の
    サイレントな上書き、VLANサブインターフェースを0件のまま保存できる点
  - `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア

- **ルーティングプロトコルの実機テスト（2026-10-08）**：OSPFに加えてRIP/BGP/IS-IS/OSPFv3
  （ospf6d）を2ルーター構成で一通り検証。全て最終的に疎通成功（0% loss）：
  - RIP: `redistribute connected`で問題なく疎通
  - IS-IS: `metric-style wide`が無いとSPFは計算されるがzebraにルートが入らなかった
    （標準的なIS-IS設定なので対応不要、学習内容として妥当）
  - OSPFv3: `router ospf6`のインスタンス自体を作らないと動かない点に注意（インターフェース側の
    `ipv6 ospf6 area 0`だけでは不十分）
  - **BGP: 要注意**。FRR 10.xはeBGP（AS番号が違う）セッションに対して
    デフォルトで`bgp ebgp-requires-policy`が有効で、明示的なroute-map等のポリシーが
    無いとprefixを一切交換しない（`show bgp summary`に`(Policy)`と表示されるだけで
    原因が分かりにくい）。`no bgp ebgp-requires-policy`で解除すれば教科書通りの設定で動く。
    `router bgp <AS番号>`はdeployより前にAS番号が決まらないため、デフォルトの`frr.conf`に
    事前設定することはできない——学生がハマりやすい点として、何らかの形で周知する方法を
    検討する必要がある（次回相談）

- **YAML export/import機能を追加（2026-10-08、「授業で使うテンプレート共有」指摘対応）**：
  - エクスポート：deploy済みラボのトポロジYAML＋annotations（座標・VLAN/アドレス設定）を
    サーバーから取得し直してダウンロードする（今の編集中の未deploy変更ではなく、実際に
    deployされている内容を正確に反映するため）
  - インポート：ローカルのYAML（＋任意でannotations）ファイルを読み込んでキャンバスに
    反映する（deployはしない、確認してから自分のアカウントでdeployしてもらう想定）
  - 既存の「エディタで開く」時の復元ロジック（`applyPortAnnotations`→
    `restoreSwitchIdentities`→`applyAnnotations`の順）を`parseImportedTopology()`として
    共通化し、サーバー取得/ローカルファイルどちらでも同じ復元品質になるようにした
  - `npx tsc --noEmit` / `npm run lint` / `npm run build`はクリア。**実機でのexport→import
    往復テストは次回**

- **パケットキャプチャ機能の前提：EdgeShark導入（2026-10-08）**：「リンクを右クリックして
  パケットキャプチャ」機能を検討。clab-api-server側のAPIは実装済みだったが、裏で動く
  Siemens EdgeShark（`ghostwire`＋`packetflix`）が無いと`503`になることが判明していた。
  clab-api-serverのソース（`internal/config/config.go`）を確認し、デフォルトポート設定
  （5001）がEdgeShark公式のデフォルトと一致することを確認（**clab-api-server側の設定変更は
  不要**）。公式docker-composeを`backend/edgeshark/docker-compose.yaml`に保存して導入。
  `labuser`が`docker`グループに入っているため**sudo不要で起動できた**（実機確認：
  `curl http://127.0.0.1:5001/version`が正常応答）。権限についての整理（ghostwire/edgesharkは
  `pid: host`等、学生用コンテナとは別次元の広い権限で動くが、具体的に列挙されたcapability
  のみ＋非root＋読み取り専用rootfsという設計で、学生向けコンテナの権限を絞る方針とは
  矛盾しないと判断）は`docs/direction.md`の2026-10-08決定事項参照。
  **未確認**：clab-api-server経由の実際のキャプチャAPI（実ユーザーのJWTでの呼び出し）・
  フロントエンドのUI実装はまだ無い。次回対応

- **パケットキャプチャ機能：フロントエンドUI＋中継プロキシ実装（2026-10-08）**：
  リンクを右クリック→「パケットキャプチャ」→別タブでWiresharkのnoVNC画面を開く、という
  流れを実装。clab-api-serverのソースを確認し、`/vnc/{proxyPath}`（noVNCのHTML/JS/CSS資産＋
  VNC用WebSocketを中継するエンドポイント）も`Authorization`ヘッダー必須（代替手段無し）だと
  判明。これは統合コンソール機能（`console-proxy`）で経験した壁と同じ構造の問題のため、
  同じ発想で`backend/capture-proxy/`（ポート8084）という新しい中継プロキシを新設した。
  ただし`console-proxy`（最初の1メッセージでトークンを送る方式）とは違い、noVNCは素のGETで
  複数ファイルを読みに行く通常のWebアプリなので、**トークンをURLのパスに埋め込む方式**
  （`/capture/<sessionId>/<jwt>/<相対パス>`）にした。L2スイッチ側はコンテナを持たないため
  キャプチャ対象から除外（PC/ルーター側のみ対象）。`npx tsc --noEmit` / `npm run lint` /
  `npm run build`はクリア。**実機での動作確認（noVNC経由でWireshark画面が実際に開くか）は
  まだ**。詳細は`docs/direction.md`の2026-10-08決定事項、`backend/capture-proxy/README.md`参照

- **パケットキャプチャ機能：実機テストで見つかった不具合2件を修正＋動作確認（2026-10-08）**：
  1. 初回のWiresharkイメージpullが clab-api-server側の45秒固定タイムアウトに引っかかり
     `signal: killed`で失敗 → `docker pull ghcr.io/srl-labs/wireshark-vnc-docker:latest`を
     事前実行してキャッシュしておくことで回避（2回目以降は問題なし）
  2. VNC用WebSocket（`/vnc/websockify`）がWireshark VNCコンテナ内のnginxに`400`で拒否される
     不具合を発見・修正：nginxの`websockify_pass`ディレクティブが`Sec-WebSocket-Protocol: binary`
     ヘッダーを要求しており、`ws`ライブラリはデフォルトでこれを送らないため拒否されていた。
     capture-proxy側でブラウザが送ってきたプロトコルをそのまま上流にも伝えるよう修正し解決
  - 上記2点を直した上で**実機確認：noVNC経由でWiresharkの画面が実際に開き、動作することを
    確認済み**（ユーザーのブラウザで動作確認。HTML/JS/CSS資産読み込みは最初から問題無かった）
  - ユーザーから2件の使い勝手の指摘：(a) 複数タブを開くとどのリンクをキャプチャしているか
    タブの見た目で分からない → capture-proxyが上流HTMLの`<title>`をラベル（例：
    「R1(eth1) ↔ SW1」）に書き換える機能を追加して対応済み。(b) noVNC画面との間でコピペが
    できない → VNC自体の構造的な制約（画面を転送しているだけ）で、クリップボード同期機能が
    無いと解決しない。**未対応**（優先度は要相談、docs/direction.md参照）
  - デバッグ中にWireshark VNCコンテナが複数（6個）溜まってしまい、掃除の際に誤って
    ユーザーが開いていた可能性のあるセッションのコンテナも削除してしまった（実害は
    「もう一度右クリックし直せば直る」程度だが、今後は稼働中セッションの有無を
    確認してから掃除するよう注意）

- **パケットキャプチャ機能：タブタイトル不具合修正＋HTTPS化（2026-10-09）**：
  - タブタイトルが反映されない不具合を発見・修正：Wireshark VNCコンテナのベースイメージ
    （`jlesage/baseimage-gui`）のnoVNCアプリがページ読み込み後にJSで`document.title`を
    "Wireshark"に上書きしてしまうため、`<title>`タグの静的な書き換えだけでは効かなかった。
    `setInterval`で定期的に強制上書きするスクリプトを埋め込むよう修正
  - 「コピペが面倒」という指摘を受けて調査したところ、noVNCには**ブラウザのClipboard APIを
    使ったホストクリップボード自動同期機能が標準で既に入っている**ことが判明。ただし
    Clipboard APIが「secure context」（HTTPS）を要求するため、capture-proxyが平文HTTPの
    ままでは有効化されなかった。自己署名TLS証明書を`certs/`に生成し、capture-proxyを
    HTTPS化して解決（`frontend/.env`の`VITE_CAPTURE_PROXY_URL`も`https://`に変更済み、
    vite devサーバーも再起動済み）
  - 手動でのコピペ方法（noVNCサイドバーのクリップボードテキストエリア）も案内済み
    （`backend/capture-proxy/README.md`参照）

**Blocked / 相手待ち**
- **（2026-10-07、ユーザー確認済み）** コンソールのvtyshループ・PC/ルーターの
  privileged:false化、router on a stick（GUIでVLAN ID＋アドレス一括設定）＋ゲートウェイ設定は
  front-test/test2で実機確認済み（問題なし。test2で見つかったルーター側アドレス未設定の件も、
  その後の指摘で判明したコードの不具合も含めて対応済み）
- ルーターのCLI主体化（プレーンなアドレス設定をvtyshで行う方式）＋FRR設定の永続化
  （`write memory`→再deployを越えて設定が残る）の実機テストは一時テストラボで実施済みだが、
  front-test等の実運用ラボでも確認してほしい
- **YAML export/import機能（上記、新規実装）の実機確認**：front-test等をエクスポートし、
  別の新規ラボにインポートしてトポロジ・VLAN・座標が正しく復元されるか確認してほしい
- **BGPの`ebgp-requires-policy`問題（上記で発見）への対応方針**：学生がハマりやすい点を
  どう周知するか（READMEに書く／UIにヒント表示する等）、次回相談
- **パケットキャプチャ機能（上記、実機動作確認済み。ARP/ICMPが見えることまで確認済み）**：
  タブタイトル不具合の修正、HTTPS化によるクリップボード自動同期の有効化は対応済み。
  **サービス再起動が必要**：`frontend/.env`の`VITE_CAPTURE_PROXY_URL`を`https://`に変更
  したので、vite devサーバーの再起動が必要（既に再起動済み）。自己署名TLSのため、初回
  `https://<server>:8084/`へのアクセス時にブラウザで証明書の警告を一度許可する必要あり
  （clab-api-serverと同じ対応）。クリップボード自動同期が実際に機能するかは引き続き実機確認を

---

## Bさん（フロントエンド）

**Done**
- Vite + React プロジェクト雛形、React Flow (@xyflow/react) 導入、モックでラボ一覧・トポロジ表示（PR #3）
- ノードパレット3種（ルーター/L2スイッチ/PC）のドラッグ&ドロップ実装
  （`components/NodePalette.tsx` → `components/TopologyEditor.tsx` にドロップしてノード追加。
  kind/image は `api-contract.md` 3章の対応表を `types/lab.ts` の `PALETTE_NODE_CONFIGS` に反映）
- `mocks/labs.ts` の owner を実在アカウント名から架空名に変更
- `types/lab.ts` の `PALETTE_NODE_CONFIGS` を確定値に更新（ルーター image: `quay.io/frrouting/frr:10.2.1`、PC image: `alpine:3.20`）
- `ovs-bridge`ブリッジ名のグローバル衝突対策を実装：`frontend/src/utils/clabNaming.ts` の `toClabBridgeName()`（`<username>_<labname>_<ノード名>`形式に変換。2026-09-16決定、`docs/direction.md`参照）。`docs/api-contract.md` 3章のTODOを解消

**Doing**
- （なし）

**Next**
- M7に向けて、`toClabBridgeName()` を実際のAPI送信処理（topologyContent組み立て）に組み込む
- M7に向けて、モックのレスポンス形状を `api-contract.md` の実レスポンス例に合わせて調整

**Blocked / 相手待ち**
- 実 API 接続そのものはまだだが、`docs/api-contract.md`にログイン/ラボ一覧/deploy/destroyの
  実レスポンス例を記録済み（M3で確認）。モックのレスポンス形状はこれに合わせて作れる。
- 開発サーバーの origin は `http://localhost:5173`（Vite標準、ポート変更なし）です。
  kawase3さん、`CORS_ALLOWED_ORIGINS`の設定をお願いします（`api-contract.md` 0章のTODO）。

---

## 相談中・未決（決まったら direction.md へ移す）

- （2026-09-16、下記3件はdirection.mdへ決定事項として記録済み）
  - 状態管理ライブラリ → **Zustandに決定**
  - 同時起動ノード数の上限 → **設けない**（実測データはdirection.md参照）
  - ovs-bridgeのブリッジ名衝突対策 → **`<username>_<labname>_<ノード名>`に決定**（FE実装済み: `toClabBridgeName()`、api-contract.md参照）
- 企画・設計書のチーム情報（サイクル/チーム名/メンバー欄）の記入 → コード外のタスク、要対応
