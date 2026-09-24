# 進捗ステータス（非同期の朝会）

> このファイルが「今どこまで進んでいるか」の唯一の正。
> **セッション開始時に読む**、**セッション終了時に更新してコミット**すること。
> 判断・決定は書かない（それは `direction.md`）。API仕様は書かない（それは `api-contract.md`）。

最終更新: 2026-09-24 / kawase3（Bさん休暇中にM7の一部を先行実装。統合コンソール用に`console-proxy`を新設。frontend/を触った理由は下記Doing参照）
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
  - リンクに接続インターフェース名（例: `eth1↔eth2`）をラベル表示。deploy時に実際に割り当てる
    インターフェース番号と同じロジック（`assignInterfaces()`）を共有し、表示とdeploy結果が食い違わないようにした
  - エッジを直線・太め（`type: 'straight'`, 2px）に変更
  - ノードを右クリックすると「名前を変更」「削除」のコンテキストメニューが出るように
  - ダーク/ライトモード切り替えボタンを追加（`theme.css`でCSS変数化、localStorageに保存、
    OS設定の`prefers-color-scheme`にも初期値として追従）
  - `npx tsc --noEmit` / `npm run lint` / `npm run build` すべて確認済み。開発中のdevサーバーでHMR確認済み

**Next**
- Bさんの休み明けに、今回のfrontend/・backend/console-proxy/への変更をレビューしてもらう
- 残りのM7範囲（ラボ一覧のstart/stop/destroy操作、wipeボタンのUI化）を引き続き進める

**Blocked / 相手待ち**
- （なし）

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
