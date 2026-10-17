// backend/collab-proxy/ のクライアント（ラボの閲覧のみの共有リンク、2026-10-16、docs/collab-design.md）。
// 持ち主の操作（共有の作成・一覧・取り消し）も、ゲストの閲覧も、ログインのトークンが要る（ゲストも自分のアカウントでログインする）。
import { ApiError, getAuthToken, getShareRoute, notifyUnauthorized, type RawLabNode } from './client'

const COLLAB_BASE_URL = import.meta.env.VITE_COLLAB_PROXY_URL ?? 'http://localhost:8085'

export interface ShareInfo {
  id: string
  labName: string
  role: ShareRole
  expiresAt: string
}

// view=見るだけ。edit=トポロジの編集・起動停止・ノードでのコマンド実行まで（持ち主のノードを触らせる）
export type ShareRole = 'view' | 'edit'

export interface SharedLab {
  labName: string
  owner: string
  viewer: string
  role: ShareRole
  expiresAt: string
  yaml: string
  annotations: string | null
  nodes: RawLabNode[]
}

async function call<T>(path: string, init: RequestInit = {}, auth = false, quiet = false): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (auth || quiet) {
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
    if (res.status === 401 && auth && !quiet) notifyUnauthorized()
    throw new ApiError(res.status, message)
  }
  return body as T
}

export function createShare(labName: string, role: ShareRole = 'view') {
  return call<ShareInfo>('/shares', { method: 'POST', body: JSON.stringify({ labName, role }) }, true)
}

export async function listShares() {
  return (await call<{ shares: ShareInfo[] }>('/shares', {}, true)).shares
}

export function deleteShare(id: string) {
  return call<{ ok: true }>(`/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }, true)
}

export function getSharedLab(id: string) {
  return call<SharedLab>(`/s/${encodeURIComponent(id)}`, {}, true)
}

// 自分のラボのトポロジ（YAML＋注釈）の今の版（短いハッシュ）。保存の前後の確認に使う軽い問い合わせ。
// fresh=trueは見張りの次の周期を待たず今の上流を見て、見ている画面にも通知する。取れない時はnull
export async function getLabVersion(labName: string, fresh = false): Promise<string | null> {
  try {
    // 編集できる共有でラボを開いている間は、共有の窓口で聞く
    const shareId = getShareRoute()
    const base = shareId ? `/s/${encodeURIComponent(shareId)}/version` : `/version/${encodeURIComponent(labName)}`
    const r = await call<{ version: string }>(`${base}${fresh ? '?fresh=1' : ''}`, {}, false, true)
    return r.version
  } catch {
    return null
  }
}

// ラボの変更の通知（SSE、collab-proxyの`/watch/<ラボ>`と`/s/<id>/watch`）を受ける。
// 変わったら onVersion が呼ばれる（接続直後にも1回）。切れたら間隔を空けて繋ぎ直す。止める関数を返す
export interface VersionEvent {
  version: string
  // 通知に付いてくる、その版の中身（付いていない時はnull。画面は取り直す）
  yaml: string | null
  annotations: string | null
}

export function watchPath(path: string, onVersion: (event: VersionEvent) => void): () => void {
  let stopped = false
  let ctrl: AbortController | null = null
  const run = async () => {
    let delay = 1000
    while (!stopped) {
      try {
        const token = getAuthToken()
        if (!token) return
        ctrl = new AbortController()
        const res = await fetch(`${COLLAB_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
        // 見つからない・権限が無い時は、繋ぎ直しても直らないので諦める（定期的な取得だけで動く）
        if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) return
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
        delay = 1000
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let i: number
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            const event = /^event: (.+)$/m.exec(block)?.[1]
            if (event === 'version') {
              try {
                const d = JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? '{}')
                onVersion({
                  version: String(d.version ?? ''),
                  yaml: typeof d.yaml === 'string' ? d.yaml : null,
                  annotations: typeof d.annotations === 'string' ? d.annotations : null,
                })
              } catch {
                onVersion({ version: '', yaml: null, annotations: null })
              }
            }
            if (event === 'closed') return
          }
        }
      } catch {
        if (stopped) return
      }
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 15000)
    }
  }
  void run()
  return () => {
    stopped = true
    ctrl?.abort()
  }
}

export const watchLab = (labName: string, onVersion: (event: VersionEvent) => void) => {
  const shareId = getShareRoute()
  return watchPath(shareId ? `/s/${encodeURIComponent(shareId)}/watch` : `/watch/${encodeURIComponent(labName)}`, onVersion)
}
export const watchShare = (id: string, onVersion: (event: VersionEvent) => void) => watchPath(`/s/${encodeURIComponent(id)}/watch`, onVersion)

// 共有リンクのURL（ハッシュに合言葉を入れる。サーバーのアクセスログに残らない）
export function shareUrl(id: string) {
  return `${window.location.origin}/#/share/${id}`
}

export function shareIdFromHash(hash: string): string | null {
  const m = /^#\/share\/([A-Za-z0-9_-]{32})$/.exec(hash)
  return m ? m[1] : null
}
