/**
 * Page discovery — plain HTTP fetcher (no browser). Cheap and fast, and enough for
 * most sites; a WAF block or a navigation built in JavaScript is what the browser
 * fetcher (./browser.ts) is for.
 */
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { Fetcher, FetchResult } from "./types";

const UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Mobile Safari/537.36";

/** A homepage's markup or a sitemap's first entries — 3 MB is already generous. */
const MAX_BODY_BYTES = 3_000_000;

type Hop =
  | { url: string; status: number; body: Buffer; encoding?: string; location?: string }
  | { error: string };

function requestOnce(url: string): Promise<Hop> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return resolve({ error: "URL invalide" });
    }
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "fr-FR,fr;q=0.9,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
        timeout: 20_000,
        // Same allowance as the collector's direct request: some CDNs send more
        // than Node's 16 KB default of response headers.
        maxHeaderSize: 256 * 1024,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ url: u.toString(), status, body: Buffer.alloc(0), location });
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (c: Buffer) => {
          if (bytes >= MAX_BODY_BYTES) {
            res.destroy(); // enough read — a truncated body is still usable
            return;
          }
          bytes += c.length;
          chunks.push(c);
        });
        const done = () =>
          resolve({
            url: u.toString(),
            status,
            body: Buffer.concat(chunks),
            encoding: String(res.headers["content-encoding"] ?? "").toLowerCase(),
          });
        res.on("end", done);
        res.on("close", done); // destroyed above: resolve with what was read
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ error: "timeout" });
    });
    req.on("error", (e) => resolve({ error: (e as Error).message }));
    req.end();
  });
}

/**
 * Decodes a body: its Content-Encoding first, then a gzip FILE (`sitemap.xml.gz`
 * is served as a gzip payload, not as an encoded response). Tolerates a stream cut
 * short by the size cap — whatever was inflated before the cut is kept.
 */
export function decodeBody(body: Buffer, encoding = ""): string {
  const lenient = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  let buf = body;
  try {
    if (encoding.includes("br")) buf = zlib.brotliDecompressSync(buf, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    else if (encoding.includes("gzip")) buf = zlib.gunzipSync(buf, lenient);
    else if (encoding.includes("deflate")) buf = zlib.inflateSync(buf, lenient);
  } catch {
    /* mislabelled encoding — read the bytes as they are */
  }
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = zlib.gunzipSync(buf, lenient);
    } catch {
      /* not really gzip */
    }
  }
  return buf.toString("utf-8");
}

async function getOnce(url: string): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    const r = await requestOnce(current);
    if ("error" in r) return r;
    if (r.location) {
      try {
        current = new URL(r.location, r.url).toString();
      } catch {
        return { error: "redirection invalide" };
      }
      continue;
    }
    return { url: r.url, status: r.status, html: decodeBody(r.body, r.encoding) };
  }
  return { error: "trop de redirections" };
}

/**
 * GET following redirects, resolving to the FINAL url + body. A timeout or a socket
 * error is retried once: losing a whole site to one flaky connection is not worth it.
 */
export async function httpGet(url: string, retriesLeft = 1): Promise<FetchResult> {
  const r = await getOnce(url);
  if ("error" in r && retriesLeft > 0 && r.error !== "URL invalide") {
    await new Promise((s) => setTimeout(s, 1500));
    return httpGet(url, retriesLeft - 1);
  }
  return r;
}

export const httpFetcher: Fetcher = { kind: "http", get: (url) => httpGet(url) };
