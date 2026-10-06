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

**Blocked / 相手待ち**
- `backend/ovs-helper/`のsystemdサービス化（手順は依頼済み、`console-proxy.service.example`と同様）

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
