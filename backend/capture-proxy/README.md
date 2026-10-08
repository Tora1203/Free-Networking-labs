# capture-proxy

パケットキャプチャ機能（WiresharkのnoVNCセッション）用のHTTP+WebSocket中継プロキシ。
`backend/console-proxy/`と同じ理由・同じ発想で立てている。

## なぜ必要か

clab-api-serverの`GET /api/v1/capture/wireshark-vnc-sessions/{sessionId}/vnc/{proxyPath}`
（noVNCのHTML/JS/CSS資産＋VNC用WebSocketを中継するエンドポイント）は
`Authorization: Bearer <jwt>`ヘッダーでしか認証できない（ソースコード確認済み。
clab-api-serverの`AuthMiddleware`はヘッダー以外の手段を一切持たない）。

一方、ブラウザが新しいタブ（`window.open()`）で開くページや、そこから発生する個々の
アセット読み込み・WebSocket接続は、カスタムヘッダーを一切設定できない。
→ ブラウザからは直接開けないため、この中継プロキシがヘッダーを付けて代わりに取得する。

## プロトコル

`console-proxy`（最初の1メッセージでトークンを送る方式）と違い、こちらは
**トークンをURLのパスに埋め込む**方式にしている。noVNCは複数のHTML/JS/CSSファイルを
素のGETで読みに行く通常のWebアプリであり、「最初の1メッセージでトークンを送る」ような
ハンドシェイクをフックできないため：

```
http://<capture-proxy>/capture/<sessionId>/<jwt>/<相対パス>
```

を開くと、`<相対パス>`部分を

```
https://<clab-api-server>/api/v1/capture/wireshark-vnc-sessions/<sessionId>/vnc/<相対パス>
```

にAuthorizationヘッダー付きで転送する（WebSocketアップグレードも同じパスパターンで中継、
RFBプロトコルの生バイナリフレームをそのまま双方向に流すだけでJSON等の解釈はしない）。

**注意（2026-10-08時点、未確認）**：noVNC自身が生成するリンク/WebSocket接続先が、
この`/capture/<sessionId>/<jwt>/`というパス配下に正しく収まるかは実機確認がまだ。
noVNCが絶対パス（`/`始まり）でアセットを参照している場合、このプレフィックスが
落ちてしまい404になる可能性がある。問題が出たら、相対パスへの書き換え
（HTMLレスポンスのbody rewriting等）が必要になるかもしれない。

## 起動方法

```sh
npm install
npm start
```

環境変数（`.env.example`参照）:
- `CAPTURE_PROXY_PORT`: 待受ポート（デフォルト `8084`）
- `CLAB_API_BASE_URL`: `clab-api-server`のベースURL（デフォルト `https://localhost:8090`）

## 常駐させる

`backend/console-proxy/README.md`と同じ理由で、`systemctl --user`でのuserサービス化を
推奨します。`capture-proxy.service.example`をコピーして使ってください。

## 前提

`backend/edgeshark/`でEdgeShark（ghostwire+packetflix）が起動していること。
