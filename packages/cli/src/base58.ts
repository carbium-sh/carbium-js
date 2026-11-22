const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const MAP = new Map([...ALPHABET].map((c, i) => [c, i]))

export function base58Decode(s: string): Uint8Array {
  let zeros = 0
  while (zeros < s.length && s[zeros] === '1') zeros++
  const bytes: number[] = []
  for (const c of s.slice(zeros)) {
    const v = MAP.get(c)
    if (v === undefined) throw new Error('not base58')
    let carry = v
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58
      bytes[i] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  return new Uint8Array([...new Array<number>(zeros).fill(0), ...bytes.reverse()])
}

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const digits: number[] = []
  for (const b of bytes.slice(zeros)) {
    let carry = b
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] as number) << 8
      digits[i] = carry % 58
      carry = Math.floor(carry / 58)
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = Math.floor(carry / 58)
    }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('')
}

/** A 64-byte signature from base58 or padded standard base64 (88 characters ending ==; base58 never has =, and most base58 signatures are 88 long too). */
export function decodeSignature(s: string): Uint8Array {
  const t = s.trim()
  if (/^[A-Za-z0-9+/]{86}==$/.test(t)) return new Uint8Array(Buffer.from(t, 'base64'))
  return base58Decode(t)
}
