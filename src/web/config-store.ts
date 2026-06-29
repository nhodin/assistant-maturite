/**
 * Bridges the DB-stored control configuration with the engine's ConfigMap and
 * provides the control catalog for the Settings UI.
 */
import { prisma } from "./db";
import { TOPICS, ALL_CONTROLS } from "../topics";
import type { ConfigMap } from "../engine";
import { DEFAULT_CONTROL_CONFIG } from "../core";

const TOPIC_NAME = new Map(TOPICS.map((t) => [t.id, t.name]));

export interface CatalogTopic {
  topicId: number;
  topicName: string;
  hasNA: boolean;
  standalone: boolean;
  controls: CatalogControl[];
  effectiveTotal: number;
}

export interface CatalogControl {
  id: string;
  topicId: number;
  topicName: string;
  label: string;
  description: string;
  defaultPoints: number;
  enabled: boolean;
  pointsOverride: number | null;
  naForced: boolean;
  effectivePoints: number;
}

/** Build the engine ConfigMap from DB overrides merged over defaults. */
export async function buildConfigMap(): Promise<ConfigMap> {
  const rows = await prisma.controlConfig.findMany();
  const byId = new Map(rows.map((r) => [r.controlId, r]));
  const map: ConfigMap = {};
  for (const c of ALL_CONTROLS) {
    const r = byId.get(c.id);
    map[c.id] = r
      ? { enabled: r.enabled, pointsOverride: r.pointsOverride, naForced: r.naForced }
      : { ...DEFAULT_CONTROL_CONFIG };
  }
  return map;
}

/** Catalog of all controls grouped by topic, with effective config, for Settings. */
export async function controlCatalog(): Promise<CatalogTopic[]> {
  const rows = await prisma.controlConfig.findMany();
  const byId = new Map(rows.map((r) => [r.controlId, r]));

  const topics: CatalogTopic[] = TOPICS.map((t) => {
    const controls: CatalogControl[] = t.controls.map((c) => {
      const r = byId.get(c.id);
      const enabled = r ? r.enabled : true;
      const pointsOverride = r ? r.pointsOverride : null;
      const naForced = r ? r.naForced : false;
      const effectivePoints = pointsOverride ?? c.defaultPoints;
      return {
        id: c.id,
        topicId: c.topicId,
        topicName: TOPIC_NAME.get(c.topicId) ?? `Topic ${c.topicId}`,
        label: c.label,
        description: c.description,
        defaultPoints: c.defaultPoints,
        enabled,
        pointsOverride,
        naForced,
        effectivePoints,
      };
    });
    const effectiveTotal = controls
      .filter((c) => c.enabled)
      .reduce((s, c) => s + c.effectivePoints, 0);
    return {
      topicId: t.id,
      topicName: t.name,
      hasNA: t.hasNA,
      standalone: t.standalone,
      controls,
      effectiveTotal,
    };
  });
  return topics;
}

/** Upsert a single control's config. */
export async function setControlConfig(
  controlId: string,
  patch: { enabled?: boolean; pointsOverride?: number | null; naForced?: boolean },
): Promise<void> {
  await prisma.controlConfig.upsert({
    where: { controlId },
    create: {
      controlId,
      enabled: patch.enabled ?? true,
      pointsOverride: patch.pointsOverride ?? null,
      naForced: patch.naForced ?? false,
    },
    update: {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.pointsOverride !== undefined ? { pointsOverride: patch.pointsOverride } : {}),
      ...(patch.naForced !== undefined ? { naForced: patch.naForced } : {}),
    },
  });
}

/** Reset all controls to their defaults (clears overrides). */
export async function resetAllControls(): Promise<void> {
  await prisma.controlConfig.deleteMany({});
}
