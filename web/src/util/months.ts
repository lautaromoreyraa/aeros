import type { MonthKey } from "../api/types";

export const MONTH_LABELS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTH_LABELS_ES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
export const MONTH_LABELS = MONTH_LABELS_EN;

export function monthLabel(monthIndex0: number, locale: "en" | "es" = "en"): string {
  return (locale === "es" ? MONTH_LABELS_ES : MONTH_LABELS_EN)[monthIndex0] ?? "";
}

export function monthKey(year: number, monthOfYear: number): MonthKey {
  return year * 12 + (monthOfYear - 1);
}

/** Parses "YYYY-MM" (the format of `<input type="month">` and of the artifacts). */
export function parseMonth(text: string): MonthKey | null {
  const match = /^(\d{4})-(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return monthKey(Number(match[1]), month);
}

export function formatMonth(key: MonthKey): string {
  const year = Math.floor(key / 12);
  const month = (key % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function yearOf(key: MonthKey): number {
  return Math.floor(key / 12);
}

export function monthOfYear(key: MonthKey): number {
  return (key % 12) + 1;
}

export function clampMonth(key: MonthKey, min: MonthKey, max: MonthKey): MonthKey {
  return Math.min(max, Math.max(min, key));
}
