// ラボのスナップショット（2026-10-18）。設計は docs/snapshot-design.md。
//
// 1つのスナップショット＝起動しない別ラボ `<ラボ>-snap-<日時14桁>` として保存する（案B）。
// トポロジのYAML、座標などのannotations、ルーター・スイッチの設定（write memory相当）の全文を持つ。
// 設定の全文はannotationsの `snapshot` キーに入れる。元のラボのannotationsには何も足さないので、
// エディタの自動保存や「別の画面の変更」の判定には影響しない。
// 実行中の状態（MACテーブル、OSPFの隣接、ARP）は保存しない。戻した後に再収束させる。
import { dump as dumpYaml, load as loadYaml } from 'js-yaml'

// 1つのラボに残せるスナップショットの数
export const SNAPSHOT_LIMIT = 20
// 1つのスナップショットの大きさの上限（YAML＋annotations、文字数）。保存先のAPIの上限が分からないため安全側
export const SNAPSHOT_MAX_CHARS = 900_000
// ノード1台の設定の大きさの上限
const NODE_CONFIG_MAX_CHARS = 200_000

const SNAPSHOT_NAME_PATTERN = /^(.+)-snap-(\d{14})$/

function pad(n: number, width = 2) {
  return String(n).padStart(width, '0')
}

