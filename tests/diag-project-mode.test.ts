/**
 * A run's kind must come from the project's STORED mode, never from a guess at
 * its page kinds. The original inference ("every page is kind OTHER") would have
 * turned a maturity project whose pages happen to be OTHER into a diagnostic run,
 * silently dropping its scoring — this test exists to keep that from coming back.
 */
import { describe, it, expect } from "vitest"
import { isDiagProject } from "../src/web/routes/projects"

describe("isDiagProject", () => {
  it("recognises a diagnostic project", () => {
    expect(isDiagProject({ mode: "DIAGNOSTIC" })).toBe(true)
  })

  it("leaves a maturity project alone, whatever its pages look like", () => {
    expect(isDiagProject({ mode: "STANDARD" })).toBe(false)
    expect(isDiagProject({ mode: "MONITORING" })).toBe(false)
  })
})
