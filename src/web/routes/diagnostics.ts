import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { collect } from "../../collector";
import { openBrowser } from "../../collector/browser";

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
function ok(html: string): string {
  return `<div class="diag-result diag-ok">✅ ${html}</div>`;
}
function fail(html: string): string {
  return `<div class="diag-result diag-fail">❌ ${html}</div>`;
}

export async function diagnosticsRoutes(app: FastifyInstance) {
  app.get("/diagnostics", async (_req, reply) => {
    return reply.view("diagnostics", { active: "diagnostics", title: "Diagnostics" });
  });

  // MySQL connectivity
  app.post("/diagnostics/mysql", async (_req, reply) => {
    reply.type("text/html");
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      const sites = await prisma.site.count();
      const runs = await prisma.run.count();
      return reply.send(ok(`MySQL reachable — ${sites} site(s), ${runs} run(s) stored.`));
    } catch (e) {
      return reply.send(fail(`MySQL error: ${esc(String(e)).slice(0, 300)}`));
    }
  });

  // Quick browser launch test (no scoring)
  app.post("/diagnostics/browser", async (req, reply) => {
    reply.type("text/html");
    const b = req.body as any;
    const browser = b.browser === "cloak" ? "cloak" : "playwright";
    const t0 = Date.now();
    let opened;
    try {
      opened = await openBrowser({ browser, device: "mobile" });
      const page = await opened.context.newPage();
      await page.goto("https://www.example.com", { waitUntil: "load", timeout: 30000 });
      const title = await page.title();
      await opened.close();
      return reply.send(
        ok(`${browser} launched OK in ${Date.now() - t0}ms — example.com title: "${esc(title)}"`),
      );
    } catch (e) {
      try { await opened?.close(); } catch { /* ignore */ }
      return reply.send(fail(`${browser} launch failed: ${esc(String(e)).slice(0, 300)}`));
    }
  });

  // Collect a single URL and summarise the EvidenceBundle
  app.post("/diagnostics/collect", async (req, reply) => {
    reply.type("text/html");
    const b = req.body as any;
    const url = String(b.url ?? "").trim();
    const browser = b.browser === "cloak" ? "cloak" : "playwright";
    if (!/^https?:\/\//i.test(url)) {
      return reply.send(fail("Please provide a valid http(s) URL."));
    }
    const t0 = Date.now();
    try {
      const e = await collect(url, { browser, device: "mobile", acceptCookies: true });
      const imgReqs = e.requests.filter((r) => r.resourceType === "image").length;
      const rows = [
        `URL: ${esc(e.finalUrl)}`,
        `requests: ${e.requests.length} (images: ${imgReqs})`,
        `rawHtml: ${(e.rawHtml.length / 1024).toFixed(0)} KB · renderedHtml: ${(e.renderedHtml.length / 1024).toFixed(0)} KB`,
        `LCP: ${e.perf.lcpMs ?? "—"} ms (${e.perf.lcpElement?.tagName ?? "no element"}) · CLS: ${e.perf.cls ?? "—"} · TTFB: ${e.perf.ttfbMs ?? "—"} ms`,
        `TLS: ${e.network.tlsVersion ?? "—"} · ALPN: ${e.network.alpn ?? "—"} · HTTP/3: ${e.network.http3 ?? "—"} · IPv6: ${e.network.ipv6 ?? "—"}`,
        `slider: ${e.features.sliderDetected} · video: ${e.features.videoDetected} · cookies accepted: ${e.features.cookieAccepted}`,
      ];
      const blocked = e.renderedHtml.length < 1000;
      const head = `${browser} collect OK in ${Date.now() - t0}ms${blocked ? " — ⚠ rendered DOM very small (possible bot block)" : ""}`;
      return reply.send(
        (blocked ? fail : ok)(`${head}<pre>${esc(rows.join("\n"))}</pre>`),
      );
    } catch (e) {
      return reply.send(fail(`collect failed: ${esc(String(e)).slice(0, 400)}`));
    }
  });
}
