// clab-api-server との通信クライアント。
// 実際のレスポンス形状・エラー形式は docs/api-contract.md を参照（すべて実機確認済み）。

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
    nodes: Record<string, { kind: string; image?: string }>
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
