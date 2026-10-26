import { LogoMark } from './LogoMark'
import './Brand.css'

// ロゴ（2026-10-26〜）：記号（LogoMark、SVG）＋文字「FreeNetworkLab」＋「F N L」。画像ではなくSVGと文字なので、
// ライト/ダークの切り替えは色の変数（文字色）に自動で追従する（以前はlight/darkの2枚のPNGをCSSで切り替えていた）。

interface BrandProps {
  size?: 'nav' | 'login'
  // ナビのロゴはクリックでホームに戻れるようにする（2026-10-05追加）
  onClick?: () => void
}

export default function Brand({ size = 'nav', onClick }: BrandProps) {
  return (
    <div
      className={`brand brand--${size} ${onClick ? 'brand--clickable' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      title={onClick ? 'ホームに戻る' : undefined}
      aria-label={onClick ? 'ホームに戻る（FreeNetworkLab）' : undefined}
    >
      <LogoMark className="brand__mark" size={size === 'login' ? 72 : 38} />
      <span className="brand__text">
        <span className="brand__name">FreeNetworkLab</span>
        <span className="brand__tag">F N L</span>
      </span>
    </div>
  )
}
