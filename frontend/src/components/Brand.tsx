import './Brand.css'

// ワードマーク画像（logo-wordmark-*.png）を使用。元はプレゼン資料用でドット模様の
// 背景があったため、透過処理＋コンテンツ部分のみにトリミング済み（frontend/public/参照）。
// ライト/ダーク2種類あり、どちらを出すかはCSS側で `:root[data-theme]` を見て切り替える
// （テーマ状態をpropsで渡さなくても自動追従するように）。
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
      <img className="brand__wordmark brand__wordmark--light" src="/logo-wordmark-light.png" alt="FreeNetworkLab" />
      <img className="brand__wordmark brand__wordmark--dark" src="/logo-wordmark-dark.png" alt="FreeNetworkLab" />
    </div>
  )
}
