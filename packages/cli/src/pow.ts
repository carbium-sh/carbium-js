import { blake3 } from '@noble/hashes/blake3.js'

/** Solves the sign-up proof of work: BLAKE3(challenge UTF-8 || nonce as 8 little-endian bytes) with `difficulty` leading zero bits. */
export function solveProofOfWork(challenge: string, difficulty: number): number {
  const prefix = new TextEncoder().encode(challenge)
  const buf = new Uint8Array(prefix.length + 8)
  buf.set(prefix, 0)
  const view = new DataView(buf.buffer, prefix.length, 8)
  for (let nonce = 0; nonce < Number.MAX_SAFE_INTEGER; nonce++) {
    view.setUint32(0, nonce >>> 0, true)
    view.setUint32(4, Math.floor(nonce / 2 ** 32), true)
    if (leadingZeroBits(blake3(buf)) >= difficulty) return nonce
  }
  throw new Error('no nonce found')
}

export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0
  for (const b of hash) {
    if (b === 0) {
      bits += 8
      continue
    }
    bits += Math.clz32(b) - 24
    break
  }
  return bits
}
