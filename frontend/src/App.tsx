import { useEffect, useState } from 'react'
import TopologyEditor from './components/TopologyEditor'
import LabList from './components/LabList'
import ConsolePane from './components/Console'
import LoginForm from './components/LoginForm'
import { useAuthStore } from './store/authStore'
import './App.css'

type View = 'topology' | 'labs' | 'console'
type Theme = 'light' | 'dark'

const views: { id: View; label: string }[] = [
  { id: 'topology', label: 'トポロジエディタ' },
  { id: 'labs', label: 'ラボ一覧' },
  { id: 'console', label: '統合コンソール(検証中)' },
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
  const [view, setView] = useState<View>('topology')
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
        <img className="app-nav__logo" src="/logo.svg" alt="ロゴ" />
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
        {view === 'console' && <ConsolePane />}
      </div>
    </div>
  )
}

export default App
