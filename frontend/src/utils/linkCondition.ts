// リンクの品質（帯域・遅延・ゆらぎ・ロス・破損）とケーブルの抜き差し（2026-10-14追加。
// 「今のリンクは何bpsで動いているのか」から始まった、CMLのリンク品質設定に当たる機能）。
//
// リンクはvethで、そのままでは帯域の制限が無い（実測で直結約8.5Gbps）。共有サーバー（CPU 4コア）で
// 1人のiperf等がCPUを使い切らないよう、何も設定しないリンクも**既定で100Mbps**に絞る（2026-10-14決定。
// 最大40人程度で使う想定で、iperf3 1本あたりのCPUが1Gbpsの約8.6%→約3%になる。「無制限」は明示的に選んだ時だけ）。品質の設定は
// clab-api-serverのnetem API（POST /api/v1/tools/netem/set）で、リンクの両端のI/Fに同じ値を入れる。
// netemは送信側にしか効かないので、両端に入れることで「行き」と「帰り」の両方に効く
// （遅延50msなら往復で100ms、ロス1%なら片道ごとに1%）。
// netemの設定はノードを停止→起動すると消える（2026-10-14 CLIで確認。相手側の端は残る）ので、
// 起動のたびに入れ直す（TopologyEditor / labRuntime）。
//
// ケーブルを抜く：vethはどちらかの端をdownにすると相手側がNO-CARRIER（notconnect）になるので、
// 片方の端だけdownにする。スイッチの端はエージェントが普段ポートを上げ直すため、
// スイッチの中のファイル（/run/fnl-switch/unplugged、backend/l2switch/swcli.py）に書いて
// downのままにしてもらう。スイッチが無いリンクはPC（無ければsource側のルーター）の端を
// `ip link set down`する。どちらの端を落とすかはlinkDownEnd()で決める。

export interface LinkCondition {
  // 帯域（kbit/s）。未設定＝既定（DEFAULT_RATE_KBIT）、0＝無制限
  rateKbit?: number
  // 片道の遅延（ms）
  delayMs?: number
  // 遅延のゆらぎ（ms、遅延を設定した時だけ効く）
  jitterMs?: number
  // パケットロス（%）
  lossPct?: number
  // パケット破損（%）
  corruptPct?: number
  // ケーブルを抜いている
  down?: boolean
}

export const LIMITS = {
  delayMs: 10000,
  jitterMs: 10000,
  rateKbit: 10_000_000,
}

// 何も設定しないリンクの帯域（kbit/s）
export const DEFAULT_RATE_KBIT = 100_000

// 帯域の選択肢（kbit/s）。undefined＝既定、0＝無制限
export const RATE_PRESETS: { label: string; kbit: number | undefined }[] = [
  { label: '100 Mbps（既定）', kbit: undefined },
  { label: '無制限', kbit: 0 },
  { label: '1 Gbps', kbit: 1_000_000 },
  { label: '10 Mbps', kbit: 10_000 },
  { label: '1.5 Mbps（T1）', kbit: 1_544 },
  { label: '512 kbps', kbit: 512 },
  { label: '128 kbps', kbit: 128 },
  { label: '64 kbps', kbit: 64 },
]

// よくある回線をまとめて選べるひな形
export const CONDITION_PRESETS: { label: string; description: string; condition: LinkCondition }[] = [
  { label: '既定に戻す', description: '100Mbps・遅延やロスなし', condition: {} },
  { label: '拠点間WAN', description: '10Mbps・片道10ms', condition: { rateKbit: 10_000, delayMs: 10 } },
  { label: '海外回線', description: '片道100ms±10ms', condition: { delayMs: 100, jitterMs: 10 } },
  { label: '衛星回線', description: '1Mbps・片道300ms', condition: { rateKbit: 1_000, delayMs: 300 } },
  { label: '不安定な無線', description: '片道5ms±20ms・ロス3%', condition: { delayMs: 5, jitterMs: 20, lossPct: 3 } },
]

function num(value: unknown, max: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(n, max)
}

// 保存データ・入力から読み直す（範囲外・0は外す。帯域の0＝無制限だけは残す）。何も残らなければundefined
export function normalizeCondition(value: unknown): LinkCondition | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const c: LinkCondition = {}
  const rate = num(v.rateKbit, LIMITS.rateKbit)
  if (rate !== undefined) c.rateKbit = Math.max(1, Math.round(rate))
  else if (v.rateKbit === 0 || v.rateKbit === '0') c.rateKbit = 0
  const delay = num(v.delayMs, LIMITS.delayMs)
  if (delay !== undefined) c.delayMs = Math.round(delay)
  const jitter = num(v.jitterMs, LIMITS.jitterMs)
  if (jitter !== undefined && c.delayMs) c.jitterMs = Math.round(jitter)
  const loss = num(v.lossPct, 100)
  if (loss !== undefined) c.lossPct = Math.round(loss * 100) / 100
  const corrupt = num(v.corruptPct, 100)
  if (corrupt !== undefined) c.corruptPct = Math.round(corrupt * 100) / 100
  if (v.down === true) c.down = true
  return Object.keys(c).length > 0 ? c : undefined
}


