// clab-api-server との通信クライアント。
// 実際のレスポンス形状・エラー形式は docs/api-contract.md を参照（すべて実機確認済み）。

import type { NetemInterfaceInfo, NetemParams } from '../utils/linkCondition'

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'https://localhost:8090'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// authStore が login/logout のタイミングで設定する。循環import を避けるため
// authStore側からトークンを注入してもらう方式にしている（client → store は参照しない）。
let authToken: string | null = null
let onUnauthorized: (() => void) | null = null

export function setAuthToken(token: string | null) {
  authToken = token
}

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

// 統合コンソール(WebSocket)のプロキシ接続で使う。api/client.ts自身はfetchしか使わないため
// authTokenを外に出す必要は無かったが、Console.tsx側でWS接続時にトークンを送る必要がある。
// 別のクライアント（collabClient）が401を受けた時に、再ログインへ誘導する
export function notifyUnauthorized() {
  onUnauthorized?.()
}

export function getAuthToken() {
  return authToken
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('Content-Type', 'application/json')
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`)

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })
  const text = await res.text()
  const body = text.length > 0 ? JSON.parse(text) : undefined

  if (!res.ok) {
    // api-contract.md 4章: エラーボディは共通で {"error": "..."}
    const message = (body && typeof body === 'object' && 'error' in body ? body.error : undefined) ?? `HTTP ${res.status}`
    if (res.status === 401) {
      // トークン切れ/無効。リフレッシュ手段は無いため再ログインさせる（api-contract.md 1章）
      onUnauthorized?.()
    }
    throw new ApiError(res.status, message)
  }
  return body as T
}

// topology/yamlエンドポイントはJSONではなくtext/plainでYAML本文を返すため、
// request<T>()（JSON.parse前提）とは別の軽量版を使う。
async function requestText(path: string, options: RequestInit = {}): Promise<string> {
  const headers = new Headers(options.headers)
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`)

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })
  const text = await res.text()

  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = JSON.parse(text)
      if (body && typeof body === 'object' && 'error' in body) message = body.error
    } catch {
      if (text) message = text
    }
    if (res.status === 401) onUnauthorized?.()
    throw new ApiError(res.status, message)
  }
  return text
}

export interface LoginResponse {
  token: string
}

