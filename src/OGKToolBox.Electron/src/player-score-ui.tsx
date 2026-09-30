import type { PlayerScore } from "./player-save-models";
import { difficultyNames, usePlayerSave } from "./player-save-context";
import "./player-score-ui.css";

export function DifficultyBadge({ difficulty, children }: { difficulty: number; children?: React.ReactNode }) {
  return <span className={`score-difficulty difficulty-${difficulty}`}>{children ?? difficultyNames[difficulty] ?? "未知"}</span>;
}
export function ScoreAchievements({ score, compact = false }: { score?: PlayerScore; compact?: boolean }) {
  const achievements = [[score?.fullCombo || score?.allBreak, "FC", "Full Combo"], [score?.fullBell, "FB", "Full Bell"], [score?.allBreak, "AB", "All Break"]] as const;
  const achieved = achievements.filter(([enabled]) => enabled);
  if (compact && !achieved.length) return null;
  return <span className="score-achievements" aria-label="达成状态">{achieved.length ? achieved.map(([, label, title]) => <span key={label} title={`${title} · 已达成`} aria-label={`${title} 已达成`}>{label}</span>) : <span className="is-empty">暂无达成</span>}</span>;
}
export function SaveFeedback({ error = false, children }: { error?: boolean; children: React.ReactNode }) {
  return <div className={`player-save-feedback${error ? " is-error" : ""}`} role={error ? "alert" : "status"}>
    {error && <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 22 20H2zM12 9v5M12 17.5v.1"/></svg>}<span>{children}</span>
  </div>;
}
export function MusicSaveSource() {
  const { save, state, loadError } = usePlayerSave();
  return <div className="music-save-source"><b>{save?.playerName ?? (loadError ? "读取失败" : state ? "尚无存档" : "读取中…")}</b><span>{save?.scope || save?.serverId ? state?.profiles.server?.label : save ? "来源未知" : state?.profiles.server?.label}</span>{loadError && <span className="score-read-error" role="status">读取失败</span>}</div>;
}
export function MusicScoreDetails({ score, difficulty }: { score?: PlayerScore; difficulty?: number }) {
  const { save, state, loadError } = usePlayerSave();
  return <section className="music-score-details" aria-label="谱面成绩">
    <div className="music-score-heading"><b>我的成绩</b>{difficulty !== undefined && <DifficultyBadge difficulty={difficulty}/>}</div>
    {!score ? <p className="music-score-empty">{loadError && !state ? "存档读取失败" : !state ? "读取中…" : !save ? "获取或导入存档后查看" : "当前存档暂无成绩"}</p> : <>
      <div className="music-tech-score"><span>技术分</span><div className="music-tech-score-value"><strong>{score.techScore.toLocaleString()}</strong><ScoreAchievements score={score}/></div></div>
      <dl className="music-score-stats"><div><dt>战斗分</dt><dd>{score.battleScore?.toLocaleString() ?? "—"}</dd></div><div><dt>白金分</dt><dd>{score.platinumScore?.toLocaleString() ?? "—"}</dd></div><div><dt>游玩次数</dt><dd>{score.playCount?.toLocaleString() ?? "—"}</dd></div></dl>
    </>}
  </section>;
}