export function formatRate(kbit: number): string {
  if (kbit >= 1_000_000 && kbit % 1_000_000 === 0) return `${kbit / 1_000_000}Gbps`
  if (kbit >= 1_000) return `${Math.round(kbit / 100) / 10}Mbps`
  return `${kbit}kbps`
}

// 品質の要約（キャンバスのラベル・元に戻すの説明用）。既定のままなら空文字
export function conditionSummary(c: LinkCondition | undefined): string {
  if (!c) return ''
  const parts: string[] = []
  if (c.rateKbit === 0) parts.push('帯域無制限')
  else if (c.rateKbit) parts.push(formatRate(c.rateKbit))
  if (c.delayMs) parts.push(`${c.delayMs}ms${c.jitterMs ? `±${c.jitterMs}ms` : ''}`)
  if (c.lossPct) parts.push(`ロス${c.lossPct}%`)
  if (c.corruptPct) parts.push(`破損${c.corruptPct}%`)
  return parts.join('・')
}

// ---------------------------------------------------------------------------
// netem API（clab-api-server）に渡す値
// ---------------------------------------------------------------------------

export interface NetemParams {
  delay?: string
  jitter?: string
  loss?: number
  rate?: number
  corruption?: number
}

// 何も設定していないリンクにも既定の帯域を入れる。無制限で遅延・ロスも無い時だけnull（netemを外す）
export function netemParams(c: LinkCondition | undefined): NetemParams | null {
  const p: NetemParams = {}
  const rate = c?.rateKbit ?? DEFAULT_RATE_KBIT
  if (rate) p.rate = rate
  if (c?.delayMs) p.delay = `${c.delayMs}ms`
  if (c?.delayMs && c.jitterMs) p.jitter = `${c.jitterMs}ms`
  if (c?.lossPct) p.loss = c.lossPct
  if (c?.corruptPct) p.corruption = c.corruptPct
  return Object.keys(p).length > 0 ? p : null
}

// 「今入っている設定」と「入れたい設定」を比べるための文字列（設定なし＝空文字）
function stateKey(delayMs: number, jitterMs: number, loss: number, rate: number, corruption: number): string {
  if (!delayMs && !loss && !rate && !corruption) return ''
  return JSON.stringify([delayMs, delayMs ? jitterMs : 0, loss, rate, corruption])
}

export function netemKey(p: NetemParams | null): string {
  if (!p) return ''
  return stateKey(parseDurationMs(p.delay), parseDurationMs(p.jitter), p.loss ?? 0, p.rate ?? 0, p.corruption ?? 0)
}

// GET /api/v1/tools/netem/show の1行（設定の無いI/Fは値が空・0）
export interface NetemInterfaceInfo {
  interface: string
  delay?: string
  jitter?: string
  packet_loss?: number
  rate?: number
  corruption?: number
}

export function netemKeyFromShow(info: NetemInterfaceInfo): string {
  return stateKey(
    parseDurationMs(info.delay),
    parseDurationMs(info.jitter),
    Math.round((info.packet_loss ?? 0) * 100) / 100,
    info.rate ?? 0,
    Math.round((info.corruption ?? 0) * 100) / 100,
  )
}

// Goのtime.Durationの文字列（"50ms"、"1.5s"、"1m30s"、"0s"）をmsにする
const DURATION_UNITS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1000, ms: 1, us: 0.001, 'µs': 0.001, ns: 0.000001 }
export function parseDurationMs(text: string | undefined): number {
  if (!text) return 0
  let total = 0
  for (const [, value, unit] of text.matchAll(/([0-9.]+)(ms|us|µs|ns|h|m|s)/g)) {
    total += Number(value) * (DURATION_UNITS[unit] ?? 0)
  }
  return Math.round(total)
}

// ---------------------------------------------------------------------------
// ケーブルを抜く時に落とす端
// ---------------------------------------------------------------------------

type EndKind = 'switch' | 'pc' | 'router' | undefined

// スイッチの端があればそちら（相手側も自然にnotconnectになる）、無ければPCの端、
// ルーター同士ならsource側
export function linkDownEnd(sourceKind: EndKind, targetKind: EndKind): 'source' | 'target' {
  if (sourceKind === 'switch') return 'source'
  if (targetKind === 'switch') return 'target'
  if (sourceKind === 'pc') return 'source'
  if (targetKind === 'pc') return 'target'
  return 'source'
}
