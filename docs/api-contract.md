# API コントラクト（BE ↔ FE インターフェース）

> フロントは**このドキュメントに対してモック実装**する。バックエンドは**このドキュメントどおりに実装/確認**する。
> clab-api-server の公式仕様（Swagger UI / GitHub Pages）が一次情報。
> ここには「このプロジェクトで実際に使うエンドポイント」と「実際に叩いて確認したレスポンス実例」だけを書く。
> **推測で埋めない。未確認の項目は `TODO(kawase3)` / `TODO(Bさん)` と明記する。**

## 変更履歴

| 日付 | 変更者 | 内容 |
|---|---|---|
| 2026-09-10 | kawase3 | 初版（骨組みのみ。実挙動は M3/M4 で追記） |

---

## 0. 基本情報

- clab-api-server バージョン: `TODO(kawase3)`（導入時に記入）
- ベース URL: `TODO(kawase3)`（例: `https://lab-server:8090`）
- 公式 Swagger UI: `https://<server>:8090/swagger/index.html`
- 公式 API 仕様書（GitHub Pages）: `TODO` リンクを貼る
- CORS 設定: `TODO(kawase3)`（フロントの開発サーバー origin を許可する必要あり）

## 1. 認証

- 方式: PAM（Linux アカウント）
- ログイン: `POST /login`（`TODO(kawase3)`: 実際のパス・ボディ・レスポンスを確認）
  - リクエスト例: `TODO`
  - レスポンス例（実物を貼る）: `TODO`
- 以降のリクエストへのトークン付与方法: `TODO(kawase3)`（例: `Authorization: Bearer <jwt>`）
- トークン有効期限 / リフレッシュ: `TODO(kawase3)`

## 2. このプロジェクトで使うエンドポイント

> 各項目、確認できたら「実レスポンス JSON」を fenced code block で貼る。

### 2.1 ラボ一覧
- `GET /api/v1/labs`（仮パス。`TODO(kawase3)` 確認）
- 用途: FE のラボ一覧画面
- 所有権: 自分のラボだけ返るか？ → `TODO(kawase3)` で検証
- レスポンス実例: `TODO`

### 2.2 ラボ deploy
- `POST ...`（`TODO`）
- ボディ: containerlab トポロジ YAML? JSON? → `TODO(kawase3)`
- レスポンス実例: `TODO`

### 2.3 ラボ destroy / 削除
- `TODO`

### 2.4 ノードのライフサイクル操作（start / stop / restart / wipe）
- `TODO(kawase3)`: clab-api-server が個別ノード操作 API を持つか確認。
  無ければ「トポロジ再 deploy」or「exec 経由」で代替する方針を direction.md に記録。

### 2.5 統合コンソール（WebSocket）
- ノードへの exec / attach 用 WebSocket エンドポイント: `TODO(kawase3)`
- プロトコル（入力/出力のフレーム形式、リサイズ通知など）: `TODO(kawase3)`
- xterm.js 側の期待: バイナリ or テキスト、`{cols, rows}` リサイズメッセージの形式

### 2.6 状態更新（ノード/リンクのライブ状態）
- ポーリング（`GET /labs` を定期取得）か WebSocket push か: `TODO(kawase3)`

## 3. ノードタイプとトポロジ表現

FE のパレット3種と containerlab kind の対応:

| GUI 上の名前 | containerlab kind | image | 備考 |
|---|---|---|---|
| ルーター | `linux`（FRR イメージ）※要確認 | `quay.io/frrouting/frr:TODO` | `TODO(kawase3)`: 0.79 に `frr` 専用 kind があるか確認 |
| L2スイッチ | `ovs-bridge` | （ホストの OVS） | VLAN: `ovs-vsctl set port ... tag=/trunks=` |
| PC/ホスト | `linux` | `alpine:TODO` | |

- FE がトポロジを組んだ結果を、どの形式で BE に渡すか（clab YAML を FE が生成 / BE が生成）: `TODO` で決めて direction.md に記録

## 4. エラー形式

- HTTP ステータスの使い分け、エラーボディの JSON 形状: `TODO(kawase3)`
