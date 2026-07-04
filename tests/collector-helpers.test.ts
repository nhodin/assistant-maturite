/**
 * Unit tests for the pure helpers extracted from the collector (src/collector/index.ts).
 * These are network-free: the collector's capture path itself has no mocked-network
 * tests, so the reviewable logic (HTTP/2 header normalization, zstd feature-detect)
 * lives in exported pure functions tested here.
 */
import { describe, it, expect } from "vitest"
import {
  extractFontFacesFromCss,
  normalizeHttp2Headers,
  zstdDecompressorAvailable,
} from "../src/collector/index"

describe("extractFontFacesFromCss", () => {
  it("parses ascent-override and descent-override into the FontFace", () => {
    const css = `
      @font-face {
        font-family: "Fallback";
        src: local("Arial");
        ascent-override: 90%;
        descent-override: 22.5%;
        size-adjust: 105%;
      }
    `
    const [font] = extractFontFacesFromCss(css)
    expect(font.family).toBe("Fallback")
    expect(font.ascentOverride).toBe("90%")
    expect(font.descentOverride).toBe("22.5%")
    expect(font.sizeAdjust).toBe("105%")
    expect(font.src).toContain("local(")
  })
})

describe("normalizeHttp2Headers", () => {
  it("strips pseudo-headers (leading ':') and lowercases keys", () => {
    const out = normalizeHttp2Headers({
      ":status": 103,
      ":path": "/x",
      Link: "</a.css>; rel=preload",
      "Cache-Control": "max-age=60",
    })
    expect(out).toEqual({
      link: "</a.css>; rel=preload",
      "cache-control": "max-age=60",
    })
    expect(out[":status"]).toBeUndefined()
    expect(out[":path"]).toBeUndefined()
  })

  it("joins array-valued headers with ', '", () => {
    const out = normalizeHttp2Headers({
      Link: ["</a.css>; rel=preload", "</b.js>; rel=preload"],
    })
    expect(out.link).toBe("</a.css>; rel=preload, </b.js>; rel=preload")
  })

  it("stringifies non-string scalar values", () => {
    const out = normalizeHttp2Headers({ "x-count": 42 })
    expect(out["x-count"]).toBe("42")
  })

  it("returns an empty object when only pseudo-headers are present", () => {
    expect(normalizeHttp2Headers({ ":status": 200, ":path": "/" })).toEqual({})
  })
})

describe("zstdDecompressorAvailable", () => {
  it("true when the zlib-like object exposes createZstdDecompress", () => {
    expect(zstdDecompressorAvailable({ createZstdDecompress: () => ({}) })).toBe(true)
  })

  it("false when createZstdDecompress is missing", () => {
    expect(zstdDecompressorAvailable({})).toBe(false)
  })

  it("false when createZstdDecompress is not a function", () => {
    expect(zstdDecompressorAvailable({ createZstdDecompress: 123 })).toBe(false)
  })

  it("defaults to probing the real node:zlib without throwing", () => {
    expect(typeof zstdDecompressorAvailable()).toBe("boolean")
  })
})
