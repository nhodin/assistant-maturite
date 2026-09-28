/**
 * PDP/PLP discovery executor for diagnostic projects — searches in the background
 * and stores each outcome as a `PageCandidate` for the operator to validate. Spec:
 * ../../../docs/DIAGNOSTIC.md, « Découverte des PDP / PLP ».
 *
 * In-process and fire-and-forget, like runs: the project page polls the candidates.
 * Several sites are searched side by side (each one is a different origin, so no
 * WAF sees two sessions at once); the browser fallback is limited to one session
 * process-wide by ../discovery/browser.ts.
 *
 * Only an ACCEPTED candidate becomes a page of the project: an unvalidated proposal
 * is never diagnosed.
 */
import { Prisma, type PageKind } from "@prisma/client";
import { prisma } from "./db";
import { discoverSite, discoveryStartUrl, isHomeLikeUrl, type DiscoveryKind, type DiscoveryOutcome } from "../discovery";
import { httpFetcher } from "../discovery/http";
import { createBrowserFetcher, type ClosableFetcher } from "../discovery/browser";
import { runPool } from "../collector/concurrency";
import { findCanonicalMatch } from "./url-paste";

/** Sites searched side by side. */
const SITE_CONCURRENCY = 3;
/** Pause between two requests to the same site, ms. */
const DELAY_MS = 400;

/** `${projectId}:${siteId}` of every search in flight. */
const inFlight = new Set<string>();
const keyOf = (projectId: number, siteId: number) => `${projectId}:${siteId}`;

export interface DiscoveryTarget {
  siteId: number;
  startUrl: string;
  kinds: DiscoveryKind[];
}

/**
 * Where to search each site of a project from, and for what: its home (a page of
 * kind HP first, else a home-like URL, else its host's root), for every kind in
 * `kinds` the site does not already have — as a page of the project, or as a
 * candidate that is accepted or still being searched.
 */
export async function projectDiscoveryTargets(projectId: number, kinds: DiscoveryKind[]): Promise<DiscoveryTarget[]> {
  const [pages, candidates] = await Promise.all([
    prisma.projectPage.findMany({
      where: { projectId },
      select: { page: { select: { siteId: true, url: true, kind: true } } },
      orderBy: { pageId: "asc" },
    }),
    prisma.pageCandidate.findMany({
      where: { projectId, status: { in: ["ACCEPTED", "SEARCHING"] } },
      select: { siteId: true, kind: true },
    }),
  ]);
  const bySite = new Map<number, Array<{ url: string; kind: PageKind }>>();
  for (const { page } of pages) {
    const list = bySite.get(page.siteId) ?? [];
    list.push({ url: page.url, kind: page.kind });
    bySite.set(page.siteId, list);
  }
  const targets: DiscoveryTarget[] = [];
  for (const [siteId, list] of bySite) {
    const has = (k: DiscoveryKind) =>
      list.some((p) => p.kind === k) || candidates.some((c) => c.siteId === siteId && c.kind === k);
    const wanted = kinds.filter((k) => !has(k));
    if (!wanted.length) continue;
    const hp = list.find((p) => p.kind === "HP")?.url;
    const startUrl = hp ?? discoveryStartUrl(list.map((p) => p.url));
    if (startUrl) targets.push({ siteId, startUrl, kinds: wanted });
  }
  return targets;
}

/**
 * Marks the targets' candidates SEARCHING (creating them, or resetting a previous
 * proposal), then searches in the background. A site already being searched for
 * this project is skipped, and an ACCEPTED candidate is never reset. Returns how
 * many sites were actually launched.
 */
export async function startDiscovery(projectId: number, targets: DiscoveryTarget[]): Promise<number> {
  const launched: DiscoveryTarget[] = [];
  for (const t of targets) {
    if (inFlight.has(keyOf(projectId, t.siteId))) continue;
    const accepted = await prisma.pageCandidate.findMany({
      where: { projectId, siteId: t.siteId, status: "ACCEPTED", kind: { in: t.kinds } },
      select: { kind: true },
    });
    const kinds = t.kinds.filter((k) => !accepted.some((a) => a.kind === k));
    if (!kinds.length) continue;
    for (const kind of kinds) {
      const reset = {
        status: "SEARCHING" as const,
        startUrl: t.startUrl,
        url: null,
        confidence: null,
        source: null,
        via: null,
        note: null,
        alternatives: Prisma.DbNull,
        pageId: null,
      };
      await prisma.pageCandidate.upsert({
        where: { projectId_siteId_kind: { projectId, siteId: t.siteId, kind } },
        create: { projectId, siteId: t.siteId, kind, ...reset },
        update: reset,
      });
    }
    inFlight.add(keyOf(projectId, t.siteId));
    launched.push({ ...t, kinds });
  }
  if (launched.length) {
    // searchSite settles its own failures; this only guards the pool itself.
    runPool(
      launched.map((t) => () => searchSite(projectId, t)),
      SITE_CONCURRENCY,
    ).catch((err) => console.error(`Discovery pool (project #${projectId}) failed:`, err));
  }
  return launched.length;
}

async function searchSite(projectId: number, t: DiscoveryTarget): Promise<void> {
  const browsers: ClosableFetcher[] = [];
  try {
    const result = await discoverSite(t.startUrl, {
      want: { pdp: t.kinds.includes("PDP"), plp: t.kinds.includes("PLP") },
      http: httpFetcher,
      browser: () => {
        const b = createBrowserFetcher();
        browsers.push(b);
        return b;
      },
      delayMs: DELAY_MS,
    });
    if (t.kinds.includes("PDP") && result.pdp) await saveOutcome(projectId, t.siteId, "PDP", result.pdp);
    if (t.kinds.includes("PLP") && result.plp) await saveOutcome(projectId, t.siteId, "PLP", result.plp);
  } catch (err) {
    console.error(`Discovery ${t.startUrl} (project #${projectId}) crashed:`, err);
    await prisma.pageCandidate
      .updateMany({
        where: { projectId, siteId: t.siteId, kind: { in: t.kinds }, status: "SEARCHING" },
        data: { status: "NOT_FOUND", note: `Recherche interrompue : ${String(err).slice(0, 300)}` },
      })
      .catch(() => {});
  } finally {
    for (const b of browsers) await b.close();
    inFlight.delete(keyOf(projectId, t.siteId));
  }
}

