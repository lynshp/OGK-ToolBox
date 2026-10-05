import { BundleThumbnail } from "./bundle-thumbnail";
import { DifficultyBadge } from "./player-score-ui";
import { difficultyNames } from "./player-save-context";
import type { RatingGroup } from "./player-rating";
import type { RefObject } from "react";

export function Best110({ groups, root, scrollRef }: { groups: RatingGroup[]; root: string; scrollRef?: RefObject<HTMLDivElement | null> }) {
  return <div ref={scrollRef} className="player-best-scroll" tabIndex={0} aria-label="BEST 110 谱面列表"><div className="player-best-content">
    {groups.map(group => <section className="player-best-group" key={group.id} data-rating-group={group.id} aria-label={`${group.title} ${group.limit} 张`}>
      <div className="player-best-heading"><h3>{group.title} <span>{group.limit} 张</span></h3><span>{group.entries.length} / {group.limit}<b title="按固定名额计算，并按游戏规则截断">{group.missing ? "已知 " : ""}+{(group.contribution1000 / 1000).toFixed(3)}</b></span></div>
      {group.missing > 0 && <p className="player-best-incomplete" role="status">{group.missing} 张谱面数据不完整，当前仅展示可计算成绩</p>}
      {group.entries.length ? <>
        <ol className="player-best-list">{group.entries.map((entry, index) => <li key={`${entry.score.musicId}:${entry.score.difficulty}`}>
          <div className="player-best-artwork"><BundleThumbnail className="cover-dot player-best-cover" bundlePath={entry.music.jacket?.bundlePath} alt="" fallback="♫" cache={{ gameRoot: root, kind: "music" }}/><span className="player-best-rank" aria-label={`第 ${index + 1} 名`}>{index + 1}</span></div>
          <b className="player-best-song" title={entry.music.title}>{entry.music.title}</b>
          <DifficultyBadge difficulty={entry.score.difficulty}>{difficultyNames[entry.score.difficulty]} {entry.constant.toFixed(2).replace(/0$/, "")}</DifficultyBadge>
          <dl className="player-best-stats"><div><dt>技术分</dt><dd className="player-best-score">{entry.score.techScore.toLocaleString()}</dd></div>
            {group.id === "platinum" && <div><dt>白金分</dt><dd>{entry.score.platinumScore?.toLocaleString() ?? "—"}<span className="player-best-stars">{entry.stars === undefined ? "—" : `★${entry.stars}`}</span></dd></div>}
            <div className="player-best-rating"><dt>Rating</dt><dd className="player-best-contribution" title="单张谱面对总 Rating 的贡献；分组总值按游戏规则截断">+{(entry.rate1000 / group.limit / 1000).toFixed(5)}</dd></div>
          </dl>
        </li>)}</ol>
      </> : <p className="player-best-empty">{group.missing ? "缺少计算所需的存档或谱面数据" : "暂无符合条件的成绩"}</p>}
    </section>)}
  </div></div>;
}
