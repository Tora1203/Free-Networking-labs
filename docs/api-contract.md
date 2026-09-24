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
| 2026-09-17 | Bさん | 3章: ovs-bridgeブリッジ名衝突対策の`TODO(Bさん)`を`toClabBridgeName()`実装で解消 |
| 2026-09-24 | kawase3 | 1章: ログイン失敗文言・トークンリフレッシュ無しを確認。2.4: wipe相当の操作を確定。2.6: events複数ユーザー分離を確認。3章: ovs-bridge命名規則を15文字制限の判明により改訂（ハッシュ方式に変更）、M7の一部（deploy送信ロジック）を先行実装 |
| 2026-09-24 | kawase3 | 2.5: ブラウザから統合コンソールWebSocketに直接接続できない問題を発見、`console-proxy`を追加して解消。実機で通し確認・M7の一部として先行実装 |

---

## 0. 基本情報

- clab-api-server バージョン: `v0.6.0`（内蔵 containerlab は `0.78.0` — ホストにCLIで入れている `0.79.0` とは**わずかにバージョンが異なる**点に注意。挙動差が出たら要疑い）
- ベース URL: `https://<server>:8090`（自己署名TLS。ブラウザ/curlで警告が出るのは正常。`TLS_AUTO_CERT`のデフォルト動作）
- インストール方法: 公式 `install.sh`（systemdサービス化、`/etc/clab-api-server/clab-api-server.env`で設定）
- `CLAB_LABS_ROOT=/var/lib/containerlab/labs` に設定済み。ユーザーごとに `.../labs/<username>/<labname>/` に分離される（OS権限も `drwxr-x---` でユーザー本人のみアクセス可、確認済み）
- 公式 Swagger UI: `https://<server>:8090/swagger/index.html`（Swagger JSON: `/swagger/doc.json`）
- CORS 設定: **設定済み（2026-09-17）**。`CORS_ALLOWED_ORIGINS=http://localhost:5173` を
  `/etc/clab-api-server/clab-api-server.env` に追記し再起動。実機確認済み（該当originからのpreflightが
  `204`、`Authorization`ヘッダーも許可）。開発サーバーのポートを変える場合はこの設定も追記が必要

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
  - 認証失敗時（実機確認済み・2026-09-24）: `401 {"error":"Invalid username or password"}`（存在しないユーザー名でも同じ文言。ユーザー存在有無を教えないタイプ）
- 以降のリクエストへのトークン付与方法: `Authorization: Bearer <jwt>` ヘッダー（未指定だと `401 {"error":"Authorization header required"}`）
- トークン有効期限: ログイン時の `sessionDuration`（デフォルト `24h`）。**リフレッシュ/ログアウト用エンドポイントは無い**（Swagger全パスを確認済み・2026-09-24）。
  期限が切れたら再度`POST /login`する以外の手段は無い → FE側はトークン期限切れ（`401`）を検知したらログイン画面に戻す実装が必要

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
  - **wipe相当（実機確認済み・2026-09-24）**: 明示的な`wipe`エンドポイントは無いが、
    `POST /api/v1/labs?reconfigure=true&nodeFilter=<ノード名>` に**同じ**`topologyContent`を渡すことで、
    指定ノードだけコンテナを破棄→再作成できる（`container_id`が変わり、コンテナ内の状態は消える。
    他ノードは触られない）。FEの「wipeボタン」はこの呼び出しで実現できる

### 2.5 統合コンソール（WebSocket / ターミナル）— **実機確認済み（2026-09-17）**
- 手順:
  1. `POST /api/v1/labs/{labName}/nodes/{nodeName}/terminal-sessions`
     - `{nodeName}`は**短いノード名ではなくコンテナのフルネーム**（例: `clab-m4-console-test-h1`）を渡す
     - ボディ: `{"protocol":"shell","cols":80,"rows":24}`（`protocol`は`ssh`/`shell`/`telnet`から選択。`shell`は`docker exec -it <container> <shell>`相当）
     - レスポンス: `{"sessionId":"...","state":"ready","expiresAt":"...", ...}`
  2. `GET /api/v1/terminal-sessions/{sessionId}/stream` にWebSocketで接続（`Authorization: Bearer <jwt>`ヘッダーをハンドシェイクに付与すればOK、実機で確認済み）
- **フレーム形式（全てWebSocketのテキストフレーム＝JSON）**:
  - 接続直後、サーバーから `{"type":"ready","sessionId":"...","protocol":"shell", ...}`
  - サーバー→クライアントの出力: `{"type":"output","data":"<base64>","encoding":"base64"}`
    **出力はbase64エンコードされている**（PTYの生バイト列のため）。xterm.js側でdecodeしてから`term.write()`する必要あり
  - クライアント→サーバーの入力: `{"type":"input","data":"echo hello\n"}`
    **こちらは平文（base64ではない）**。実機確認：送った文字列がそのままPTYに渡り、シェルのエコーが`output`フレームとして返ってきた
  - リサイズ: `{"type":"resize","cols":100,"rows":30}`
  - 明示終了: `{"type":"close"}`
- **1セッション1回だけ接続可能**：WS接続が切れる（クライアント側切断含む）と即座にセッションが終了扱いになり、再接続すると`410 Gone {"error":"terminal session has already exited"}`になる（実機確認）。再度使うには`terminal-sessions`を作り直す必要がある
- 代替手段（未検証・必要になったら確認）: `POST /api/v1/labs/{labName}/nodes/{nodeName}/ssh`（外部SSHクライアント用の一時アクセス情報を返すだけで、ブラウザ内ターミナルには使わない）、`sshx`/`gotty`系

