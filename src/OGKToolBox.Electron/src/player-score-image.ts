import type { RatingChart, RatingGroup } from "./player-rating";
import type { PlayerSave, PlayerScore } from "./player-save-models";

export type PlayerScoreImageOptions = {
  save: PlayerSave;
  groups: RatingGroup[];
  root: string;
  rating?: number;
  ratingSource?: "stored" | "local";
  signal?: AbortSignal;
};
export type PlayerScoreImage = { dataUrl: string; width: number; height: number; missingCovers: number };
const width = 2860, height = 1972, font = '"Microsoft YaHei UI", "Segoe UI", sans-serif';
const colors = { ink: "#25364d", muted: "#697789", border: "#d4ddea", paper: "#ffffff", orange: "#df4b20" };
const difficulties = [
  { name: "BASIC", background: "#e2f3ec", ink: "#136c50", border: "#bcdfcf" },
  { name: "ADVANCED", background: "#fff3cd", ink: "#805b09", border: "#ead593" },
  { name: "EXPERT", background: "#ffebe6", ink: "#a53725", border: "#f0c4b8" },
  { name: "MASTER", background: "#efe8fb", ink: "#68419e", border: "#d8c8ee" },
  { name: "LUNATIC", background: "#ffffff", ink: "#536174", border: "#cbd3de" }
];
let requestSequence = 0;
const abortError = () => new DOMException("成绩图生成已取消", "AbortError");
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw abortError(); }
function waitForFonts(signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let complete = false;
    const finish = (aborted = false) => {
      if (complete) return;
      complete = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      if (aborted) reject(abortError()); else resolve();
    };
    const cancel = () => finish(true), timer = setTimeout(() => finish(), 1500);
    signal?.addEventListener("abort", cancel, { once: true });
    void Promise.resolve().then(() => document.fonts.ready).then(() => finish(), () => finish());
  });
}

// Keep stored ranks authoritative. Only the three bonus-rank thresholds already used
// by the rating calculator are inferred when the archive did not record a rank.
export function scoreImageGrade(score: PlayerScore): string {
  if (score.techScoreRank !== undefined) return ({ 9: "S", 10: "SS", 11: "SSS", 12: "SSS+" } as Record<number, string>)[score.techScoreRank] ?? "—";
  return score.techScore >= 1007500 ? "SSS+" : score.techScore >= 1000000 ? "SSS" : score.techScore >= 990000 ? "SS" : "—";
}

