// L2スイッチ(ovs-bridge kind)のブリッジ作成・ポートのリセット・VLAN設定（アクセス/トランク）を
// 行うための専用ヘルパー。
//
// なぜブリッジ作成が必要か（2026-10-06、実機確認）:
//   containerlabの`ovs-bridge` kindはブリッジを自動生成しない。`ovs-vsctl add-br`で
//   事前にブリッジが存在していないと、deployが
//   `bridge "..." referenced in topology but does not exist` で失敗する
//   （`CLAUDE.md`・`docs/direction.md`のM2の発見事項を参照。既存の既知の制約だが、
//   これまでフロント側の自動deployフローにはブリッジ作成処理が入っておらず、
//   手動でブリッジを作っていない状態でのdeployが失敗することが判明した）。
//
// なぜポートのリセットが必要か（2026-10-06、実機確認）:
//   ポート名は(username,labName,switchNodeId,iface)から決定的にハッシュ化されるため、
//   同じラボを再deployすると毎回同じポート名になる。前回のdeployでOVS側に作られた
//   インターフェースが残っていると、containerlabが
//   `interface "..." is defined via topology but already exists` で失敗する。
//   deploy前に`ovs-vsctl --if-exists del-port`で一度消してから作り直させる
//   （VLAN設定はdeploy後に毎回再投入するので、消しても実質的な影響はない）。
//
// なぜVLAN設定が必要か:
//   containerlabのトポロジYAMLにはVLAN設定の項目が無く、deploy後に`ovs-vsctl`をホスト側で
//   実行して別途投入する必要がある。clab-api-serverの`exec`系APIはコンテナ単位でしか実行
//   できず、ovs-bridge kindのノードはそもそもコンテナを持たないため、ホストのOVSデータベース
//   （ovs-vsctl）には届かない。
//
// そのためconsole-proxyと同じ発想で、JWTを受け取って「そのユーザーが所有するラボかどうか」を
// clab-api-server自身に問い合わせてから、代わりにovs-vsctlを実行する薄いヘルパーをここに立てる。
//
// 認可の仕組み:
//   JWTの署名検証は行わない（秘密鍵を共有していないため）。代わりに、受け取ったトークンで
//   `GET /api/v1/labs`をclab-api-server自身に叩き、返ってきたラボ一覧に対象のlabNameが
//   含まれているかで「本人が所有するラボか」を確認する（clab-api-server側で既に
//   所有権フィルタされたレスポンスが返るため、これで十分）。ブリッジ作成は、deployより
//   前の「まだそのラボが存在しない」タイミングでも呼ぶ必要があるため、ラボ一覧に
//   無くてもエラーにはしない（＝所有権チェックをスキップする。ブリッジ名自体が
//   toClabBridgeName()でusername/labName/nodeNameから決定的にハッシュ化されているため、
//   他人のラボのブリッジ名を当てて壊すことは現実的に困難）。
//
// ブリッジ名・ポート名について:
//   frontend/src/utils/clabNaming.ts の toClabBridgeName()/toClabPortName() で決定的に
//   ハッシュ化された名前をそのまま受け取る想定（UI上の"eth1"等とは別物）。

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'

const HELPER_PORT = Number(process.env.OVS_HELPER_PORT ?? 8083)
const CLAB_API_BASE_URL = process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
// `ip link delete`はCAP_NET_ADMINが要るため、labuser権限のこのプロセスからは直接呼べない。
// sudoersで限定許可した専用ラッパー（link-delete.sh、要セットアップ）を`sudo -n`経由で呼ぶ。
// 詳細はそのファイルを参照
const LINK_DELETE_BIN = process.env.OVS_HELPER_LINK_DELETE_BIN ?? '/usr/local/sbin/ovs-helper-link-delete'
// ルーターのFRR設定（daemons/frr.conf/vtysh.conf）の永続化先ルート。
// このプロセス（labuser等、各ユーザー自身の権限で動く）がそのまま書き込める、
// 各ユーザー自身のラボディレクトリのルート（2026-10-07追加）
const CLAB_LABS_ROOT = process.env.CLAB_LABS_ROOT ?? '/var/lib/containerlab/labs'

// OVSのVLAN IDとして有効な範囲（802.1Q）
const MIN_VLAN = 1
const MAX_VLAN = 4094
// ブリッジ名・ポート名は toClabBridgeName()/toClabPortName() が生成する形式のみ受け付ける
// （任意の文字列をそのままexecFileの引数に渡すこと自体は安全だが、
// 想定外の名前を受け付けないよう形式を絞っておく）
const BRIDGE_NAME_PATTERN = /^sw-[0-9a-f]{8}$/
const PORT_NAME_PATTERN = /^p-[0-9a-f]{8}$/
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

