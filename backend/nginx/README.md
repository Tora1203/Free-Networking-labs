# nginx（入口・単一オリジン化）

ブラウザからの入口を nginx 1つ（443/HTTPS）にまとめ、フロントの静的ファイル配信と
各サービスへのリバースプロキシを担う。決定の経緯は `docs/direction.md`（2026-10-10）、
比較は `docs/backlog.md` C-1。

| パス | 中継先 |
| --- | --- |
| `/login`, `/api/` | clab-api-server (127.0.0.1:8090, HTTPS自己署名) |
| `/console` | console-proxy (8082, WebSocket) |
| `/ovs/` | ovs-helper (8083、先頭の`/ovs`を除去) |
| `/capture/` | capture-proxy (8084, HTTPS自己署名) |
| `/` | `/var/www/free-networking-labs`（`vite build`の出力、SPA） |

同一オリジンになるので **CORS設定は不要**（上流へ渡す`Origin`は空にしている）、
証明書の警告も `https://fnl.sotsuken.net/` の1回で済む。

## 初回セットアップ

```sh
# 1. 自己署名証明書（certs/はgitignore対象）
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem -days 825 -nodes \
  -subj "/CN=fnl.sotsuken.net" \
  -addext "subjectAltName=DNS:fnl.sotsuken.net,DNS:fnl,DNS:localhost,IP:10.0.200.50,IP:127.0.0.1"

# 2. フロントを本番ビルド（frontend/.env.production が相対パスの接続先を指定している）
(cd ../../frontend && npm run build)

# 3. nginx導入・設定・起動（要sudo、冪等）
bash install.sh
```

## フロントを更新したとき（sudo不要）

```sh
bash deploy-frontend.sh
```

## 注意

- nginxのバックエンド（8082/8083/8084/8090）は、今まで通りホスト上で動かしておくこと。
  これらを外部に直接公開する必要はなくなったので、将来はファイアウォールで閉じられる。
- 開発時は従来どおり `vite dev`（5173、`frontend/.env`）で作業できる。
