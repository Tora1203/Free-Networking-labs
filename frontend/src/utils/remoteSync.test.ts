import { describe, expect, it } from 'vitest'
import { remoteChanged } from './remoteSync'

describe('remoteChanged', () => {
  const base = { yaml: 'a', annotations: '{"x":1}' }
  it('基準が無ければ変わっていない扱い', () => {
    expect(remoteChanged(null, base)).toBe(false)
  })
  it('同じ内容なら変わっていない', () => {
    expect(remoteChanged(base, { ...base })).toBe(false)
  })
  it('YAMLかannotationsが違えば変わった', () => {
    expect(remoteChanged(base, { ...base, yaml: 'b' })).toBe(true)
    expect(remoteChanged(base, { ...base, annotations: null })).toBe(true)
  })
})
