/** View helpers exposed to all EJS templates via defaultContext. */
import { categoryLabel, CATEGORY_LABELS, CATEGORIES, PAGE_KINDS } from "./categories";

/** CSS class bucket for a 0–100 score (or null/N-A). */
export function scoreClass(score: number | null | undefined): string {
  if (score === null || score === undefined) return "s-na";
  if (score >= 80) return "s-90";
  if (score >= 60) return "s-70";
  if (score >= 40) return "s-50";
  if (score >= 1) return "s-20";
  return "s-0";
}

export function fmtScore(score: number | null | undefined): string {
  return score === null || score === undefined ? "N/A" : String(score);
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const dt = typeof d === "string" ? new Date(d) : d;
  return dt.toLocaleString("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const viewHelpers = {
  categoryLabel,
  CATEGORY_LABELS,
  CATEGORIES,
  PAGE_KINDS,
  scoreClass,
  fmtScore,
  fmtDate,
};
