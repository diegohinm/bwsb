#!/usr/bin/env node
/**
 * `prisma generate`, safe to run while the dev API / worker is up on Windows.
 *
 * Why this exists: Prisma writes the generated JS/types first and THEN installs
 * the query engine with copy-to-temp + rename-over. A running API
 * (`tsx watch src/server.ts`) or worker (`node dist/worker.js`) has that DLL
 * loaded, and Windows refuses to replace a loaded DLL, so `npm run build` died
 * with EPERM — after the JS was regenerated but before `schema.prisma` and the
 * wasm engine were written, i.e. with a half-updated client and a failed build.
 *
 * Windows does allow RENAMING a loaded DLL. So before generating, each
 * installed engine is moved aside to `<name>.stale-<timestamp>`; Prisma then
 * installs a fresh engine under the canonical name and completes every step.
 * Running processes keep their (already mapped) old copy until they restart —
 * the runtime only ever loads the canonical file name, never a `.stale-*` one.
 * Stale copies and the `.tmp<pid>` files earlier EPERM runs left behind are
 * deleted as soon as nothing holds them (this run if possible, else the next).
 * If generation fails, the original engine is put back where it was.
 *
 * Everywhere else (Linux CI / Render, macOS) this is a plain passthrough.
 *
 * Usage: node scripts/prisma-generate.mjs [extra prisma generate args]
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js')
const clientDir = path.join(root, 'node_modules', '.prisma', 'client')

const ENGINE = /^query_engine-.+\.dll\.node$/
const LEFTOVER = /^query_engine-.+\.dll\.node\.(tmp\d+|stale-\d+)$/

const log = (message) => console.log(`[prisma-generate] ${message}`)

function listClientDir() {
  try {
    return fs.readdirSync(clientDir)
  } catch {
    return [] // never generated yet — nothing to move or clean
  }
}

/** Deletes leftovers nothing holds anymore; returns the ones still locked. */
function removeLeftovers() {
  const locked = []
  for (const name of listClientDir()) {
    if (!LEFTOVER.test(name)) continue
    try {
      fs.unlinkSync(path.join(clientDir, name))
    } catch {
      locked.push(name)
    }
  }
  return locked
}

/** Renames each installed engine out of the way so Prisma can write a new one. */
function moveEnginesAside() {
  const stamp = Date.now()
  const moved = []
  for (const name of listClientDir()) {
    if (!ENGINE.test(name)) continue
    const from = path.join(clientDir, name)
    const to = `${from}.stale-${stamp}`
    try {
      fs.renameSync(from, to)
      moved.push({ from, to })
    } catch (err) {
      log(`could not move ${name} aside (${err.code ?? err.message}); prisma will try to replace it in place`)
    }
  }
  return moved
}

function restoreEngines(moved) {
  for (const { from, to } of moved) {
    if (fs.existsSync(from)) continue // prisma got as far as installing a new one
    try {
      fs.renameSync(to, from)
    } catch (err) {
      console.error(`[prisma-generate] could not restore ${path.basename(from)}: ${err.code ?? err.message}`)
    }
  }
}

const windows = process.platform === 'win32'
let moved = []
if (windows) {
  removeLeftovers()
  moved = moveEnginesAside()
}

const result = spawnSync(process.execPath, [prismaCli, 'generate', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

if (result.error) console.error(`[prisma-generate] could not run prisma: ${result.error.message}`)
const status = result.status ?? 1

if (status !== 0) {
  restoreEngines(moved)
  process.exit(status)
}

if (windows) {
  const locked = removeLeftovers()
  if (locked.length > 0) {
    log(
      `a running API/worker still has the previous query engine loaded (${locked.length} stale ` +
        'copy kept, removed on a later generate). Restart them to load the regenerated client.',
    )
  }
}
