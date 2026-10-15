// リンクの品質（netem）の値の変換のテスト（2026-10-15追加）
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RATE_KBIT,
  conditionSummary,
  netemKey,
  netemKeyFromShow,
  netemParams,
  normalizeCondition,
  parseDurationMs,
} from './linkCondition'

describe('normalizeCondition', () => {
  it('0・負・数でないものは外し、帯域の0（無制限）だけは残す', () => {
    expect(normalizeCondition({ rateKbit: 0, delayMs: 0, lossPct: -1, corruptPct: 'x' })).toEqual({ rateKbit: 0 })
    expect(normalizeCondition({ delayMs: 0 })).toBeUndefined()
    expect(normalizeCondition(null)).toBeUndefined()
    expect(normalizeCondition('50')).toBeUndefined()
  })

  it('入力欄の文字列を数にし、上限で切る', () => {
    expect(normalizeCondition({ delayMs: '50', lossPct: '0.123', corruptPct: '200' })).toEqual({ delayMs: 50, lossPct: 0.12, corruptPct: 100 })
  })

  it('ゆらぎは遅延がある時だけ', () => {
    expect(normalizeCondition({ jitterMs: 10 })).toBeUndefined()
    expect(normalizeCondition({ delayMs: 20, jitterMs: 10 })).toEqual({ delayMs: 20, jitterMs: 10 })
  })

  it('ケーブルを抜いた状態はtrueの時だけ', () => {
    expect(normalizeCondition({ down: true })).toEqual({ down: true })
    expect(normalizeCondition({ down: 'yes' })).toBeUndefined()
  })
})

describe('netemParams', () => {
  it('設定が無くても既定の帯域を入れる', () => {
    expect(netemParams(undefined)).toEqual({ rate: DEFAULT_RATE_KBIT })
    expect(netemParams({ down: true })).toEqual({ rate: DEFAULT_RATE_KBIT })
  })

  it('無制限で他に何も無ければnull（netemを外す）', () => {
    expect(netemParams({ rateKbit: 0 })).toBeNull()
    expect(netemParams({ rateKbit: 0, delayMs: 10 })).toEqual({ delay: '10ms' })
  })

  it('全部の値', () => {
    expect(netemParams({ rateKbit: 1000, delayMs: 50, jitterMs: 5, lossPct: 1.5, corruptPct: 0.1 })).toEqual({
      rate: 1000,
      delay: '50ms',
      jitter: '5ms',
      loss: 1.5,
      corruption: 0.1,
    })
  })
})

describe('今の設定と入れたい設定の比較', () => {
  it('APIのshowの値と、入れる値が同じなら同じキー', () => {
    const p = netemParams({ rateKbit: 1000, delayMs: 50, jitterMs: 5, lossPct: 1.5 })
    expect(netemKeyFromShow({ interface: 'eth1', delay: '50ms', jitter: '5ms', packet_loss: 1.5, rate: 1000, corruption: 0 })).toBe(netemKey(p))
  })

  it('設定の無いI/Fと「外す」は空文字', () => {
    expect(netemKey(null)).toBe('')
    expect(netemKeyFromShow({ interface: 'eth1', delay: '0s', jitter: '0s', packet_loss: 0, rate: 0, corruption: 0 })).toBe('')
  })

  it('遅延が無ければゆらぎは比べない', () => {
    expect(netemKeyFromShow({ interface: 'eth1', jitter: '5ms', rate: 1000 })).toBe(netemKey({ rate: 1000 }))
  })
})

describe('parseDurationMs（Goのtime.Durationの文字列）', () => {
  it.each([
    ['50ms', 50],
    ['1.5s', 1500],
    ['1m30s', 90_000],
    ['0s', 0],
    ['500µs', 1],
    ['', 0],
    [undefined, 0],
  ])('%s → %d', (text, ms) => expect(parseDurationMs(text)).toBe(ms))
})

describe('conditionSummary', () => {
  it('キャンバスのラベル', () => {
    expect(conditionSummary(undefined)).toBe('')
    expect(conditionSummary({ rateKbit: 0 })).toBe('帯域無制限')
    expect(conditionSummary({ rateKbit: 1_000_000, delayMs: 20, jitterMs: 5, lossPct: 1, corruptPct: 0.5 })).toBe('1Gbps・20ms±5ms・ロス1%・破損0.5%')
    expect(conditionSummary({ rateKbit: 1500 })).toBe('1.5Mbps')
  })
})
