/**
 * Syntax-check every inline <script> in the EJS views.
 *
 * Why this exists: a broken string literal inside footer.ejs silently took down
 * the WHOLE script block, so `toggleCrit` and `diagCheckEdit` were never defined
 * and every accordion button in the app did nothing when clicked. Nothing caught
 * it — `ejs.compile` only validates the TEMPLATE, never the JavaScript it emits,
 * and the page still rendered perfectly. Only a real browser console showed
 * "toggleCrit is not defined".
 *
 * Parsing the emitted script here turns that class of bug into a failing test.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import vm from "node:vm"

const VIEWS = join(import.meta.dirname, "..", "src", "web", "views")

/** Every .ejs under views/, including partials/. */
function viewFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...viewFiles(full))
    else if (entry.name.endsWith(".ejs")) out.push(full)
  }
  return out
}

/**
 * Inline <script> bodies, with EJS tags blanked out: a template expression is not
 * JavaScript we can parse, but replacing it with a harmless literal keeps the
 * surrounding syntax checkable — which is exactly what we care about here.
 */
function inlineScripts(source: string): string[] {
  const out: string[] = []
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const body = m[1].replace(/<%[-=]?([\s\S]*?)%>/g, "0")
    if (body.trim()) out.push(body)
  }
  return out
}

describe("inline view scripts", () => {
  const files = viewFiles(VIEWS)

  it("finds the views to check", () => {
    expect(files.length).toBeGreaterThan(5)
  })

  for (const file of files) {
    const scripts = inlineScripts(readFileSync(file, "utf-8"))
    if (scripts.length === 0) continue
    it(`parses the inline script(s) of ${file.split(/[\\/]/).pop()}`, () => {
      for (const body of scripts) {
        expect(() => new vm.Script(body)).not.toThrow()
      }
    })
  }
})

describe("footer helpers", () => {
  const footer = readFileSync(join(VIEWS, "partials", "footer.ejs"), "utf-8")

  // Both are called from onclick/onchange attributes rendered by other views, so
  // they must exist as globals on every page — a missing one is a dead button.
  it("defines toggleCrit and diagCheckEdit", () => {
    expect(footer).toMatch(/function toggleCrit\(/)
    expect(footer).toMatch(/function diagCheckEdit\(/)
  })
})
