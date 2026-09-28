// 軽量な非暗号学的ハッシュ(FNV-1a 32bit)。ブリッジ名・ラボ名の衝突回避に使う。
// 暗号学的な強度は不要（このプロジェクトの想定利用規模は数人×数ラボ）。
export function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
