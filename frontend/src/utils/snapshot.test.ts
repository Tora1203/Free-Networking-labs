import { describe, expect, it } from 'vitest'
import { load as loadYaml } from 'js-yaml'
import {
  SNAPSHOT_MAX_CHARS,
  buildReadConfigCommand,
  buildSnapshotFiles,
  buildWriteConfigCommand,
  decodeConfigOutput,
  isSnapshotLabName,
  parseSnapshotLabName,
  readSnapshotMeta,
  snapshotLabName,
  stripSnapshotMeta,
} from './snapshot'

const YAML = 'name: lab1\ntopology:\n  nodes:\n    R1:\n      kind: linux\n    PC1:\n      kind: linux\n  links: []\n'

describe('スナップショットのラボ名', () => {
  it('日時14桁の名前を作り、元のラボ名を取り出せる', () => {
    const name = snapshotLabName('taro-lab1', new Date(2026, 9, 18, 14, 5, 9))
    expect(name).toBe('taro-lab1-snap-20261018140509')
    expect(parseSnapshotLabName(name)).toEqual({ parent: 'taro-lab1', stamp: '20261018140509' })
    expect(isSnapshotLabName(name)).toBe(true)
  })
  it('普通のラボ名はスナップショットとみなさない', () => {
    expect(isSnapshotLabName('taro-lab1')).toBe(false)
    expect(isSnapshotLabName('lab-snap-1')).toBe(false)
    expect(parseSnapshotLabName('x')).toBeNull()
  })
})

describe('設定の読み書きのコマンド', () => {
  it('ルーターは write memory が失敗したら cat しない', () => {
    expect(buildReadConfigCommand('router')).toContain('vtysh -c "write memory" >/dev/null && cat /etc/frr/frr.conf | base64')
  })
  it('スイッチは running-config を startup-config に写してから読む', () => {
    const c = buildReadConfigCommand('l2-switch')
    expect(c).toContain('cp $f /etc/fnl-switch/startup.json')
    expect(c).toContain('cat /etc/fnl-switch/startup.json')
  })
  it('読み取りの出力はbase64を戻す（日本語・JSONも壊さない）', () => {
    const text = '{"hostname":"SW1","note":"説明"}\n'
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    expect(decodeConfigOutput(b64 + '\n')).toBe(text)
    expect(decodeConfigOutput('')).toBe('')
    expect(() => decodeConfigOutput({ hostname: 'SW1' })).toThrow()
  })
  it('書き込みはbase64で渡し、日本語も壊さない', () => {
    const text = 'hostname R1\n! 説明\n'
    const cmd = buildWriteConfigCommand('router', text)
    const b64 = /echo ([A-Za-z0-9+/=]+) \|/.exec(cmd)?.[1] ?? ''
    expect(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))).toBe(text)
    expect(cmd).toContain('> /etc/frr/frr.conf')
    expect(buildWriteConfigCommand('l2-switch', '{"a":1}')).toContain('> /etc/fnl-switch/startup.json')
  })
  it('スイッチの空の設定はstartup-configを消す', () => {
    expect(buildWriteConfigCommand('l2-switch', '')).toContain('rm -f /etc/fnl-switch/startup.json')
  })
})

describe('保存するファイルの組み立て', () => {
  const input = { title: '課題の前', note: 'OSPF設定前', configs: { R1: { kind: 'router' as const, text: 'hostname R1\n' } }, skipped: ['SW1'] }

  it('YAMLの名前をスナップショットのラボ名にし、annotationsの他の項目を残す', () => {
    const files = buildSnapshotFiles('lab1-snap-20261018140509', YAML, '{"version":2,"positions":{"R1":{"x":1,"y":2}},"extraNodes":[],"title":"授業"}', input)
    expect((loadYaml(files.yaml) as { name: string }).name).toBe('lab1-snap-20261018140509')
    const ann = JSON.parse(files.annotations)
    expect(ann.positions.R1).toEqual({ x: 1, y: 2 })
    expect(ann.title).toBe('授業')
    expect(files.meta.nodeCount).toBe(2)
  })
  it('annotationsが無くても保存でき、読み戻せる', () => {
    const files = buildSnapshotFiles('lab1-snap-20261018140509', YAML, null, input)
    const meta = readSnapshotMeta(files.annotations)
    expect(meta?.title).toBe('課題の前')
    expect(meta?.configs.R1.text).toBe('hostname R1\n')
    expect(meta?.skipped).toEqual(['SW1'])
  })
  it('大きすぎるものは保存しない', () => {
    const big = { kind: 'router' as const, text: 'x'.repeat(199_000) }
    const configs = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`R${i}`, big]))
    expect(SNAPSHOT_MAX_CHARS).toBeLessThan(5 * 199_000)
    expect(() => buildSnapshotFiles('lab1-snap-20261018140509', YAML, null, { ...input, configs })).toThrow('大きすぎ')
  })
  it('壊れたYAMLは保存しない', () => {
    expect(() => buildSnapshotFiles('x-snap-20261018140509', '- a\n- b: [', null, input)).toThrow()
  })
})

describe('スナップショットの読み出し', () => {
  it('snapshotキーが無い・壊れていればnull', () => {
    expect(readSnapshotMeta(null)).toBeNull()
    expect(readSnapshotMeta('{"version":2}')).toBeNull()
    expect(readSnapshotMeta('not json')).toBeNull()
  })
  it('使えないノード名・種類の設定は読み捨てる', () => {
    const text = JSON.stringify({
      snapshot: {
        version: 1,
        createdAt: '2026-10-18T05:00:00.000Z',
        configs: { 'R1': { kind: 'router', text: 'a' }, '../x': { kind: 'router', text: 'b' }, R2: { kind: 'pc', text: 'c' } },
      },
    })
    expect(Object.keys(readSnapshotMeta(text)?.configs ?? {})).toEqual(['R1'])
  })
  it('戻す時はsnapshotキーを除く', () => {
    expect(JSON.parse(stripSnapshotMeta('{"version":2,"snapshot":{"a":1},"positions":{}}'))).toEqual({ version: 2, positions: {} })
  })
})
