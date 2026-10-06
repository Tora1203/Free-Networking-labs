// L2スイッチ(ovs-bridge kind)のポートにVLAN設定（アクセス/トランク）を投入するための
// 専用ヘルパー。
//
// なぜ必要か（2026-10-06、docs/direction.md参照）:
//   containerlabのトポロジYAMLにはVLAN設定の項目が無く、deploy後に`ovs-vsctl`をホスト側で
//   実行して別途投入する必要がある。clab-api-serverの`exec`系APIはコンテナ単位でしか実行
//   できず、ovs-bridge kindのノードはそもそもコンテナを持たないため、ホストのOVSデータベース
//   （ovs-vsctl）には届かない。そのためconsole-proxyと同じ発想で、JWTを受け取って
//   「そのユーザーが所有するラボかどうか」をclab-api-server自身に問い合わせてから、
//   代わりにovs-vsctlを実行する薄いヘルパーをここに立てる。
//
// 認可の仕組み:
//   JWTの署名検証は行わない（秘密鍵を共有していないため）。代わりに、受け取ったトークンで
//   `GET /api/v1/labs`をclab-api-server自身に叩き、返ってきたラボ一覧に対象のlabNameが
//   含まれているかで「本人が所有するラボか」を確認する（clab-api-server側で既に
//   所有権フィルタされたレスポンスが返るため、これで十分）。
//
// ポート名について:
//   frontend/src/utils/clabNaming.ts の toClabPortName() で決定的にハッシュ化された名前を
//   そのままportとして受け取る想定（UI上の"eth1"等とは別物）。この一致はフロント側の責務。

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import https from 'node:https'

const HELPER_PORT = Number(process.env.OVS_HELPER_PORT ?? 8083)
const CLAB_API_BASE_URL = process.env.CLAB_API_BASE_URL ?? 'https://localhost:8090'
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// OVSのVLAN IDとして有効な範囲（802.1Q）
const MIN_VLAN = 1
const MAX_VLAN = 4094
// ポート名はtoClabPortName()が生成する`p-<8桁16進数>`形式のみ受け付ける
// （任意の文字列をそのままexecFileの引数に渡すこと自体は安全だが、
// 想定外の名前を受け付けないよう形式を絞っておく）
const PORT_NAME_PATTERN = /^p-[0-9a-f]{8}$/

function isValidVlanId(n) {
  return Number.isInteger(n) && n >= MIN_VLAN && n <= MAX_VLAN
}

async function verifyLabOwnership(token, labName) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${CLAB_API_BASE_URL}/api/v1/labs`,
      { headers: { Authorization: `Bearer ${token}` }, rejectUnauthorized: false },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error('認証に失敗しました'))
            return
          }
          try {
            const labs = JSON.parse(body)
            resolve(Object.prototype.hasOwnProperty.call(labs, labName))
          } catch {
            reject(new Error('clab-api-serverからの応答を解釈できませんでした'))
          }
        })
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

const server = createServer((req, res) => {
  applyCors(req, res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method !== 'POST' || req.url !== '/vlan') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  const authHeader = req.headers.authorization ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null
  if (!token) {
    sendJson(res, 401, { error: 'Authorization: Bearer <token> が必要です' })
    return
  }

  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', async () => {
    let payload
    try {
      payload = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { error: 'リクエストボディがJSONではありません' })
      return
    }

    const { labName, port, mode, vlan, vlans } = payload ?? {}
    if (typeof labName !== 'string' || !labName) {
      sendJson(res, 400, { error: 'labNameが必要です' })
      return
    }
    if (typeof port !== 'string' || !PORT_NAME_PATTERN.test(port)) {
      sendJson(res, 400, { error: 'portの形式が不正です' })
      return
    }

    try {
      const owned = await verifyLabOwnership(token, labName)
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
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : 'VLAN設定の適用に失敗しました' })
    }
  })
})

server.listen(HELPER_PORT, () => {
  console.log(`ovs-helper listening on http://localhost:${HELPER_PORT} (upstream: ${CLAB_API_BASE_URL})`)
})