export function login(username: string, password: string) {
  return request<LoginResponse>('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

// GET /api/v1/labs の生レスポンス（api-contract.md 2.1、{ [labName]: RawLabNode[] } 形状）
export interface RawLabNode {
  name: string
  container_id: string
  image: string
  kind: string
  state: string
  status: string
  ipv4_address?: string
  ipv6_address?: string
  lab_name: string
  nodeName: string
  labPath: string
  absLabPath: string
  group: string
  owner: string
}
export type RawLabsResponse = Record<string, RawLabNode[]>

export function getLabs() {
  return request<RawLabsResponse>('/api/v1/labs')
}

// POST /api/v1/labs のボディ（api-contract.md 2.2）。
// containerlab のトポロジYAMLと1:1のJSONオブジェクトをそのまま渡す。
export interface TopologyContent {
  name: string
  topology: {
    nodes: Record<string, { kind: string; image?: string; privileged?: boolean; 'cap-add'?: string[]; binds?: string[] }>
    links: { endpoints: [string, string] }[]
  }
}

export function deployLab(topologyContent: TopologyContent, opts?: { reconfigure?: boolean }) {
  const query = opts?.reconfigure ? '?reconfigure=true' : ''
  return request<RawLabsResponse>(`/api/v1/labs${query}`, {
    method: 'POST',
    body: JSON.stringify({ topologyContent }),
  })
}

// 既存ラボをトポロジエディタで開くための、デプロイ済みトポロジYAMLの取得
// （SwaggerのGET /api/v1/labs/{labName}/topology/yamlで2026-10-05に存在を確認）
export function getLabTopologyYaml(labName: string) {
  return requestText(`/api/v1/labs/${encodeURIComponent(labName)}/topology/yaml`)
}

// ノード座標・ラベル/エリア注釈の保存先。SwaggerではGET/PUT共にtext/plainの
// 「文字列を保存するだけ」のエンドポイントで、中身のフォーマットはクライアント側が決めてよい
// （2026-10-05確認）。独自のJSON形式で保存する（utils/annotations.ts参照）。
// 保存されていない場合は404（File not found）が返る。
export function getLabAnnotations(labName: string) {
  return requestText(`/api/v1/labs/${encodeURIComponent(labName)}/topology/annotations`)
}

export function putLabAnnotations(labName: string, content: string) {
  return requestText(`/api/v1/labs/${encodeURIComponent(labName)}/topology/annotations`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: content,
  })
}

export function destroyLab(labName: string) {
  return request<{ message: string }>(`/api/v1/labs/${encodeURIComponent(labName)}?cleanup=true`, {
    method: 'DELETE',
  })
}

// ラボを完全に削除する（コンテナの破棄＋ラボディレクトリごと削除、2026-10-14）。
// 自動保存になってからは、destroyだけだと保存済みトポロジが残って一覧に「停止中」として出続けるため
export function deleteLab(labName: string) {
  return request<{ message: string }>(`/api/v1/labs/${encodeURIComponent(labName)}?cleanup=true&purgeLabDir=true`, {
    method: 'DELETE',
  })
}

// ラボディレクトリ内のファイルを削除する。一度も起動していない（コンテナが無い）ラボは
// DELETE /labs/{name} の対象にならないため、保存済みトポロジのファイルを直接消す
export function deleteLabFile(labName: string, path: string) {
  return request<{ success: boolean }>(
    `/api/v1/labs/${encodeURIComponent(labName)}/topology/file?path=${encodeURIComponent(path)}`,
    { method: 'DELETE' },
  )
}

// ---- 自動保存＋差分反映（api-contract.md 2.7、2026-10-13実機確認） ----

// トポロジYAMLを保存する。未起動の新規ラボ名にも書ける（ラボディレクトリが作られる）
export function putLabTopologyYaml(labName: string, yamlText: string) {
  return requestText(`/api/v1/labs/${encodeURIComponent(labName)}/topology/yaml`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: yamlText,
  })
}

export interface ApplyResponse {
  dryRun: boolean
  deployedLab: boolean
  labName: string
  addedNodes: string[] | null
  deletedNodes: string[] | null
  recreatedNodes: string[] | null
  startedNodes: string[] | null
  restartedNodes: string[] | null
  addedLinks: string[] | null
  deletedEndpoints: string[] | null
}

// 保存済みトポロジをラボに反映する。動いていなければdeploy（停止中なら起動）、
// 動いていれば差分だけ反映し、既存ノードは作り直さない
export async function applyLab(labName: string) {
  try {
    return await request<ApplyResponse>(`/api/v1/labs/${encodeURIComponent(labName)}/apply`, { method: 'POST' })
  } catch (e) {
    // 同じIDのラボを別のユーザーが動かしていると、APIは「not found or not owned by user」を返す
    // （コンテナ名がサーバー全体で1つしか使えないため。2026-10-15以前に作ったラボで起こりうる。utils/labName.ts参照）
    if (e instanceof ApiError && e.status === 404 && /not owned/i.test(e.message)) {
      throw new ApiError(
        404,
        `ラボのID「${labName}」は別のユーザーのラボが使用中のため起動できません。新しいラボを作り、トポロジをYAMLで書き出して取り込んでください`,
      )
    }
    throw e
  }
}

// 保存済みラボ（未起動のものも含む）の一覧。`deploymentState`は常に"undeployed"で、
// 実際に動いているかはGET /api/v1/labs と突き合わせる（2026-10-14 Swaggerで確認）
export interface TopologyFileEntry {
  labName: string
  yamlFileName: string
  annotationsFileName: string
  hasAnnotations: boolean
}

