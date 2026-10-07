# ovs-helper

L2スイッチ（`ovs-bridge` kind）のポートにVLAN設定（アクセス/トランク）を投入するための
専用ヘルパー。

## なぜ必要か

containerlabのトポロジYAMLにはVLAN設定の項目が無く、deploy後に`ovs-vsctl`をホスト側で
実行して別途投入する必要があります（`CLAUDE.md`参照）。

`clab-api-server`の`POST /api/v1/labs/{labName}/exec`はコンテナ単位でしか実行できません。
`ovs-bridge` kindのノードはそもそもコンテナを持たないため（ホスト側でOVSブリッジとして
実現される）、この経路ではホストのOVSデータベースに届きません。

そのため`backend/console-proxy/`と同じ発想で、ブラウザから直接認証付きで叩ける薄い
ヘルパーをここに立てています。

## 認可の仕組み

JWTの署名検証はしません（`clab-api-server`の秘密鍵を共有していないため）。代わりに、
受け取ったトークンで`clab-api-server`自身に問い合わせます。

- `/vlan`（VLAN設定の投入）: `GET /api/v1/labs/{labName}/topology/yaml`を叩き、200なら
  本人所有のラボと判断します（`GET /api/v1/labs`はcontainerlabのinspect結果＝実行中コンテナ
  一覧がベースのため、コンテナを1台も持たないラボ＝スイッチ同士を直結しただけの構成等が
  一覧に出てこないことが判明し、2026-10-06にこちらへ切り替えました）
- `/bridge`・`/port/reset`（ブリッジ作成・ポートリセット）: `GET /api/v1/labs`が401を返さない
  ことだけを確認します（deployより前の「まだそのラボが存在しない」タイミングでも呼ぶ必要があるため、
  所有権チェック自体はスキップ。名前自体がusername/labNameから決定的にハッシュ化されているため、
  他人のラボの名前を当てて壊すことは現実的に困難）

## 前提：OVSへの非root権限

このサービスは`sudo`なしで`ovs-vsctl`を実行できるLinuxアカウントで動かす必要があります。
このサーバーでは`labuser`に対して設定済み（`docs/direction.md`参照：
`/etc/default/openvswitch-switch`に`--ovs-user=root:clab_admins`等）。

## 前提：veth削除用ラッパーのsudoers設定（初回のみ）

`POST /port/reset`は再deploy時のポート名衝突を防ぐため、OVSから切り離した後のvethデバイス
自体も`ip link delete`で削除します。これにはCAP_NET_ADMINが必要で、`labuser`権限で動く
このプロセスからは直接呼べません（2026-10-07実機確認：`Operation not permitted`）。
`setcap`も試したがシェルスクリプトには効かない（Linuxのファイルcapabilityはshebang経由で
実行されるインタプリタには引き継がれない既知の制限。2026-10-07実機確認：
`setcap`してもなお`Operation not permitted`）ため、`/etc/sudoers.d/`での限定NOPASSWD許可に
切り替えました：

```sh
sudo cp backend/ovs-helper/link-delete.sh /usr/local/sbin/ovs-helper-link-delete
sudo chown root:clab_admins /usr/local/sbin/ovs-helper-link-delete
sudo chmod 750 /usr/local/sbin/ovs-helper-link-delete
echo 'labuser ALL=(root) NOPASSWD: /usr/local/sbin/ovs-helper-link-delete' | sudo tee /etc/sudoers.d/ovs-helper-link-delete
sudo chmod 440 /etc/sudoers.d/ovs-helper-link-delete
sudo visudo -c
```

`ip`本体をsudoersで丸ごと許可しない理由は`link-delete.sh`のコメント参照（`p-xxxxxxxx`形式の
名前のdeleteだけに絞っているので、このスクリプト1本だけを許可すれば操作範囲を絞れる）。

## API

### `POST /bridge`

```jsonc
// リクエストヘッダ: Authorization: Bearer <jwt>
{ "bridge": "sw-xxxxxxxx" }  // frontend/src/utils/clabNaming.ts の toClabBridgeName() が生成する実名
```

`ovs-vsctl --may-exist add-br`を実行します（既に存在してもエラーになりません）。deployより
前に、トポロジに含まれる全L2スイッチに対して呼ぶ想定です。

### `POST /port/reset`

```jsonc
// リクエストヘッダ: Authorization: Bearer <jwt>
{ "port": "p-xxxxxxxx" }  // toClabPortName() が生成する実名
```

`ovs-vsctl --if-exists del-port`に続けて`ip link delete`相当（sudoersで限定許可した
ラッパー経由）でvethデバイス自体も削除します。存在しなくてもエラーになりません。deployより前に、
トポロジに含まれる全L2スイッチ側ポートに対して呼ぶ想定です。

### `POST /vlan`

```jsonc
// リクエストヘッダ: Authorization: Bearer <jwt>
{
  "labName": "lab-xxxxxxxx",
  "port": "p-xxxxxxxx",      // toClabPortName() が生成する実名
  "mode": "access",          // "access" | "trunk"
  "vlan": 10                 // mode: "access" の場合
  // "vlans": [10, 20, 30]   // mode: "trunk" かつ「指定VLANのみ許可」の場合
  //                            （"全VLAN許可"の場合はフロント側がこのエンドポイントを呼ばない。
  //                            OVSはポートにtag/trunksどちらも設定しないとデフォルトで
  //                            全VLAN許可のトランクになるため、resetPort後の状態で十分）
}
```

成功時は`200 {"message": "..."}`、認可エラーは`403`、入力不正は`400`、
`ovs-vsctl`実行失敗は`500`で`{"error": "..."}`を返します。

## 起動方法

```sh
npm start
```

環境変数（`.env.example`参照）:
- `OVS_HELPER_PORT`: 待受ポート（デフォルト `8083`）
- `CLAB_API_BASE_URL`: `clab-api-server`のベースURL（デフォルト `https://localhost:8090`。
  自己署名証明書を許容する設定になっている）
- `CORS_ALLOWED_ORIGINS`: フロントエンドのオリジンをカンマ区切りで（空なら全オリジン許可）

## 常駐させる

`backend/console-proxy/README.md`と同じ理由で、`systemctl --user`でのuserサービス化を
推奨します。`ovs-helper.service.example`をコピーして使ってください。
