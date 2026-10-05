import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ApiError, createTerminalSession, getAuthToken } from '../api/client'

// clab-api-server の統合コンソール用WebSocket（/api/v1/terminal-sessions/{id}/stream）は
// Authorizationヘッダーでしか認証できないが、ブラウザのWebSocket APIはヘッダーを設定できない
// （2026-09-24 実機確認・ソースコード確認済み、docs/direction.md参照）。
// そのため backend/console-proxy/ の中継プロキシを経由して接続する。
const PROXY_URL = import.meta.env.VITE_CONSOLE_PROXY_URL ?? 'ws://localhost:8082'

// autoCommandを流し込むまでの待機時間。シェルの'ready'直後はまだプロンプトが出ていないことがあり、
// 早すぎるとvtysh側のターミナル問い合わせ（カーソル位置応答など）の断片が画面に
// 生の文字列として出てしまう不具合があった（2026-10-05指摘、「5R」等の文字化け）。
// 最初の実データ(output)を受け取ってからさらに少し待ってから送る。
const AUTO_COMMAND_DELAY_MS = 400

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
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const autoCommandSentRef = useRef(false)
  const autoCommandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 接続中のconnect()呼び出しを無効化するためのトークン（再接続時に古い接続の結果を無視する）
  const connectionTokenRef = useRef(0)
  const [status, setStatus] = useState<Status>('connecting')
  const [statusMessage, setStatusMessage] = useState('')

  // ラボをstop→再startした後など、既存タブから再接続したい時のために接続処理を関数として
  // 切り出す（2026-10-05追加）。xterm.js本体はマウント時に1つだけ作り、再接続時は使い回す。
  const connect = useCallback(() => {
    const term = termRef.current
    if (!term) return
    const myToken = ++connectionTokenRef.current

    socketRef.current?.close()
    onDataDisposableRef.current?.dispose()
    autoCommandSentRef.current = false
    if (autoCommandTimerRef.current) clearTimeout(autoCommandTimerRef.current)

    setStatus('connecting')
    setStatusMessage('')

    void (async () => {
      try {
        // api-contract.md 2.5: nodeNameは短い名前ではなくコンテナのフルネームを渡す
        const containerName = `clab-${labName}-${nodeName}`
        const session = await createTerminalSession(labName, containerName)
        const token = getAuthToken()
        if (!token) throw new Error('ログインしていません')
        if (connectionTokenRef.current !== myToken) return // 途中で再接続/アンマウントされた

        const socket = new WebSocket(`${PROXY_URL}/console?sessionId=${encodeURIComponent(session.sessionId)}`)
        socketRef.current = socket

        socket.addEventListener('open', () => {
          // プロキシへの最初のメッセージとしてトークンを送る（backend/console-proxy/server.js参照）
          socket.send(JSON.stringify({ token }))
        })
        socket.addEventListener('message', (event) => {
          if (connectionTokenRef.current !== myToken) return
          const msg = JSON.parse(event.data)
          if (msg.type === 'ready') {
            setStatus('connected')
            term.writeln(`[connected to ${labName}/${nodeName}]`)
          } else if (msg.type === 'output') {
            // api-contract.md 2.5: サーバー→クライアントの出力はbase64
            term.write(atob(msg.data))
            // シェルの実際の出力（＝プロンプトが出てきたタイミング）が来てから、
            // 少し待ってautoCommandを送る。'ready'直後にすぐ送ると、プロンプトが
            // まだ出来上がっていない状態に割り込んでしまい文字化けの原因になっていた
            if (autoCommand && !autoCommandSentRef.current) {
              autoCommandSentRef.current = true
              autoCommandTimerRef.current = setTimeout(() => {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify({ type: 'input', data: `${autoCommand}\n` }))
                }
              }, AUTO_COMMAND_DELAY_MS)
            }
          } else if (msg.type === 'exit') {
            setStatus('closed')
            setStatusMessage('セッションが終了しました（ラボを再起動した場合は再接続してください）')
          }
        })
        socket.addEventListener('close', (event) => {
          if (connectionTokenRef.current !== myToken) return
          setStatus((s) => (s === 'connecting' ? 'error' : 'closed'))
          setStatusMessage(event.reason || '')
        })
        socket.addEventListener('error', () => {
          if (connectionTokenRef.current !== myToken) return
          setStatus('error')
          setStatusMessage('プロキシへの接続に失敗しました（backend/console-proxy は起動していますか？）')
        })

        const onDataDisposable = term.onData((data) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'input', data }))
          }
        })
        onDataDisposableRef.current = onDataDisposable
      } catch (e) {
        if (connectionTokenRef.current !== myToken) return
        setStatus('error')
        setStatusMessage(e instanceof ApiError || e instanceof Error ? e.message : '接続に失敗しました')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- labName/nodeName/autoCommandはこのセッションの生存期間中不変
  }, [])

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

    connect()

    return () => {
      connectionTokenRef.current += 1 // 進行中のconnect()の結果を無視させる
      if (autoCommandTimerRef.current) clearTimeout(autoCommandTimerRef.current)
      window.removeEventListener('resize', handleResize)
      onDataDisposableRef.current?.dispose()
      socketRef.current?.close()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- マウント時に一度だけ実行する
  }, [])

  // タブが表示状態に切り替わった瞬間、隠れていた間にリサイズされていた分をfitし直す。
  // display:noneで隠れていたcanvasが再表示時に古い内容のまま描画されないよう、
  // fit()だけでなく明示的にrefresh()で全行を再描画させる
  // （タブを切り替えても前のタブの内容が残って見える不具合への対策、2026-10-05）
  useEffect(() => {
    if (!visible) return
    const term = termRef.current
    fitAddonRef.current?.fit()
    if (term) term.refresh(0, term.rows - 1)
  }, [visible])

  const canReconnect = status === 'closed' || status === 'error'

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
        {canReconnect && (
          <button className="console-pane__reconnect" onClick={connect}>
            🔄 再接続
          </button>
        )}
      </div>
      <div className="console-pane__term" ref={containerRef} />
    </div>
  )
}
