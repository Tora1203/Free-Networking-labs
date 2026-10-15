# セキュリティの点検（2026-10-15）

限定公開・授業での利用（40人程度）を前に、サーバー（lab-server、10.0.200.50）とアプリの守りを点検した結果。
**済**はリポジトリと本番に反映済み。**要対応**は管理者が`sudo`で行う作業（手順は下の「管理者の作業」）。

## 前提（利用者に許していること）

- 利用者はブラウザから`https://<サーバー>/`だけを使う。入口はnginx（443）で、その奥の各サービスには
  nginx経由でしか届かないようにする。
- 利用者はclab-api-serverのAPIを自分のトークンで直接呼べる（ブラウザの開発者ツール等）。そのため
  「画面に出していない操作」も、APIで許されている範囲ならできる前提で考える。
  - 自分のラボのノードでは任意のコマンドを実行できる（`exec` API）。ノードは特権なしのコンテナで、
    DockerのAppArmor（docker-default）とseccompが効いている。ルーターだけはFRRの起動にSYS_ADMINが要る（`frontend/src/utils/labTopology.ts`）。
  - 他人のラボ・ノードは、ラボの一覧・exec・netem・キャプチャのどれもAPIが所有者で絞っている（ソースで確認）。

## 点検の結果

| # | 内容 | 危険度 | 状態 |
|---|---|---|---|
| 1 | 8082（console-proxy）・8083（ovs-helper）・8084（capture-proxy）がLANに直接開いていた | 中 | **済**：127.0.0.1だけで待ち受ける（`LISTEN_HOST`） |
| 2 | 8090（clab-api-server）がLANに直接開いている（待ち受け先を選ぶ設定が無い） | 中 | **要対応**：ufwで22/80/443以外を閉じる |
| 3 | ovs-helperの古い窓口（`/bridge`・`/port/reset`・`/vlan`）が残っていた。ログインしていれば誰でも、名前さえ分かれば他人のvethを消せた | 中 | **済**：削除。sudoersの`ovs-helper-link-delete`は**要対応**（削除） |
| 4 | ovs-helperのCORSが「設定が空なら全オリジン許可」だった | 低 | **済**：空なら付けない（本番は同じオリジン） |
| 5 | ovs-helperがトークンの確認で「401以外なら有効」としていた（APIの不調でも通る） | 低 | **済**：200の時だけ |
| 6 | capture-proxyのログに、URLに埋め込んだトークン（24時間有効）がそのまま残っていた | 中 | **済**：伏せる。nginxのアクセスログ（root/admだけが読める）には残る |
| 7 | capture-proxyがキャプチャ以外のAPIのパスも中継していた | 低 | **済**：noVNCのパスだけ |
| 8 | `/login`に回数制限が無く、パスワードの総当たりができた | 中 | リポジトリは**済**（同じIPから1分に30回、まとめて40回まで）。本番のnginxへの反映が**要対応** |
| 9 | 利用者のLinuxアカウント（labuser2・proxytest1）のシェルが`/bin/sh`で、SSHでサーバーに入れる | 高 | **要対応**：利用者のグループをSSHで拒否する |
| 10 | labuser2がdockerグループに入っている（dockerグループ＝サーバーのroot相当） | 高 | **要対応**：利用者をdockerグループに入れない |
| 11 | labuser2がclab_admins（clab-api-serverの管理者）に入っている。管理者は他人のラボを操作でき、ホストにveth・VxLANを作れる | 高 | **要対応**：利用者はclab_apiだけに入れる |
| 12 | 別のユーザーと同じ名前のラボを作れて、後から起動した方が起動できなかった | 中（可用性） | **済**：PR #24（新しいラボのIDにユーザー名を付ける） |
| 13 | HTTPSの証明書が自己署名で、初回に警告が出る | 低 | 据え置き（学内のLANだけで使うため） |
| 14 | キャプチャのセッションが、使用中でも作ってから2時間で消える（clab-api-serverの既定のTTL） | 低（使い勝手） | 据え置き（`CAPTURE_WIRESHARK_SESSION_TTL`で延ばせる） |

## 管理者の作業（要sudo）

### ファイアウォール（#2）

```sh
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status verbose
```

- Dockerが公開したポートはufwを通らない（DockerがiptablesのDNATを先に入れるため）。今このサーバーで
  Dockerが公開しているのはEdgeSharkの5001だけで、127.0.0.1に限っているので問題ない。
- ラボのノードの管理用ネットワーク（172.20.20.0/24）はホストの中だけのもので、影響しない。

### 使わなくなったsudoersの削除（#3）

```sh
sudo rm /etc/sudoers.d/ovs-helper-link-delete /usr/local/sbin/ovs-helper-link-delete
sudo visudo -c
```

### nginxの設定の反映（#8）

```sh
cd ~/Free-Networking-labs/backend/nginx && bash install.sh
```

### 利用者のアカウント（#9〜#11）

利用者（学生）のアカウントは次の形にする。

- グループは`clab_api`だけ（`clab_admins`・`docker`・`sudo`に入れない）
- SSHでログインさせない（パスワードはclab-api-serverのログインにだけ使う）

```sh
# 利用者のアカウントを作る
sudo useradd -m -G clab_api -s /usr/sbin/nologin <ユーザー名>
sudo passwd <ユーザー名>

# SSHで、clab_apiのユーザーを拒否する
echo 'DenyGroups clab_api' | sudo tee /etc/ssh/sshd_config.d/90-fnl-deny-students.conf
sudo sshd -t && sudo systemctl reload ssh
```

シェルを`/usr/sbin/nologin`にしてもclab-api-serverのログイン（PAM）はできる設計（PAMの`pam_unix`はシェルを見ない）。**未確認**なので、アカウントを作ったら一度ログインを試すこと。
既存のアカウントを直す時は、例えば`sudo gpasswd -d labuser2 docker`・`sudo gpasswd -d labuser2 clab_admins`・
`sudo usermod -aG clab_api -s /usr/sbin/nologin labuser2`。

## 定期的に見ること

- `getent group clab_admins docker sudo`に、利用者が入っていないか
- `ss -ltn`で、0.0.0.0で待ち受けているのが22/80/443/8090だけか（8090はufwで閉じている前提）
- `journalctl -u clab-api-server`の`TLS handshake error`や、ログインの失敗が急に増えていないか
