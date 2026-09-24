import { useState } from 'react'
import TopologyEditor from './components/TopologyEditor'
import LabList from './components/LabList'
import ConsolePane from './components/Console'
import LoginForm from './components/LoginForm'
import { useAuthStore } from './store/authStore'
import './App.css'

type View = 'topology' | 'labs' | 'console'

const views: { id: View; label: string }[] = [
  { id: 'topology', label: 'トポロジエディタ' },
  { id: 'labs', label: 'ラボ一覧' },
  { id: 'console', label: '統合コンソール(検証中)' },
]

function App() {
  const [view, setView] = useState<View>('topology')
  const username = useAuthStore((s) => s.username)
  const logout = useAuthStore((s) => s.logout)

  if (!username) {
    return <LoginForm />
  }

  return (
    <div className="app-shell">
      <nav className="app-nav">
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
