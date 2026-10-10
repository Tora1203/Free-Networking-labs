#!/usr/bin/env bash
# フロントを再ビルドしてnginxの配信先へ反映する（sudo不要）。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
(cd "$REPO/frontend" && npm run build)
rsync -a --delete "$REPO/frontend/dist/" /var/www/free-networking-labs/
echo "反映しました"
