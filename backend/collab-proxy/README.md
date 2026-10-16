# collab-proxy（試作、2026-10-16）

ラボの**閲覧のみの共有リンク**を作る小さなサーバー。設計は`docs/collab-design.md`（段階2の試作）。

clab-api-serverはラボを持ち主のLinuxユーザーでしか見せない。持ち主が共有を作った時に、そのトークンをこの
プロセスの**メモリにだけ**預かり、ゲストの閲覧を持ち主として代行する。

## 守りの要

- ゲストも**自分のアカウントでログイン**していること（`Authorization`のトークンが上流で有効）。リンクだけでは見られず、誰が見たかをログに残す
- ゲスト向けの窓口は「そのラボのトポロジ・注釈・状態を返す」1つだけ（`GET /s/<id>`）。ゲストはパスもラボ名も
  指定できず、任意のAPIを中継する作りにしていない。上流に出す問い合わせはGETの3種類だけ
  （`topology/yaml`・`topology/annotations`・`/api/v1/labs`。最後は結果からこのラボの分だけを返す）
- 合言葉（id）は192bitの乱数。期限は既定8時間で、持ち主のトークンの期限（24時間）が先に来ればそこまで
- トークンはメモリにだけ置く。ファイル・ログに出さない（**再起動すると共有は消える**）
- 共有を作れるのはそのラボの持ち主だけ（持ち主のトークンでラボを問い合わせて200なら持ち主）
- 持ち主ごとに10件まで。ログには合言葉の先頭6文字・ラボ名・持ち主・見た人・IPだけ

## API

持ち主（`Authorization: Bearer <JWT>`）:

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | `/shares` `{"labName": "..."}` | 共有を作る → `{id, labName, role, expiresAt}` |
| GET | `/shares` | 自分の共有の一覧 |
| DELETE | `/shares/<id>` | 取り消す（他人の共有は404） |

ゲスト（`Authorization: Bearer <JWT>`が要る。idが合言葉）:

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/s/<id>` | `{labName, owner, viewer, role, expiresAt, yaml, annotations, nodes}`。ログインしていなければ401、持ち主のトークンが失効していたら410 |

画面のリンクは`https://<サーバー>/#/share/<id>`（ハッシュにidを入れる。nginxのアクセスログに残らない）。

## 環境変数

| 名前 | 既定 | 内容 |
| --- | --- | --- |
| `COLLAB_PROXY_PORT` | 8085 | 待ち受けポート |
| `LISTEN_HOST` | 127.0.0.1 | 待ち受けアドレス（nginx経由でしか使わない） |
| `CLAB_API_BASE_URL` | https://localhost:8090 | clab-api-server |
| `SHARE_TTL_HOURS` | 8 | 共有の有効時間 |
| `MAX_SHARES_PER_USER` | 10 | 持ち主ごとの上限 |

## 起動・テスト

```sh
cd backend/collab-proxy
node server.js          # 依存パッケージなし
node --test             # 上流を模したサーバーでのテスト（9件）
```

常駐は`collab-proxy.service.example`（systemdのuserサービス、sudo不要）。nginxは`backend/nginx/fnl.conf`の
`/collab/`（`bash backend/nginx/install.sh`で反映、要sudo）。

## まだ無いもの（`docs/collab-design.md`）

- 編集権限の共有、変更のリアルタイム配信
- コンソールの閲覧、キャプチャ
- 共有を永続化しない（再起動で消える）
