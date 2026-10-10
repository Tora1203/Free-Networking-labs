#!/usr/bin/env bash
# nginx を入れて Free-Networking-labs の入口として設定する（要sudo。冪等）。
# 使い方: bash backend/nginx/install.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OWNER="${SUDO_USER:-$USER}"

[ -f "$HERE/certs/cert.pem" ] || { echo "certs/cert.pem がありません。README.mdの手順で作成してください"; exit 1; }
[ -f "$REPO/frontend/dist/index.html" ] || { echo "frontend/dist がありません。先に (cd frontend && npm run build)"; exit 1; }

sudo apt-get install -y nginx
sudo install -d -m 0750 /etc/nginx/ssl/fnl
sudo install -m 0644 "$HERE/certs/cert.pem" /etc/nginx/ssl/fnl/cert.pem
sudo install -m 0600 "$HERE/certs/key.pem"  /etc/nginx/ssl/fnl/key.pem
sudo install -m 0644 "$HERE/fnl.conf" /etc/nginx/conf.d/fnl.conf
sudo rm -f /etc/nginx/sites-enabled/default      # 80番の既定サイトと競合するため
# 静的ファイルの置き場所は一度だけ自分の所有にして、以後のデプロイはsudo不要にする
sudo install -d -o "$OWNER" -g "$OWNER" /var/www/free-networking-labs
rsync -a --delete "$REPO/frontend/dist/" /var/www/free-networking-labs/
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
echo "OK: https://$(hostname)/ （または https://fnl.sotsuken.net/）"
