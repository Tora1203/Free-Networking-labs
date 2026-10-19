import { useCallback, useEffect, useState } from 'react'
import { deleteLabSnapshot, errorMessage, listLabSnapshots, type SnapshotEntry } from '../utils/labRuntime'
import { SNAPSHOT_LIMIT, formatSnapshotTime } from '../utils/snapshot'
import './SnapshotDialog.css'

// ラボのスナップショットの一覧・保存・戻す・削除のダイアログ（2026-10-18、utils/snapshot.ts）。
// 保存と戻すの実処理はエディタ側（編集内容の保存、実行中ノードへの反映と順番をそろえる必要があるため）。
// 一覧の取得と削除はここで行う
interface Props {
  labName: string
  // ラボが動いているか（動いていなければ、ルーター・スイッチの設定は読めずトポロジだけの保存になる）
  running: boolean
  onTake: (title: string, note: string) => Promise<void>
  onRestore: (entry: SnapshotEntry) => void
  onClose: () => void
}

function defaultTitle() {
  return `${formatSnapshotTime(new Date().toISOString())} の状態`
}

export default function SnapshotDialog({ labName, running, onTake, onRestore, onClose }: Props) {
  const [entries, setEntries] = useState<SnapshotEntry[] | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    listLabSnapshots(labName)
      .then(setEntries)
      .catch((e: unknown) => setError(errorMessage(e, 'スナップショットの一覧を取得できませんでした')))
  }, [labName])
  useEffect(refresh, [refresh])

  const take = async () => {
    setWorking(true)
    setError(null)
    try {
      await onTake(title.trim() || defaultTitle(), note.trim())
      setTitle('')
      setNote('')
      refresh()
    } catch (e) {
      setError(errorMessage(e, 'スナップショットを保存できませんでした'))
    } finally {
      setWorking(false)
    }
  }

  const remove = async (entry: SnapshotEntry) => {
    if (!window.confirm(`スナップショット「${entry.meta.title}」を削除します。元に戻せません。よろしいですか？`)) return
    setWorking(true)
    setError(null)
    try {
      await deleteLabSnapshot(entry)
    } catch (e) {
      setError(errorMessage(e, '削除できませんでした'))
    } finally {
      setWorking(false)
      refresh()
    }
  }

  const full = (entries?.length ?? 0) >= SNAPSHOT_LIMIT

  return (
    <div className="topology-editor__modal-overlay" onClick={working ? undefined : onClose}>
      <div className="topology-editor__modal snapshot-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>スナップショット</h3>
        <p className="snapshot-dialog__lead">
          今のトポロジと、ルーター・スイッチの設定（write memory相当）を保存します。MACテーブルやOSPFの隣接などの
          実行中の状態は保存せず、戻した後に作り直されます。PCに手で入れた設定は保存されません。
        </p>

        <div className="snapshot-dialog__form">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`名前（例：${defaultTitle()}）`} maxLength={60} disabled={working} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="メモ（任意）" maxLength={200} disabled={working} />
          <button className="btn-primary" onClick={take} disabled={working || full}>
            {working ? '処理中...' : '今の状態を保存'}
          </button>
        </div>
        {!running && <div className="topology-editor__modal-warn">ラボが停止中のため、ルーター・スイッチの設定は保存されません（トポロジだけを保存します）。</div>}
        {full && <div className="topology-editor__modal-warn">上限（{SNAPSHOT_LIMIT}個）です。不要なものを削除してください。</div>}
        {error && <div className="topology-editor__modal-warn">{error}</div>}

        <div className="snapshot-dialog__list">
          {entries === null && !error && <p className="snapshot-dialog__empty">読み込み中...</p>}
          {entries?.length === 0 && <p className="snapshot-dialog__empty">まだありません</p>}
          {entries?.map((entry) => {
            const m = entry.meta
            const saved = Object.keys(m.configs).length
            return (
              <div className="snapshot-dialog__item" key={entry.labName}>
                <div className="snapshot-dialog__item-main">
                  <div className="snapshot-dialog__item-title">
                    {m.title || entry.labName}
                    {m.auto && <span className="snapshot-dialog__tag">自動</span>}
                  </div>
                  <div className="snapshot-dialog__item-meta">
                    {formatSnapshotTime(m.createdAt)} ・ ノード{m.nodeCount}台 ・ 設定を保存: {saved}台
                    {m.skipped.length > 0 && <span className="snapshot-dialog__skipped">（取れなかった: {m.skipped.join(', ')}）</span>}
                  </div>
                  {m.note && <div className="snapshot-dialog__item-note">{m.note}</div>}
                </div>
                <div className="snapshot-dialog__item-actions">
                  <button onClick={() => onRestore(entry)} disabled={working} title="この状態に戻します（戻す前の状態は自動で残します）">
                    戻す
                  </button>
                  <button className="btn-danger" onClick={() => remove(entry)} disabled={working}>
                    削除
                  </button>
                </div>
              </div>
            )
          })}
        </div>

        <div className="topology-editor__modal-actions">
          <button onClick={onClose} disabled={working}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
