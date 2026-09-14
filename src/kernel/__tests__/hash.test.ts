import { describe, expect, it } from 'vitest'
import { sha256Hex } from '../hash'

// FIPS 180-4 / NIST test vectors
describe('sha256Hex', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    // multi-byte UTF-8
    expect(sha256Hex('日本語')).toBe(
      '77710aedc74ecfa33685e33a6c7df5cc83004da1bdcef7fb280f5c2b2e97e0a5',
    )
    // exercises the two-block path (length > 55 bytes)
    expect(sha256Hex('a'.repeat(64))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    )
  })

  it('is deterministic and content-sensitive', () => {
    expect(sha256Hex('claim A')).toBe(sha256Hex('claim A'))
    expect(sha256Hex('claim A')).not.toBe(sha256Hex('claim B'))
  })
})
