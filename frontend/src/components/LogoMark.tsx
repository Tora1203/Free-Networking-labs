// FNLのロゴの記号（2026-10-26決定、docs/direction.md）。Fの2本目の腕の先の橙の丸（ハブ）から、NとLが下りる。
// NとLがつながった塊の形（public/favicon.svgと同じ形）。ログインの画面だけで使う（ナビには出さない）。
// 線の色は文字色（currentColor）に従うので、ライト/ダークで自動で切り替わる。橙はブランド色で固定。
const ORANGE = 'var(--brand-orange, #f28c4b)'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function LogoMark({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={(size * 76) / 64} height={size} viewBox="0 0 76 64" aria-hidden="true" focusable="false">
      <path {...stroke} d="M12 58V8h22M12 29h22" />
      <path {...stroke} d="M34 29V58" />
      <path {...stroke} d="M34 29 48 58" />
      <path {...stroke} d="M48 29V58h20" />
      <circle cx="34" cy="29" r="4.6" fill={ORANGE} />
    </svg>
  )
}
