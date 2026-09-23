import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { EventChain, isVersionOp, type ChainDump, type VersionOp } from '../chain/chain'
import { checkpointOf, nextSegment } from '../chain/segments'
import { atomicWrite } from './lock'

/**
 * The chain folder (chain-segments): a project's chain lives in
 * <project>/.ddag — chain.json is the live segment, archive/NNN-<version>.json
 * the sealed ones, and a migrated single-file chain is kept beside them
 * untouched. A chain file given by any other path is a single-file chain:
 * it works as before and never rolls.
 */
export const CHAIN_FOLDER = '.ddag'
export const LIVE_NAME = 'chain.json'
export const ARCHIVE_DIR = 'archive'
export const LEGACY_NAME = 'ddag.json'
export const MIGRATED_NAME = 'migrated-ddag.json'

/** The .ddag folder a chain file lives in, when it is a folder chain; null for a single-file chain. */
export function folderOf(file: string): string | null {
  const abs = resolve(file)
  return basename(abs) === LIVE_NAME && basename(dirname(abs)) === CHAIN_FOLDER ? dirname(abs) : null
}

/** The project directory of a chain file: above the folder for a folder chain, the file's directory otherwise. */
export function projectDirOf(file: string): string {
  const folder = folderOf(file)
  return folder === null ? dirname(resolve(file)) : dirname(folder)
}

export const liveChainPath = (projectDir: string): string => join(projectDir, CHAIN_FOLDER, LIVE_NAME)

export function archiveName(segment: number, version: string): string {
  const safe = version.replace(/[^A-Za-z0-9._-]+/g, '-') || 'version'
  return `${String(segment).padStart(3, '0')}-${safe}.json`
}

/**
 * Seal the live chain at a version mark and prepare the next segment: the
 * sealed segment is written to the archive first, and the next segment's
 * dump is returned for the caller to write as the live chain under its lock.
 */
export function sealAt(folder: string, chain: EventChain, version: string): { archive: string; next: ChainDump; sealedEvents: number } {
  const segment = chain.checkpoint?.segment ?? 0
  const rel = join(ARCHIVE_DIR, archiveName(segment, version))
  const archive = join(folder, rel)
  mkdirSync(dirname(archive), { recursive: true })
  atomicWrite(archive, JSON.stringify(chain.dump()))
  const checkpoint = checkpointOf(chain, { segment: segment + 1, parent: rel, after: version })
  return { archive, next: nextSegment(chain, checkpoint), sealedEvents: chain.length }
}

/**
 * Move a single-file chain into a .ddag folder beside it, split at its
 * version marks: one sealed segment per version, each replayed to prove it
 * stands on its own, then the live segment. Every event keeps its number.
 * The original file is moved into the folder untouched, so nothing is lost
 * and the old path no longer exists to be written by an older shell.
 */
export function migrateToFolder(file: string): { live: string; segments: number; events: number } {
  const abs = resolve(file)
  const dump = JSON.parse(readFileSync(abs, 'utf8')) as ChainDump
  if (dump.checkpoint !== undefined) throw new Error(`${abs} is already a segment; it belongs in a .ddag folder`)
  const full = EventChain.replay(dump) // the whole file must replay before anything is written
  const folder = join(dirname(abs), CHAIN_FOLDER)
  mkdirSync(join(folder, ARCHIVE_DIR), { recursive: true })
  const marks = full
    .chain()
    .filter((e) => isVersionOp(e.op))
    .map((e) => ({ seq: e.seq, name: (e.op as VersionOp).name }))
  let current: ChainDump = { initial: dump.initial, events: [] }
  if (dump.meta !== undefined) current.meta = dump.meta
  let segment = 0
  let from = 0
  for (const m of marks) {
    const sealed: ChainDump = { ...current, events: dump.events.slice(from, m.seq) }
    const chain = EventChain.replay(sealed)
    const rel = join(ARCHIVE_DIR, archiveName(segment, m.name))
    atomicWrite(join(folder, rel), JSON.stringify(sealed))
    current = nextSegment(chain, checkpointOf(chain, { segment: segment + 1, parent: rel, after: m.name }))
    segment++
    from = m.seq
  }
  const live: ChainDump = { ...current, events: dump.events.slice(from) }
  EventChain.replay(live) // the tail must stand on its checkpoint
  atomicWrite(join(folder, LIVE_NAME), JSON.stringify(live))
  renameSync(abs, join(folder, MIGRATED_NAME))
  return { live: join(folder, LIVE_NAME), segments: segment, events: dump.events.length }
}

export interface OpenedChain {
  file: string
  migrated?: { from: string; segments: number; events: number }
}

/**
 * Where the chain for a request lives, migrating a single ddag.json into a
 * folder on the way:
 * - no request: <cwd>/.ddag/chain.json, after migrating a <cwd>/ddag.json beside it;
 * - a directory, or a path named .ddag: that project's folder chain;
 * - a path named ddag.json, or inside a .ddag folder: that project's folder chain, migrating the file if it exists;
 * - any other file path: a single-file chain, used as given, which never rolls.
 */
export function openChainPath(cwd: string, requested?: string): OpenedChain {
  const target = resolve(cwd, requested ?? '.')
  let dir: string | null = null
  if (requested === undefined) dir = resolve(cwd)
  else if (existsSync(target) && statSync(target).isDirectory()) dir = basename(target) === CHAIN_FOLDER ? dirname(target) : target
  else if (basename(target) === CHAIN_FOLDER || basename(target) === LEGACY_NAME) dir = dirname(target)
  else if (folderOf(target) !== null) dir = projectDirOf(target)
  if (dir === null) return { file: target }
  const live = liveChainPath(dir)
  const legacy = join(dir, LEGACY_NAME)
  if (!existsSync(live) && existsSync(legacy)) {
    const m = migrateToFolder(legacy)
    return { file: live, migrated: { from: legacy, segments: m.segments, events: m.events } }
  }
  return { file: live }
}