async function coverImage(bundlePath: string, root: string, signal: AbortSignal | undefined, timeout: number): Promise<HTMLImageElement | null> {
  checkAbort(signal);
  const requestId = `score-image-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    let complete = false;
    const finish = (value: HTMLImageElement | null, aborted = false) => {
      if (complete) return;
      complete = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      try { window.ogk.cancelThumbnail(requestId); } catch { /* The window may be closing. */ }
      if (aborted) reject(abortError()); else resolve(value);
    };
    const cancel = () => finish(null, true), timer = setTimeout(() => finish(null), timeout);
    signal?.addEventListener("abort", cancel, { once: true });
    void Promise.resolve().then(() => window.ogk.thumbnail(bundlePath, { gameRoot: root, kind: "music" }, "prefetch", requestId)).then(src => {
      if (complete) return;
      // The resource bridge resolves ogk:// identifiers into inline PNGs. Never
      // draw arbitrary network/file URLs, which could taint the export canvas.
      if (!src || !/^data:image\/(?:png|jpeg|webp);base64,/i.test(src)) { finish(null); return; }
      const image = new Image(); image.onload = () => finish(image.naturalWidth && image.naturalHeight ? image : null);
      image.onerror = () => finish(null); image.src = src;
    }).catch(() => finish(null));
  });
}

async function loadCovers(entries: RatingChart[], root: string, signal?: AbortSignal) {
  const paths = [...new Set(entries.map(entry => entry.music.jacket?.bundlePath).filter((value): value is string => !!value))];
  const images = new Map<string, HTMLImageElement | null>();
  if (!root) return images;
  let cursor = 0;
  const deadline = Date.now() + 45000;
  await Promise.all(Array.from({ length: Math.min(6, paths.length) }, async () => {
    while (cursor < paths.length) {
      checkAbort(signal);
      const bundlePath = paths[cursor++], remaining = deadline - Date.now();
      images.set(bundlePath, remaining <= 0 ? null : await coverImage(bundlePath, root, signal, Math.min(8000, remaining)));
    }
  }));
  return images;
}

export async function generatePlayerScoreImage(options: PlayerScoreImageOptions): Promise<PlayerScoreImage> {
  const { save, root, rating, ratingSource, signal } = options;
  checkAbort(signal);
  const groups = (["old", "new", "platinum"] as const).map((id, index) => options.groups.find(group => group.id === id) ?? {
    id, title: ["旧曲最佳", "新曲最佳", "白金贡献最高"][index], limit: index === 1 ? 10 : 50, entries: [], contribution1000: 0, missing: 0
  });
  const entries = groups.flatMap(group => group.entries.slice(0, group.id === "new" ? 10 : 50));
  const images = await loadCovers(entries, root, signal);
  checkAbort(signal);
  await waitForFonts(signal);
  checkAbort(signal);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建成绩图画布，请重试。");
  const missingCovers = entries.filter(entry => !entry.music.jacket?.bundlePath || !images.get(entry.music.jacket.bundlePath)).length;
  const setFont = (size: number, weight: number = 400) => { ctx.font = `${weight} ${size}px ${font}`; };
  const text = (value: string, x: number, y: number, size: number, color = colors.ink, weight = 400, maxWidth?: number) => {
    setFont(size, weight); ctx.fillStyle = color; ctx.textBaseline = "alphabetic";
    if (maxWidth !== undefined && ctx.measureText(value).width > maxWidth) {
      const chars = Array.from(value); while (chars.length && ctx.measureText(chars.join("") + "…").width > maxWidth) chars.pop();
      value = chars.join("") + "…";
    }
    ctx.fillText(value, x, y);
  };
  const round = (x: number, y: number, w: number, h: number, radius: number, background: string, border?: string) => {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fillStyle = background; ctx.fill();
    if (border) { ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.stroke(); }
  };
  const right = (value: string, x: number, y: number, size: number, color = colors.ink, weight = 400) => {
    setFont(size, weight); text(value, x - ctx.measureText(value).width, y, size, color, weight);
  };
  const achievements = (score: PlayerScore) => [score.fullCombo || score.allBreak ? "FC" : "", score.fullBell ? "FB" : "", score.allBreak ? "AB" : ""].filter(Boolean).join(" · ");
  const number = (value: number | undefined) => value === undefined ? "—" : value.toLocaleString("en-US");
  const constant = (value: number) => value.toFixed(2).replace(/0$/, "");
  const cover = (entry: RatingChart, x: number, y: number, size: number, rank: number, compact: boolean) => {
    const image = entry.music.jacket?.bundlePath ? images.get(entry.music.jacket.bundlePath) : null;
    round(x, y, size, size, compact ? 5 : 8, "#eef2f7");
    if (image) {
      ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, size, size, compact ? 5 : 8); ctx.clip();
      const crop = Math.min(image.naturalWidth, image.naturalHeight);
      ctx.drawImage(image, (image.naturalWidth - crop) / 2, (image.naturalHeight - crop) / 2, crop, crop, x, y, size, size);
      ctx.restore();
    } else {
      text("♫", x + size * .32, y + size * .64, size * .4, "#a7b2c1");
    }
    round(x + 4, y + 4, compact ? 26 : 30, compact ? 21 : 25, 4, "#25364de6");
    text(String(rank), x + (compact ? 8 : 10), y + (compact ? 19 : 23), compact ? 12 : 15, "#ffffff", 700);
  };
  const chartCard = (entry: RatingChart | undefined, group: RatingGroup, index: number, x: number, y: number, w: number) => {
    round(x, y, w, 116, 11, colors.paper, colors.border);
    if (!entry) { text(`#${index + 1}`, x + 16, y + 38, 18, "#a7b2c1", 600); text("暂无成绩", x + 16, y + 78, 18, colors.muted); return; }
    const theme = difficulties[entry.score.difficulty] ?? difficulties[4], tx = x + 120, contentWidth = w - 134;
    cover(entry, x + 10, y + 10, 96, index + 1, false);
    round(tx, y + 10, contentWidth, 25, 5, theme.background, theme.border);
    text(`${theme.name}  ${constant(entry.constant)}`, tx + 8, y + 28, 14, theme.ink, 700, contentWidth - 16);
    text(entry.music.title, tx, y + 56, 19, colors.ink, 700, contentWidth);
    text(number(entry.score.techScore), tx, y + 85, 25, colors.ink, 700);
    right(scoreImageGrade(entry.score), x + w - 14, y + 85, 21, theme.ink, 700);
    text(achievements(entry.score) || "—", tx, y + 105, 12, colors.muted, 600);
    right(`+${(entry.rate1000 / group.limit / 1000).toFixed(5)}`, x + w - 14, y + 105, 14, colors.ink, 600);
  };
  const platinumCard = (entry: RatingChart | undefined, group: RatingGroup, index: number, x: number, y: number, w: number) => {
    round(x, y, w, 62, 7, colors.paper, colors.border);
    if (!entry) { text(`#${index + 1}  暂无成绩`, x + 12, y + 36, 16, "#a7b2c1"); return; }
    const theme = difficulties[entry.score.difficulty] ?? difficulties[4], tx = x + 68;
    ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, 62, 7); ctx.strokeStyle = theme.ink; ctx.lineWidth = 2; ctx.stroke(); ctx.restore();
    cover(entry, x + 5, y + 5, 52, index + 1, true);
    text("白金分", tx, y + 13, 11, colors.muted);
    text(number(entry.score.platinumScore), tx, y + 38, 26, colors.ink, 700, w - 166);
    right(`★ ${entry.stars ?? "—"}`, x + w - 14, y + 38, 24, "#805b09", 700);
    text(`定数 ${constant(entry.constant)}`, tx, y + 56, 13, theme.ink, 600);
    right(`+${(entry.rate1000 / group.limit / 1000).toFixed(5)}`, x + w - 14, y + 56, 13, colors.ink, 600);
  };
  const heading = (group: RatingGroup, x: number, y: number, w: number, english: string, compact = false) => {
    text(english, x, y, compact ? 28 : 30, colors.ink, 700);
    text(`${group.title} · ${group.entries.length} / ${group.id === "new" ? 10 : 50}`, x, y + 29, compact ? 16 : 18, colors.muted);
    right(`${group.missing ? "已知 " : ""}+${(group.contribution1000 / 1000).toFixed(3)}`, x + w, y + 1, compact ? 24 : 28, colors.orange, 700);
    if (group.missing) right(`${group.missing} 张谱面数据不完整`, x + w, y + 29, compact ? 13 : 16, "#a53725");
  };

  const background = ctx.createLinearGradient(0, 0, width, height); background.addColorStop(0, "#f2f5fa"); background.addColorStop(1, "#e9eff7");
  ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
  round(48, 42, width - 96, 154, 18, colors.paper, colors.border);
  round(68, 65, 8, 106, 4, colors.orange);
  text("OGKToolBox  /  PLAY DATA", 96, 85, 18, colors.muted, 600);
  text(save.playerName || "未记录玩家名", 96, 139, 42, colors.ink, 700, 700);
  text("BEST 110", 96, 172, 18, colors.muted, 600);
  text(ratingSource === "local" ? "本地 Rating" : "Rating", 880, 86, 18, colors.muted, 600);
  text(rating !== undefined && Number.isFinite(rating) ? rating.toFixed(3) : "—", 880, 146, 50, colors.ink, 700);
  let lastPlayed = -Infinity;
  for (const play of save.recentPlays ?? []) {
    const timestamp = Date.parse(play.playedAt);
    if (Number.isFinite(timestamp) && timestamp > lastPlayed) lastPlayed = timestamp;
  }
  const playTime = Number.isFinite(lastPlayed) ? new Date(lastPlayed).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "未记录";
  text(`游玩时间  ${playTime}`, 1260, 94, 18, colors.muted);
  groups.forEach((group, index) => {
    const x = 1260 + index * 440;
    text(["旧曲 BEST 50", "新曲 BEST 10", "白金 BEST 50"][index], x, 128, 17, colors.muted);
    text(`${group.missing ? "已知 " : ""}+${(group.contribution1000 / 1000).toFixed(3)}`, x, 166, 27, colors.ink, 700);
  });

  const leftX = 48, leftW = 2078, rightX = 2170, rightW = 642, cardGap = 14, cardW = (leftW - cardGap * 4) / 5;
  heading(groups[0], leftX, 248, leftW, "BEST 50");
  for (let index = 0; index < 50; index++) chartCard(groups[0].entries[index], groups[0], index, leftX + index % 5 * (cardW + cardGap), 292 + Math.floor(index / 5) * 128, cardW);
  heading(groups[1], leftX, 1614, leftW, "NEW 10");
  for (let index = 0; index < 10; index++) chartCard(groups[1].entries[index], groups[1], index, leftX + index % 5 * (cardW + cardGap), 1668 + Math.floor(index / 5) * 128, cardW);
  heading(groups[2], rightX, 248, rightW, "PLATINUM 50", true);
  for (let index = 0; index < 50; index++) platinumCard(groups[2].entries[index], groups[2], index, rightX + index % 2 * 329, 292 + Math.floor(index / 2) * 64, 313);

  checkAbort(signal);
  return { dataUrl: canvas.toDataURL("image/png"), width, height, missingCovers };
}
