import path from "node:path";
import { compatibleGameDataPaths } from "./player-item-catalog";
import { playerRatingCatalog } from "./player-rating-catalog";
import type { SaveScore } from "./player-save";

// Resolve only absent platinum ranks through the same compatible package/chart
// metadata used by B110. No client-supplied maximum is trusted by persistence.
export async function playerBestPlatinumMaxima(root: string, scores: SaveScore[], signal?: AbortSignal): Promise<Map<string, number>> {
  const missing = scores.filter(score => score.platinumScoreStar === undefined && (score.platinumScore ?? 0) > 0);
  const result = new Map<string, number>();
  if (!missing.length) return result;
  const { paths } = await compatibleGameDataPaths(root), ids = [...new Set(missing.map(score => score.musicId))];
  const metadata = await playerRatingCatalog(root, paths.flatMap(directory => ids.map(numericId => ({ numericId, packageId: path.basename(directory) }))), signal);
  for (const [id, song] of metadata) for (const chart of song.charts) if (chart.platinumMax !== undefined) result.set(`${id}:${chart.difficulty}`, chart.platinumMax);
  return result;
}
