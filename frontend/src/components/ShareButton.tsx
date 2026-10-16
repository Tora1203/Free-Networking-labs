import { useCallback, useEffect, useRef, useState } from 'react'
import { createShare, deleteShare, listShares, shareUrl, type ShareInfo } from '../api/collabClient'
import './ShareButton.css'

// ラボの「閲覧のみの共有リンク」を作る・取り消す（2026-10-16、docs/collab-design.md 段階2の試作）
export default function ShareButton({ labName }: { labName: string }) {
  const [open, setOpen] = useState(false)
  const [shares, setShares] = useState<ShareInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
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
      await createShare(labName)
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
      <button onClick={() => setOpen((v) => !v)} title="このラボを、リンクを知っている人に見せます（閲覧のみ）">
        共有
      </button>
      {open && (
        <div className="share-button__panel">
          <div className="share-button__note">
            リンクを知っている人は、ログインすればこのラボを<strong>見られます</strong>（操作はできません）。誰が見たかはサーバーのログに残ります。
            期限は最長8時間で、あなたのログインが切れると無効になります。
          </div>
          {shares.map((s) => (
            <div key={s.id} className="share-button__row">
              <input readOnly value={shareUrl(s.id)} onFocus={(e) => e.currentTarget.select()} />
              <button onClick={() => copy(s.id)}>コピー</button>
              <button onClick={() => void revoke(s.id)} disabled={busy}>
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
