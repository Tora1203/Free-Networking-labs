import { useEffect, useState } from 'react'
import TopologyEditor from './components/TopologyEditor'
import LabList from './components/LabList'
import ConsolePane from './components/ConsolePane'
import LoginForm from './components/LoginForm'
import Brand from './components/Brand'
import { useAuthStore } from './store/authStore'
import { useUiStore, type View } from './store/uiStore'
import './App.css'

type Theme = 'light' | 'dark'

const views: { id: View; label: string }[] = [
  { id: 'topology', label: 'トポロジエディタ' },
  { id: 'labs', label: 'ラボ一覧' },
  { id: 'console', label: '統合コンソール' },
]

function readInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem('theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // localStorageが使えない環境（プライベートブラウジング等）では無視してlightにフォールバック
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function App() {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const consolePanelDocked = useUiStore((s) => s.consolePanelDocked)
  const [theme, setTheme] = useState<Theme>(readInitialTheme)
  const username = useAuthStore((s) => s.username)
  const logout = useAuthStore((s) => s.logout)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // 保存できなくても表示自体は問題ないので無視
    }
  }, [theme])

  if (!username) {
    return <LoginForm />
  }

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <Brand size="nav" />
        {views.map((v) => (
          <button
            key={v.id}
            className={v.id === view ? 'app-nav__btn app-nav__btn--active' : 'app-nav__btn'}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
        <div className="app-nav__spacer" />
        <button
          className="app-nav__btn"
          onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
          title="ダーク/ライト切り替え"
        >
          {theme === 'light' ? '🌙' : '☀️'}
        </button>
        <span className="app-nav__user">@{username}</span>
        <button className="app-nav__btn" onClick={logout}>
          ログアウト
        </button>
      </nav>
      <div className="app-content">
        {view === 'topology' && <TopologyEditor />}
        {view === 'labs' && <LabList />}
        {/* ConsolePane（xterm.js＋WebSocket接続を持つ）はApp直下にこの1箇所だけマウントする。
            画面切り替えでWebSocket接続を保ちたいのはもちろん、トポロジエディタ側にも
            もう1つ同じConsolePaneをマウントすると同じセッションへの接続が二重に張られてしまい
            片方が無反応になる不具合になっていたため（2026-09-29修正）、表示位置はCSSだけで
            切り替える：フル画面（統合コンソールタブ）／トポロジエディタ右側にドッキング／非表示 */}
        <div
          className={`app-content__console app-content__console--${
            view === 'console' ? 'full' : consolePanelDocked && view === 'topology' ? 'docked' : 'hidden'
          }`}
          hidden={view !== 'console' && !(consolePanelDocked && view === 'topology')}
        >
          <ConsolePane />
        </div>
      </div>
    </div>
  )
}

export default App
