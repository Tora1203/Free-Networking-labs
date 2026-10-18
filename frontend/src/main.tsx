import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// モックモード（`npm run dev:mock`、src/mocks/mockServer.ts）。本番のビルドでは条件が偽に置き換わり、モックごと除かれる
async function start() {
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMockServer } = await import('./mocks/mockServer')
    installMockServer()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
void start()
