import { useEffect, useRef, useState } from 'react'
import { getSystemMetrics, type SystemMetrics } from '../api/client'
import './ServerStatusBar.css'

// 画面下部の、サーバー（lab-server）のCPU・メモリ・ディスク使用量の表示（2026-10-14追加。
// 40人程度で1台を共有する前提で、混み具合が見えるように）。どれを出すかはナビの📊で選び、
// ブラウザに覚えておく（利用者ごとの見た目の好みなのでlocalStorageでよい）。
// 1つも選ばなければバーごと出さず、APIも呼ばない。

export type ServerStatusItem = 'cpu' | 'mem' | 'disk'
export const SERVER_STATUS_ITEMS: { key: ServerStatusItem; label: string }[] = [
  { key: 'cpu', label: 'CPU' },
  { key: 'mem', label: 'メモリ' },
  { key: 'disk', label: 'ディスク' },
]

const STORAGE_KEY = 'serverStatusItems'
const POLL_MS = 10_000

export function readServerStatusItems(): ServerStatusItem[] {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    if (Array.isArray(saved)) return SERVER_STATUS_ITEMS.map((i) => i.key).filter((k) => saved.includes(k))
  } catch {
    // 読めなければ既定（全部出す）
  }
  return ['cpu', 'mem', 'disk']
}

export function saveServerStatusItems(items: ServerStatusItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // 保存できなくても、開いている間の表示には困らない
  }
}

const GB = 1024 ** 3
const gb = (bytes: number | undefined) => (bytes === undefined ? '?' : (bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0))

function level(percent: number | undefined): 'ok' | 'warn' | 'danger' {
  if (percent === undefined) return 'ok'
  if (percent >= 90) return 'danger'
  if (percent >= 80) return 'warn'
  return 'ok'
}

function Meter({ label, percent, detail, title }: { label: string; percent?: number; detail: string; title: string }) {
  const value = percent === undefined ? undefined : Math.max(0, Math.min(100, percent))
  return (
    <span className={`server-status__item server-status__item--${level(value)}`} title={title}>
      <span className="server-status__label">{label}</span>
      <span className="server-status__meter" aria-hidden>
        <span className="server-status__meter-fill" style={{ width: `${value ?? 0}%` }} />
      </span>
      <span className="server-status__value">{value === undefined ? '--' : `${Math.round(value)}%`}</span>
      <span className="server-status__detail">{detail}</span>
    </span>
  )
}

export default function ServerStatusBar({ items }: { items: ServerStatusItem[] }) {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)
  const [error, setError] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const inFlight = useRef(false)
  const enabled = items.length > 0

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const poll = async () => {
      // 裏のタブでは取得しない（40人が開きっぱなしにしても無駄に呼ばないように）
      if (document.hidden || inFlight.current) return
      inFlight.current = true
      try {
        const res = await getSystemMetrics()
        if (cancelled) return
        setMetrics(res.metrics ?? null)
        setError(false)
        setUpdatedAt(new Date())
      } catch {
        if (!cancelled) setError(true)
      } finally {
        inFlight.current = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled])

  if (!enabled) return null

  const cpu = metrics?.cpu
  const mem = metrics?.mem
  const disk = metrics?.disk
  const time = updatedAt ? updatedAt.toLocaleTimeString('ja-JP') : ''

  return (
    <footer className="server-status" aria-label="サーバーの使用状況">
      <span className="server-status__title">サーバー</span>
      {items.includes('cpu') && (
        <Meter
          label="CPU"
          percent={cpu?.usagePercent}
          detail={cpu?.loadAvg1 !== undefined ? `load ${cpu.loadAvg1.toFixed(2)}${cpu.numCPU ? ` / ${cpu.numCPU}コア` : ''}` : ''}
          title={
            cpu
              ? `CPU使用率（全コア）。load average 1分/5分/15分：${[cpu.loadAvg1, cpu.loadAvg5, cpu.loadAvg15]
                  .map((v) => v?.toFixed(2) ?? '?')
                  .join(' / ')}（コア数${cpu.numCPU ?? '?'}を超えると混んでいる）`
              : 'CPU使用率'
          }
        />
      )}
      {items.includes('mem') && (
        <Meter
          label="メモリ"
          percent={mem?.usagePercent}
          detail={mem ? `${gb(mem.usedMem)} / ${gb(mem.totalMem)} GB` : ''}
          title={mem ? `メモリ使用量（キャッシュを除く）。空き ${gb(mem.availableMem)} GB` : 'メモリ使用量'}
        />
      )}
      {items.includes('disk') && (
        <Meter
          label="ディスク"
          percent={disk?.usagePercent}
          detail={disk ? `${gb(disk.usedDisk)} / ${gb(disk.totalDisk)} GB` : ''}
          title={disk ? `ディスク使用量（${disk.path ?? '/'}）。空き ${gb(disk.freeDisk)} GB` : 'ディスク使用量'}
        />
      )}
      <span className="server-status__spacer" />
      <span className="server-status__time">{error ? '取得できません' : time && `${time} 更新`}</span>
    </footer>
  )
}
