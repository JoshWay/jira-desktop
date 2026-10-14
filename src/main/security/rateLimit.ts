// Pure rate limiting for the security boundary (no electron imports, so it stays unit-testable).
// codex:run npm test -- tests/unit/rateLimit.test.ts

export interface TokenBucketOptions {
  // How many takes may happen back to back (the bucket starts full)
  burst: number
  // Tokens added per second, up to `burst`
  refillPerSecond: number
  // Milliseconds; injectable so tests do not depend on the wall clock
  now?: () => number
}

// A classic token bucket: `burst` takes at once, then `refillPerSecond` on average.
export class TokenBucket {
  private readonly burst: number
  private readonly refillPerMs: number
  private readonly now: () => number
  private tokens: number
  private last: number

  constructor(options: TokenBucketOptions) {
    if (!(options.burst >= 1) || !(options.refillPerSecond > 0)) throw new Error('TokenBucket needs burst >= 1 and refillPerSecond > 0')
    this.burst = options.burst
    this.refillPerMs = options.refillPerSecond / 1000
    this.now = options.now ?? Date.now
    this.tokens = options.burst
    this.last = this.now()
  }

  // Takes one token if there is one; false means the caller must drop the request
  tryTake(): boolean {
    const now = this.now()
    // A clock that goes backwards adds nothing (and never removes tokens)
    if (now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.refillPerMs)
      this.last = now
    }
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

// Logs the first drop of a flood once, then stays quiet until something gets through again, when
// it reports how many were dropped in between. Keeps a hostile loop from also flooding the log.
export class DropLog {
  private dropped = 0
  private readonly what: string
  private readonly log: (message: string) => void

  constructor(what: string, log: (message: string) => void = (message) => console.warn(message)) {
    this.what = what
    this.log = log
  }

  drop(detail: string): void {
    if (this.dropped++ === 0) this.log(`${this.what}: dropped ${detail} (further drops are counted, not logged)`)
  }

  pass(): void {
    if (this.dropped > 1) this.log(`${this.what}: dropped ${this.dropped} requests in total`)
    this.dropped = 0
  }
}
