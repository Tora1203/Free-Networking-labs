# プロジェクト概要（Claude Code用コンテキスト）

このファイルはリポジトリ直下に置いてください。このディレクトリで`claude`を起動すると自動で読み込まれます。

## 何を作っているか

ContainerlabをバックエンドにしたOSS版CML(Cisco Modeling Labs)。CMLのようなGUI操作感
（ドラッグ&ドロップでのトポロジ編集、ブラウザ統合コンソール、ノードのライフサイクル管理）を
持ちながら、CML Freeの弱点だった「マルチユーザー非対応」「同時ノード数上限（5台）」を
持たないツールを目指す卒業制作。教員/学生のような役割分けや授業運営機能はスコープ外
（フラットなマルチユーザーでよい）。

## 確定している方針

- **対応ノードタイプ**：
  - ルーター＝FRR（vrnetlab等のVMラップが不要な軽量コンテナ）
  - L2スイッチ＝`ovs-bridge` kind（Open vSwitch。VLANタグ付け＝アクセス/トランクポートは`ovs-vsctl`の`tag`/`trunks`で対応可能）
  - PC/ホスト＝`linux` kind（Alpine等の軽量コンテナ）
  - L3スイッチは今回は見送り（FRR＋VLAN対応ブリッジの組み合わせで実現可能だが実装コストが高いため、将来の拡張候補）
- **外部ネットワークへのブリッジ接続（External Connector相当）は実装しない**（スコープ外）
- **認証はLinuxアカウンティング（clab-api-serverのPAM認証）をそのまま利用**。独自DB/自作認証は作らない
  - 各人に個別のLinuxアカウントを作成し`clab_api`/`clab_admins`グループに所属させる
  - clab-api-serverがラボを`$CLAB_LABS_ROOT/<username>/`にユーザーごとに自動分離・所有権管理する
- **フロントエンドはReact + React Flow (xyflow)（トポロジエディタ）+ xterm.js（統合コンソール）**
- **ホスティングは共有Linuxサーバー1台**（Proxmox VE上のVM「lab-server」、Ubuntu Server 24.04 LTS、メモリ12GB固定割当）

## アーキテクチャ

```
［ブラウザ：React + React Flow(トポロジ編集) / xterm.js(統合コンソール)］
        │  REST（ラボ操作）／WebSocket（ターミナル・状態更新）
        ▼
［clab-api-server：PAM認証（Linuxアカウント）でユーザー・ラボ所有権を管理］
        │
        ▼
［containerlab CLI］
        │
        ▼
［Docker：FRR / ovs-bridge / linuxコンテナ群］
```

## リポジトリ構成

```
repo/
├── CLAUDE.md          ← このファイル
├── backend/           ← clab-api-serverの設定、Containerlab関連スクリプト
├── frontend/          ← React + React Flow + xterm.jsアプリ
└── docs/              ← 設計メモ
    ├── direction.md      ← 決定事項の履歴（意思決定ログ）
    ├── overview.md       ← 背景・アーキテクチャの説明
    ├── STATUS.md         ← 進捗ステータス（毎セッション更新する朝会ノート）
    └── api-contract.md   ← BE↔FE のインターフェース定義
```

## 共同作業のルール（ドリフト防止）

kawase3（バックエンド）と Bさん（フロントエンド）が別クローンで同じ remote を触る。
両者の Claude Code がこの CLAUDE.md を自動読み込みするので、以下を毎回必ず実行する。

**セッション開始時**
1. `git switch main && git pull --rebase`
2. `docs/STATUS.md` を読み、自分の担当の Next と「相手待ち」を把握する

**セッション終了時**
1. `docs/STATUS.md` の自分の担当ブロックと最終更新行を更新する
2. 作業を feature ブランチにコミットして push する（WIP でも可）

**ブランチと変更の流し方**
- main へ直接コミットしない。`be/<topic>` / `fe/<topic>` ブランチを切る
- main へは PR 経由。相手（またはその Claude）が diff を見てからマージ
- 相手の担当ディレクトリ（`backend/` ⇄ `frontend/`）を触るときは、理由を STATUS.md に書いてから

**どこに何を書くか（混ぜない）**
- スコープ/技術の**決定** → `docs/direction.md` に日付つきで追記（ここだけ）
- **進捗・TODO・ブロッカー** → `docs/STATUS.md`
- **API の仕様・実レスポンス** → `docs/api-contract.md`（推測で埋めず、未確認は `TODO(担当)` と明記）

## 作業分担

- **バックエンド/インフラ担当（kawase3）**：サーバーへのDocker・Containerlab・clab-api-serverの
  セットアップと動作確認、Linuxアカウント分離の検証
- **フロントエンド担当（Bさん）**：ノードパレット（ルーター/L2スイッチ/PC）を含むReact Flowでの
  トポロジ描画、xterm.jsの疎通確認、clab-api-serverのSwagger UI / GitHub Pages上のAPI仕様書を
  見ながらのモック実装

## 差別化ポイント（卒論としての新規性）

Containerlab公式のGUIエコシステム（TopoViewer等）は既に存在するため、単純な「Web GUI化」だけでは
新規性が薄い。差別化は、CML相当の操作感（ノードのライフサイクル管理、統合コンソールの完成度）の
作り込みと、マルチユーザー・ノード数無制限というCML Freeにない性質に置く。

## まだ決まっていないこと

- 状態管理ライブラリ（Zustand/Reduxなど）
- 同時起動ノード数の上限を入れるか

## サーバー運用メモ

- サーバー上でClaude Codeを使う場合、各自が自分のLinuxアカウントと自分のAnthropicアカウントで
  ログインする（アカウントは共有しない）
- GitHub認証はSSH鍵方式（HTTPSパスワード認証は廃止済みのため）

## 詳しい経緯・比較検討

`docs/direction.md`（決定事項の履歴）と`docs/overview.md`（背景・アーキテクチャの説明）を参照。
