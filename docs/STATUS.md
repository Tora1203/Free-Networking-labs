# 進捗ステータス（非同期の朝会）

> このファイルが「今どこまで進んでいるか」の唯一の正。
> **セッション開始時に読む**、**セッション終了時に更新してコミット**すること。
> 判断・決定は書かない（それは `direction.md`）。API仕様は書かない（それは `api-contract.md`）。

最終更新: 2026-09-16 / Bさん（M5 進行中：ノードパレット3種のドラッグ&ドロップ実装、reports/削除対応）

---

## 全体マイルストーン

- [x] M1: FRR 2ノードを CLI で deploy し疎通（BE） → `backend/labs/m1-frr-2node/`
- [x] M2: FRR / ovs-bridge / linux の3種を1トポロジで疎通、VLAN 確認（BE） → `backend/labs/m2-ovs-l2-vlan/`
- [ ] M3: clab-api-server 導入・PAM 認証・所有権分離の確認（BE）
- [ ] M4: 実 API 挙動を `api-contract.md` に記録（BE → FE のブロッカー解除）
- [ ] M5: React + React Flow 雛形、3種ノードパレット、モックでラボ一覧/トポロジ表示（FE）
- [ ] M6: xterm.js をダミー WebSocket に接続して表示確認（FE）
- [ ] M7: FE のモックを実 API に接続（BE/FE 合流）

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

**Doing**
- （なし）

**Next**
- M3: clab-api-server 導入、PAM認証の疎通確認
- M3: 上記の「OVSブリッジ名のグローバル衝突」対策（ユーザー/ラボ名を含めた命名規則）を検討

**Blocked / 相手待ち**
- （なし）

---

## Bさん（フロントエンド）

**Done**
- Vite + React プロジェクト雛形、React Flow (@xyflow/react) 導入
- ノードパレット3種（ルーター/L2スイッチ/PC）のドラッグ&ドロップ実装
  （`components/NodePalette.tsx` → `components/TopologyEditor.tsx` にドロップしてノード追加。
  kind/image は `api-contract.md` 3章の対応表を `types/lab.ts` の `PALETTE_NODE_CONFIGS` に反映）
- `mocks/labs.ts` の owner を実在アカウント名から架空名（demo-user1/2）に変更
- `frontend/README.md` をVite雛形のままだったものからプロジェクト向けに更新
- `dev-tools/`（xterm.js疎通確認用の簡易WebSocketエコーサーバー）を追加。
  CLAUDE.mdのリポジトリ構成には未記載の新規ディレクトリ（バックエンド未接続でもコンソール表示を先行確認するため）

**Doing**
- （なし）

**Next**
- `api-contract.md` を見ながらモックでラボ一覧・トポロジ表示の続き（LabList実装済み、詳細は次回）

**Blocked / 相手待ち**
- 実 API 接続は M4（kawase3 が `api-contract.md` に実レスポンスを記録）待ち。
  それまではモックで先行して問題なし。
- **kawase3さんへ**：開発サーバーの origin は `http://localhost:5173`（Vite標準、http・ポート変更なし）。
  CORS設定をお願いします（`api-contract.md` 0章のTODO）。

---

## 相談中・未決（決まったら direction.md へ移す）

- 状態管理ライブラリ（Zustand / Redux）→ FE がプロトタイプで判断
- 同時起動ノード数の上限を設けるか → サーバー実スペック確認とセット
