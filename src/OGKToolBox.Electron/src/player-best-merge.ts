import type { PlayerScore } from "./player-save-models";

export type BestMergeSource = { id: string; serverId: string; serverLabel?: string; updatedAt: string };
export type BestMergeMetadata = { targetId: string; sourceIds: string[]; version?: 1; sources?: BestMergeSource[]; createdAt?: string };
export type BestMergeResult = { scores: PlayerScore[]; addedCharts: number; improvedCharts: number; changed: boolean };
const metrics = ["techScore", "techScoreRank", "platinumScore", "platinumScoreStar", "battleScore"] as const;
const achievements = ["fullCombo", "fullBell", "allBreak"] as const;
const key = (score: PlayerScore) => `${score.musicId}:${score.difficulty}`;
const max = (a?: number, b?: number) => a === undefined ? b : b === undefined ? a : Math.max(a, b);
// Local game 1.50 TechnicalRankIDEnum and PlatinumscorerankrateIDEnum.
// Platinum rank 6 means five stars with Ex; display/rating cap this to five.
const technicalThresholds = [0, 500000, 700000, 750000, 800000, 850000, 900000, 940000, 970000, 990000, 1000000, 1007500];
export function playerBestTechnicalRank(score: number) { return technicalThresholds.filter(lower => score >= lower).length; }
export function playerBestPlatinumRank(score: number, maximum: number) {
  if (maximum <= 0) return 0;
  const permille = Math.trunc(score * 1000 / maximum);
  return [940, 950, 960, 970, 980, 990].filter(lower => permille >= lower).length;
}
function normalize(score: PlayerScore, maxima: ReadonlyMap<string, number>): PlayerScore {
  const maximum = maxima.get(key(score));
  return { ...score, techScoreRank: score.techScoreRank ?? playerBestTechnicalRank(score.techScore),
    platinumScoreStar: score.platinumScoreStar ?? (score.platinumScore !== undefined && maximum !== undefined ? playerBestPlatinumRank(score.platinumScore, maximum) : undefined) };
}
function combine(a: PlayerScore, b: PlayerScore): PlayerScore {
  return { musicId: a.musicId, difficulty: a.difficulty, techScore: Math.max(a.techScore, b.techScore),
    techScoreRank: max(a.techScoreRank, b.techScoreRank), platinumScore: max(a.platinumScore, b.platinumScore),
    platinumScoreStar: max(a.platinumScoreStar, b.platinumScoreStar), battleScore: max(a.battleScore, b.battleScore),
    playCount: max(a.playCount, b.playCount), fullCombo: a.fullCombo || b.fullCombo,
    fullBell: a.fullBell || b.fullBell, allBreak: a.allBreak || b.allBreak };
}

// The frontend preview and persisted merge share the same per-chart operation.
// Only absent achievement ranks are derived. Explicit ranks remain independent
// best metrics, recorded zero is data, and play counts never add.
export function mergeBestScores(targetScores: PlayerScore[], sourceScores: PlayerScore[][], platinumMaximumByChart: ReadonlyMap<string, number> = new Map()): BestMergeResult {
  const baseline = new Map<string, PlayerScore>();
  for (const original of targetScores) {
    const score = normalize(original, platinumMaximumByChart);
    baseline.set(key(score), baseline.has(key(score)) ? combine(baseline.get(key(score))!, score) : score);
  }
  const result = new Map([...baseline].map(([id, score]) => [id, { ...score }]));
  for (const source of sourceScores) for (const original of source) {
    const score = normalize(original, platinumMaximumByChart);
    const id = key(score), previous = result.get(id);
    result.set(id, previous ? combine(previous, score) : score);
  }
  let addedCharts = 0, improvedCharts = 0, changed = false;
  for (const [id, score] of result) {
    const old = baseline.get(id);
    if (!old) { addedCharts++; changed = true; }
    else {
      const improved = metrics.some(metric => score[metric] !== old[metric]) || achievements.some(flag => score[flag] !== old[flag]);
      if (improved) improvedCharts++;
      changed ||= improved || score.playCount !== old.playCount;
    }
  }
  return { scores: [...result.values()].sort((a, b) => a.musicId - b.musicId || a.difficulty - b.difficulty), addedCharts, improvedCharts, changed };
}