async function saveOutcome(projectId: number, siteId: number, kind: DiscoveryKind, o: DiscoveryOutcome): Promise<void> {
  const data = o.found
    ? {
        status: "PROPOSED" as const,
        url: o.url,
        confidence: o.confidence,
        source: o.source,
        via: o.via,
        note: o.note,
        alternatives: o.alternatives,
      }
    : { status: "NOT_FOUND" as const, via: o.via, note: o.note, alternatives: o.alternatives };
  // Only a search still in flight is written: a candidate the operator settled
  // meanwhile keeps the operator's decision.
  await prisma.pageCandidate.updateMany({
    where: { projectId, siteId, kind, status: "SEARCHING" },
    data,
  });
}

/**
 * A search lives only in this process: anything still SEARCHING at boot died with
 * the previous one. Flipped to NOT_FOUND with the reason, so the UI offers « Relancer »
 * instead of a spinner nobody will ever advance.
 */
export async function recoverStaleDiscoveries(): Promise<number> {
  const r = await prisma.pageCandidate.updateMany({
    where: { status: "SEARCHING" },
    data: { status: "NOT_FOUND", note: "Recherche interrompue (redémarrage du serveur) — relancez-la." },
  });
  return r.count;
}

/** Parses an operator-typed URL: absolute http(s) only. */
function parseHttpUrl(raw: string): string | null {
  const v = raw.trim();
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Validates a candidate: its URL (or the one the operator typed instead) becomes a
 * page of the candidate's site — reused when the site already holds it under the
 * same canonical form — labelled with the candidate's kind, and joins the project.
 * A page already labelled otherwise keeps its label: the inventory may be shared
 * with a maturity project.
 */
export async function acceptCandidate(
  projectId: number,
  candidateId: number,
  typedUrl?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cand = await prisma.pageCandidate.findFirst({ where: { id: candidateId, projectId } });
  if (!cand) return { ok: false, reason: "Proposition introuvable." };
  if (cand.status === "SEARCHING") return { ok: false, reason: "La recherche est encore en cours." };
  const typed = typedUrl?.trim() ? parseHttpUrl(typedUrl) : null;
  if (typedUrl?.trim() && !typed) return { ok: false, reason: "URL invalide (http ou https attendu)." };
  const url = typed ?? cand.url;
  if (!url) return { ok: false, reason: "Aucune URL à valider : collez-en une." };

  const stored = await prisma.page.findMany({
    where: { siteId: cand.siteId },
    select: { id: true, url: true, kind: true },
    orderBy: { id: "asc" },
  });
  let page = findCanonicalMatch(stored, url);
  if (!page) {
    page = await prisma.page.create({
      data: { siteId: cand.siteId, url, kind: cand.kind },
      select: { id: true, url: true, kind: true },
    });
  } else if (page.kind === "OTHER") {
    await prisma.page.update({ where: { id: page.id }, data: { kind: cand.kind } });
  }
  await prisma.projectPage.createMany({ data: [{ projectId, pageId: page.id }], skipDuplicates: true });

  const edited = cand.url === null || findCanonicalMatch([{ url: cand.url }], url) === undefined;
  await prisma.pageCandidate.update({
    where: { id: cand.id },
    data: {
      status: "ACCEPTED",
      url,
      pageId: page.id,
      ...(edited ? { source: "saisie manuelle", confidence: null } : {}),
    },
  });
  return { ok: true };
}

/** Validates every « confirmed » proposal of a project at once. Returns how many. */
export async function acceptConfirmedCandidates(projectId: number): Promise<number> {
  const confirmed = await prisma.pageCandidate.findMany({
    where: { projectId, status: "PROPOSED", confidence: "confirmed" },
    select: { id: true },
  });
  let n = 0;
  for (const c of confirmed) if ((await acceptCandidate(projectId, c.id)).ok) n++;
  return n;
}

export async function rejectCandidate(projectId: number, candidateId: number): Promise<void> {
  await prisma.pageCandidate.updateMany({
    where: { id: candidateId, projectId, status: { in: ["PROPOSED", "NOT_FOUND"] } },
    data: { status: "REJECTED" },
  });
}

/** Searches one candidate's site again, for that candidate's kind only. */
export async function retryCandidate(projectId: number, candidateId: number): Promise<number> {
  const cand = await prisma.pageCandidate.findFirst({ where: { id: candidateId, projectId } });
  if (!cand || cand.status === "ACCEPTED" || cand.status === "SEARCHING") return 0;
  return startDiscovery(projectId, [{ siteId: cand.siteId, startUrl: cand.startUrl, kinds: [cand.kind as DiscoveryKind] }]);
}

/** Candidates the operator still has to settle before the run covers every site. */
export function pendingCandidates<T extends { status: string }>(cands: readonly T[]): number {
  return cands.filter((c) => c.status === "SEARCHING" || c.status === "PROPOSED" || c.status === "NOT_FOUND").length;
}

/** The kind a pasted URL is stored under: a home (root or locale root) is HP. */
export function pastedPageKind(url: string): PageKind {
  return isHomeLikeUrl(url) ? "HP" : "OTHER";
}
