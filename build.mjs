// Compile Solid before packaging; replace generated files atomically for safe hot reload.
import { transformFileAsync } from "@babel/core"
import typescript from "@babel/preset-typescript"
import solid from "babel-preset-solid"
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises"

const dist = new URL("./dist/", import.meta.url)
await mkdir(dist, { recursive: true })
// Recursive: animation modules live in src/motion/.
for (const name of await readdir(new URL("./src/", import.meta.url), { recursive: true })) {
  if (!/\.tsx?$/.test(name)) continue
  await mkdir(new URL(name.replace(/[^/]*$/, ""), dist), { recursive: true })
  const output = await transformFileAsync(new URL(`./src/${name}`, import.meta.url).pathname, {
    configFile: false,
    babelrc: false,
    presets: [
      ...(name.endsWith(".tsx") ? [[solid, { moduleName: "@opentui/solid", generate: "universal" }]] : []),
      typescript,
    ],
    plugins: [
      () => ({
        visitor: {
          ImportDeclaration(path) {
            const source = path.node.source
            if (source.value.startsWith(".") && !/\.[a-z]+$/.test(source.value)) source.value += ".js"
          },
        },
      }),
    ],
  })
  const target = new URL(name.replace(/\.tsx?$/, ".js"), dist)
  const code = output.code + "\n"
  if ((await readFile(target, "utf8").catch(() => "")) === code) continue
  const temp = new URL(name.replace(/([^/]*)$/, `.$1.${process.pid}.tmp`), dist)
  await writeFile(temp, code)
  await rename(temp, target)
}
