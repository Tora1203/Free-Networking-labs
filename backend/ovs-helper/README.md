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
受け取ったトークンで`GET /api/v1/labs`を`clab-api-server`自身に問い合わせ、返ってきた
（所有権フィルタ済みの）ラボ一覧に対象の`labName`が含まれているかを確認します。

## 前提：OVSへの非root権限

このサービスは`sudo`なしで`ovs-vsctl`を実行できるLinuxアカウントで動かす必要があります。
このサーバーでは`labuser`に対して設定済み（`docs/direction.md`参照：
`/etc/default/openvswitch-switch`に`--ovs-user=root:clab_admins`等）。

## API

### `POST /vlan`

```jsonc
// リクエストヘッダ: Authorization: Bearer <jwt>
{
  "labName": "lab-xxxxxxxx",
  "port": "p-xxxxxxxx",      // frontend/src/utils/clabNaming.ts の toClabPortName() が生成する実名
  "mode": "access",          // "access" | "trunk"
  "vlan": 10                 // mode: "access" の場合
  // "vlans": [10, 20, 30]   // mode: "trunk" の場合
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
