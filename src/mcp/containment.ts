import { existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

const inside = (root: string, abs: string): boolean => abs === root || abs.startsWith(root + sep)

/**
 * The absolute path a chain may live at, given the folder the user opened
 * and a requested path — or null when the request would leave the folder,
 * by a dot segment, an absolute path, or a symlinked directory that points
 * outside (SEC-CONT-3). The check runs on real paths: the deepest existing
 * ancestor of the target is resolved, so a link anywhere on the way is seen.
 */
export function chainPathWithin(cwd: string, requested: string): string | null {
  const root = resolve(cwd)
  const target = resolve(root, requested)
  if (!inside(root, target)) return null
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  let probe = target
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  try {
    const real = realpathSync(probe)
    return inside(realRoot, real) ? target : null
  } catch {
    return null
  }
}
