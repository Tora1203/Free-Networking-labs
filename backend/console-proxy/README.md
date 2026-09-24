# console-proxy

統合コンソール（xterm.js）用のWebSocket中継プロキシ。

## なぜ必要か

`clab-api-server`の統合コンソール用WebSocket（`GET /api/v1/terminal-sessions/{id}/stream`）は
`Authorization: Bearer <jwt>`ヘッダーでしか認証できません（ソースコード・実機で確認済み。
クエリパラメータ/Cookie等の代替手段は無い）。

一方、**ブラウザの`WebSocket` APIはハンドシェイク時にカスタムヘッダーを一切設定できません**。
つまりブラウザから`clab-api-server`のこのエンドポイントに直接繋ぐことはできません。

このプロキシがブラウザと`clab-api-server`の間に入り、ブラウザの代わりに
`Authorization`ヘッダー付きで`clab-api-server`へ接続することで、この制約を回避します。

詳しい経緯は `docs/direction.md`（2026-09-24追記）を参照してください。

## プロトコル

1. ブラウザは `ws://<proxy>/console?sessionId=<terminal session id>` に接続
2. 接続直後、**最初のメッセージ**として `{"token":"<jwt>"}` を送る
   （トークンをURLに含めないことで、アクセスログ等に残らないようにしている）
3. 以降はメッセージをそのまま双方向に中継するだけ（中身のJSON構造は解釈しない。
   実際のフレーム形式は `docs/api-contract.md` 2.5章を参照）

## 起動方法

```sh
npm install
CLAB_API_BASE_URL=https://localhost:8090 PROXY_PORT=8082 npm start
```

環境変数（省略時のデフォルトは`.env.example`参照）:
- `PROXY_PORT`: 待受ポート（デフォルト `8082`）
- `CLAB_API_BASE_URL`: `clab-api-server`のベースURL（デフォルト `https://localhost:8090`。
  自己署名証明書を許容する設定になっている）
