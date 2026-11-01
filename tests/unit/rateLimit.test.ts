import { describe, expect, it } from 'vitest'
import { DropLog, TokenBucket } from '../../src/main/security/rateLimit'

function clock(start = 1_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('TokenBucket', () => {
  it('allows a full burst at once, then refuses', () => {
    const c = clock()
    const bucket = new TokenBucket({ burst: 3, refillPerSecond: 1, now: c.now })
    expect([1, 2, 3, 4, 5].map(() => bucket.tryTake())).toEqual([true, true, true, false, false])
  })

  it('refills at the given rate, never beyond the burst', () => {
    const c = clock()
    const bucket = new TokenBucket({ burst: 3, refillPerSecond: 1, now: c.now })
    for (let i = 0; i < 3; i++) bucket.tryTake()
    c.advance(999)
    expect(bucket.tryTake()).toBe(false)
    c.advance(1)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
    c.advance(60_000)
    expect([1, 2, 3, 4].map(() => bucket.tryTake())).toEqual([true, true, true, false])
  })

  it('a 20-request loop gets the burst plus what refilled while it ran', () => {
    const c = clock()
    const bucket = new TokenBucket({ burst: 3, refillPerSecond: 1, now: c.now })
    let granted = 0
    for (let i = 0; i < 20; i++) {
      if (bucket.tryTake()) granted++
      c.advance(100)
    }
    // 1.9 s elapsed before the last take: 3 + 1
    expect(granted).toBe(4)
  })

  it('a clock that goes backwards neither adds nor removes tokens', () => {
    const c = clock(10_000)
    const bucket = new TokenBucket({ burst: 2, refillPerSecond: 1, now: c.now })
    bucket.tryTake()
    c.advance(-5_000)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
    c.advance(1_000)
    expect(bucket.tryTake()).toBe(false)
    c.advance(5_000)
    expect(bucket.tryTake()).toBe(true)
  })

  it('rejects a configuration that could never grant', () => {
    expect(() => new TokenBucket({ burst: 0, refillPerSecond: 1 })).toThrow()
    expect(() => new TokenBucket({ burst: 3, refillPerSecond: 0 })).toThrow()
    expect(() => new TokenBucket({ burst: Number.NaN, refillPerSecond: 1 })).toThrow()
  })
})

describe('DropLog', () => {
  it('logs the first drop of a flood once and the total when something passes again', () => {
    const lines: string[] = []
    const log = new DropLog('external open', (line) => lines.push(line))
    log.pass()
    for (let i = 0; i < 5; i++) log.drop('https://x.test/')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('external open: dropped https://x.test/')
    log.pass()
    expect(lines[1]).toBe('external open: dropped 5 requests in total')
    log.drop('again')
    log.pass()
    expect(lines).toHaveLength(3)
  })
})
