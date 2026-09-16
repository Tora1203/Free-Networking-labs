# API コントラクト（BE ↔ FE インターフェース）

> フロントは**このドキュメントに対してモック実装**する。バックエンドは**このドキュメントどおりに実装/確認**する。
> clab-api-server の公式仕様（Swagger UI / GitHub Pages）が一次情報。
> ここには「このプロジェクトで実際に使うエンドポイント」と「実際に叩いて確認したレスポンス実例」だけを書く。
> **推測で埋めない。未確認の項目は `TODO(kawase3)` / `TODO(Bさん)` と明記する。**

## 変更履歴

| 日付 | 変更者 | 内容 |
|---|---|---|
| 2026-09-10 | kawase3 | 初版（骨組みのみ。実挙動は M3/M4 で追記） |
| 2026-09-14 | kawase3 | M3: clab-api-server 導入。認証・所有権分離・エラー形式・主要エンドポイントを実機確認して記入 |

---

## 0. 基本情報

- clab-api-server バージョン: `v0.6.0`（内蔵 containerlab は `0.78.0` — ホストにCLIで入れている `0.79.0` とは**わずかにバージョンが異なる**点に注意。挙動差が出たら要疑い）
- ベース URL: `https://<server>:8090`（自己署名TLS。ブラウザ/curlで警告が出るのは正常。`TLS_AUTO_CERT`のデフォルト動作）
- インストール方法: 公式 `install.sh`（systemdサービス化、`/etc/clab-api-server/clab-api-server.env`で設定）
- `CLAB_LABS_ROOT=/var/lib/containerlab/labs` に設定済み。ユーザーごとに `.../labs/<username>/<labname>/` に分離される（OS権限も `drwxr-x---` でユーザー本人のみアクセス可、確認済み）
- 公式 Swagger UI: `https://<server>:8090/swagger/index.html`（Swagger JSON: `/swagger/doc.json`）
- CORS 設定: **デフォルトでは他オリジンからのアクセスは拒否される**（未設定状態でpreflightに`403`を確認）。
  環境変数 `CORS_ALLOWED_ORIGINS`（カンマ区切り）に FE の開発サーバー origin を追加する必要あり。
  → `TODO(kawase3)`: Bさんの開発サーバーの実際の origin が決まり次第、`/etc/clab-api-server/clab-api-server.env` に追記して再起動

## 1. 認証

- 方式: PAM（Linux アカウント）。`clab_api` グループ所属で一般ユーザーとしてログイン可、`clab_admins` 所属だと全ユーザーのラボを横断操作できる管理者(superuser)になる（実機確認: 非管理者が管理者専用エンドポイントを叩くと `403 {"error":"Superuser privileges required for this operation"}`）
- ログイン: `POST /login`
  - リクエスト例:
    ```json
    { "username": "clabtest1", "password": "********", "sessionDuration": "24h" }
    ```
    （`sessionDuration`は省略可、省略時デフォルト`24h`）
  - レスポンス例（実物、構造のみ・値は例示):
    ```json
    { "token": "<JWT>" }
    ```
    JWTのペイロードは `{"username": "...", "sub": "...", "exp": ..., "iat": ...}`
  - 認証失敗時: `401 {"error":"..."}`（`TODO`: 実際の文言はPAM側のエラーに依存、要再確認）
- 以降のリクエストへのトークン付与方法: `Authorization: Bearer <jwt>` ヘッダー（未指定だと `401 {"error":"Authorization header required"}`）
- トークン有効期限: ログイン時の `sessionDuration`（デフォルト `24h`）。リフレッシュ用エンドポイントは今回のパス一覧には見当たらず → `TODO`: 再ログイン以外の手段があるか要確認

## 2. このプロジェクトで使うエンドポイント

> 各項目、確認できたら「実レスポンス JSON」を fenced code block で貼る。

### 2.1 ラボ一覧
- `GET /api/v1/labs`（**確定パス**、実機確認済み）
- 用途: FE のラボ一覧画面
- 所有権: **自分のラボだけ返る**（実機確認済み。他人のラボは一覧にも出ない。`GET /api/v1/labs/{labName}`で名指ししても`404`）
- レスポンス実例（ノード1台のラボ）:
  ```json
  {
    "iso-test-1": [
      {
        "name": "clab-iso-test-1-h1",
        "container_id": "87ca2c72b0b6",
        "image": "alpine:3.20",
        "kind": "linux",
        "state": "running",
        "status": "Up 10 seconds",
        "ipv4_address": "172.20.20.2/24",
        "ipv6_address": "3fff:172:20:20::2/64",
        "lab_name": "iso-test-1",
        "nodeName": "h1",
        "labPath": "/var/lib/containerlab/labs/clabtest1/iso-test-1/iso-test-1.clab.yml",
        "absLabPath": "/var/lib/containerlab/labs/clabtest1/iso-test-1/iso-test-1.clab.yml",
        "group": "",
        "owner": "clabtest1"
      }
    ]
  }
  ```
  ラボが無い場合は `{}`。

### 2.2 ラボ deploy
- `POST /api/v1/labs`（**確定パス**、実機確認済み）
- ボディ: containerlab トポロジを**YAMLではなくJSONオブジェクトとして** `topologyContent` に入れる（`topologySourceUrl`で外部URL指定も可、両方同時指定は不可）:
  ```json
  {
    "topologyContent": {
      "name": "iso-test-1",
      "topology": {
        "kinds": { "linux": { "image": "alpine:3.20" } },
        "nodes": { "h1": { "kind": "linux" } }
      }
    }
  }
  ```
  → FE側は「clab YAMLのキー構造と1:1のJSON」を組み立てて渡す設計でよい（YAML文字列に変換する必要はない）