export function getLabTopologyFiles() {
  return request<TopologyFileEntry[]>('/api/v1/labs/topology/files')
}

// ラボ全体のstart/stop/restart（api-contract.md 2.4）。ノード個別のstart/stopとは別エンドポイント。
function labAction(labName: string, action: 'start' | 'stop' | 'restart') {
  return request<{ message: string }>(`/api/v1/labs/${encodeURIComponent(labName)}/${action}`, {
    method: 'POST',
  })
}
export const startLab = (labName: string) => labAction(labName, 'start')
export const stopLab = (labName: string) => labAction(labName, 'stop')
export const restartLab = (labName: string) => labAction(labName, 'restart')

function nodeAction(labName: string, nodeName: string, action: 'start' | 'stop' | 'restart') {
  return request<{ message: string }>(
    `/api/v1/labs/${encodeURIComponent(labName)}/nodes/${encodeURIComponent(nodeName)}/${action}`,
    { method: 'POST' },
  )
}
export const startNode = (labName: string, nodeName: string) => nodeAction(labName, nodeName, 'start')
export const stopNode = (labName: string, nodeName: string) => nodeAction(labName, nodeName, 'stop')
export const restartNode = (labName: string, nodeName: string) => nodeAction(labName, nodeName, 'restart')

// 統合コンソール用セッション作成（api-contract.md 2.5、2026-09-24実機確認）。
// 注意: nodeNameは短いノード名ではなく、コンテナのフルネーム（clab-<labname>-<nodename>）を渡す。
export interface TerminalSessionInfo {
  sessionId: string
  labName: string
  nodeName: string
  protocol: string
  state: string
  createdAt: string
  expiresAt: string
}

export function createTerminalSession(labName: string, containerName: string) {
  return request<TerminalSessionInfo>(
    `/api/v1/labs/${encodeURIComponent(labName)}/nodes/${encodeURIComponent(containerName)}/terminal-sessions`,
    { method: 'POST', body: JSON.stringify({ protocol: 'shell', cols: 80, rows: 24 }) },
  )
}

// wipe相当（api-contract.md 2.4、2026-09-24実機確認）:
// 同一 topologyContent を reconfigure=true & nodeFilter=<node> 付きで送ると、
// 指定ノードだけコンテナが破棄・再作成される（他ノードは無影響）。
export function wipeNode(topologyContent: TopologyContent, nodeName: string) {
  return request<RawLabsResponse>(
    `/api/v1/labs?reconfigure=true&nodeFilter=${encodeURIComponent(nodeName)}`,
    { method: 'POST', body: JSON.stringify({ topologyContent }) },
  )
}

// コンテナ内でコマンドを実行する（api-contract.md 2.4）。PC/ルーターの固定IPアドレス設定に使う
// （L2スイッチも2026-10-13からコンテナになったので、VLAN設定はこの経路で投入する）。
// nodeFilterは短いノード名ではなく**コンテナのフルネーム**が必要（2026-10-07実機確認：
// 短い名前だと`filter did not match any containers`で失敗した。execはdeploy済みコンテナを
// 対象にするため、terminal-sessions（ConsoleSession.tsx）と同じ`clab-<labName>-<nodeName>`が
// 要る。wipeNode()のnodeFilterはトポロジ定義＝デプロイ前の層を指すので短い名前のままでよく、
// 同じ引数名でも層が違うため挙動が異なる点に注意）
export interface ExecResult {
  cmd: string[]
  'return-code': number
  stdout: string
  stderr: string
}
export type ExecResponse = Record<string, ExecResult[]>

export function execInLab(labName: string, nodeName: string, command: string) {
  const containerName = `clab-${labName}-${nodeName}`
  return request<ExecResponse>(
    `/api/v1/labs/${encodeURIComponent(labName)}/exec?nodeFilter=${encodeURIComponent(containerName)}`,
    { method: 'POST', body: JSON.stringify({ command }) },
  )
}

