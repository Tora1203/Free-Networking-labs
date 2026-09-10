# プロジェクト概要（Claude Code用コンテキスト）

このファイルはリポジトリ直下に置いてください。このディレクトリで`claude`を起動すると自動で読み込まれます。

## 何を作っているか

ContainerlabをバックエンドにしたOSS版CML(Cisco Modeling Labs)。CMLのようなGUI操作感
（ドラッグ&ドロップでのトポロジ編集、ブラウザ統合コンソール、ノードのライフサイクル管理）を
持ちながら、CML Freeの弱点だった「マルチユーザー非対応」「同時ノード数上限（5台）」を
持たないツールを目指す卒業制作。教員/学生のような役割分けや授業運営機能はスコープ外
（フラットなマルチユーザーでよい）。

## 確定している方針

- **対応ネットワークOSはFRRのみ**（vrnetlab等のVMラップが不要な軽量コンテナで、共有サーバー上での
  リソース消費を抑えるため）
- **外部ネットワークへのブリッジ接続（External Connector相当）は実装しない**（スコープ外）
- **認証はLinuxアカウンティング（clab-api-serverのPAM認証）をそのまま利用**。独自DB/自作認証は作らない
  - 各人に個別のLinuxアカウントを作成し`clab_api`/`clab_admins`グループに所属させる
  - clab-api-serverがラボを`$CLAB_LABS_ROOT/<username>/`にユーザーごとに自動分離・所有権管理する
- **フロントエンドはReact + React Flow (xyflow)（トポロジエディタ）+ xterm.js（統合コンソール）**
- **ホスティングは共有Linuxサーバー1台**（Proxmox VE上のVM、Ubuntu Server 24.04 LTS、メモリ12GB固定割当）

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
［Docker：FRRコンテナ群］
```

## リポジトリ構成

```
repo/
├── CLAUDE.md          ← このファイル
├── backend/           ← clab-api-serverの設定、Containerlab関連スクリプト
├── frontend/          ← React + React Flow + xterm.jsアプリ
└── docs/              ← 設計メモ（direction.md, overview.md）
```

## 作業分担

- **バックエンド/インフラ担当（kawase3）**：サーバーへのDocker・Containerlab・FRR・clab-api-serverの
  セットアップと動作確認、Linuxアカウント分離の検証
- **フロントエンド担当**：React Flowでのトポロジ描画、xterm.jsの疎通確認、clab-api-serverの
  Swagger UI / GitHub Pages上のAPI仕様書を見ながらのモック実装

## 差別化ポイント（卒論としての新規性）

Containerlab公式のGUIエコシステム（TopoViewer等）は既に存在するため、単純な「Web GUI化」だけでは
新規性が薄い。差別化は、CML相当の操作感（ノードのライフサイクル管理、統合コンソールの完成度）の
作り込みと、マルチユーザー・ノード数無制限というCML Freeにない性質に置く。

## まだ決まっていないこと

- 状態管理ライブラリ（Zustand/Reduxなど）
- 同時起動ノード数の上限を入れるか

## 詳しい経緯・比較検討

`docs/direction.md`（決定事項の履歴）と`docs/overview.md`（背景・アーキテクチャの説明）を参照。
