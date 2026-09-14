import { WebSocketServer } from 'ws'

const PORT = 8081
const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws) => {
  console.log('client connected')
  ws.send('echo server ready. type something.\r\n')
  ws.on('message', (data) => {
    // dataはBufferで届く。そのままsendするとバイナリフレームになり
    // ブラウザ側でBlobとして受信されxterm.jsが描画できないため、文字列化して送る。
    ws.send(data.toString())
  })
  ws.on('close', () => console.log('client disconnected'))
})

console.log(`echo ws server listening on ws://localhost:${PORT}`)