export function snapshotLabName(parent: string, date = new Date()): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${parent}-snap-${stamp}`
}

// スナップショット用のラボ名なら、元のラボ名を返す
export function parseSnapshotLabName(name: string): { parent: string; stamp: string } | null {
  const m = SNAPSHOT_NAME_PATTERN.exec(name)
  return m ? { parent: m[1], stamp: m[2] } : null
}

export function isSnapshotLabName(name: string): boolean {
  return SNAPSHOT_NAME_PATTERN.test(name)
}

export type ConfigNodeKind = 'router' | 'l2-switch'

export interface NodeConfig {
  kind: ConfigNodeKind
  text: string
}

export interface SnapshotMeta {
  version: 1
  title: string
  note: string
  // ISO 8601
  createdAt: string
  // 戻す前に自動で取ったもの（容量がいっぱいの時に古いものから消してよい）
  auto?: boolean
  nodeCount: number
  // 設定を取れたノード（clabName→設定）
  configs: Record<string, NodeConfig>
  // 設定を取れなかったノード（停止中など）。戻す時はこのノードの設定に触らない
  skipped: string[]
}

// ---- 設定の読み書きのコマンド（コンテナの中で実行する） ----

const NODE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

// write memory相当を行い、保存された設定の全文を標準出力に出す。
// ルーター：`vtysh -c 'write memory'`が失敗したら取れなかったことにする（古い内容を黙って保存しない）。
// スイッチ：running-config（/run/fnl-switch/running.json）をstartup-configに写す（swcliの`write memory`と同じ）。
// 一度も設定していないスイッチは空の設定（＝初期状態）として扱う
export function buildReadConfigCommand(kind: ConfigNodeKind): string {
  if (kind === 'router') {
    return `sh -c 'vtysh -c "write memory" >/dev/null && cat /etc/frr/frr.conf | base64 | tr -d "\\n"'`
  }
  return `sh -c 'f=/run/fnl-switch/running.json; if [ -f $f ]; then cp $f /etc/fnl-switch/startup.json; fi; cat /etc/fnl-switch/startup.json 2>/dev/null | base64 | tr -d "\\n"; true'`
}

// 読み取りの出力（base64）を元の文字列に戻す。標準出力をそのまま返すと、スイッチの設定（JSON）を
// containerlabがJSONとして解釈して文字列でなくなる（2026-10-18、スイッチだけ取れなかった）ため、base64で受け取る
export function decodeConfigOutput(stdout: unknown): string {
  if (typeof stdout !== 'string') throw new Error('出力を読めませんでした')
  const binary = atob(stdout.trim())
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

// 保存先に設定の全文を書く。bind mountされたファイルは差し替えられないので、同じファイルの中身を書き換える
// （labTopology.buildWipeCommandと同じ事情）。スイッチの空の設定は、startup-configを消す（初期状態）
export function buildWriteConfigCommand(kind: ConfigNodeKind, text: string): string {
  if (kind === 'l2-switch' && text.trim() === '') {
    return `sh -c 'rm -f /etc/fnl-switch/startup.json /etc/fnl-switch/startup.json.tmp'`
  }
  const target = kind === 'router' ? '/etc/frr/frr.conf' : '/etc/fnl-switch/startup.json'
  return `sh -c 'echo ${toBase64(text)} | base64 -d > ${target}'`
}

export function isValidNodeName(name: string): boolean {
  return NODE_NAME_PATTERN.test(name)
}

// ---- 保存するファイルの組み立て・読み出し ----

export interface SnapshotFiles {
  yaml: string
  annotations: string
  meta: SnapshotMeta
}

// 元のラボのYAML・annotationsから、スナップショットのラボに書くファイルを作る。
// YAMLの`name`はスナップショットのラボ名にする（保存先のラボ名と食い違わないように）
export function buildSnapshotFiles(
  snapLabName: string,
  yamlText: string,
  annotationsText: string | null,
  input: { title: string; note: string; auto?: boolean; configs: Record<string, NodeConfig>; skipped: string[]; now?: Date },
): SnapshotFiles {
  const doc = loadYaml(yamlText) as { name?: string; topology?: { nodes?: Record<string, unknown> } } | null
  if (!doc || typeof doc !== 'object') throw new Error('トポロジのYAMLを読めませんでした')
  doc.name = snapLabName
  const nodeCount = Object.keys(doc.topology?.nodes ?? {}).length

  for (const [name, config] of Object.entries(input.configs)) {
    if (config.text.length > NODE_CONFIG_MAX_CHARS) throw new Error(`「${name}」の設定が大きすぎてスナップショットに入れられません`)
  }
  const meta: SnapshotMeta = {
    version: 1,
    title: input.title,
    note: input.note,
    createdAt: (input.now ?? new Date()).toISOString(),
    ...(input.auto ? { auto: true } : {}),
    nodeCount,
    configs: input.configs,
    skipped: input.skipped,
  }

  let annotations: Record<string, unknown> = { version: 2, positions: {}, extraNodes: [] }
  if (annotationsText) {
    try {
      const parsed = JSON.parse(annotationsText)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) annotations = parsed
    } catch {
      // 壊れていれば座標なしで保存する（戻した時はグリッド配置になる）
    }
  }
  const files: SnapshotFiles = {
    yaml: dumpYaml(doc, { lineWidth: -1 }),
    annotations: JSON.stringify({ ...annotations, snapshot: meta }),
    meta,
  }
  if (files.yaml.length + files.annotations.length > SNAPSHOT_MAX_CHARS) {
    throw new Error('スナップショットが大きすぎて保存できません（ノードの設定を減らしてください）')
  }
  return files
}

// スナップショットのannotationsから、見出し・設定を取り出す（壊れていれば null）
export function readSnapshotMeta(annotationsText: string | null): SnapshotMeta | null {
  if (!annotationsText) return null
  try {
    const raw = (JSON.parse(annotationsText) as { snapshot?: Partial<SnapshotMeta> } | null)?.snapshot
    if (!raw || raw.version !== 1 || typeof raw.createdAt !== 'string') return null
    const configs: Record<string, NodeConfig> = {}
    for (const [name, c] of Object.entries(raw.configs ?? {})) {
      if (!isValidNodeName(name)) continue
      if (c && (c.kind === 'router' || c.kind === 'l2-switch') && typeof c.text === 'string') configs[name] = { kind: c.kind, text: c.text }
    }
    return {
      version: 1,
      title: typeof raw.title === 'string' ? raw.title : '',
      note: typeof raw.note === 'string' ? raw.note : '',
      createdAt: raw.createdAt,
      ...(raw.auto ? { auto: true } : {}),
      nodeCount: typeof raw.nodeCount === 'number' ? raw.nodeCount : 0,
      configs,
      skipped: Array.isArray(raw.skipped) ? raw.skipped.filter((s): s is string => typeof s === 'string') : [],
    }
  } catch {
    return null
  }
}

// 戻す時に使うannotations（snapshotキーを除く）。座標・ラベルなどをそのまま使う
export function stripSnapshotMeta(annotationsText: string): string {
  try {
    const parsed = JSON.parse(annotationsText) as Record<string, unknown>
    delete parsed.snapshot
    return JSON.stringify(parsed)
  } catch {
    return annotationsText
  }
}

// 一覧に出す日時（例：2026/10/18 14:05）
export function formatSnapshotTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
