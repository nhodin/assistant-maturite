/** Category enum ↔ display label mapping (single source of truth for the UI). */

export const CATEGORIES = [
  "Beauty",
  "Fragrances",
  "WatchesJewelry",
  "WineSpirits",
  "SR",
  "Other",
] as const;

export type CategoryKey = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<CategoryKey, string> = {
  Beauty: "Beauty",
  Fragrances: "Fragrances",
  WatchesJewelry: "Watches & Jewelry",
  WineSpirits: "Wine & Spirits",
  SR: "SR",
  Other: "Other",
};

export function categoryLabel(key: string): string {
  return (CATEGORY_LABELS as Record<string, string>)[key] ?? key;
}

/** CHINA marks a page served to the Chinese market — scored apart (see PageScoringMode). */
export const PAGE_KINDS = ["HP", "PLP", "PDP", "CHINA", "OTHER"] as const;

/** Page kinds graded with the China rule (first criterion per topic + topic 12). */
export function isChinaKind(kind: string): boolean {
  return kind === "CHINA";
}
export type PageKindKey = (typeof PAGE_KINDS)[number];
