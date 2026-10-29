import type { ReactNode } from 'react'

// 文字の代わりに出す小さなアイコン（2026-10-26）。外部のアイコン集を入れず、必要な分だけをここに持つ。
// 24x24の枠・線の太さ2・丸い端で統一し、色は文字色（currentColor）に従うのでライト/ダーク・
// 主要/危険などボタンの種類にそのまま追従する。意味は呼ぶ側のボタンの title と aria-label で伝える
// （アイコン自体は装飾として読み上げない）。

export type IconName =
  | 'chart'
  | 'moon'
  | 'sun'
  | 'logout'
  | 'home'
  | 'undo'
  | 'redo'
  | 'play'
  | 'stop'
  | 'import'
  | 'export'
  | 'snapshot'
  | 'share'
  | 'terminal'
  | 'rebuild'
  | 'close'
  | 'router'
  | 'switch'
  | 'l3switch'
  | 'pc'
  | 'label'
  | 'area'

const STROKE: Record<Exclude<IconName, 'play' | 'stop'>, ReactNode> = {
  // 棒グラフ（サーバーの使用状況）
  chart: (
    <>
      <path d="M3 3v18h18" />
      <path d="M8 17v-6" />
      <path d="M13 17V7" />
      <path d="M18 17v-3" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  // 下向きの矢印がトレイに入る＝読み込む
  import: (
    <>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  // 上向きの矢印がトレイから出る＝書き出す
  export: (
    <>
      <path d="M12 15V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M5 20h14" />
    </>
  ),
  // カメラ（その時点の状態を撮る）
  snapshot: (
    <>
      <path d="M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 4" />
      <path d="m15.4 6.5-6.8 4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </>
  ),
  rebuild: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  close: <path d="M18 6 6 18M6 6l12 12" />,
  // ---- ノードパレットの記号（キャンバス上の形と同じ：ルーター＝円、スイッチ＝角丸の四角、PC＝四角）----
  // ルーター：円と、外に向かう4本の矢印（ネットワーク図の慣例）
  router: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 5v14M5 12h14" />
      <path d="m9.5 7.5 2.5-2.5 2.5 2.5M9.5 16.5l2.5 2.5 2.5-2.5M7.5 9.5 5 12l2.5 2.5M16.5 9.5 19 12l-2.5 2.5" />
    </>
  ),
  // L2スイッチ：角丸の四角と、左右の矢印
  switch: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="3" />
      <path d="M7 10h10m-2-2 2 2-2 2" />
      <path d="M17 14H7m2-2-2 2 2 2" />
    </>
  ),
  // L3スイッチ：L2スイッチに、上位（ルーティング）を表す円を重ねる
  l3switch: (
    <>
      <rect x="3" y="9" width="18" height="11" rx="3" />
      <path d="M7 14.5h10m-2-2 2 2-2 2" />
      <circle cx="12" cy="4.5" r="2.5" />
      <path d="M12 7v2" />
    </>
  ),
  // PC：モニターとスタンド
  pc: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  // ラベル：タグ
  label: (
    <>
      <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z" />
      <circle cx="8" cy="8" r="1.4" />
    </>
  ),
  // エリア：ノードを囲む点線の枠
  area: <rect x="3" y="4" width="18" height="16" rx="3" strokeDasharray="3 3" />,
}

// 再生（▶）と停止（■）は、塗りつぶしの方が小さくても見分けやすい
const FILLED: Record<'play' | 'stop', ReactNode> = {
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />,
  stop: <rect x="5.5" y="5.5" width="13" height="13" rx="2.5" />,
}

// size は、CSS の既定（.icon、buttons.css）と違う大きさにしたい時だけ渡す
export function Icon({ name, size }: { name: IconName; size?: number }) {
  const filled = name === 'play' || name === 'stop'
  return (
    <svg
      className="icon"
      style={size ? { width: size, height: size } : undefined}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {filled ? FILLED[name] : STROKE[name]}
    </svg>
  )
}
