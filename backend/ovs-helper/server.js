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

const HELPER_PORT = Number(process.env.OVS_HELPER_PORT ?? 8083)
const CLAB_API_BASE_URL = process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// OVSのVLAN IDとして有効な範囲（802.1Q）
const MIN_VLAN = 1
const MAX_VLAN = 4094
// ブリッジ名・ポート名は toClabBridgeName()/toClabPortName() が生成する形式のみ受け付ける
// （任意の文字列をそのままexecFileの引数に渡すこと自体は安全だが、
// 想定外の名前を受け付けないよう形式を絞っておく）
const BRIDGE_NAME_PATTERN = /^sw-[0-9a-f]{8}$/
const PORT_NAME_PATTERN = /^p-[0-9a-f]{8}$/

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
  // 残っているとcontainerlabが「already exists」で失敗する（2026-10-06実機確認）
  await runOvsVsctl(['--if-exists', 'del-port', port])
  sendJson(res, 200, { message: `port ${port} をリセットしました` })
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

const ROUTES = { '/bridge': handleBridge, '/port/reset': handlePortReset, '/vlan': handleVlan }

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
