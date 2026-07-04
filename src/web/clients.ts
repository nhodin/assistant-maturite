/** Client helpers shared by routes: parse the ?client= filter and list clients. */
import { prisma } from "./db";

/** Parse a `client` query/body value into a client id (or null for "all" / unset). */
export function parseClientId(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** All clients, alphabetical — used to populate filter dropdowns and forms. */
export function listClients() {
  return prisma.client.findMany({ orderBy: { name: "asc" } });
}
