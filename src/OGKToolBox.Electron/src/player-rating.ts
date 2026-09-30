import type { MusicEntry } from "./player-library";
import type { PlayerScore } from "./player-save-models";

export type RatingChart = { music: MusicEntry; score: PlayerScore; constant: number; rate1000: number; stars?: number };
export type RatingGroup = { id: "old" | "new" | "platinum"; title: string; limit: number; entries: RatingChart[]; contribution1000: number; missing: number };
const nodes = [[800000, -6000], [900000, -4000], [970000, 0], [990000, 750], [1000000, 1250], [1007500, 1750], [1010000, 2000]];
export const ratingLevel = (constant: number) => Math.fround(Math.max(0, Math.min(99, constant)));
const level1000 = (constant: number) => Math.floor(Math.fround(Math.fround(ratingLevel(constant) * 1000) + 0.5));

// 1.50 NewRating: keep integer interpolation and float32 constants in the same order as the game.
export function technicalRating(score: PlayerScore, constant: number) {
  const value = Math.min(1010000, Math.max(0, score.techScore)), level = level1000(constant);
  if (value <= 500000) return 0;
  if (value <= 800000) return Math.max(0, Math.trunc((level - 6000) * (value - 500000) / 300000));
  const index = nodes.findIndex(([limit]) => value <= limit), [lowScore, lowBonus] = nodes[index - 1], [highScore, highBonus] = nodes[index];
  const rank = score.techScoreRank ?? (value >= 1007500 ? 12 : value >= 1000000 ? 11 : value >= 990000 ? 10 : 9);
  const rankBonus = rank >= 12 ? 300 : rank >= 11 ? 200 : rank >= 10 ? 100 : 0;
  const clearBonus = score.allBreak ? value >= 1010000 ? 350 : 300 : score.fullCombo ? 100 : 0;
  return Math.max(0, level + lowBonus + Math.trunc((highBonus - lowBonus) * (value - lowScore) / (highScore - lowScore)) + rankBonus + clearBonus + (score.fullBell ? 50 : 0));
}
export function platinumStars(score: PlayerScore, maximum?: number) {
  if (score.platinumScoreStar !== undefined) return Math.min(5, score.platinumScoreStar);
  if (score.platinumScore === undefined || maximum === undefined) return undefined;
  if (maximum <= 0) return 0;
  const permille = Math.trunc(score.platinumScore * 1000 / maximum);
  return permille >= 980 ? 5 : permille >= 970 ? 4 : permille >= 960 ? 3 : permille >= 950 ? 2 : permille >= 940 ? 1 : 0;
}
export function platinumRating(score: PlayerScore, constant: number, stars: number) {
  const level = ratingLevel(constant);
  return score.techScore <= 500000 ? 0 : Math.trunc(stars * level * level);
}
const compare = (a: RatingChart, b: RatingChart) => b.rate1000 - a.rate1000 || (a.rate1000 > 0 ? a.score.techScore - b.score.techScore : 0) || level1000(b.constant) - level1000(a.constant) || Number(a.music.id) - Number(b.music.id) || a.score.difficulty - b.score.difficulty;

export function best110(scores: PlayerScore[], music: MusicEntry[]) {
  const groups: RatingGroup[] = [
    { id: "old", title: "旧曲最佳", limit: 50, entries: [], contribution1000: 0, missing: 0 },
    { id: "new", title: "新曲最佳", limit: 10, entries: [], contribution1000: 0, missing: 0 },
    { id: "platinum", title: "白金贡献最高", limit: 50, entries: [], contribution1000: 0, missing: 0 }
  ];
  const library = new Map(music.map(item => [Number(item.id), item]));
  let missingMetadata = 0;
  for (const original of scores) {
    if (original.musicId === 1) continue;
    const song = library.get(original.musicId), metadata = song?.rating;
    if (metadata?.isBonus) continue;
    const chart = metadata?.charts.find(item => item.difficulty === original.difficulty);
    if (!song || !metadata || !chart) { missingMetadata++; continue; }
    if (level1000(chart.constant) === 0) continue;
    const score = { ...original, techScore: Math.min(1010000, Math.max(0, original.techScore)) };
    const base = { music: song, score, constant: chart.constant };
    if (metadata.isNew === undefined) { groups[0].missing++; groups[1].missing++; }
    else {
      const rate = technicalRating(score, chart.constant);
      groups[metadata.isNew ? 1 : 0].entries.push({ ...base, rate1000: metadata.isNew ? Math.trunc(rate / 5) : rate });
    }
    const stars = platinumStars(score, chart.platinumMax);
    if (stars === undefined && score.techScore > 500000) groups[2].missing++;
    else groups[2].entries.push({ ...base, stars, rate1000: platinumRating(score, chart.constant, stars ?? 0) });
  }
  for (const group of groups) {
    group.missing += missingMetadata;
    group.entries.sort(compare); group.entries = group.entries.slice(0, group.limit);
    group.contribution1000 = Math.trunc(group.entries.reduce((sum, entry) => sum + entry.rate1000, 0) / group.limit);
  }
  const complete = groups.every(group => group.missing === 0);
  return { groups, complete, total: complete ? groups.reduce((sum, group) => sum + group.contribution1000, 0) / 1000 : undefined };
}
