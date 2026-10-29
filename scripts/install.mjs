#!/usr/bin/env node
// One-step installer for people and coding agents: checks OpenCode, builds the plugin and registers it in cli.json.
// Uses only Node built-ins, so it runs straight after `git clone`. Re-running it is safe.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const MINIMUM = "2.1.4"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = new Set(process.argv.slice(2))
const keepHighlights = args.has("--keep-highlights")
const skipVersionCheck = args.has("--skip-version-check")

const fail = (message) => {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}
const step = (message) => console.log(`• ${message}`)
const newer = (left, right) => {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index]
  return false
}

const [major] = process.versions.node.split(".").map(Number)
if (major < 20) fail(`Node.js 20 or newer is required to build the plugin (found ${process.versions.node}).`)

// 1. OpenCode version
let version
for (const binary of ["opencode", "opencode2"]) {
  try {
    const output = execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    version = /(\d+\.\d+\.\d+)/.exec(output)?.[1]
    if (version) break
  } catch {}
}
if (!version && !skipVersionCheck) fail("OpenCode was not found on PATH. Install OpenCode 2 first: https://opencode.ai")
if (version && !version.startsWith("2.") && !skipVersionCheck)
  fail(`This is a plugin for OpenCode 2, but OpenCode ${version} is installed. Install OpenCode 2: https://opencode.ai`)
if (version && newer(MINIMUM, version) && !skipVersionCheck)
  fail(
    `OpenCode ${version} is too old: opencode2-changelog needs OpenCode ${MINIMUM} or newer and will not work on it.\n` +
      `  Update OpenCode (run /update in the TUI or \`opencode upgrade\`), then run this installer again.`,
  )
step(version ? `OpenCode ${version} — supported (${MINIMUM}+)` : "OpenCode version not checked")

// 2. Build
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
try {
  step("Installing build dependencies (npm ci)…")
  execFileSync(npm, ["ci", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: root, stdio: "inherit" })
  step("Building…")
  execFileSync(npm, ["run", "--silent", "build"], { cwd: root, stdio: "inherit" })
} catch {
  fail("The build failed; see the npm output above.")
}
if (!existsSync(join(root, "dist", "tui.js"))) fail("The build did not produce dist/tui.js.")

// 3. Register in the TUI settings file (OpenCode docs: $XDG_CONFIG_HOME/opencode/cli.json, else ~/.config/opencode).
const directory =
  process.env.OPENCODE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
const file = join(directory, "cli.json")
let config = {}
if (existsSync(file)) {
  try {
    config = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    fail(`${file} is not valid JSON; fix it or add the plugin by hand (see README).`)
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) fail(`${file} must contain a JSON object.`)
}
const plugins = Array.isArray(config.plugins) ? config.plugins : []
const entry = (item) => (typeof item === "string" ? item : item?.package)
const same = (item) => {
  const value = entry(item)
  return (
    typeof value === "string" &&
    (resolve(value.replace(/^file:\/\//, "")) === root || /opencode2-changelog\/?$/.test(value))
  )
}
const existing = plugins.find(same)
const next = {
  $schema: "https://opencode.ai/v2/cli.json",
  ...config,
  // Keep options of an existing entry; point it at this checkout.
  plugins: [
    ...plugins.filter((item) => !same(item)),
    typeof existing === "object" && existing ? { ...existing, package: root } : root,
  ],
}
if (!keepHighlights) next.highlights = false
mkdirSync(directory, { recursive: true })
if (existsSync(file)) writeFileSync(`${file}.bak`, readFileSync(file))
writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
renameSync(`${file}.tmp`, file)
step(`Registered in ${file}${keepHighlights ? "" : " (built-in highlights dialog turned off)"}`)

console.log(`
✓ opencode2-changelog is installed.
  Restart the OpenCode TUI and type /changelog. After each OpenCode update it opens by itself.
  Update later: git -C ${root} pull && node ${join(root, "scripts", "install.mjs")}
`)