- **⚠️ ブラウザから直接は接続できない（2026-09-24発見、要`console-proxy`経由）**：
  上記2.のWebSocket認証は`Authorization`ヘッダーのみ対応（ソースコード確認済み。クエリパラメータ/Cookie等は無い）。
  一方ブラウザの`WebSocket` APIはハンドシェイク時にカスタムヘッダーを設定できないため、直接は接続不可能。
  対策として`backend/console-proxy/`（Node.js中継プロキシ）を追加した。ブラウザ側のプロトコルは：
  1. `ws://<console-proxy>/console?sessionId=<terminal session id>` に接続
  2. 接続直後、**最初のメッセージ**として `{"token":"<jwt>"}` を送る（トークンをURLに含めない）
  3. 以降は上記のフレーム形式がそのまま中継されてくる
  詳細は`backend/console-proxy/README.md`・`docs/direction.md`（2026-09-24追記）参照。
  実機で認証込みの通し（トークン検証→シェル起動→入出力）を確認済み。

### 2.6 状態更新（ノード/リンクのライブ状態）— **実機確認済み（2026-09-17）**
- `GET /api/v1/events`（**WebSocketではなく、接続を張りっぱなしにするNDJSON応答**。`Content-Type: application/x-ndjson`、1行1JSON、クライアントが切断するまでサーバーは流し続ける）
  - クエリ: `?initialState=true`で接続直後に現在の状態のスナップショットも流す、`?interfaceStats=true`でインターフェースの送受信バイト数も流す
  - イベント例（ノードをstop→startした時に実際に流れたもの）:
    ```json
    {"timestamp":"2026-09-17T00:52:31.3133445Z","type":"container","action":"die","actor_name":"clab-m4-console-test-h1","attributes":{"clab-node-name":"h1","clab-owner":"clabtest1","containerlab":"m4-console-test","exitCode":"137", "...":"..."}}
    {"timestamp":"2026-09-17T00:52:33.6081165Z","type":"container","action":"start","actor_name":"clab-m4-console-test-h1","attributes":{"clab-node-name":"h1","clab-owner":"clabtest1","containerlab":"m4-console-test", "...":"..."}}
    ```
    `action`は`start`/`stop`/`kill`/`die`/`running`(snapshot)等、Dockerのイベント名に近い。`type: interface`のイベントも流れる（linkのup/down等）
  - **複数ユーザー間の分離を実機確認済み（2026-09-24）**：2アカウントで同時に接続し、片方のラボをstart/stopしても、
    もう片方のストリームには一切流れてこないことを確認（サーバー側でユーザーごとにフィルタリングされている）。
    FEはそのまま「自分がログイン中のユーザーのイベントだけ届く」前提で実装してよい
  - `GET /api/v1/labs/{labName}/topology/events`、`GET /api/v1/labs/workspace/events`という名前のエンドポイントも存在（おそらく特定ラボ/ワークスペースに絞ったイベント）→ 未検証

## 3. ノードタイプとトポロジ表現

FE のパレット3種と containerlab kind の対応:

| GUI 上の名前 | containerlab kind | image | 備考 |
|---|---|---|---|
| ルーター | `linux`（FRR イメージ、専用kindは無し・M1/M2で確認済み） | `quay.io/frrouting/frr:10.2.1` | daemons/frr.conf/vtysh.confを`binds`でマウント |
| L2スイッチ | `ovs-bridge` | （ホストの OVS） | VLAN: `ovs-vsctl set port ... tag=/trunks=`。**ブリッジ自動生成なし、事前に`ovs-vsctl add-br <ノード名>`が必要**（M2で確認）。ブリッジ名/インターフェース名はホスト全体でグローバル → 命名規則を決定済み（下記参照） |
| PC/ホスト | `linux` | `alpine:3.20` | |

- FE がトポロジを組んだ結果を、どの形式で BE に渡すか: **`POST /api/v1/labs`の`topologyContent`にJSONオブジェクトとして渡す**（2.2参照、確定）
- **ovs-bridgeのブリッジ名衝突対策（2026-09-24改訂、経緯は`docs/direction.md`）**：
  `ovs-bridge` kindのノードだけ、UI上の表示名とは別に、`POST /api/v1/labs`へ送るJSON内の実際のノード名を
  短いハッシュベースの名前に変換してから送信する。
  - ~~当初案（2026-09-16）：`<username>_<labname>_<UI上のノード名>`~~ → **実機検証でボツ**。
    **Linuxのネットワークインターフェース名は15文字までという制約（`IFNAMSIZ`）**があり、
    16文字以上を`ovs-vsctl add-br`に渡すと`Invalid argument`で失敗することを2026-09-24に実機確認。
    現実的な名前の組み合わせは簡単に15文字を超えるため、この方式は使えない
  - **採用方式**：`username/labName/nodeName`をFNV-1a(32bit)でハッシュ化し、`sw-`+8桁16進数
    （合計11文字、15文字制限に収まる）を実際のノード名として使う（例: `sw-bbb1067d`）。
    可読性は失うが、このプロジェクトの想定利用規模（数人×数ラボ）では衝突確率は無視できる
  - ルーター(`linux`+FRR)・PC(`linux`)のノードはこの変換は不要（コンテナ名はcontainerlabが
    `clab-<labname>-<nodename>`で自動的に一意化してくれるため。こちらは長さ制限の対象外）
  - → **実装・実機検証済み（2026-09-24）**：`frontend/src/utils/clabNaming.ts` の `toClabBridgeName()`。
    生成した`topologyContent`を実際に`POST /api/v1/labs`でdeployし、L2疎通まで確認した
    （`frontend/src/components/TopologyEditor.tsx`のDeployボタンから呼び出す形でM7の一部を先行実装）

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
