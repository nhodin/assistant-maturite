/**
 * PDP/PLP proposals of a diagnostic project — the validation step between a
 * background discovery (../discovery-runner.ts) and the project's pages. Spec:
 * docs/DIAGNOSTIC.md, « Découverte des PDP / PLP ».
 *
 * Every action is a plain form post answered by a redirect to the project page:
 * accepting a proposal changes the page list and the run button too, not only the
 * proposal block. Only the block's polling (while a search runs) goes through HTMX.
 */
import type { FastifyInstance } from "fastify";
import { prisma } from "../db";
import {
  acceptCandidate,
  acceptConfirmedCandidates,
  projectDiscoveryTargets,
  rejectCandidate,
  retryCandidate,
  startDiscovery,
} from "../discovery-runner";
import { discoveryKindsOf, isDiagProject } from "./projects";

const back = (id: number, flash?: string) =>
  `/projects/${id}${flash ? `?flash=${encodeURIComponent(flash)}` : ""}#candidates`;

export async function discoveryRoutes(app: FastifyInstance) {
  // The proposal block alone — polled by HTMX while a search is running.
  app.get("/projects/:id/candidates", async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        pageCandidates: {
          include: { site: { select: { name: true } } },
          orderBy: [{ siteId: "asc" }, { kind: "asc" }],
        },
      },
    });
    if (!project) return reply.code(404).send("Project not found");
    return reply.view("partials/page-candidates", { project, candidates: project.pageCandidates });
  });

  // « 🔎 Trouver PDP/PLP » — searches every site of the project that lacks one.
  app.post("/projects/:id/discover", async (req, reply) => {
    const id = Number((req.params as any).id);
    const project = await prisma.project.findUnique({ where: { id } });
    if (!project) return reply.redirect("/projects");
    if (!isDiagProject(project)) return reply.redirect(`/projects/${id}`);
    const kinds = discoveryKindsOf(req.body as Record<string, unknown>);
    if (!kinds.length) return reply.redirect(back(id, "discovery_nokind"));
    const n = await startDiscovery(id, await projectDiscoveryTargets(id, kinds));
    return reply.redirect(back(id, n ? `discovery_started_${n}` : "discovery_none"));
  });

  app.post("/projects/:id/candidates/:cid/accept", async (req, reply) => {
    const id = Number((req.params as any).id);
    const cid = Number((req.params as any).cid);
    const url = String((req.body as any)?.url ?? "");
    const r = await acceptCandidate(id, cid, url);
    return reply.redirect(back(id, r.ok ? "candidate_accepted" : `candidate_error:${r.reason}`));
  });

  app.post("/projects/:id/candidates/:cid/reject", async (req, reply) => {
    const id = Number((req.params as any).id);
    await rejectCandidate(id, Number((req.params as any).cid));
    return reply.redirect(back(id));
  });

  app.post("/projects/:id/candidates/:cid/retry", async (req, reply) => {
    const id = Number((req.params as any).id);
    await retryCandidate(id, Number((req.params as any).cid));
    return reply.redirect(back(id));
  });

  app.post("/projects/:id/candidates/accept-confirmed", async (req, reply) => {
    const id = Number((req.params as any).id);
    const n = await acceptConfirmedCandidates(id);
    return reply.redirect(back(id, `candidates_accepted_${n}`));
  });
}
