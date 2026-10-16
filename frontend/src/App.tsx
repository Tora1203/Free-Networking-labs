import { useCallback, useEffect, useRef, useState } from 'react'
import TopologyEditor from './components/TopologyEditor'
import Home from './components/Home'
import ConsolePane from './components/ConsolePane'
import LoginForm from './components/LoginForm'
import ShareViewer from './components/ShareViewer'
import { shareIdFromHash } from './api/collabClient'
import Brand from './components/Brand'
import ServerStatusBar, {
  SERVER_STATUS_ITEMS,
  readServerStatusItems,
  saveServerStatusItems,
  type ServerStatusItem,
} from './components/ServerStatusBar'
import { useAuthStore } from './store/authStore'
import { useUiStore } from './store/uiStore'
import './App.css'

type Theme = 'light' | 'dark'

// ナビのタブボタンは持たない（2026-10-06決定）。ロゴクリックで常にホームに戻れるので、
// 「ホーム」ボタンを別に置くのは冗長だった。トポロジエディタ（'editor'）・統合コンソールも
// 単独のタブは持たず、ホームからの導線経由でしか開けない専用画面（docs/direction.md参照）

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
  const consolePanelWidth = useUiStore((s) => s.consolePanelWidth)
  const setConsolePanelWidth = useUiStore((s) => s.setConsolePanelWidth)
  const [theme, setTheme] = useState<Theme>(readInitialTheme)
  // 共有リンク（#/share/<合言葉>）で開いた時は、ログインなしの閲覧専用画面を出す（2026-10-16）
  const [shareId, setShareId] = useState(() => shareIdFromHash(window.location.hash))
  useEffect(() => {
    const onHash = () => setShareId(shareIdFromHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const username = useAuthStore((s) => s.username)
  const logout = useAuthStore((s) => s.logout)
  const resizingRef = useRef(false)
  // 画面下部に出すサーバーの使用状況（2026-10-14追加、components/ServerStatusBar.tsx）
  const [statusItems, setStatusItems] = useState<ServerStatusItem[]>(readServerStatusItems)
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const statusMenuRef = useRef<HTMLDivElement>(null)
  const toggleStatusItem = (key: ServerStatusItem) => {
    setStatusItems((prev) => {
      const next = SERVER_STATUS_ITEMS.map((i) => i.key).filter((k) => (k === key ? !prev.includes(k) : prev.includes(k)))
      saveServerStatusItems(next)
      return next
    })
  }
  useEffect(() => {
    if (!statusMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!statusMenuRef.current?.contains(e.target as Node)) setStatusMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [statusMenuOpen])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // 保存できなくても表示自体は問題ないので無視
    }
  }, [theme])

  // ドッキングパネルの幅をドラッグで調整できるようにする（2026-10-05追加：
  // 「右側コンソールのサイズが調整できない」という指摘に対応）。
  // パネルは右端固定・左端がハンドルなので、ポインタのX座標とウィンドウ幅の差がそのまま幅になる
  const onResizeStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      resizingRef.current = true
      const onMove = (e: MouseEvent) => {
        if (!resizingRef.current) return
        setConsolePanelWidth(window.innerWidth - e.clientX)
      }
      const onUp = () => {
        resizingRef.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [setConsolePanelWidth],
  )

  if (shareId) {
    return <ShareViewer shareId={shareId} />
  }

  if (!username) {
    return <LoginForm />
  }

  const consoleDocked = consolePanelDocked && view === 'editor'

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <Brand size="nav" onClick={() => setView('home')} />
        <div className="app-nav__spacer" />
        <div className="server-status-menu" ref={statusMenuRef}>
          <button
            className="app-nav__btn"
            onClick={() => setStatusMenuOpen((v) => !v)}
            title="画面下部に出すサーバーの使用状況を選ぶ"
            aria-expanded={statusMenuOpen}
          >
            📊
          </button>
          {statusMenuOpen && (
            <div className="server-status-menu__panel">
              <h4>サーバーの使用状況を表示</h4>
              {SERVER_STATUS_ITEMS.map((item) => (
                <label key={item.key}>
                  <input
                    type="checkbox"
                    checked={statusItems.includes(item.key)}
                    onChange={() => toggleStatusItem(item.key)}
                  />
                  {item.label}
                </label>
              ))}
            </div>
          )}
        </div>
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
        {view === 'home' && <Home />}
        {view === 'editor' && <TopologyEditor />}
        {/* ConsolePane（xterm.js＋WebSocket接続を持つ）はApp直下にこの1箇所だけマウントする。
            トポロジエディタ側にもう1つ同じConsolePaneをマウントすると同じセッションへの接続が
            二重に張られてしまい片方が無反応になる不具合になっていたため（2026-09-29修正）、
            表示位置はCSSだけで切り替える：トポロジエディタ右側にドッキング／非表示
            （統合コンソールの単独タブは廃止済み、2026-10-05決定） */}
        <div
          className={`app-content__console app-content__console--${consoleDocked ? 'docked' : 'hidden'}`}
          style={consoleDocked ? { width: consolePanelWidth } : undefined}
          hidden={!consoleDocked}
        >
          {consoleDocked && (
            <div className="app-content__console-resizer" onMouseDown={onResizeStart} title="ドラッグして幅を調整" />
          )}
          <ConsolePane />
        </div>
      </div>
      <ServerStatusBar items={statusItems} />
    </div>
  )
}

export default App
