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
http://<capture-proxy>/capture/<jwt>/<clab-api-serverのパス（先頭/から）>
```

を開くと、`<clab-api-serverのパス>`部分をそのまま

```
https://<clab-api-server><そのパス>
```

にAuthorizationヘッダー付きで転送する（WebSocketアップグレードも同じパスパターンで中継、
RFBプロトコルの生バイナリフレームをそのまま双方向に流すだけでJSON等の解釈はしない）。

`GET /capture/wireshark-vnc-sessions/{sessionId}/ready`が返す`url`は
`/api/v1/capture/wireshark-vnc-sessions/<sessionId>/vnc/...`という**完全なパス**
（2026-10-08実機確認。`/vnc/{proxyPath}`配下の相対パスではなかった）なので、
フロントエンドはこの`url`をそのまま`<clab-api-serverのパス>`部分に埋め込むだけでよい。
このプロキシ自身はパスを組み立て直さず、渡されたパスをそのまま右から左に流すだけ。

**注意（2026-10-08時点、未確認）**：noVNC自身が生成するリンク/WebSocket接続先が、
この`/capture/<jwt>/`というパス配下に正しく収まるかは実機確認がまだ。
noVNCが絶対パス（`/`始まり、`/api/v1/...`を含まないもの）でアセットを参照している場合、
このプレフィックスが落ちてしまい404になる可能性がある。問題が出たら、相対パスへの書き換え
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
