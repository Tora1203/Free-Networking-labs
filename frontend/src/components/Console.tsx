import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './Console.css'

// TASK4: ローカルのechoサーバー（dev-tools/echo-server.js）に接続して動作確認する。
// バックエンドが動き出したら、ノードごとのSSH/exec WebSocketエンドポイントに差し替える。
const ECHO_WS_URL = 'ws://localhost:8081'

export default function ConsolePane() {
  const containerRef = useRef<HTMLDivElement>(null)

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

    const socket = new WebSocket(ECHO_WS_URL)

    socket.addEventListener('open', () => {
      term.writeln('[connected to ' + ECHO_WS_URL + ']')
    })
    socket.addEventListener('message', async (event) => {
      // 実バックエンド接続時はバイナリフレームで届く可能性があるため文字列に変換する
      const text = event.data instanceof Blob ? await event.data.text() : event.data
      term.write(text)
    })
    socket.addEventListener('close', () => {
      term.writeln('\r\n[disconnected]')
    })
    socket.addEventListener('error', () => {
      term.writeln('\r\n[connection error — dev-tools/echo-server.js is running?]')
    })

    const onDataDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data)
      }
    })

    const handleResize = () => fitAddon.fit()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      onDataDisposable.dispose()
      socket.close()
      term.dispose()
    }
  }, [])

  return (
    <div className="console-pane">
      <div className="console-pane__bar">integrated console — echo test (ws://localhost:8081)</div>
      <div className="console-pane__term" ref={containerRef} />
    </div>
  )
}
