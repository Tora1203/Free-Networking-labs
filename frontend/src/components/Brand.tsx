import './Brand.css'

// アイコン(logo.png、透過済み) + テキストの組み合わせ。
// logo-wordmark-*.png（プレゼン資料用に作られたもの、背景にドット模様あり）は
// 小さく使うと透過処理の跡が汚くなりやすいため、アイコン+実テキストで再構成している。
// これならテーマ切り替えにも自動で追従する。
export default function Brand({ size = 'nav' }: { size?: 'nav' | 'login' }) {
  return (
    <div className={`brand brand--${size}`}>
      <img className="brand__icon" src="/logo.png" alt="" />
      <span className="brand__text">
        <span className="brand__text-light">Free</span>
        <span className="brand__text-bold">NetworkLab</span>
      </span>
    </div>
  )
}