- クエリパラメータ: `reconfigure`（自分所有のラボの上書き再deployを許可）、`maxWorkers`、`nodeFilter` 等（詳細はSwagger参照）
- レスポンス実例: 2.1と同形式（`ClabInspectOutput`、deployされたノード一覧）

### 2.3 ラボ destroy / 削除
- `DELETE /api/v1/labs/{labName}`（**確定パス**、実機確認済み）。クエリ `?cleanup=true` でラボディレクトリも削除
- レスポンス実例: `{"message":"Lab 'iso-test-1' destroyed successfully"}`
- 他人のラボ名を指定すると `404 {"error":"lab '...' not found or not owned by user"}`（存在の有無を教えないタイプのエラー）

### 2.4 ノードのライフサイクル操作（start / stop / restart / wipe）
- **確認できた: 個別ノード操作APIが存在する**（想定していた「トポロジ再deployで代替」は不要）
  - `POST /api/v1/labs/{labName}/nodes/{nodeName}/start`
  - `POST /api/v1/labs/{labName}/nodes/{nodeName}/stop`
  - `POST /api/v1/labs/{labName}/nodes/{nodeName}/restart`
  - `POST /api/v1/labs/{labName}/nodes/{nodeName}/pause` / `/unpause`
  - ラボ全体: `POST /api/v1/labs/{labName}/start` / `/stop` / `/restart`
  - wipe相当: 明示的な`wipe`エンドポイントは無し。`DELETE .../topology/file`や`PUT .../topology/yaml`で構成を変えてから`?reconfigure=true`でdeployし直す形になりそう → `TODO(kawase3)`: 実際に「設定初期化」に近い操作を試して確定

### 2.5 統合コンソール（WebSocket / ターミナル）
- 想定より機能が多い。関連エンドポイント（**パスは確認済み、プロトコル詳細は未検証・M6でのTODO**）:
  - `POST /api/v1/labs/{labName}/nodes/{nodeName}/terminal-sessions` → セッション作成
  - `GET /api/v1/terminal-sessions/{sessionId}/stream` → おそらくこれがWebSocket/SSEのストリーム本体
  - `POST /api/v1/labs/{labName}/nodes/{nodeName}/ssh`、`POST /api/v1/labs/{labName}/sshx/{action}`、`POST /api/v1/labs/{labName}/gotty/{action}` など、SSH/gotty経由の代替手段も複数用意されている
- プロトコル（フレーム形式、`{cols,rows}`リサイズ通知など）: `TODO(kawase3)`（M6でxterm.js接続時に実機で確認）

### 2.6 状態更新（ノード/リンクのライブ状態）
- `GET /api/v1/events`、`GET /api/v1/labs/{labName}/topology/events`、`GET /api/v1/labs/workspace/events` という名前のエンドポイントが存在（SSE/WebSocketでのpush型と推測）→ `TODO(kawase3)`: 実際にpushされるイベント形式をM6手前で確認。無ければ`GET /labs`のポーリングにフォールバック

## 3. ノードタイプとトポロジ表現

FE のパレット3種と containerlab kind の対応:

| GUI 上の名前 | containerlab kind | image | 備考 |
|---|---|---|---|
| ルーター | `linux`（FRR イメージ、専用kindは無し・M1/M2で確認済み） | `quay.io/frrouting/frr:10.2.1` | daemons/frr.conf/vtysh.confを`binds`でマウント |
| L2スイッチ | `ovs-bridge` | （ホストの OVS） | VLAN: `ovs-vsctl set port ... tag=/trunks=`。**ブリッジ自動生成なし、事前に`ovs-vsctl add-br <ノード名>`が必要**（M2で確認）。ブリッジ名/インターフェース名はホスト全体でグローバル → 命名規則を決定済み（下記参照） |
| PC/ホスト | `linux` | `alpine:3.20` | |

- FE がトポロジを組んだ結果を、どの形式で BE に渡すか: **`POST /api/v1/labs`の`topologyContent`にJSONオブジェクトとして渡す**（2.2参照、確定）
- **ovs-bridgeのブリッジ名衝突対策（2026-09-16 決定、詳細は`docs/direction.md`）**：
  `ovs-bridge` kindのノードだけ、UI上の表示名とは別に、`POST /api/v1/labs`へ送るJSON内の実際のノード名を
  `<username>_<labname>_<UI上のノード名>` に変換してから送信する（例: ユーザー`alice`がラボ`lab1`で
  `sw1`という名前のL2スイッチを置いたら、実際に送るノード名は`alice_lab1_sw1`）。
  ユーザー名はLinuxアカウント単位で一意なので、これで複数ユーザー間のブリッジ名衝突を防げる。
  ルーター(`linux`+FRR)・PC(`linux`)のノードはこの変換は不要（コンテナ名はcontainerlabが
  `clab-<labname>-<nodename>`で自動的に一意化してくれるため）。
  → `TODO(Bさん)`: このリネーム処理をFEのdeploy送信ロジックに実装

## 4. エラー形式

- エラーボディは共通で `{"error": "<メッセージ>"}` 形状（実機確認済み、401/403/404すべて同じ形）
- 確認できたステータスコード:
  | ステータス | 状況 | メッセージ例 |
  |---|---|---|
  | 401 | `Authorization`ヘッダー無し | `Authorization header required` |
  | 401 | ログイン失敗 | `TODO(kawase3)`: 実際の文言を再確認 |
  | 403 | 非管理者が管理者専用APIを叩いた | `Superuser privileges required for this operation` |
  | 404 | 他人のラボ/存在しないラボを指定 | `lab '<name>' not found or not owned by user` |
  | 200 | 正常時のdestroy等 | `{"message": "..."}`（エラーとは別形状） |