// パケットキャプチャ（WiresharkのnoVNCセッション）関連（api-contract.md参照、2026-10-08追加）。
// `containerName`はcapture_handlers.goのresolveCaptureContainer()がノード名の曖昧一致も
// 受け付けるため、execInLab()と違って短いノード名のままで通る想定（短い名前だと
// NodeNameとの一致でヒットする実装になっている、ソースコード確認済み）
export interface CaptureTarget {
  containerName: string
  interfaceName: string
}
export interface CaptureWiresharkVncSession {
  sessionId: string
  labName: string
  containerName: string
  interfaceNames: string[]
  vncPath: string
  showVolumeTip: boolean
  createdAt: string
  expiresAt: string
}
export interface CaptureWiresharkVncCreateResponse {
  sessions: CaptureWiresharkVncSession[]
}
export interface CaptureWiresharkVncReadyResponse {
  ready: boolean
  url: string
}

export function createCaptureSessions(labName: string, targets: CaptureTarget[]) {
  return request<CaptureWiresharkVncCreateResponse>(
    `/api/v1/labs/${encodeURIComponent(labName)}/capture/wireshark-vnc-sessions`,
    { method: 'POST', body: JSON.stringify({ targets }) },
  )
}

export function deleteCaptureSession(sessionId: string) {
  return request<unknown>(`/api/v1/capture/wireshark-vnc-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
}

export function getCaptureSessionReady(sessionId: string) {
  return request<CaptureWiresharkVncReadyResponse>(
    `/api/v1/capture/wireshark-vnc-sessions/${encodeURIComponent(sessionId)}/ready`,
  )
}

// リンクの品質（netem）。2026-10-14追加（utils/linkCondition.ts）。containerNameはexecと同じ
// `clab-<labName>-<nodeName>`（所有者のチェックがあり、自分のラボのコンテナにしか効かない）。
// setは指定しなかった項目を0に戻す（値の上書きではなく置き換え、CLIで確認）。
// resetは何も設定されていないI/Fに対してはエラーになる
export function setNetem(labName: string, nodeName: string, iface: string, params: NetemParams) {
  return request<unknown>('/api/v1/tools/netem/set', {
    method: 'POST',
    body: JSON.stringify({ containerName: `clab-${labName}-${nodeName}`, interface: iface, ...params }),
  })
}

export function resetNetem(labName: string, nodeName: string, iface: string) {
  return request<unknown>('/api/v1/tools/netem/reset', {
    method: 'POST',
    body: JSON.stringify({ containerName: `clab-${labName}-${nodeName}`, interface: iface }),
  })
}

export function showNetem(labName: string, nodeName: string) {
  const containerName = `clab-${labName}-${nodeName}`
  return request<Record<string, NetemInterfaceInfo[] | null>>(
    `/api/v1/tools/netem/show?containerName=${encodeURIComponent(containerName)}`,
  )
}

// サーバーのCPU・メモリ・ディスクの使用量（2026-10-14追加、画面下部のステータスバー用）。
// clab-api-server v0.6.0のソースで、ログインしていれば誰でも呼べることを確認
// （routes.goのコメントは「superuser only」だが、ハンドラに権限の確認は無い）。
// CPU使用率は1秒間測ってから返すので、応答に1秒ほどかかる。ディスクは「/」
export interface SystemMetrics {
  cpu?: { usagePercent?: number; numCPU?: number; loadAvg1?: number; loadAvg5?: number; loadAvg15?: number }
  mem?: { usagePercent?: number; totalMem?: number; usedMem?: number; availableMem?: number }
  disk?: { usagePercent?: number; totalDisk?: number; usedDisk?: number; freeDisk?: number; path?: string }
}

export function getSystemMetrics() {
  return request<{ metrics?: SystemMetrics }>('/api/v1/health/metrics')
}
