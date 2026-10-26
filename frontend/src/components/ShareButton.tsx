import { useCallback, useEffect, useRef, useState } from 'react'
import { createShare, deleteShare, listShares, shareUrl, type ShareInfo, type ShareRole } from '../api/collabClient'
import './ShareButton.css'
import { Icon } from './Icon'

// ラボの「閲覧のみの共有リンク」を作る・取り消す（2026-10-16、docs/collab-design.md 段階2の試作）
export default function ShareButton({ labName }: { labName: string }) {
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [role, setRole] = useState<ShareRole>('view')
  const boxRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      setShares((await listShares()).filter((s) => s.labName === labName))
      setMessage(null)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '共有の一覧を取得できませんでした')
    }
  }, [labName])

  useEffect(() => {
    if (!open) return
    void refresh()
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, refresh])

  const create = async () => {
    setBusy(true)
    try {
      await createShare(labName, role)
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '共有を作れませんでした')
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (id: string) => {
    setBusy(true)
    try {
      await deleteShare(id)
      await refresh()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '取り消せませんでした')
    } finally {
      setBusy(false)
    }
  }
  const copy = (id: string) => {
    void navigator.clipboard?.writeText(shareUrl(id)).then(
      () => setMessage('リンクをコピーしました'),
      () => setMessage('コピーできませんでした。リンクを選択してコピーしてください'),
    )
  }

  return (
    <div className="share-button" ref={boxRef}>
      <button
        className="btn-icon"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="共有"
        title="共有：このラボを、リンクを知っている人と共有します（閲覧のみ／編集も可）"
      >
        <Icon name="share" />
      </button>
      {open && (
        <div className="share-button__panel">
          <div className="share-button__note">
            リンクを知っている人は、ログインすればこのラボを開けます。誰が見た・操作したかはサーバーのログに残ります。
            期限は最長8時間で、あなたのログインが切れると無効になります。
          </div>
          <label className="share-button__role">
            権限：
            <select value={role} onChange={(e) => setRole(e.target.value as ShareRole)}>
              <option value="view">閲覧のみ</option>
              <option value="edit">編集も可</option>
            </select>
          </label>
          {role === 'edit' && (
            <div className="share-button__warn">
              「編集も可」のリンクを開いた人は、あなたのノードで<strong>コマンドを実行でき</strong>、トポロジの変更・起動停止もできます。
              コンソールとキャプチャも使えます。信頼できる人にだけ渡してください。
            </div>
          )}
          {shares.map((s) => (
            <div key={s.id} className="share-button__row">
              <span className="share-button__role-tag">{s.role === 'edit' ? '編集可' : '閲覧'}</span>
              <input readOnly value={shareUrl(s.id)} onFocus={(e) => e.currentTarget.select()} />
              <button onClick={() => copy(s.id)}>コピー</button>
              <button className="btn-danger" onClick={() => void revoke(s.id)} disabled={busy}>
                取り消す
              </button>
              <div className="share-button__expires">期限: {new Date(s.expiresAt).toLocaleString()}</div>
            </div>
          ))}
          <button onClick={() => void create()} disabled={busy}>
            共有リンクを作る
          </button>
          {message && <div className="share-button__message">{message}</div>}
        </div>
      )}
    </div>
  )
}
