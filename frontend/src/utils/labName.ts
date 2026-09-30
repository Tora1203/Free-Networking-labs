// containerlab のラボ名（topologyContent.name）は clab-api-server 側で文字種を検証していて、
// 日本語等を含めると `{"error":"Invalid characters in topology 'name'."}` で拒否される
// （2026-09-28 実機確認）。英数字・ハイフン・アンダースコアのみが安全。
//
// ユーザーには自由な名前（日本語含む）を入力してもらいたいので、
// - 安全な名前ならそのままAPIに渡す
// - 安全でない名前は、決定的なハッシュから "lab-xxxxxxxx" という安全な名前を生成して渡す
//   （同じ入力なら常に同じ名前になるので、同じラボ名で再deployしても一貫する）
// - 元の名前は localStorage に保存しておき、ラボ一覧では表示名として復元する
//   （clab-api-server自体は表示名を保存する仕組みを持たないため、あくまでこのブラウザ内だけの表示補助）
import { fnv1aHash } from './hash'

const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const STORAGE_KEY = 'labDisplayNames'

export function isSafeLabName(name: string): boolean {
  return SAFE_NAME_PATTERN.test(name)
}

export function toSafeLabName(name: string): string {
  const trimmed = name.trim()
  return isSafeLabName(trimmed) ? trimmed : `lab-${fnv1aHash(trimmed)}`
}

function readMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  } catch {
    return {}
  }
}

export function rememberLabDisplayName(actualName: string, displayName: string) {
  if (actualName === displayName) return // 変換不要だった場合は保存しない
  try {
    const map = readMap()
    map[actualName] = displayName
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorageが使えなくても致命的ではないので無視
  }
}

export function getLabDisplayName(actualName: string): string {
  return readMap()[actualName] ?? actualName
}
