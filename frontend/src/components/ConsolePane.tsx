import { useConsoleStore } from '../store/consoleStore'
import ConsoleSession from './ConsoleSession'
import './Console.css'

// 統合コンソールのタブ管理。セッション自体（ConsoleSession）は開いている間ずっとマウントし続け、
// 非アクティブなタブはCSSで隠すだけにする（タブを切り替えてもWebSocket接続を保ったままにするため）。
export default function ConsolePane() {
  const sessions = useConsoleStore((s) => s.sessions)
  const activeId = useConsoleStore((s) => s.activeId)
  const setActive = useConsoleStore((s) => s.setActive)
  const closeConsole = useConsoleStore((s) => s.closeConsole)

  if (sessions.length === 0) {
    return (
      <div className="console-pane console-pane--empty">
        <p className="console-pane__hint">
          開いているコンソールはありません。ホームのノードの<strong>🖥ボタン</strong>、または
          このトポロジのノードを右クリックして<strong>「コンソールを開く」</strong>を押すと、ここにタブとして開きます。
        </p>
      </div>
    )
  }

  // 複数ラボを同時に開いていない限りはノード名だけで十分見分けられるので、
  // タブが増えた時に文字で埋まって見づらくなるのを避けるため表示を短くする
  // （2026-10-05指摘：複数タブで視認性が著しく低下する）
  const multipleLabsOpen = new Set(sessions.map((s) => s.labName)).size > 1

  return (
    <div className="console-manager">
      <div className="console-tabs">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`console-tab ${s.id === activeId ? 'console-tab--active' : ''}`}
            onClick={() => setActive(s.id)}
            title={`${s.labName} / ${s.nodeName}`}
          >
            <span className="console-tab__label">{multipleLabsOpen ? `${s.labName}/${s.nodeName}` : s.nodeName}</span>
            <button
              className="console-tab__close"
              title="閉じる"
              onClick={(e) => {
                e.stopPropagation()
                closeConsole(s.id)
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="console-manager__body">
        {sessions.map((s) => (
          <ConsoleSession
            key={s.id}
            labName={s.labName}
            nodeName={s.nodeName}
            visible={s.id === activeId}
            autoCommand={s.autoCommand}
          />
        ))}
      </div>
    </div>
  )
}
