// 統合コンソールで「同時に開いているノード」を管理する状態。
// CMLのように同一ラボ内の複数ノードを並行して操作できるよう、タブとして複数セッションを保持する。
// 画面（トポロジ/ラボ一覧/コンソール）を行き来してもWebSocket接続が切れないよう、
// セッション自体はApp直下に常時マウントしたComponentが持ち、ここには「何を開いているか」だけを持つ。
import { create } from 'zustand'

export interface ConsoleSessionInfo {
  id: string
  labName: string
  nodeName: string
  // シェルに接続した直後に自動で流し込むコマンド（例: ルーターはvtyshを自動起動）。
  // 末尾の改行は付けずに渡す（ConsoleSession.tsx側でEnter相当を追加する）
  autoCommand?: string
}

interface ConsoleState {
  sessions: ConsoleSessionInfo[]
  activeId: string | null
  openConsole: (labName: string, nodeName: string, autoCommand?: string) => void
  closeConsole: (id: string) => void
  setActive: (id: string) => void
  // 別のラボをエディタで開いた時に、前のラボのコンソールタブが残り続けないようにする
  // （2026-10-05指摘：「labを切り替えた時に前のlabの機械のコンソールが残るのは良くない」）
  closeAllConsoles: () => void
}

function sessionId(labName: string, nodeName: string) {
  return `${labName}:${nodeName}`
}

export const useConsoleStore = create<ConsoleState>()((set, get) => ({
  sessions: [],
  activeId: null,
  openConsole: (labName, nodeName, autoCommand) => {
    const id = sessionId(labName, nodeName)
    const exists = get().sessions.some((s) => s.id === id)
    set((s) => ({
      sessions: exists ? s.sessions : [...s.sessions, { id, labName, nodeName, autoCommand }],
      activeId: id,
    }))
  },
  closeConsole: (id) =>
    set((s) => {
      const closedIndex = s.sessions.findIndex((sess) => sess.id === id)
      const sessions = s.sessions.filter((sess) => sess.id !== id)
      // 閉じたタブがアクティブだった場合、直感的に「1つ左（無ければ右）」のタブへ移す
      const activeId =
        s.activeId === id ? (sessions[closedIndex - 1] ?? sessions[closedIndex] ?? null)?.id ?? null : s.activeId
      return { sessions, activeId }
    }),
  setActive: (id) => set({ activeId: id }),
  closeAllConsoles: () => set({ sessions: [], activeId: null }),
}))
