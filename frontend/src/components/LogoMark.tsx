// FNLのロゴの記号（2026-10-26決定、docs/direction.md）。Fの2本目の腕の先の橙の丸（ハブ）から、NとLが下りる。
// 線の色は文字色（currentColor）に従うので、ライト/ダークで自動で切り替わる。橙はブランド色で固定。
//  - full   ：Fの上に橙の小さな点、NとLは別々の文字（ナビ・ログイン用。幅が広い）
//  - compact：NとLがつながった塊（ファビコンなど、正方形に近い用途。public/favicon.svgと同じ形）
export type LogoVariant = 'full' | 'compact'

const ORANGE = 'var(--brand-orange, #f28c4b)'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function LogoMark({ variant = 'full', size = 36, className }: { variant?: LogoVariant; size?: number; className?: string }) {
  if (variant === 'compact') {
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
  return (
    <svg className={className} width={(size * 88) / 70} height={size} viewBox="0 0 88 70" aria-hidden="true" focusable="false">
      <g transform="translate(0 6)">
        <path {...stroke} d="M12 58V8h22M12 26h24" />
        <path {...stroke} d="M37 26V58" />
        <path {...stroke} d="M37 26 55 58" />
        <path {...stroke} d="M55 26V58" />
        <path {...stroke} d="M64 26V58h16" />
        <circle cx="37" cy="26" r="5.2" fill={ORANGE} />
        <circle cx="18" cy="0.5" r="2.9" fill={ORANGE} />
      </g>
    </svg>
  )
}
