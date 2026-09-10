# 進捗ステータス（非同期の朝会）

> このファイルが「今どこまで進んでいるか」の唯一の正。
> **セッション開始時に読む**、**セッション終了時に更新してコミット**すること。
> 判断・決定は書かない（それは `direction.md`）。API仕様は書かない（それは `api-contract.md`）。

最終更新: 2026-09-10 / kawase3（M1 完了：FRR 2ノード OSPF 疎通）

---

## 全体マイルストーン

- [x] M1: FRR 2ノードを CLI で deploy し疎通（BE） → `backend/labs/m1-frr-2node/`
- [ ] M2: FRR / ovs-bridge / linux の3種を1トポロジで疎通、VLAN 確認（BE）
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

**Doing**
- （なし）

**Next**
- M2: ホストに OVS ブリッジを作成、`ovs-bridge` kind + `linux` kind 2台（Alpine）で L2 疎通
- M2: `ovs-vsctl` の `tag` / `trunks` で VLAN アクセス/トランクを検証
- M2: FRR + ovs-bridge + linux を1トポロジに混在させて疎通

**Blocked / 相手待ち**
- （なし）

---

## Bさん（フロントエンド）

**Done**
- （未着手）

**Doing**
- （なし）

**Next**
- Vite + React プロジェクト雛形、React Flow 導入
- ノードパレット3種（ルーター/L2スイッチ/PC）
- `api-contract.md` を見ながらモックでラボ一覧・トポロジ表示

**Blocked / 相手待ち**
- 実 API 接続は M4（kawase3 が `api-contract.md` に実レスポンスを記録）待ち。
  それまではモックで先行して問題なし。

---

## 相談中・未決（決まったら direction.md へ移す）

- 状態管理ライブラリ（Zustand / Redux）→ FE がプロトタイプで判断
- 同時起動ノード数の上限を設けるか → サーバー実スペック確認とセット
