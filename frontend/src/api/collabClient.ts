// backend/collab-proxy/ のクライアント（ラボの閲覧のみの共有リンク、2026-10-16、docs/collab-design.md）。
// 持ち主の操作（共有の作成・一覧・取り消し）はログインのトークンで、ゲストの閲覧はトークン無し（idが合言葉）。
import { ApiError, getAuthToken, type RawLabNode } from './client'

const COLLAB_BASE_URL = import.meta.env.VITE_COLLAB_PROXY_URL ?? 'http://localhost:8085'

export interface ShareInfo {
  id: string
  labName: string
  role: 'view'
  expiresAt: string
}

export interface SharedLab {
  labName: string
  owner: string
  role: 'view'
  expiresAt: string
  yaml: string
  annotations: string | null
  nodes: RawLabNode[]
}

async function call<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (auth) {
    const token = getAuthToken()
    if (!token) throw new Error('ログインしていません')
    headers.set('Authorization', `Bearer ${token}`)
  }
  const res = await fetch(`${COLLAB_BASE_URL}${path}`, { ...init, headers })
  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  if (!res.ok) {
    const message = (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : undefined) ?? `HTTP ${res.status}`
    throw new ApiError(res.status, message)
  }
  return body as T
}

export function createShare(labName: string) {
  return call<ShareInfo>('/shares', { method: 'POST', body: JSON.stringify({ labName }) }, true)
}

export async function listShares() {
  return (await call<{ shares: ShareInfo[] }>('/shares', {}, true)).shares
}

export function deleteShare(id: string) {
  return call<{ ok: true }>(`/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }, true)
}

export function getSharedLab(id: string) {
  return call<SharedLab>(`/s/${encodeURIComponent(id)}`)
}

// 共有リンクのURL（ハッシュに合言葉を入れる。サーバーのアクセスログに残らない）
export function shareUrl(id: string) {
  return `${window.location.origin}/#/share/${id}`
}

export function shareIdFromHash(hash: string): string | null {
  const m = /^#\/share\/([A-Za-z0-9_-]{32})$/.exec(hash)
  return m ? m[1] : null
}
