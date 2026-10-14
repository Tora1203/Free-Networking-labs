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
https://<capture-proxy>/capture/<jwt>/<clab-api-serverのパス（先頭/から）>
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

**実機確認済み（2026-10-08）**：noVNCのHTML/JS/CSS資産は想定通りこのパスプレフィックス越しに
正しく読み込めた（絶対パス参照による404は発生しなかった）。

**実機で発見・修正した不具合**：VNC用WebSocket（`/vnc/websockify`）がWireshark VNCコンテナ内の
nginx（`websockify_pass`ディレクティブ、ベースイメージ`jlesage/baseimage-gui`）に
`400 Bad Request`で拒否されていた。原因は`Sec-WebSocket-Protocol: binary`ヘッダーが
無かったこと（`ws`ライブラリは`protocols`引数を渡さない限りこれを自動で送らない）。
ブラウザ（noVNC）が送ってきた`Sec-WebSocket-Protocol`ヘッダーをそのまま上流への接続にも
伝えるように修正して解決（`server.js`の`requestedProtocol`参照）。

## タブの見分け方（`?label=`）

`window.open()`で複数のキャプチャを別タブで開くと、タブタイトルが汎用的（"noVNC"等）で
どのリンク/インターフェースのキャプチャか見分けがつかない、という指摘（2026-10-08）に対応。
URLに`?label=<表示したい文字列>`を付けると、上流から返ってきたHTMLの`<title>`タグを
その場で書き換える（レスポンスボディをバッファして文字列置換→`Content-Length`再計算）。
フロントエンド（`captureClient.ts`）は「R1(eth1) ↔ SW1」のような、ノードの短縮表示名＋
インターフェース名＋相手ノード名の形式でラベルを組み立てて渡している。

**実機で発見・修正した不具合（2026-10-09）**：単に`<title>`タグを書き換えるだけでは
反映されなかった。原因は、ベースイメージ（`jlesage/baseimage-gui`）のnoVNCアプリが
ページ読み込み後にJSで`document.title`を`APP_NAME`（"Wireshark"）に上書きしてしまうため。
対応：`setInterval`で定期的に`document.title`を強制的に書き戻すスクリプトを
HTMLレスポンスに埋め込むように修正（`injectTitle()`参照）。

## クリップボード同期（HTTPS化、2026-10-09）

当初は平文HTTPだったが、「noVNC画面とのコピペが面倒」という指摘を受けてHTTPS化した。
理由：noVNC（`jlesage/baseimage-gui`ベース）には、ブラウザのClipboard APIを使った
「ホストクリップボード自動同期」機能が標準で入っている（`UI.webData.hostClipboardSync`、
`RFB.isClipboardAutoSyncSupported()`）。Wireshark側でテキストをコピーすると自動的に
ブラウザ（OS）側のクリップボードに反映され、普通にCtrl+Vで貼り付けられるようになる。

ただし、Clipboard APIの非同期read/writeは「secure context」（HTTPS、またはlocalhost）
でないと動かない仕様のため、capture-proxyが平文HTTPのままだと自動同期機能自体が
有効化されなかった。`certs/`に自己署名証明書を生成し、`https.createServer`で
待ち受けるように変更して解決（自己署名のため初回アクセス時はブラウザの警告が出る）。

この機能が無効・使えない場合でも、noVNCのサイドバー（画面左端の矢印タブ）に
手動のクリップボードテキストエリアがあり、そちら経由でもコピペは可能
（Wireshark側で右クリック→Copy→任意の形式を選ぶ→サイドバーのテキストエリアに
反映→そこから選択してCtrl+Cすればブラウザのクリップボードに入る、という手順）。

## 起動方法

```sh
npm install
# 初回のみ：自己署名証明書を生成（certs/はリポジトリに含めない）
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem \
  -days 825 -nodes -subj "/CN=capture-proxy" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
npm start
```

環境変数（`.env.example`参照）:
- `CAPTURE_PROXY_PORT`: 待受ポート（デフォルト `8084`）
- `CLAB_API_BASE_URL`: `clab-api-server`のベースURL（デフォルト `https://localhost:8090`）
- `CAPTURE_PROXY_TLS_CERT` / `CAPTURE_PROXY_TLS_KEY`: TLS証明書/秘密鍵のパス
  （デフォルト `certs/cert.pem` / `certs/key.pem`）

## 常駐させる

`backend/console-proxy/README.md`と同じ理由で、`systemctl --user`でのuserサービス化を
推奨します。`capture-proxy.service.example`をコピーして使ってください。

## 前提

- `backend/edgeshark/`でEdgeShark（ghostwire+packetflix）が起動していること。
- `docker pull ghcr.io/srl-labs/wireshark-vnc-docker:latest`を事前に実行してイメージを
  キャッシュしておくこと。clab-api-serverのセッション作成APIは45秒の固定タイムアウトを
  持つため、初回pull（イメージが無い状態）だとそれより時間がかかって`signal: killed`で
  失敗することがある（2026-10-08実機確認）。
