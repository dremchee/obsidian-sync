import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const distDir = resolve(rootDir, 'dist')
const envFile = resolve(rootDir, '.env')

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return
  const raw = readFileSync(filePath, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

loadDotEnv(envFile)

const targetDir = process.env.OBSIDIAN_PLUGIN_DIR

console.log(`Deploying plugin to ${targetDir}`)

if (!targetDir) {
  throw new Error('OBSIDIAN_PLUGIN_DIR not set (set it in plugin/.env or shell env)')
}

if (!existsSync(distDir)) {
  throw new Error(`Build output directory not found: ${distDir}`)
}

mkdirSync(targetDir, { recursive: true })

const entries = readdirSync(distDir)
if (!entries.length) {
  throw new Error(`Build output directory is empty: ${distDir}`)
}

for (const entry of entries) {
  cpSync(resolve(distDir, entry), resolve(targetDir, entry), {
    recursive: true,
    force: true
  })
}

console.log(`Plugin deployed to ${targetDir}`)