function isValidVlanId(n) {
  return Number.isInteger(n) && n >= MIN_VLAN && n <= MAX_VLAN
}

// 所有権確認には `GET /api/v1/labs` ではなく `GET /api/v1/labs/{labName}/topology/yaml` を使う。
// `GET /api/v1/labs`はcontainerlabのinspect結果（＝実行中コンテナ一覧）を元に返しているらしく、
// コンテナを1台も持たないラボ（今回のようにOVSブリッジ同士を直結しただけのラボ、
// `Lab deployed successfully ... containerCount=0`のログで確認）は何秒待っても
// 一覧に出てこないことが判明した（2026-10-06実機確認。15秒再試行しても「所有ではありません」で
// 失敗し続けた事象の真因。待ち時間の問題ではなかった）。
// topology/yamlエンドポイントは保存済みYAMLファイルを読むだけで、所有権チェック済みの
// 200/404を返す（存在しない・他人のラボなら404）ため、コンテナ数に依存しない
async function verifyLabOwnership(token, labName) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${CLAB_API_BASE_URL}/api/v1/labs/${encodeURIComponent(labName)}/topology/yaml`,
      { headers: { Authorization: `Bearer ${token}` }, rejectUnauthorized: false },
      (res) => {
        res.resume()
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(true)
            return
          }
          if (res.statusCode === 404) {
            resolve(false)
            return
          }
          reject(new Error('認証に失敗しました'))
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// トークンが有効かどうかだけを確認する（labNameがまだ存在しない＝deploy前でも使える）。
// clab-api-serverはトークンが無効なら401を返すので、それ以外（200/404等）はトークン自体は
// 有効と判断する
async function verifyTokenOnly(token) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${CLAB_API_BASE_URL}/api/v1/labs`,
      { headers: { Authorization: `Bearer ${token}` }, rejectUnauthorized: false },
      (res) => {
        res.resume()
        resolve(res.statusCode !== 401)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// JWTのペイロードから`username`を読む（署名検証はしない）。ファイルパスの構築にしか使わず、
// 認可そのものは別途verifyTokenOnly/verifyLabOwnershipがclab-api-server自身に問い合わせて
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

function runOvsVsctl(args) {
  return new Promise((resolve, reject) => {
    execFile('ovs-vsctl', args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr?.trim() || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

// `ovs-vsctl del-port`はOVSブリッジからポートを切り離すだけで、裏にあるvethデバイス自体は
// カーネルに残り続ける（2026-10-07実機確認：`ip link show`で`del-port`後も
// `p-xxxxxxxx@p-yyyyyyyy`が見え続けていた）。再deploy時、containerlabが同名のvethを
// 作り直そうとしてカーネル側で名前衝突し`already exists`になる。`ip link delete`で
// veth自体も削除する必要があるが、これにはCAP_NET_ADMINが要り、labuser権限のこの
// プロセスからは直接呼べない（`Operation not permitted`を実機確認）。setcapも試したが
// シェルスクリプトには効かない（2026-10-07実機確認：link-delete.sh参照）ため、
// `/etc/sudoers.d/`での限定NOPASSWD許可経由でラッパーを呼ぶ（存在しない場合は
// `Cannot find device`で失敗するだけなので無視）
function deleteLinkIfExists(iface) {
  return new Promise((resolve, reject) => {
    execFile('sudo', ['-n', LINK_DELETE_BIN, iface], (error, stdout, stderr) => {
      if (error && !/Cannot find device/.test(stderr ?? '')) {
        reject(new Error(stderr?.trim() || error.message))
        return
      }
      resolve()
    })
  })
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin && (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin))) {
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

async function handleBridge(req, res, token) {
  const payload = await readJsonBody(req)
  const { bridge } = payload ?? {}
  if (typeof bridge !== 'string' || !BRIDGE_NAME_PATTERN.test(bridge)) {
    sendJson(res, 400, { error: 'bridgeの形式が不正です' })
    return
  }

  const tokenOk = await verifyTokenOnly(token)
  if (!tokenOk) {
    sendJson(res, 401, { error: '認証に失敗しました' })
    return
  }

  // 既に存在していてもエラーにしない（同じラボの再deployで何度呼ばれても安全なように）
  await runOvsVsctl(['--may-exist', 'add-br', bridge])
  sendJson(res, 200, { message: `bridge ${bridge} を用意しました` })
}

async function handlePortReset(req, res, token) {
  const payload = await readJsonBody(req)
  const { port } = payload ?? {}
  if (typeof port !== 'string' || !PORT_NAME_PATTERN.test(port)) {
    sendJson(res, 400, { error: 'portの形式が不正です' })
    return
  }

  const tokenOk = await verifyTokenOnly(token)
  if (!tokenOk) {
    sendJson(res, 401, { error: '認証に失敗しました' })
    return
  }

  // 存在しなくてもエラーにしない。ポート名は(username,labName,switchNodeId,iface)から
  // 決定的に決まるため、再deployすると同じ名前になり、前回のOVS側インターフェースが
  // 残っているとcontainerlabが「already exists」で失敗する（2026-10-06実機確認）。
  // OVSからの切り離し（del-port）だけではvethデバイス自体が残るため、ip linkでも削除する
  // （2026-10-07実機確認：del-portだけでは再deployのたびに同じエラーが再発していた）
  await runOvsVsctl(['--if-exists', 'del-port', port])
  await deleteLinkIfExists(port)
  sendJson(res, 200, { message: `port ${port} をリセットしました` })
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
async function handleFrrConfig(req, res, token) {
  const payload = await readJsonBody(req)
  const { labName, routerName } = payload ?? {}
  if (typeof labName !== 'string' || !SAFE_PATH_SEGMENT_PATTERN.test(labName)) {
    sendJson(res, 400, { error: 'labNameの形式が不正です' })
    return
  }
  if (typeof routerName !== 'string' || !SAFE_PATH_SEGMENT_PATTERN.test(routerName)) {
    sendJson(res, 400, { error: 'routerNameの形式が不正です' })
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

  const dir = path.join(CLAB_LABS_ROOT, username, labName, 'frr-config', routerName)
  fs.mkdirSync(dir, { recursive: true })

  const files = {
    daemons: FRR_DEFAULT_DAEMONS,
    'frr.conf': `frr version 10.2.1\nfrr defaults traditional\nhostname ${routerName}\n!\nline vty\n!\n`,
    'vtysh.conf': 'service integrated-vtysh-config\n',
  }
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name)
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content)
  }

  sendJson(res, 200, { message: `router ${routerName} のFRR設定を用意しました` })
}

async function handleVlan(req, res, token) {
  const payload = await readJsonBody(req)
  const { labName, port, mode, vlan, vlans } = payload ?? {}
  if (typeof labName !== 'string' || !labName) {
    sendJson(res, 400, { error: 'labNameが必要です' })
    return
  }
  if (typeof port !== 'string' || !PORT_NAME_PATTERN.test(port)) {
    sendJson(res, 400, { error: 'portの形式が不正です' })
    return
  }

  // topology/yamlエンドポイントはファイルを直接読むだけなので基本的に即座に反映されるはずだが、
  // 保険として少しだけ再試行する（本質的な原因はcontainerCount=0ラボが`GET /api/v1/labs`に
  // 出てこないことだったため、以前の15回×1秒のロングリトライは不要になった）
  let owned = false
  for (let attempt = 0; attempt < 3 && !owned; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500))
    owned = await verifyLabOwnership(token, labName)
  }
  if (!owned) {
    sendJson(res, 403, { error: `ラボ「${labName}」は自分の所有ではありません` })
    return
  }

  if (mode === 'access') {
    if (!isValidVlanId(vlan)) {
      sendJson(res, 400, { error: `vlanは${MIN_VLAN}〜${MAX_VLAN}の整数で指定してください` })
      return
    }
    await runOvsVsctl(['set', 'port', port, `tag=${vlan}`])
  } else if (mode === 'trunk') {
    if (!Array.isArray(vlans) || vlans.length === 0 || !vlans.every(isValidVlanId)) {
      sendJson(res, 400, { error: `vlansは${MIN_VLAN}〜${MAX_VLAN}の整数の配列で指定してください` })
      return
    }
    await runOvsVsctl(['set', 'port', port, `trunks=${vlans.join(',')}`])
  } else {
    sendJson(res, 400, { error: 'modeは access か trunk を指定してください' })
    return
  }

  sendJson(res, 200, { message: `port ${port} に ${mode} 設定を適用しました` })
}

const ROUTES = {
  '/bridge': handleBridge,
  '/port/reset': handlePortReset,
  '/vlan': handleVlan,
  '/frr-config': handleFrrConfig,
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

server.listen(HELPER_PORT, () => {
  console.log(`ovs-helper listening on http://localhost:${HELPER_PORT} (upstream: ${CLAB_API_BASE_URL})`)
})
