import type { PlayerScore } from "./player-save-models";

export type MusicEntry = { id: string | number; title: string; artist?: string; genre?: string; jacket?: { bundlePath?: string }; charts?: { difficulty: number; levelConstant: number | string; filePath: string; exists?: boolean }[]; rating?: { isNew?: boolean; isBonus: boolean; charts: { difficulty: number; constant: number; platinumMax?: number }[] } };
export const difficultyPriority = (preferred: number) => [preferred, ...[0, 1, 2, 3, 4].filter(level => level > preferred), ...[4, 3, 2, 1, 0].filter(level => level < preferred)];
export function musicScore(index: Map<string, PlayerScore>, id: string | number, preferred: number) {
  for (const level of difficultyPriority(preferred)) {
    const score = index.get(`${Number(id)}:${level}`);
    if (score) return score;
  }
}
export function chartConstant(music: MusicEntry, difficulty: number) {
  const value = music.charts?.find(chart => chart.difficulty === difficulty)?.levelConstant;
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
// Catalog constants retain the game's float32 precision for rating calculations.
// Render and search the same decimal notation used by BEST 110 instead of raw tails.
export function formatChartConstant(value?: number) {
  return value !== undefined && Number.isFinite(value) ? value.toFixed(2).replace(/0$/, "") : "—";
}
export function sortPlayerMusic<T extends MusicEntry>(items: T[], mode: string, preferred: number, scores: Map<string, PlayerScore>): T[] {
  const priority = difficultyPriority(preferred);
  return items.map((music, order) => ({ music, order, score: musicScore(scores, music.id, preferred), constant: chartConstant(music, preferred) })).sort((a, b) => {
    if (mode === "score") {
      if (!a.score || !b.score) return Number(!a.score) - Number(!b.score) || a.order - b.order;
      return priority.indexOf(a.score.difficulty) - priority.indexOf(b.score.difficulty) || b.score.techScore - a.score.techScore || a.order - b.order;
    }
    if (mode === "constant") {
      if (a.constant === undefined || b.constant === undefined) return Number(a.constant === undefined) - Number(b.constant === undefined) || a.order - b.order;
      return b.constant - a.constant || a.order - b.order;
    }
    return a.order - b.order;
  }).map(item => item.music);
}
