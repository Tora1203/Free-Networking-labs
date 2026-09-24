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

export function destroyLab(labName: string) {
  return request<{ message: string }>(`/api/v1/labs/${encodeURIComponent(labName)}?cleanup=true`, {
    method: 'DELETE',
  })
}

function nodeAction(labName: string, nodeName: string, action: 'start' | 'stop' | 'restart') {
  return request<{ message: string }>(
    `/api/v1/labs/${encodeURIComponent(labName)}/nodes/${encodeURIComponent(nodeName)}/${action}`,
    { method: 'POST' },
  )
}
export const startNode = (labName: string, nodeName: string) => nodeAction(labName, nodeName, 'start')
export const stopNode = (labName: string, nodeName: string) => nodeAction(labName, nodeName, 'stop')
export const restartNode = (labName: string, nodeName: string) => nodeAction(labName, nodeName, 'restart')

// wipe相当（api-contract.md 2.4、2026-09-24実機確認）:
// 同一 topologyContent を reconfigure=true & nodeFilter=<node> 付きで送ると、
// 指定ノードだけコンテナが破棄・再作成される（他ノードは無影響）。
export function wipeNode(topologyContent: TopologyContent, nodeName: string) {
  return request<RawLabsResponse>(
    `/api/v1/labs?reconfigure=true&nodeFilter=${encodeURIComponent(nodeName)}`,
    { method: 'POST', body: JSON.stringify({ topologyContent }) },
  )
}
