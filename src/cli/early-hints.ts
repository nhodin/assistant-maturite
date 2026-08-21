/**
 * Debug runner: probes a URL for a 103 Early Hints interim response and prints
 * the Link directives of both the 103 and the final response.
 *
 * Many CDNs only emit 103 over HTTP/2 AND only for requests that look like a
 * real top-level navigation (sec-fetch-*). `--bare` replays the request without
 * those navigation headers so the differential is visible.
 *
 * Usage: npx tsx src/cli/early-hints.ts <url> [--bare] [--h1] [--raw]
 */
import http2 from "http2";
import https from "https";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) " +
  "Version/16.0 Mobile/15E148 Safari/604.1";

const NAVIGATION_HEADERS: Record<string, string> = {
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

const url = process.argv[2];
const bare = process.argv.includes("--bare");
const h1 = process.argv.includes("--h1");
const raw = process.argv.includes("--raw");

if (!url) {
  console.error("Usage: npx tsx src/cli/early-hints.ts <url> [--bare] [--h1] [--raw]");
  process.exit(1);
}

/** "font,font,style,script,preconnect" — one label per link-value. */
function summarize(link: string): string {
  if (!link) return "(no Link header)";
  return link
    .split(/,(?=\s*<)/)
    .map((d) => {
      if (/rel\s*=\s*["']?preconnect/i.test(d)) return "preconnect";
      if (/rel\s*=\s*["']?dns-prefetch/i.test(d)) return "dns-prefetch";
      const as = d.match(/as\s*=\s*["']?([a-z]+)/i);
      return as ? as[1] : "?";
    })
    .join(",");
}

function report(label: string, link: string): void {
  console.log(`${label.padEnd(22)} ${summarize(link)}`);
  if (raw && link) {
    for (const d of link.split(/,(?=\s*<)/)) console.log(`    ${d.trim()}`);
  }
}

function headersFor(): Record<string, string> {
  const base: Record<string, string> = {
    "user-agent": MOBILE_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "accept-encoding": "gzip, br",
  };
  return bare ? base : { ...base, ...NAVIGATION_HEADERS };
}

function probeHttp1(target: URL): void {
  let seen103 = false;
  const req = https.request(
    target,
    { method: "GET", headers: headersFor() },
    () => undefined,
  );
  req.on("information", (info: { statusCode: number; headers: Record<string, unknown> }) => {
    if (info.statusCode !== 103) return;
    seen103 = true;
    report("103 Early Hints:", String(info.headers.link ?? ""));
  });
  req.on("response", (res) => {
    if (!seen103) console.log("103 Early Hints:      NONE over HTTP/1.1");
    console.log(`final ${res.statusCode}:`.padEnd(22) + summarize(String(res.headers.link ?? "")));
    if (raw) for (const d of String(res.headers.link ?? "").split(/,(?=\s*<)/)) console.log(`    ${d.trim()}`);
    res.resume();
    res.on("end", () => process.exit(0));
  });
  req.on("error", (err) => {
    console.error("error:", err.message);
    process.exit(1);
  });
  req.end();
}

function probeHttp2(target: URL): void {
  const session = http2.connect(target.origin);
  let seen103 = false;
  session.on("error", (err) => {
    console.error("session error:", err.message);
    process.exit(1);
  });
  const req = session.request({
    ":method": "GET",
    ":path": target.pathname + target.search,
    ...headersFor(),
  });
  req.on("headers", (headers: Record<string, unknown>) => {
    if (Number(headers[":status"]) !== 103) return;
    seen103 = true;
    report("103 Early Hints:", String(headers.link ?? ""));
  });
  req.on("response", (headers: Record<string, unknown>) => {
    if (!seen103) console.log("103 Early Hints:      NONE");
    report(`final ${headers[":status"]}:`, String(headers.link ?? ""));
    session.destroy();
    process.exit(0);
  });
  req.on("error", (err) => {
    console.error("request error:", err.message);
    process.exit(1);
  });
  req.end();
}

const target = new URL(url);
console.log(`\n${target.href}  (${h1 ? "HTTP/1.1" : "HTTP/2"}, nav headers: ${bare ? "OFF" : "ON"})`);
console.log("─".repeat(60));
if (h1) probeHttp1(target);
else probeHttp2(target);
