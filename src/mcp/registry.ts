import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { atomicWrite, withFileLock } from './lock'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * The project registry: every chain file the MCP server has loaded or
 * written, so the dashboard can list and serve projects without any
 * configuration. Lives in ~/.ddag/projects.json (DDAG_HOME overrides the
 * directory). Entries are keyed by absolute chain path — a repository with
 * several chains registers each — and named after the chain's folder, with
 * a numeric suffix when two folders share a basename.
 */
export interface ProjectEntry {
  name: string
  /** absolute path of the chain file */
  chain: string
  /** the chain's directory — the project */
  dir: string
  /** ISO timestamp of the last load or write */
  lastSeen: string
}

export function defaultRegistryPath(): string {
  return join(process.env['DDAG_HOME'] ?? join(homedir(), '.ddag'), 'projects.json')
}

export class Registry {
  constructor(readonly file: string = defaultRegistryPath()) {}

  /** A corrupt or missing file reads as empty — the registry must never take a server down. */
  read(): ProjectEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { projects?: unknown }
      if (!Array.isArray(raw.projects)) return []
      return raw.projects.filter(
        (p): p is ProjectEntry =>
          typeof p === 'object' && p !== null && typeof (p as ProjectEntry).name === 'string' && typeof (p as ProjectEntry).chain === 'string',
      )
    } catch {
      return []
    }
  }

  find(name: string): ProjectEntry | undefined {
    return this.read().find((p) => p.name === name)
  }

  register(chainFile: string): ProjectEntry {
    mkdirSync(dirname(this.file), { recursive: true })
    return withFileLock(this.file, () => this.registerLocked(chainFile))
  }

  private registerLocked(chainFile: string): ProjectEntry {
    const chain = resolve(chainFile)
    const entries = this.read()
    const now = new Date().toISOString()
    const existing = entries.find((p) => p.chain === chain)
    if (existing) {
      existing.lastSeen = now
      this.write(entries)
      return existing
    }
    const dir = dirname(chain)
    const taken = new Set(entries.map((p) => p.name))
    const base = basename(dir) || 'project'
    let name = base
    for (let i = 2; taken.has(name); i++) name = `${base}-${i}`
    const entry: ProjectEntry = { name, chain, dir, lastSeen: now }
    entries.push(entry)
    this.write(entries)
    return entry
  }

  private write(projects: ProjectEntry[]): void {
    atomicWrite(this.file, JSON.stringify({ projects }, null, 2))
  }
}

export const registryExists = (file: string = defaultRegistryPath()): boolean => existsSync(file)
