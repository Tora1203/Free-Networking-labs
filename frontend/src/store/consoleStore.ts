// 統合コンソールで「同時に開いているノード」を管理する状態。
// CMLのように同一ラボ内の複数ノードを並行して操作できるよう、タブとして複数セッションを保持する。
// 画面（トポロジ/ラボ一覧/コンソール）を行き来してもWebSocket接続が切れないよう、
// セッション自体はApp直下に常時マウントしたComponentが持ち、ここには「何を開いているか」だけを持つ。
import { create } from 'zustand'

export interface ConsoleSessionInfo {
  id: string
  labName: string
  nodeName: string
}

interface ConsoleState {
  sessions: ConsoleSessionInfo[]
  activeId: string | null
  openConsole: (labName: string, nodeName: string) => void
  closeConsole: (id: string) => void
  setActive: (id: string) => void
}

function sessionId(labName: string, nodeName: string) {
  return `${labName}:${nodeName}`
}

export const useConsoleStore = create<ConsoleState>()((set, get) => ({
  sessions: [],
  activeId: null,
  openConsole: (labName, nodeName) => {
    const id = sessionId(labName, nodeName)
    const exists = get().sessions.some((s) => s.id === id)
    set((s) => ({
      sessions: exists ? s.sessions : [...s.sessions, { id, labName, nodeName }],
      activeId: id,
    }))
  },
  closeConsole: (id) =>
    set((s) => {
      const sessions = s.sessions.filter((sess) => sess.id !== id)
      const activeId = s.activeId === id ? (sessions.at(-1)?.id ?? null) : s.activeId
      return { sessions, activeId }
    }),
  setActive: (id) => set({ activeId: id }),
}))
