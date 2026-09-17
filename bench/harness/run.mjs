#!/usr/bin/env node
// node bench/harness/run.mjs --version 0.3.2            a published version, from npm
// node bench/harness/run.mjs --local dist/ddag-mcp.mjs --label 0.4.1-local   an unreleased build
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, platform, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { metric, openSession, scratchProject, sha256 } from './lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const bench = resolve(here, '..')
const HARNESS = '1'
const argv = process.argv.slice(2)
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
const target = arg('--local') ? { local: resolve(arg('--local')), version: arg('--label') ?? 'local' } : { version: arg('--version') }
if (!target.version) {
  console.error('usage: run.mjs --version <x.y.z> | --local <path to ddag-mcp.mjs> --label <name>')
  process.exit(2)
}

const caseDir = join(bench, 'cases/mechanism')
const result = { suite: 'mechanism', version: target.version, source: target.local ? 'local build' : 'npm', harness: HARNESS, date: new Date().toISOString(), env: { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? '?' }, cases: {} }

// warm the npx cache so the first session does not pay the download
if (!target.local) await (await openSession(target, scratchProject({ 'README.md': 'warm-up\n' }))).close()

for (const file of readdirSync(caseDir).filter((f) => f.endsWith('.mjs')).sort()) {
  const mod = await import(join(caseDir, file))
  const hash = sha256(readFileSync(join(caseDir, file), 'utf8')).slice(0, 12)
  const project = scratchProject(mod.files())
  const s = await openSession(target, project)
  process.stderr.write(`${target.version}  ${mod.name} … `)
  const metrics = await mod.run(s, project)
  if (mod.name === 'standard-session') {
    metrics.tools = metric(s.tools.length, 'tools', 'neutral', 'Tools the server offers')
    metrics.start_ms = { ...metric(Math.round(s.startMs), 'ms', 'lower', 'Server start to first tool list', target.local ? 'local bundle' : 'through npx, cache warm'), compare: 'same-source' }
  }
  await s.close()
  result.cases[mod.name] = { title: mod.title, hash, metrics, steps: s.steps }
  process.stderr.write(`${s.steps.length} steps\n`)
}
if (!target.local) {
  try {
    const v = JSON.parse(execFileSync('npm', ['view', `@dreamc0der/ddag@${target.version}`, 'dist', '--json'], { encoding: 'utf8' }))
    result.cases['standard-session'].metrics.package_bytes = metric(v.unpackedSize, 'bytes', 'lower', 'npm package, unpacked')
  } catch {}
}
const outDir = join(bench, 'results/mechanism')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, `${target.version}.json`), JSON.stringify(result, null, 1))
const all = readdirSync(outDir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort()
writeFileSync(join(bench, 'results/index.json'), JSON.stringify({ mechanism: all.map((f) => `mechanism/${f}`) }, null, 1))
console.log(`wrote results/mechanism/${target.version}.json`)
