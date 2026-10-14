# EdgeShark（パケットキャプチャ機能の前提サービス）

clab-api-serverにはパケットキャプチャAPI（`POST /api/v1/labs/{labName}/capture/wireshark-vnc-sessions`
でブラウザにWireshark GUIをnoVNC経由で表示、`POST /api/v1/labs/{labName}/capture/packetflix`で
ローカルのWiresharkと連携）が実装済みだが、裏で実際にパケットをキャプチャする
[Siemens EdgeShark](https://github.com/siemens/edgeshark)（`ghostwire`＋`packetflix`の2コンテナ構成）
が別途動いていないと`503 EdgeShark not running`になる（2026-10-08確認）。

## なぜこの構成が必要か

- **ghostwire**：ホスト上の全コンテナのネットワーク名前空間を発見・可視化するデーモン
- **edgeshark（packetflix）**：ghostwireの情報を使って、指定インターフェースのパケットを
  WebSocket経由でストリーミングするサービス。clab-api-serverはこの`packetflix`サービス
  （デフォルトポート5001、`http://127.0.0.1:5001`）とだけ通信する

clab-api-server側はデフォルト設定（`CAPTURE_PACKETFLIX_PORT=5001`）がEdgeShark公式の
デフォルトポートと一致しているため、**clab-api-server側の設定変更は不要**
（`CAPTURE_WIRESHARK_DOCKER_IMAGE`等、他のcapture関連env varもデフォルトのままで動く想定。
`srl-labs/clab-api-server`の`internal/config/config.go`で確認）。

## 権限について（要確認・要許容）

`ghostwire`/`edgeshark`コンテナは、ホスト上の**全コンテナ**のネットワーク名前空間を
覗き見る必要があるため、他のラボ用コンテナ（PC/ルーター等、今回`privileged:false`に
絞り込んだもの）とは別次元の、意図的に広い権限で動く：

- `pid: host`（ホストの全プロセスが見える）
- `cap_add: CAP_SYS_ADMIN, CAP_SYS_PTRACE, CAP_SYS_CHROOT, CAP_DAC_READ_SEARCH,
  CAP_DAC_OVERRIDE, CAP_NET_ADMIN, CAP_NET_RAW`
- `security_opt: apparmor:unconfined`

ただし`--privileged`そのものではなく、具体的に列挙された権限のみ（`cap_drop: ALL`で
一度全部落としてから必要な分だけ`cap_add`）＋非root（uid 65534）＋読み取り専用rootfsで動く
よう公式docker-compose自体が設計されている。これは「管理者が運用するホスト側の
可視化・計測インフラ」であり、学生が触る対象（PC/ルーターコンテナ）とは明確に別物
という位置づけ（学生のラボコンテナの権限を絞る作業とは矛盾しない）。

## セットアップ

```sh
cd backend/edgeshark
docker compose up -d
```

`labuser`が`docker`グループに入っていれば**sudoは不要**（dockerグループ自体がroot相当の
権限を持つため。2026-10-08実機確認：sudoなしで起動できた）。

- 確認: `curl http://127.0.0.1:5001/version` → `{"name":"packetflix","version":"..."}`
- `restart: unless-stopped`が設定されているため、`docker`サービス自体が自動起動する限り
  （既に`enabled`、docs/STATUS.md参照）ホスト再起動後も自動で立ち上がる

## 更新・停止

```sh
cd backend/edgeshark
docker compose pull && docker compose up -d   # 更新
docker compose down                           # 停止・削除
```

## 未確認・次回やること

- clab-api-serverの実際の`POST /capture/wireshark-vnc-sessions`
  エンドポイントを、実際にログインしたユーザーのJWTで叩いて動作確認する
  （このセットアップ作業はJWTを持たない状態で行ったため、EdgeShark自体の起動・
  packetflixの応答までは確認したが、clab-api-server経由の実際のキャプチャフローは未確認）
- フロントエンド側のUI実装（ノード/リンクを右クリックしてキャプチャを開始するボタン等）
