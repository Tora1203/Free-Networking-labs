import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { ApiError, createTerminalSession, getAuthToken } from '../api/client'
import './Console.css'

// clab-api-server の統合コンソール用WebSocket（/api/v1/terminal-sessions/{id}/stream）は
// Authorizationヘッダーでしか認証できないが、ブラウザのWebSocket APIはヘッダーを設定できない
// （2026-09-24 実機確認・ソースコード確認済み、docs/direction.md参照）。
// そのため backend/console-proxy/ の中継プロキシを経由して接続する。
const PROXY_URL = import.meta.env.VITE_CONSOLE_PROXY_URL ?? 'ws://localhost:8082'

type Status = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

export default function ConsolePane() {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const [labName, setLabName] = useState('')
  const [nodeName, setNodeName] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [statusMessage, setStatusMessage] = useState('')

  // xterm.js自体は接続の有無に関わらず一度だけマウントする
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

    return () => {
      window.removeEventListener('resize', handleResize)
      socketRef.current?.close()
      term.dispose()
    }
  }, [])

  const disconnect = useCallback(() => {
    socketRef.current?.close()
    socketRef.current = null
  }, [])

  const connect = useCallback(async () => {
    const term = termRef.current
    if (!term || !labName.trim() || !nodeName.trim()) return
    disconnect()
    term.clear()
    setStatus('connecting')
    setStatusMessage('')

    try {
      // api-contract.md 2.5: nodeNameは短い名前ではなくコンテナのフルネームを渡す
      const containerName = `clab-${labName.trim()}-${nodeName.trim()}`
      const session = await createTerminalSession(labName.trim(), containerName)
      const token = getAuthToken()
      if (!token) throw new Error('ログインしていません')

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
      setStatus('error')
      setStatusMessage(e instanceof ApiError || e instanceof Error ? e.message : '接続に失敗しました')
    }
  }, [labName, nodeName, disconnect])

  return (
    <div className="console-pane">
      <div className="console-pane__bar">
        <input
          className="console-pane__input"
          placeholder="ラボ名"
          value={labName}
          onChange={(e) => setLabName(e.target.value)}
          disabled={status === 'connecting' || status === 'connected'}
        />
        <input
          className="console-pane__input"
          placeholder="ノード名"
          value={nodeName}
          onChange={(e) => setNodeName(e.target.value)}
          disabled={status === 'connecting' || status === 'connected'}
        />
        {status === 'connected' ? (
          <button onClick={disconnect}>切断</button>
        ) : (
          <button onClick={connect} disabled={!labName.trim() || !nodeName.trim() || status === 'connecting'}>
            {status === 'connecting' ? '接続中...' : '接続'}
          </button>
        )}
        {statusMessage && <span className="console-pane__status">{statusMessage}</span>}
      </div>
      <div className="console-pane__term" ref={containerRef} />
    </div>
  )
}
