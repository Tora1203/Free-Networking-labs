// ラボのノードの設定の保存先（ルーターのfrr-config/、スイッチのswitch-config/）をdeployより前に用意する
// 専用ヘルパー。ラボのディレクトリは本人所有（0750）で、clab-api-serverのAPIでは作れないため、
// sudoersで限定許可したラッパー（frr-config-init.sh）を呼ぶ。
//
// 元はL2スイッチがovs-bridge kindだった頃（〜2026-10-13）に、ホストのOVSのブリッジ作成・ポートのリセット・
// VLAN設定を行うために作ったもの（名前はその名残）。スイッチがコンテナになって使わなくなった
// /bridge・/port/reset・/vlan は2026-10-15に削除した（ログインしていれば誰でも、他人のポートを
// 名前さえ分かれば消せる窓口だったため。セキュリティの点検、docs/STATUS.md参照）。
//
// 認可の仕組み:
//   JWTの署名検証は行わない（秘密鍵を共有していないため）。受け取ったトークンでclab-api-server自身に
//   問い合わせ、401でなければ有効とみなす（verifyTokenOnly）。ユーザー名はJWTのペイロードから読むが、
//   偽装したトークンはその問い合わせが401になるので、読み取ったユーザー名を信じてよい。
//   作る場所は常に「そのユーザー自身のラボのディレクトリ」なので、ラボの所有権の確認は要らない
//   （deploy前のまだ存在しないラボにも作る必要がある）。

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import https from 'node:https'

const HELPER_PORT = Number(process.env.OVS_HELPER_PORT ?? 8083)
// 待ち受けるアドレス（2026-10-15〜既定は127.0.0.1）。ブラウザからはnginx（443）経由でしか使わないので、
// LANに直接開かない（開くと認証の無い前段を素通りで叩ける窓口が増えるため）。開発で直接使う時だけ0.0.0.0に
const LISTEN_HOST = process.env.LISTEN_HOST ?? '127.0.0.1'
const CLAB_API_BASE_URL = process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
// sudoersで限定許可した専用ラッパー（frr-config-init.sh、要セットアップ）
const FRR_CONFIG_INIT_BIN = process.env.OVS_HELPER_FRR_CONFIG_INIT_BIN ?? '/usr/local/sbin/ovs-helper-frr-config-init'

// ラボ名・ルーター名はファイルパスの一部に使うため、パストラバーサル等を防ぐために
// 英数字・ハイフン・アンダースコアのみに制限する（2026-10-07追加。
// ラボ名はtoSafeLabName()が生成する形式、ルーター名はユーザーがUIで付けたノードidそのもの）
const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
// Linuxのユーザー名は`.`も許されるため、上のパターンだと存在するアカウントを拒否してしまう
// 可能性があった（2026-10-08レビュー指摘）。先頭を英数字に固定しているので、この時点で
// 文字列全体が".."等のパストラバーサル列になることはない
const SAFE_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

// ルーター新規作成時のdaemonsファイルの初期値。学生がvtyshのコンソールから直接
// daemonsファイルを編集する手段が無い（コンソールはvtyshのみに制限済み、docs/direction.md
// 参照）ため、一般的な大学の講義で扱う範囲のプロトコルを一通り有効にしておく
const FRR_DEFAULT_DAEMONS = `zebra=yes
bgpd=yes
ospfd=yes
ospf6d=yes
ripd=yes
ripngd=no
isisd=yes
pimd=no
pim6d=no
ldpd=no
nhrpd=no
eigrpd=no
babeld=no
sharpd=no
pbrd=no
staticd=yes
bfdd=no
fabricd=no
vrrpd=no
pathd=no
vtysh_enable=yes
zebra_options="  -A 127.0.0.1 -s 90000000"
bgpd_options="   -A 127.0.0.1"
ospfd_options="  -A 127.0.0.1"
ospf6d_options=" -A ::1"
ripd_options="   -A 127.0.0.1"
ripngd_options=" -A ::1"
isisd_options="  -A 127.0.0.1"
pimd_options="   -A 127.0.0.1"
pim6d_options="  -A ::1"
ldpd_options="   -A 127.0.0.1"
nhrpd_options="  -A 127.0.0.1"
eigrpd_options=" -A 127.0.0.1"
babeld_options=" -A 127.0.0.1"
sharpd_options=" -A 127.0.0.1"
pbrd_options="   -A 127.0.0.1"
staticd_options="-A 127.0.0.1"
bfdd_options="   -A 127.0.0.1"
fabricd_options="-A 127.0.0.1"
vrrpd_options="  -A 127.0.0.1"
pathd_options="  -A 127.0.0.1"
`

