# ovs-helper

ラボのノードの設定の保存先を、deployより前に用意する専用ヘルパー。

- ルーター：`frr-config/<ノード名>/`（`daemons`/`frr.conf`/`vtysh.conf`）
- L2スイッチ：`switch-config/<ノード名>/`

ラボのディレクトリはユーザーごとに`drwxr-x---`で分離されていて、`clab-api-server`のAPIでは
これらを作れないため、sudoersで限定許可したラッパー（`frr-config-init.sh`）を呼ぶ。

名前はL2スイッチが`ovs-bridge` kindだった頃（〜2026-10-13）の名残。当時はホストのOVSの
ブリッジ作成・ポートのリセット・VLAN設定（`/bridge`・`/port/reset`・`/vlan`）も行っていたが、
スイッチがコンテナになって使わなくなったため2026-10-15に削除した。ログインしていれば誰でも、
名前さえ分かれば他人のポートを消せる窓口だったため。セキュリティの点検は`docs/security.md`を参照。

## 認可の仕組み

JWTの署名検証はしません（`clab-api-server`の秘密鍵を共有していないため）。代わりに、
受け取ったトークンで`GET /api/v1/labs`を`clab-api-server`自身に問い合わせ、200なら有効とみなします。
ユーザー名はJWTのペイロードから読みます。偽装したトークンはこの問い合わせで401になるので、
読み取ったユーザー名を信じてよい。作る場所は常に「そのユーザー自身のラボのディレクトリ」なので、
ラボの所有権の確認は要りません（deploy前のまだ存在しないラボにも作る必要があるため）。

## 前提：FRR設定用ラッパーのsudoers設定（初回のみ）

`POST /frr-config`は、ラボのディレクトリ（ユーザーごとに`drwxr-x---`で分離）に書き込むため、
`labuser`権限のovs-helperからは他ユーザーのラボに作れない（2026-10-13実機確認：
`labuser2`のdeployが`EACCES: permission denied, mkdir .../frr-config/router-1`で失敗）。
そこで「そのユーザーのラボ配下に`frr-config`を作り所有者を本人にする」だけを行うラッパー
（`frr-config-init.sh`）をsudoersで限定許可する。入力（ユーザー名/ラボ名/ルーター名）は形式を検証し、
シンボリックリンクは拒否、既存ファイルは上書きしない。

```sh
sudo cp backend/ovs-helper/frr-config-init.sh /usr/local/sbin/ovs-helper-frr-config-init
sudo chown root:clab_admins /usr/local/sbin/ovs-helper-frr-config-init
sudo chmod 750 /usr/local/sbin/ovs-helper-frr-config-init
echo 'labuser ALL=(root) NOPASSWD: /usr/local/sbin/ovs-helper-frr-config-init' | sudo tee /etc/sudoers.d/ovs-helper-frr-config-init
sudo chmod 440 /etc/sudoers.d/ovs-helper-frr-config-init
sudo visudo -c
```

## API

### `POST /switch-config`

```jsonc
// リクエストヘッダ: Authorization: Bearer <jwt>
{ "labName": "lab-xxxxxxxx", "switchName": "switch-1" }
```

L2スイッチ（`backend/l2switch/`）の`/etc/fnl-switch`にbind mountする空のディレクトリ
`$CLAB_LABS_ROOT/<username>/<labName>/switch-config/<switchName>/`をdeployより前に用意する（2026-10-14追加）。
swcliの`write memory`（`startup.json`）がホストに残り、ラボを作り直しても消えなくなる。
既にあれば何もしない。作成は`/frr-config`と同じラッパー（`frr-config-init.sh`の`switch`モード）で行う。
ラッパーを更新したら、下のセットアップの`sudo cp`〜`chmod 750`をやり直すこと（sudoersはそのままでよい）。

### `POST /frr-config`

```jsonc
// リクエストヘッダ: Authorization: Bearer <jwt>
{ "labName": "lab-xxxxxxxx", "routerName": "router-1" }
```

ルーターのFRR設定（`daemons`/`frr.conf`/`vtysh.conf`）をdeployより前に用意するための
エンドポイント（2026-10-07追加）。`$CLAB_LABS_ROOT/<username>/<labName>/frr-config/<routerName>/`
に3ファイルを作成します。**既に存在するファイルは上書きしません**
（学生がvtyshで`write memory`した設定を消さないため）。

- なぜ必要か：ルーターのIPアドレス設定等は「GUIで一方的に投入する」のではなく、
  学生がvtyshのCLIで直接設定し、それがdeployを越えて残るようにしたい
  （「ルーターはCLIで設定しないと意味がない」指摘対応）。containerlabはbind mount先の
  ファイルが事前に存在しないとdeploy自体を拒否するため（実機確認済み：
  `Failed to verify bind path: ... no such file or directory`）、最低限の初期ファイルを
  ここで用意する必要がある
- `username`はJWTのペイロードから読むだけで署名検証はしない（ファイルパスの構築にしか
  使わないため。認可自体は`verifyTokenOnly`がclab-api-server自身に問い合わせて行っており、
  偽装トークンならそこで401になる）
- 実機確認済み：`write memory`で保存した設定が、コンテナを完全に破棄・再作成する
  redeployを越えて残ることを確認した（一時テストラボでの検証）
- `labName`/`routerName`は英数字・ハイフン・アンダースコアのみ（`SAFE_PATH_SEGMENT_PATTERN`）。
  パストラバーサル対策

環境変数`CLAB_LABS_ROOT`（デフォルト`/var/lib/containerlab/labs`）でラボのルートディレクトリを
指定します。

## 起動方法

```sh
npm start
```

環境変数（`.env.example`参照）:
- `OVS_HELPER_PORT`: 待受ポート（デフォルト `8083`）
- `CLAB_API_BASE_URL`: `clab-api-server`のベースURL（デフォルト `https://localhost:8090`。
  自己署名証明書を許容する設定になっている）
- `LISTEN_HOST`: 待ち受けるアドレス（デフォルト `127.0.0.1`。ブラウザからはnginxの`/ovs/`経由で使う）
- `CORS_ALLOWED_ORIGINS`: 開発で別オリジン（viteの5173等）から直接呼ぶ時だけ、そのオリジンをカンマ区切りで
  （空ならCORSのヘッダーを付けない。本番はnginxの同じオリジンなので不要。2026-10-15までは空なら全オリジン許可だった）

## 常駐させる

`backend/console-proxy/README.md`と同じ理由で、`systemctl --user`でのuserサービス化を
推奨します。`ovs-helper.service.example`をコピーして使ってください。
