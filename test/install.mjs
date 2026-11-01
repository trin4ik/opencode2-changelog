#!/usr/bin/env node
// Pre-release install test: for the minimum and the newest OpenCode 2, a clean Docker container installs the plugin
// as the README says and opens /changelog in the real TUI. Needs Docker and network; tests the committed HEAD.
// Usage: npm run test:install [-- 2.1.4 2.2.5]
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const minimum = /const MINIMUM = "(\d+\.\d+\.\d+)"/.exec(readFileSync(`${root}/scripts/install.mjs`, "utf8"))[1]
const latest = execFileSync("npm", ["view", "@opencode/cli", "version"], { encoding: "utf8" }).trim()
const versions = process.argv.length > 2 ? process.argv.slice(2) : [...new Set([minimum, latest])]

const failed = versions.filter((version) => {
  console.log(`\n=== OpenCode ${version}`)
  const image = `opencode2-changelog-install:${version}`
  try {
    execFileSync(
      "docker",
      [
        "build",
        "--quiet",
        "--build-arg",
        `OPENCODE_VERSION=${version}`,
        "-t",
        image,
        "-f",
        "test/install.Dockerfile",
        "test",
      ],
      { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
    )
    execFileSync("docker", ["run", "--rm", "-v", `${root}:/src:ro`, image, "bash", "/src/test/install-check.sh"], {
      stdio: "inherit",
    })
    return false
  } catch {
    return true
  }
})

if (failed.length) {
  console.error(`\n✗ install test failed on OpenCode ${failed.join(", ")}`)
  process.exit(1)
}
console.log(`\n✓ install test passed on OpenCode ${versions.join(", ")}`)
