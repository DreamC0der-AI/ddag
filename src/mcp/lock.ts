import { closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * Cross-process exclusion for a file, without native modules: an O_EXCL
 * lock file beside it. Two ddag servers on one chain (two Claude Code
 * sessions in one folder) serialize their read-modify-write through it.
 * A lock older than STALE_MS is reclaimed (a crashed holder); a live lock
 * makes the caller wait, then fail honestly after `timeoutMs`.
 */
export interface LockOptions {
  timeoutMs?: number
  staleMs?: number
}

const STALE_MS = 10_000
const RETRY_MS = 25

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export const lockPathFor = (file: string): string => join(dirname(file), `.${basename(file)}.lock`)

export function withFileLock<T>(file: string, fn: () => T, o: LockOptions = {}): T {
  const lock = lockPathFor(file)
  const timeout = o.timeoutMs ?? 5_000
  const stale = o.staleMs ?? STALE_MS
  const started = Date.now()
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}`)
      closeSync(fd)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > stale) {
          unlinkSync(lock) // reclaim a crashed holder's lock
          continue
        }
      } catch {
        continue // vanished between the check and the stat — try again
      }
      if (Date.now() - started > timeout) {
        let holder = '?'
        try {
          holder = readFileSync(lock, 'utf8')
        } catch {
          // unreadable holder info is fine
        }
        throw new Error(`chain file is locked by another ddag session (${holder.trim()}) — retry in a moment`)
      }
      sleepSync(RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(lock)
    } catch {
      // already gone
    }
  }
}

/** Write via a temp file and rename, so a concurrent reader never sees a partial file. */
export function atomicWrite(file: string, data: string): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, data)
  renameSync(tmp, file)
}
