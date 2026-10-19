import { useState } from 'react'
import {
  CONDITION_PRESETS,
  LIMITS,
  RATE_PRESETS,
  conditionSummary,
  normalizeCondition,
  type LinkCondition,
} from '../utils/linkCondition'
import './LinkConditionDialog.css'

// リンクの品質（帯域・遅延・ゆらぎ・ロス・破損）を設定するダイアログ（2026-10-14追加）。
// 値はリンクの両方向に掛かる（utils/linkCondition.ts）。ケーブルの抜き差しは右クリックメニューで別に行う
interface Props {
  // 「R1 eth1 ⇔ SW1 eth2」のようなリンクの呼び名
  linkName: string
  initial: LinkCondition | undefined
  // ラボが動いているか（動いていれば保存と同時に反映される）
  running: boolean
  onApply: (condition: LinkCondition | undefined) => void
  onCancel: () => void
}

type Fields = { rate: string; customRate: string; delay: string; jitter: string; loss: string; corrupt: string }

const CUSTOM = 'custom'
// 帯域の選択肢の値（既定＝''、無制限＝'0'、それ以外はkbit/sの数字）
const rateValue = (kbit: number | undefined) => (kbit === undefined ? '' : String(kbit))

function toFields(c: LinkCondition | undefined): Fields {
  const rate = c?.rateKbit
  const preset = RATE_PRESETS.some((p) => p.kbit === rate)
  return {
    rate: preset ? rateValue(rate) : CUSTOM,
    customRate: preset ? '' : String(rate),
    delay: c?.delayMs ? String(c.delayMs) : '',
    jitter: c?.jitterMs ? String(c.jitterMs) : '',
    loss: c?.lossPct ? String(c.lossPct) : '',
    corrupt: c?.corruptPct ? String(c.corruptPct) : '',
  }
}

// 入力欄の値を確かめる。エラーがあれば説明を返す
function validate(f: Fields): string | null {
  const check = (text: string, label: string, max: number, integer: boolean) => {
    if (!text.trim()) return null
    const n = Number(text)
    if (!Number.isFinite(n) || n < 0) return `${label}は0以上の数で入力してください`
    if (integer && !Number.isInteger(n)) return `${label}は整数で入力してください`
    if (n > max) return `${label}は${max.toLocaleString()}以下にしてください`
    return null
  }
  return (
    (f.rate === CUSTOM ? check(f.customRate, '帯域', LIMITS.rateKbit, true) : null) ??
    check(f.delay, '遅延', LIMITS.delayMs, true) ??
    check(f.jitter, 'ゆらぎ', LIMITS.jitterMs, true) ??
    check(f.loss, 'ロス', 100, false) ??
    check(f.corrupt, '破損', 100, false) ??
    (f.jitter.trim() && Number(f.jitter) > 0 && !(Number(f.delay) > 0) ? 'ゆらぎは遅延を設定した時だけ使えます' : null)
  )
}

function toCondition(f: Fields): LinkCondition | undefined {
  return normalizeCondition({
    rateKbit: f.rate === CUSTOM ? f.customRate : f.rate,
    delayMs: f.delay,
    jitterMs: f.jitter,
    lossPct: f.loss,
    corruptPct: f.corrupt,
  })
}

export default function LinkConditionDialog({ linkName, initial, running, onApply, onCancel }: Props) {
  const [fields, setFields] = useState<Fields>(() => toFields(initial))
  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }))
  const error = validate(fields)
  const preview = error ? '' : conditionSummary(toCondition(fields))

  return (
    <div className="topology-editor__modal-overlay" onClick={onCancel}>
      <div className="topology-editor__modal link-condition" onClick={(e) => e.stopPropagation()}>
        <h3>リンクの品質</h3>
        <div className="link-condition__name">{linkName}</div>

        <div className="link-condition__presets">
          {CONDITION_PRESETS.map((p) => (
            <button key={p.label} type="button" title={p.description} onClick={() => setFields(toFields(p.condition))}>
              {p.label}
            </button>
          ))}
        </div>

        <label className="link-condition__field">
          <span>帯域</span>
          <span className="link-condition__inputs">
            <select value={fields.rate} onChange={set('rate')}>
              {RATE_PRESETS.map((p) => (
                <option key={p.label} value={rateValue(p.kbit)}>
                  {p.label}
                </option>
              ))}
              <option value={CUSTOM}>指定する...</option>
            </select>
            {fields.rate === CUSTOM && (
              <>
                <input inputMode="numeric" value={fields.customRate} onChange={set('customRate')} placeholder="例：2000" />
                <span className="link-condition__unit">kbps</span>
              </>
            )}
          </span>
        </label>
        <label className="link-condition__field">
          <span>遅延（片道）</span>
          <span className="link-condition__inputs">
            <input inputMode="numeric" value={fields.delay} onChange={set('delay')} placeholder="0" />
            <span className="link-condition__unit">ms</span>
          </span>
        </label>
        <label className="link-condition__field">
          <span>ゆらぎ（±）</span>
          <span className="link-condition__inputs">
            <input inputMode="numeric" value={fields.jitter} onChange={set('jitter')} placeholder="0" />
            <span className="link-condition__unit">ms</span>
          </span>
        </label>
        <label className="link-condition__field">
          <span>パケットロス</span>
          <span className="link-condition__inputs">
            <input inputMode="decimal" value={fields.loss} onChange={set('loss')} placeholder="0" />
            <span className="link-condition__unit">%</span>
          </span>
        </label>
        <label className="link-condition__field">
          <span>パケット破損</span>
          <span className="link-condition__inputs">
            <input inputMode="decimal" value={fields.corrupt} onChange={set('corrupt')} placeholder="0" />
            <span className="link-condition__unit">%</span>
          </span>
        </label>

        {error ? (
          <div className="topology-editor__modal-warn">{error}</div>
        ) : (
          <div className="link-condition__note">
            {preview ? `設定：${preview}` : '既定（帯域100Mbps、遅延・ロスなし）'}
            {fields.rate === '0' && (
              <>
                <br />
                無制限は実測で約8Gbps出ます。大量に流すとサーバーのCPUを使い切るので注意してください。
              </>
            )}
            <br />
            値は行きと帰りの両方に掛かります（遅延50msなら往復で約100ms）。
            {running ? '保存するとすぐに反映されます。' : 'ラボを起動した時に反映されます。'}
          </div>
        )}

        <div className="topology-editor__modal-actions">
          <button onClick={onCancel}>キャンセル</button>
          <button className="btn-primary" onClick={() => onApply(toCondition(fields))} disabled={!!error}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