// トークンが有効かどうかだけを確認する（labNameがまだ存在しない＝deploy前でも使える）。
// 有効なトークンならGET /api/v1/labsは200を返す
async function verifyTokenOnly(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${CLAB_API_BASE_URL}/api/v1/labs`,
      { headers: { Authorization: `Bearer ${token}` }, rejectUnauthorized: false },
      (res) => {
        res.resume()
        // 200の時だけ有効とみなす（以前は401以外を有効としていたため、APIの不調（5xx）でも通っていた、2026-10-15）
        resolve(res.statusCode === 200)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// JWTのペイロードから`username`を読む（署名検証はしない）。ファイルパスの構築にしか使わず、
// 認可そのものは別途verifyTokenOnlyがclab-api-server自身に問い合わせて
// 行っている（偽装トークンならその問い合わせ自体が401になるため、ここでの読み取りが
// 偽装されていても実害が無い。2026-10-07追加）
function decodeJwtUsername(token) {
  try {
    const payloadB64 = token.split('.')[1]
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'))
    return typeof payload.username === 'string' ? payload.username : null
  } catch {
    return null
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function applyCors(req, res) {
  // 本番はnginxの同じオリジン（/ovs/）から呼ぶのでCORSは要らない。開発で別オリジンから使う時だけ
  // CORS_ALLOWED_ORIGINSに書いたものを許す（以前は空なら全部許していた、2026-10-15変更）
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type')
}

async function readJsonBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw.length > 0 ? JSON.parse(raw) : {}
}

// ルーターのCLI設定（vtyshでの`write memory`）を再deployを越えて永続化するための
// FRR設定ファイル（daemons/frr.conf/vtysh.conf）を用意する（2026-10-07追加）。
// 「ルーターはCLIで設定しないと意味がない」という指摘を受けて追加：
// GUIが直接execで`ip addr add`していた時はdeployのたびに再投入が必要だったが、
// frr.confをbind mountで永続化しておけば、学生がvtyshで設定して`write memory`した内容が
// そのままファイルに残り、次回deploy時にFRR自身が読み込んで復元する（実機確認済み：
// 完全なコンテナ再作成を挟んでも設定が残ることを確認した）。
//
// 既に存在するファイルは絶対に上書きしない（学生が書いた設定を消してしまうため）。
// 無い時だけ、主要なルーティングプロトコルを一通り有効化した最小構成で新規作成する
// mode='switch'はL2スイッチの設定保存先（switch-config/<名前>/、空のディレクトリ）を作る（2026-10-14）
function initNodeConfig(username, labName, nodeName, mode) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'sudo',
      ['-n', FRR_CONFIG_INIT_BIN, username, labName, nodeName, mode],
      (error, _stdout, stderr) => {
        const what = mode === 'switch' ? 'スイッチ' : 'FRR'
        if (error) reject(new Error(`${what}設定の用意に失敗しました: ${String(stderr).trim() || error.message}`))
        else resolve()
      },
    )
    child.stdin.end(mode === 'switch' ? '' : FRR_DEFAULT_DAEMONS)
  })
}

async function handleFrrConfig(req, res, token) {
  await handleNodeConfig(req, res, token, 'router')
}

// L2スイッチの`write memory`（startup.json）をホストに残すための保存先を、deployより前に用意する
async function handleSwitchConfig(req, res, token) {
  await handleNodeConfig(req, res, token, 'switch')
}

async function handleNodeConfig(req, res, token, mode) {
  const payload = await readJsonBody(req)
  const { labName } = payload ?? {}
  const nodeName = mode === 'switch' ? payload?.switchName : payload?.routerName
  if (typeof labName !== 'string' || !SAFE_PATH_SEGMENT_PATTERN.test(labName)) {
    sendJson(res, 400, { error: 'labNameの形式が不正です' })
    return
  }
  if (typeof nodeName !== 'string' || !SAFE_PATH_SEGMENT_PATTERN.test(nodeName)) {
    sendJson(res, 400, { error: `${mode === 'switch' ? 'switchName' : 'routerName'}の形式が不正です` })
    return
  }

  const tokenOk = await verifyTokenOnly(token)
  if (!tokenOk) {
    sendJson(res, 401, { error: '認証に失敗しました' })
    return
  }
  const username = decodeJwtUsername(token)
  if (!username || !SAFE_USERNAME_PATTERN.test(username)) {
    sendJson(res, 400, { error: 'トークンからユーザー名を取得できませんでした' })
    return
  }

  // ラボのディレクトリは本人所有(0750)でovs-helper(labuser)からは書けないため、
  // 限定ラッパー経由で作る（2026-10-13：別ユーザーのラボでEACCESになった。frr-config-init.sh参照）
  await initNodeConfig(username, labName, nodeName, mode)

  sendJson(res, 200, { message: `${mode} ${nodeName} の設定の保存先を用意しました` })
}

const ROUTES = {
  '/frr-config': handleFrrConfig,
  '/switch-config': handleSwitchConfig,
}

const server = createServer((req, res) => {
  applyCors(req, res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const handler = req.method === 'POST' ? ROUTES[req.url] : undefined
  if (!handler) {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const authHeader = req.headers.authorization ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null
  if (!token) {
    sendJson(res, 401, { error: 'Authorization: Bearer <token> が必要です' })
    return
  }

  handler(req, res, token).catch((e) => {
    sendJson(res, 500, { error: e instanceof Error ? e.message : '処理に失敗しました' })
  })
})

server.listen(HELPER_PORT, LISTEN_HOST, () => {
  console.log(`ovs-helper listening on http://localhost:${HELPER_PORT} (upstream: ${CLAB_API_BASE_URL})`)
})
