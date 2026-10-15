// ラボのIDと表示名のテスト（2026-10-15追加。別のユーザーと同じ名前のラボを作ると起動できなかった不具合）
import { describe, expect, it } from 'vitest'
import { labIdPrefix, labTitleKey, toSafeLabName } from './labName'

describe('toSafeLabName', () => {
  it('先頭にユーザー名を付け、別のユーザーとIDが重ならない', () => {
    expect(toSafeLabName('2026101412', 'alice')).toBe('alice-2026101412')
    expect(toSafeLabName('2026101412', 'bob')).not.toBe(toSafeLabName('2026101412', 'alice'))
  })

  it('日本語などはハッシュにする（同じ入力なら同じID）', () => {
    const id = toSafeLabName('VLANの演習', 'alice')
    expect(id).toMatch(/^alice-lab-[0-9a-f]+$/)
    expect(toSafeLabName(' VLANの演習 ', 'alice')).toBe(id)
  })

  it('既にユーザー名で始まる名前には重ねて付けない', () => {
    expect(toSafeLabName('alice-test', 'alice')).toBe('alice-test')
  })

  it('ユーザー名のうちIDに使えない文字は-にする', () => {
    expect(labIdPrefix('a.b')).toBe('a-b')
    expect(labIdPrefix('.x')).toBe('x')
    expect(toSafeLabName('lab1', 'a.b')).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  })

  it('ユーザー名が無ければ従来どおり', () => {
    expect(toSafeLabName('lab1', null)).toBe('lab1')
  })
})

describe('labTitleKey', () => {
  it('前後の空白・全角半角・大文字小文字の違いは同じ表示名とみなす', () => {
    expect(labTitleKey(' Lab１ ')).toBe(labTitleKey('lab1'))
    expect(labTitleKey('演習A')).not.toBe(labTitleKey('演習B'))
  })
})
