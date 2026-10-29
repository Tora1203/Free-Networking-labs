import { LogoMark } from './LogoMark'
import './Brand.css'

// ワードマークは「文字だけ」の画像（public/logo-wordmark-text-*.png、2026-10-26）を使う。
// ライト/ダーク2種類あり、どちらを出すかはCSS側で `:root[data-theme]` を見て切り替える
// （テーマ状態をpropsで渡さなくても自動追従するように）。
// ナビはこれだけ。ログインは、その上に記号（LogoMark）を置く。
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
    >
      {size === 'login' && <LogoMark className="brand__mark" size={76} />}
      <img className="brand__wordmark brand__wordmark--light" src="/logo-wordmark-text-light.png" alt="FreeNetworkLab" />
      <img className="brand__wordmark brand__wordmark--dark" src="/logo-wordmark-text-dark.png" alt="FreeNetworkLab" />
    </div>
  )
}
