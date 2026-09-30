import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ApiError, createTerminalSession, getAuthToken } from '../api/client'

// clab-api-server の統合コンソール用WebSocket（/api/v1/terminal-sessions/{id}/stream）は
// Authorizationヘッダーでしか認証できないが、ブラウザのWebSocket APIはヘッダーを設定できない
// （2026-09-24 実機確認・ソースコード確認済み、docs/direction.md参照）。
// そのため backend/console-proxy/ の中継プロキシを経由して接続する。
const PROXY_URL = import.meta.env.VITE_CONSOLE_PROXY_URL ?? 'ws://localhost:8082'

type Status = 'connecting' | 'connected' | 'closed' | 'error'

interface Props {
  labName: string
  nodeName: string
  // タブが非表示の間もソケット接続自体は維持したいので、コンポーネントはアンマウントせず
  // CSSで隠すだけにする。visibleが立った瞬間にxterm.jsへ再fitさせる必要があるため props で渡す。
  visible: boolean
  // シェルに接続できた直後に自動で流し込むコマンド（例: ルーターはvtyshを自動起動）。
  // clab-api-serverのterminal-sessions APIには「シェル以外の初期コマンドを指定する」手段が無いため
  // （protocolはssh/shell/telnetのみ、api-contract.md 2.5参照）、シェルに入った後で
  // 通常の入力と同じ経路でコマンドを送り込むことで実現している
  autoCommand?: string
}

export default function ConsoleSession({ labName, nodeName, visible, autoCommand }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [status, setStatus] = useState<Status>('connecting')
  const [statusMessage, setStatusMessage] = useState('')

  // マウント時に一度だけ、xterm.js初期化→自動接続まで行う（手入力は不要にする＝ワンタッチ化）
  useEffect(() => {
    if (!containerRef.current) return
    const term = new Terminal({
      convertEol: true,
      fontFamily: 'ui-monospace, monospace',
      fontSize: 13,
      theme: { background: '#141f19' },
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()
    termRef.current = term
    fitAddonRef.current = fitAddon

    const handleResize = () => fitAddon.fit()
    window.addEventListener('resize', handleResize)

    let disposed = false
    ;(async () => {
      try {
        // api-contract.md 2.5: nodeNameは短い名前ではなくコンテナのフルネームを渡す
        const containerName = `clab-${labName}-${nodeName}`
        const session = await createTerminalSession(labName, containerName)
        const token = getAuthToken()
        if (!token) throw new Error('ログインしていません')
        if (disposed) return

        const socket = new WebSocket(`${PROXY_URL}/console?sessionId=${encodeURIComponent(session.sessionId)}`)
        socketRef.current = socket

        socket.addEventListener('open', () => {
          // プロキシへの最初のメッセージとしてトークンを送る（backend/console-proxy/server.js参照）
          socket.send(JSON.stringify({ token }))
        })
        socket.addEventListener('message', (event) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'ready') {
            setStatus('connected')
            term.writeln(`[connected to ${labName}/${nodeName}]`)
            if (autoCommand && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: 'input', data: `${autoCommand}\n` }))
            }
          } else if (msg.type === 'output') {
            // api-contract.md 2.5: サーバー→クライアントの出力はbase64
            term.write(atob(msg.data))
          } else if (msg.type === 'exit') {
            setStatus('closed')
            setStatusMessage('セッションが終了しました')
          }
        })
        socket.addEventListener('close', (event) => {
          setStatus((s) => (s === 'connecting' ? 'error' : 'closed'))
          if (event.reason) setStatusMessage(event.reason)
          term.writeln('\r\n[disconnected]')
        })
        socket.addEventListener('error', () => {
          setStatus('error')
          setStatusMessage('プロキシへの接続に失敗しました（backend/console-proxy は起動していますか？）')
        })

        const onDataDisposable = term.onData((data) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'input', data }))
          }
        })
        socket.addEventListener('close', () => onDataDisposable.dispose(), { once: true })
      } catch (e) {
        if (disposed) return
        setStatus('error')
        setStatusMessage(e instanceof ApiError || e instanceof Error ? e.message : '接続に失敗しました')
      }
    })()

    return () => {
      disposed = true
      window.removeEventListener('resize', handleResize)
      socketRef.current?.close()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labName/nodeName/autoCommandはこのセッションの生存期間中不変
  }, [])

  // タブが表示状態に切り替わった瞬間、隠れていた間にリサイズされていた分をfitし直す
  useEffect(() => {
    if (visible) fitAddonRef.current?.fit()
  }, [visible])

  return (
    <div className="console-pane" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="console-pane__bar">
        <span className="console-pane__target">
          {labName} / {nodeName}
        </span>
        <span className={`console-pane__badge console-pane__badge--${status}`}>
          {status === 'connecting' ? '接続中...' : status === 'connected' ? '接続中' : status === 'closed' ? '切断済み' : 'エラー'}
        </span>
        {statusMessage && <span className="console-pane__status">{statusMessage}</span>}
      </div>
      <div className="console-pane__term" ref={containerRef} />
    </div>
  )
}
