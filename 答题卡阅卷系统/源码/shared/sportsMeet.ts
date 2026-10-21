export type SportsEventKind = "track" | "field" | "relay";
export type SportsResultKind = "time" | "distance" | "height";
export type SportsEntryStatus = "valid" | "dns" | "dnf" | "foul";

export interface SportsScoreRow {
  id: number;
  className: string;
  result: number | null;
  status: SportsEntryStatus;
}

export interface RankedSportsScore extends SportsScoreRow {
  rank: number | null;
  points: number;
}

export const SPORTS_POINTS = [9, 7, 6, 5, 4, 3, 2, 1] as const;

export function parseSportsResult(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  // 支持 12.34、1:23.45、1'23"45 三种常见手工录入形式。
  const colon = text.match(/^(\d+):([0-5]?\d)(?:[.,](\d+))?$/);
  if (colon) {
    const seconds = Number(colon[1]) * 60 + Number(colon[2]) + Number(`0.${colon[3] ?? "0"}`);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const apostrophe = text.match(/^(\d+)'(\d{1,2})(?:[.,](\d+))?\"?$/);
  if (apostrophe) {
    const seconds = Number(apostrophe[1]) * 60 + Number(apostrophe[2]) + Number(`0.${apostrophe[3] ?? "0"}`);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const normalized = Number(text.replace(",", "."));
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function averagePoints(startRank: number, endRank: number): number {
  let total = 0;
  let count = 0;
  for (let rank = startRank; rank <= endRank; rank += 1) {
    total += SPORTS_POINTS[rank - 1] ?? 0;
    count += 1;
  }
  return count ? Number((total / count).toFixed(2)) : 0;
}

export function rankSportsScores(rows: SportsScoreRow[], resultKind: SportsResultKind = "time"): RankedSportsScore[] {
  const valid = rows
    .filter((row) => row.status === "valid" && row.result !== null && Number.isFinite(row.result))
    .sort((a, b) => resultKind === "time" ? (a.result! - b.result!) : (b.result! - a.result!));
  const ranked = new Map<number, { rank: number; points: number }>();
  let index = 0;
  while (index < valid.length) {
    const value = valid[index].result!;
    let end = index;
    while (end + 1 < valid.length && valid[end + 1].result === value) end += 1;
    const rank = index + 1;
    const points = averagePoints(rank, end + 1);
    for (let i = index; i <= end; i += 1) ranked.set(valid[i].id, { rank, points });
    index = end + 1;
  }
  return rows.map((row) => ({
    ...row,
    rank: ranked.get(row.id)?.rank ?? null,
    points: ranked.get(row.id)?.points ?? 0,
  }));
}

export function teamPointTotals(rows: Array<{ className: string; points: number }>): Array<{ className: string; points: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.className, (totals.get(row.className) ?? 0) + row.points);
  return [...totals.entries()]
    .map(([className, points]) => ({ className, points: Number(points.toFixed(2)) }))
    .sort((a, b) => b.points - a.points || a.className.localeCompare(b.className, "zh-CN"));
}
