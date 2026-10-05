import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playerItemKinds, type CaptureState, type PlayerSave } from "./player-save-models";
import { shortSaveDate, usePlayerSave } from "./player-save-context";
import { PlayerProfileEditor } from "./player-profile-editor";
import type { PlayerProfile } from "./machine-profile-models";
import { PlayerPopover } from "./player-popover";
import { BundleThumbnail } from "./bundle-thumbnail";
import type { MusicEntry } from "./player-library";
import { SaveFeedback } from "./player-score-ui";
import { best110 } from "./player-rating";
import { Best110 } from "./player-rating-ui";
import { usePlayerRecordFocus } from "./use-player-record-focus";
import { PlayerScoreImagePreview, type ScoreImageSnapshot } from "./player-score-image-preview";
import { PlayerBestMergeDialog, type BestMergeSnapshot } from "./player-best-merge-dialog";
import { PlayerSaveEditor, type PlayerSaveEditorSnapshot } from "./player-save-editor";
import { PlayerDataIntro, playerDataNoticeStorageKey } from "./player-data-intro";
import "./player-saves.css";

function archiveDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return `${date.getFullYear() === new Date().getFullYear() ? "" : `${date.getFullYear()}/`}${shortSaveDate(value)}:${String(date.getSeconds()).padStart(2, "0")}`;
}
function PlayerInventoryDetails({ save }: { save: PlayerSave }) {
  const resources = useMemo(() => {
    const groups = new Map<number, { count: number; missing: boolean }>();
    const collectibles = new Set([2, 3, 8, 16, 17, 19, 20]);
    for (const item of save.inventory?.items ?? []) {
      const group = groups.get(item.itemKind) ?? { count: 0, missing: false };
      if (item.isValid !== false) {
        if (collectibles.has(item.itemKind)) group.count += item.stock === 0 ? 0 : 1;
        else if (item.stock === undefined) group.missing = true;
        else group.count += item.stock;
      }
      groups.set(item.itemKind, group);
    }
    const priority = [3, 12, 13, 14];
    return [...groups].sort(([a], [b]) => (priority.includes(a) ? priority.indexOf(a) : a + 10) - (priority.includes(b) ? priority.indexOf(b) : b + 10));
  }, [save.inventory]);
  return <>
    <div className="player-card-total"><span>卡片</span><b>{save.inventory?.cardCount?.toLocaleString() ?? "—"}<small> 张</small></b></div>
    <section className="player-save-resources" aria-label="游戏资源"><h3>游戏资源</h3>
      {resources.length ? <dl className="player-resource-totals">{resources.map(([kind, group]) => <div key={kind} data-resource-kind={kind}><dt>{playerItemKinds[kind] ?? `类别 ${kind}`}</dt><dd>{group.missing ? group.count ? `≥ ${group.count.toLocaleString()}` : "—" : group.count.toLocaleString()}</dd></div>)}</dl> : <p>{save.inventory?.itemsRecorded ? "此存档没有资源记录。" : "此存档未包含资源数据。"}</p>}
    </section>
  </>;
}
function captureStatusText(capture?: CaptureState) {
  if (!capture) return "读取中…";
  if (!capture.enabled) return "尚未启用";
  if (!capture.installed) return "模块缺失";
  if (capture.updateAvailable) return "模块待更新";
  if (capture.status.startsWith("unsupported")) return "初始化失败";
  if (capture.status.startsWith("capture-error:")) return "采集失败";
  if (capture.status.startsWith("read-error:")) return "读取失败";
  if (capture.status === "initializing") return "初始化中…";
  if (capture.status === "ready") return "已连接 · 等待刷卡";
  if (capture.status === "capturing") return "采集中";
  if (capture.status === "captured") return "已采集 · 持续同步";
  if (["stopped", "inactive"].includes(capture.status)) return "等待游戏启动";
  return "等待连接";
}
function RecentPlays({ save, music, root }: { save: PlayerSave; music: MusicEntry[]; root: string }) {
  const library = useMemo(() => new Map(music.map(item => [Number(item.id), item])), [music]);
  const records = (save.recentPlays ?? []).slice(0, 10);
  return <section className="player-recent" aria-label="最近游玩记录"><div className="player-save-section-head"><h3>最近游玩记录</h3></div>
    {records.length ? <ol className="player-recent-grid">{records.map((play, index) => {
      const song = library.get(play.musicId);
      const title = song?.title ?? `乐曲 #${play.musicId}`;
      return <li key={`${play.musicId}:${play.difficulty}:${play.playedAt}:${index}`}>
        <BundleThumbnail className="cover-dot player-recent-cover" bundlePath={song?.jacket?.bundlePath} alt="" fallback="♫" cache={{ gameRoot: root, kind: "music" }}/>
        <b className="player-recent-song" title={title}>{title}</b>
      </li>;
    })}</ol> : <p className="player-recent-empty">{save.recentPlaysRecorded ? "暂无最近游玩记录" : "此存档未包含最近游玩记录，可重新获取"}</p>}
  </section>;
}
export function PlayerSavesPage({ root, music, onEditMachine }: { root: string; music: MusicEntry[]; onEditMachine?(id: string): void }) {
  const { state, save, saves, cardId, playerId, selectPlayer, selectImportedSave, refreshPlayerProfiles, selectingPlayer, unassigned, unknownSource, showUnknown, showUnassigned, selectSave: setSelected, reload: load, loadError } = usePlayerSave();
  const [busy, setBusy] = useState("");
  const [introOpen, setIntroOpen] = useState(() => {
    try { return localStorage.getItem(playerDataNoticeStorageKey) !== "true"; } catch { return true; }
  });
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null);
  const messageSequence = useRef(0);
  const [error, setError] = useState("");
  const [profileEdit, setProfileEdit] = useState<{ profile?: PlayerProfile } | null>(null);
  const profileTrigger = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<"capture" | "archives" | "merge" | null>(null);
  const [mergeSnapshot, setMergeSnapshot] = useState<BestMergeSnapshot | null>(null);
  const mergeTrigger = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<"best" | "recent">("best");
  const [imageSnapshot, setImageSnapshot] = useState<ScoreImageSnapshot | null>(null);
  const imageTrigger = useRef<HTMLButtonElement>(null);
  const [editorSnapshot, setEditorSnapshot] = useState<PlayerSaveEditorSnapshot | null>(null);
  const editorTrigger = useRef<HTMLButtonElement>(null);
  const viewId = useId();
  const rating = useMemo(() => best110(save?.scores ?? [], music), [save?.scores, music]);
  const currentRating = save?.newPlayerRating !== undefined ? save.newPlayerRating / 1000 : save?.scores.length ? rating.total : undefined;
  const captureTrigger = useRef<HTMLButtonElement>(null), archiveTrigger = useRef<HTMLButtonElement>(null), popoverId = useId();
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const pendingDeletion = deleteIds.filter(id => saves.some(item => item.id === id));
  const profiles = state?.profiles, server = profiles?.server, cards = profiles?.cards ?? [], players = profiles?.players ?? [], machines = profiles?.machines ?? [];
  const selectedCard = cards.find(card => card.id === cardId);
  const selectedProfile = players.find(player => player.id === playerId);
  const playerNames = useMemo(() => new Map(players.map(player => {
    const serverId = machines.find(machine => machine.id === player.machineId)?.server?.id;
    const candidates = (state?.saves ?? []).filter(item => (item.localPlayerId ? item.localPlayerId === player.id : player.importedSaveIds?.includes(item.id)
      || !!player.cardId && !!serverId && item.scope?.cardId === player.cardId && item.scope.serverId === serverId) && !!item.playerName.trim() && item.playerName !== "未命名玩家")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (b.sequence ?? 0) - (a.sequence ?? 0));
    return [player.id, candidates.find(item => item.id === save?.id)?.playerName ?? candidates[0]?.playerName ?? player.name];
  })), [players, machines, state?.saves, save?.id]);
  const automaticProfileName = useMemo(() => {
    const savedName = profileEdit?.profile?.name.trim();
    if (savedName && (/^玩家\s*\d+$/.test(savedName) || profileEdit?.profile?.importedSaveIds?.length)) return savedName;
    const occupied = new Set(players.filter(player => player.id !== profileEdit?.profile?.id)
      .map(player => Number(/^玩家\s*(\d+)$/.exec(player.name.trim())?.[1])).filter(number => Number.isInteger(number) && number > 0));
    let number = 1;
    while (occupied.has(number)) number++;
    return `玩家 ${number}`;
  }, [players, profileEdit?.profile]);
  const playerScopeValid = !profiles?.players || !!selectedProfile && selectedProfile.cardId === cardId && machines.find(machine => machine.id === selectedProfile.machineId)?.server?.id === server?.id;
  const operationGroup = `${playerId}:${server?.id ?? ""}:${cardId}`, currentGroup = useRef(operationGroup), operationVersion = useRef(0);
  const previousOperationGroup = useRef(operationGroup);
  const recordFocus = usePlayerRecordFocus(`${root}:${operationGroup}:${save?.id ?? ""}:${view}`, view === "best");
  currentGroup.current = operationGroup;
  const locallyOwned = (item: PlayerSave) => players.some(player => item.localPlayerId === player.id || player.importedSaveIds?.includes(item.id));
  const unassignedCount = state?.saves.filter(item => !item.scope && !locallyOwned(item) && item.serverId === server?.id && !!server).length ?? 0;
  const unknownCount = state?.saves.filter(item => !item.scope && !locallyOwned(item) && !item.serverId).length ?? 0;
  const mounted = useRef(true);
  useEffect(() => { setDeleteMode(false); setDeleteIds([]); }, [operationGroup, unassigned, unknownSource]);
  useEffect(() => { operationVersion.current++; setBusy(""); setProfileEdit(null); setError(""); setMessage(null); if (previousOperationGroup.current !== operationGroup && busy) window.ogk.cancelPlayerRefresh(); previousOperationGroup.current = operationGroup; }, [operationGroup]);
  useEffect(() => { setImageSnapshot(null); }, [root, operationGroup, save?.id]);
  useEffect(() => { setEditorSnapshot(null); }, [root, operationGroup]);
  useEffect(() => { setMergeSnapshot(null); setDialog(value => value === "merge" ? null : value); }, [root, operationGroup]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.ogk.cancelPlayerRefresh(); };
  }, [root]);
  const captureFailed = !!state?.capture.enabled && (!state.capture.installed || /^(unsupported|capture-error:|read-error:)/.test(state.capture.status));
  const run = async (name: string, action: (isCurrent: () => boolean) => Promise<string>) => {
    if (busy) return; setBusy(name); setError(""); setMessage(null);
    if (name !== "delete") { setDeleteMode(false); setDeleteIds([]); }
    const group = currentGroup.current, version = ++operationVersion.current;
    const isCurrent = () => mounted.current && group === currentGroup.current && version === operationVersion.current;
    try { const text = await action(isCurrent); if (isCurrent()) { await load(); if (isCurrent()) setMessage({ text, id: ++messageSequence.current }); } }
    catch (e) { if (isCurrent()) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current && version === operationVersion.current) setBusy(""); }
  };
  const closeDialog = () => { setDialog(null); setMergeSnapshot(null); setDeleteMode(false); setDeleteIds([]); };
  const feedback = (error || loadError) && <SaveFeedback error>{error || loadError}</SaveFeedback>;
  const toggleCapture = () => void run("capture", async () => {
    const enabled = !state?.capture.enabled;
    await window.ogk.setPlayerCapture(root, enabled); return enabled ? "已启用" : "已关闭";
  });
  const updateCapture = () => void run("capture", async () => { await window.ogk.setPlayerCapture(root, true); return "模块已更新"; });
  const fc = save?.scores.filter(score => score.fullCombo || score.allBreak).length ?? 0;
  const ab = save?.scores.filter(score => score.allBreak).length ?? 0;
  const intro = introOpen && <PlayerDataIntro capture={root ? state?.capture : undefined} status={root ? captureStatusText(state?.capture) : "请先选择游戏目录"} busy={!!busy} feedback={feedback} onToggle={toggleCapture} onUpdate={updateCapture} onClose={permanent => {
      if (permanent) { try { localStorage.setItem(playerDataNoticeStorageKey, "true"); } catch { setError("无法记住提示设置，请检查本地存储权限。"); return; } }
      setIntroOpen(false);
    }}/>;
  if (!root) return <>{intro}<div className="empty"><b>请选择游戏目录</b><span>游玩数据会保存在该游戏的工具箱数据目录中。</span></div></>;
  return <div ref={recordFocus.page} className="player-saves-page">
    {intro}
    {message && createPortal(<div key={message.id} className="save-toast player-save-toast" role="status" aria-live="polite" aria-atomic="true">{message.text}</div>, document.querySelector(".app") ?? document.body)}
    <div className="page-title"><h1>游玩数据</h1><div className="player-utility-actions">
      <button ref={captureTrigger} data-capture-toggle disabled={!!busy} aria-haspopup="dialog" aria-expanded={dialog === "capture"} aria-controls={dialog === "capture" ? popoverId : undefined} onClick={() => dialog === "capture" ? closeDialog() : setDialog("capture")}>自动读取 Mod<span className={`player-utility-state${captureFailed ? " is-error" : state?.capture.enabled ? " is-on" : ""}`} aria-label={captureFailed ? "读取异常" : state?.capture.enabled ? "已启用" : "未启用"}/></button>
      <button ref={archiveTrigger} data-archives-toggle disabled={!!busy} aria-haspopup="dialog" aria-expanded={dialog === "archives"} aria-controls={dialog === "archives" ? popoverId : undefined} onClick={() => dialog === "archives" ? closeDialog() : setDialog("archives")}>历史存档<span className="player-archive-count">{saves.length}</span></button>
      <button ref={mergeTrigger} type="button" data-player-best-merge aria-haspopup="dialog" aria-expanded={dialog === "merge"} disabled={!!busy || selectingPlayer || !playerScopeValid || !server || !save?.scope || save.scope.cardId !== cardId || save.scope.serverId !== server.id} onClick={() => {
        if (!save?.scope || !server) return;
        closeDialog(); setProfileEdit(null); setImageSnapshot(null);
        setMergeSnapshot({ root, target: save, cardId, serverId: server.id, serverLabel: server.label }); setDialog("merge");
      }}>合并最佳</button>
      <div className="player-save-actions player-profiles-fetch"><button className="primary" disabled={!!busy || selectingPlayer || !playerScopeValid || !server || !selectedCard} onClick={() => void run("configured", async isCurrent => { const result = await window.ogk.fetchConfiguredPlayerSave(root, cardId, server!.id); if (isCurrent()) { setSelected(result.id, result.scope); showUnassigned(false); } return result.unchanged ? "存档无变化" : "获取成功"; })}>{busy === "configured" ? "获取中…" : selectingPlayer ? "切换中…" : "获取存档"}</button>{busy === "configured" && <button onClick={() => window.ogk.cancelPlayerRefresh()}>取消获取</button>}</div>
    </div></div>
    <div ref={recordFocus.playerCollapse} className="player-direct-collapse" inert={recordFocus.fullyExpanded} aria-hidden={recordFocus.fullyExpanded}><article ref={recordFocus.player} className="surface settings-panel player-direct-panel" aria-labelledby="player-direct-title">
      <div className="player-save-section-head"><span id="player-direct-title">当前玩家</span><div className="player-connection-labels"><span className="player-server-label" title="来自所选玩家的机台"><span>玩家服务器</span><b>{server?.label ?? (state ? "未配置" : "读取中…")}</b></span></div></div>
      <div className="player-profiles-toolbar">
        <div className="player-profiles-rail" role="group" aria-label="玩家列表">{players.map(player => {
          const machine = machines.find(machine => machine.id === player.machineId), selected = playerId === player.id, name = playerNames.get(player.id) ?? player.name;
          return <div key={player.id} className={`player-profile-card${selected ? " is-selected" : ""}`}>
            <button type="button" className="player-profile-select" data-player-profile-id={player.id} aria-pressed={selected} aria-label={selected ? `编辑玩家 ${name}` : `选择玩家 ${name}`} disabled={selectingPlayer || selected && !!busy} onClick={event => {
              if (!selected) { void selectPlayer(player.id).catch(() => {}); return; }
              closeDialog(); setImageSnapshot(null); profileTrigger.current = event.currentTarget;
              setProfileEdit(value => value?.profile?.id === player.id ? null : { profile: player });
            }}><b title={name}>{name}</b><small className="player-profile-machine-name">{machine?.name ?? "机台已移除"}</small></button>
          </div>;
        })}{!players.length && <span className="player-profile-empty">{state ? "添加玩家，关联机台与卡号" : "读取玩家中…"}</span>}<button type="button" className="player-profile-add" data-player-profile-add disabled={!!busy || selectingPlayer || !state} onClick={event => { closeDialog(); setImageSnapshot(null); profileTrigger.current = event.currentTarget; setProfileEdit({}); }}><span aria-hidden="true">＋</span>新增玩家</button></div>
      </div>
      {profiles?.players && players.length > 0 && !playerScopeValid && <p className="player-profile-note">此卡号尚未关联玩家。新增玩家后可获取存档或同步成绩。</p>}
      {profiles?.configurationError && <SaveFeedback error>{profiles.configurationError}</SaveFeedback>}
    </article></div>
    {!dialog && feedback}
    {!save ? <div className="empty"><b>{loadError ? "存档读取失败" : !state ? "读取中…" : saves.length ? "请选择存档" : "当前分组暂无存档"}</b>{saves.length > 0 && <button onClick={() => setDialog("archives")}>选择历史存档</button>}</div> : <article ref={recordFocus.surface} className="surface player-save-results">
      <div className="player-summary-collapse" inert={recordFocus.fullyExpanded} aria-hidden={recordFocus.fullyExpanded}><div ref={recordFocus.summary} className="player-summary-content">
      <header className="player-results-heading"><div className="player-name-rating"><h2 id="player-save-name">{save.playerName}</h2>{save.bestMerge && <span className="player-merged-badge">合并最佳</span>}<div className="player-current-rating" aria-label="当前 Rating"><span>{save.newPlayerRating === undefined && currentRating !== undefined ? "本地 Rating" : "Rating"}</span><b>{currentRating?.toFixed(3) ?? "—"}</b></div></div><time dateTime={save.updatedAt}>{shortSaveDate(save.updatedAt)}</time></header>
      <dl className="player-save-overview">
        <div className="player-score-count"><dt>游玩乐曲数</dt><dd><strong>{new Set(save.scores.map(score => score.musicId)).size.toLocaleString()}</strong><span>首</span></dd></div>
        <div className="player-fc-count"><dt>FULL COMBO</dt><dd><strong>{fc.toLocaleString()}</strong><span>谱面</span></dd></div>
        <div className="player-ab-count"><dt>ALL BREAK</dt><dd><strong>{ab.toLocaleString()}</strong><span>谱面</span></dd></div>
      </dl>
      </div></div>
      <div className="player-results-body"><div className="player-play-records">
        <div className="player-record-toolbar">
        <div className="segmented player-record-tabs" role="tablist" aria-label="游玩记录视图" onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const next = event.key === "Home" ? "best" : event.key === "End" ? "recent" : view === "best" ? "recent" : "best";
          setView(next); document.getElementById(`${viewId}-${next}`)?.focus();
        }}>{([ ["best", "BEST 110"], ["recent", "最近游玩"] ] as const).map(([id, label]) => <button key={id} id={`${viewId}-${id}`} data-record-tab={id} role="tab" aria-selected={view === id} aria-controls={`${viewId}-panel`} tabIndex={view === id ? 0 : -1} className={view === id ? "selected-row" : ""} onClick={() => setView(id)}>{label}</button>)}</div>
        <div className="player-record-actions">{view === "best" && <button type="button" data-player-focus-toggle aria-pressed={recordFocus.expanded} title="向下滚动展开列表，返回顶部恢复概览" onClick={recordFocus.toggle}>{recordFocus.expanded ? "返回概览" : "展开列表"}</button>}<button ref={imageTrigger} type="button" data-score-image-generate disabled={!!busy} onClick={() => {
          closeDialog(); setProfileEdit(null);
          setImageSnapshot({ save, groups: rating.groups, root, rating: currentRating, ratingSource: save.newPlayerRating !== undefined ? "stored" : "local" });
        }}>生成成绩图</button><button ref={editorTrigger} type="button" data-player-save-edit disabled={!!busy || selectingPlayer || !selectedProfile || unassigned || unknownSource} onClick={() => {
          if (!selectedProfile) return;
          closeDialog(); setProfileEdit(null); setImageSnapshot(null);
          setEditorSnapshot({ root, save, playerId: selectedProfile.id, cardId, serverId: server?.id, serverLabel: server?.label });
        }}>修改存档</button></div>
        </div>
        <div id={`${viewId}-panel`} role="tabpanel" aria-labelledby={`${viewId}-${view}`} className="player-record-panel">{view === "best" ? <Best110 key={save.id} groups={rating.groups} root={root} scrollRef={recordFocus.scroller}/> : <RecentPlays key={save.id} save={save} music={music} root={root}/>}</div>
      </div><aside className="player-resource-aside" inert={recordFocus.fullyExpanded} aria-hidden={recordFocus.fullyExpanded}><div ref={recordFocus.resources} className="player-resource-content"><PlayerInventoryDetails save={save}/></div></aside></div>
    </article>}
    {dialog && dialog !== "merge" && <PlayerPopover key={dialog} id={popoverId} title={dialog === "capture" ? "自动读取 Mod" : "历史存档"} anchor={dialog === "capture" ? captureTrigger : archiveTrigger} width={dialog === "capture" ? 360 : 520} onClose={closeDialog}>
      {feedback}
      {dialog === "capture" ? <section className="player-capture-panel">
        <div className="player-capture-row"><div><h3>自动读取游玩数据</h3><p>自动读取登录与结算存档；通过「保存改动」提交的修改在下次游玩时应用。</p></div><button className={`switch-control${state?.capture.enabled ? " is-on" : ""}`} role="switch" aria-label="自动读取 Mod" aria-checked={!!state?.capture.enabled} disabled={!!busy || !state} onClick={toggleCapture}><i/></button></div>
        <span className={`player-status-badge${captureFailed ? " is-error" : state?.capture.enabled && !state.capture.updateAvailable && ["ready", "capturing", "captured"].includes(state.capture.status) ? " is-connected" : ""}`} data-capture-status role="status">{captureStatusText(state?.capture)}</span>
        {state?.capture.enabled && state.capture.updateAvailable && <button data-player-capture-update disabled={!!busy} onClick={updateCapture}>{busy === "capture" ? "更新中…" : "更新模块"}</button>}
        {captureFailed && <SaveFeedback error>{!state?.capture.installed ? "模块缺失，请关闭后重新启用。" : state.capture.status.startsWith("read-error:") ? state.capture.status.slice("read-error:".length).trim() : "读取异常，请检查游戏日志后重启。"}</SaveFeedback>}
      </section> : <>
    <section className="player-archive-panel">
      <div className="player-save-section-head"><h2>{unassigned ? unknownSource ? "来源未知存档" : "未归属存档" : "历史存档"}<span className="player-archive-count">{saves.length}</span></h2>
        <div className="player-save-actions">{!deleteMode && <button disabled={!!busy || !saves.length} onClick={() => { setDeleteMode(true); setDeleteIds([]); }}>删除存档</button>}{deleteMode && <button disabled={!!busy} onClick={() => { setDeleteMode(false); setDeleteIds([]); }}>取消删除</button>}{unknownCount > 0 && !unknownSource && <button disabled={!!busy} onClick={showUnknown}>来源未知（{unknownCount}）</button>}{(unassignedCount > 0 || unassigned) && <button disabled={!!busy} aria-pressed={unassigned} onClick={() => showUnassigned(!unassigned)}>{unassigned ? "返回当前卡号" : `未归属存档（${unassignedCount}）`}</button>}</div>
      </div>
      <div className={`player-save-history${deleteMode ? " is-deleting" : ""}`} aria-label="历史存档记录">{saves.map(item => <button key={item.id} data-save-id={item.id} disabled={!!busy} title={new Date(item.updatedAt).toLocaleString()} aria-label={`${deleteMode ? "选择删除" : "选择存档"} ${archiveDate(item.updatedAt)}`}
        className={deleteMode ? deleteIds.includes(item.id) ? "is-delete-selected" : "" : save?.id === item.id ? "selected-row" : ""} aria-pressed={deleteMode ? deleteIds.includes(item.id) : save?.id === item.id}
        onClick={() => deleteMode ? setDeleteIds(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id]) : (setSelected(item.id), setDialog(null))}>
        {deleteMode && <span className="player-delete-check" aria-hidden="true">{deleteIds.includes(item.id) ? "✓" : ""}</span>}<time dateTime={item.updatedAt}>{archiveDate(item.updatedAt)}</time>{item.bestMerge && <span className="player-merged-badge">合并</span>}{item.edit && <span className="player-merged-badge">修改</span>}
      </button>)}</div>
      {deleteMode && <div className="player-delete-controls"><span>{pendingDeletion.length ? `已选 ${pendingDeletion.length} 份` : "选择要删除的存档"}</span><button className="player-delete-confirm" disabled={!!busy || !pendingDeletion.length} onClick={() => void run("delete", async () => { await window.ogk.deletePlayerSaves(root, pendingDeletion, unassigned ? unknownSource ? null : { serverId: server!.id } : selectedProfile ? { localPlayerId: selectedProfile.id } : { serverId: server!.id, cardId }); setDeleteMode(false); setDeleteIds([]); return "已删除"; })}>{busy === "delete" ? "删除中…" : `确认删除（${pendingDeletion.length}）`}</button></div>}
      {!saves.length && <p>当前分组暂无存档</p>}
      <div className="player-archive-actions">
        <button data-player-save-import disabled={!!busy} onClick={() => void run("import", async isCurrent => { const result = await window.ogk.importPlayerSave(root, null, playerId); if (result && isCurrent()) { setDialog(null); await selectImportedSave(result); } return result ? "导入成功" : "已取消导入"; })}>{busy === "import" ? "导入中…" : "导入 JSON"}</button>
        {save && !deleteMode && <button disabled={!!busy} onClick={() => void run("export", async () => await window.ogk.exportPlayerSave(root, save.id) ? "导出成功" : "已取消导出")}>导出</button>}

      </div>
      {unassigned && <p>{unknownSource ? "这些记录缺少服务器来源，单独保留。" : `这些记录属于 ${server?.label}，尚未关联卡号。`}</p>}
    </section>
      </>}
    </PlayerPopover>}
    {dialog === "merge" && mergeSnapshot && <PlayerBestMergeDialog snapshot={mergeSnapshot} saves={state?.saves ?? []} music={music} anchor={mergeTrigger} onClose={closeDialog} reload={load} onBusyChange={value => setBusy(value ? "merge" : "")} onComplete={(result, text) => {
      setSelected(result.id, result.scope); showUnassigned(false); closeDialog(); setMessage({ text, id: ++messageSequence.current });
    }}/>}
    {imageSnapshot && <PlayerScoreImagePreview snapshot={imageSnapshot} anchor={imageTrigger} onClose={() => setImageSnapshot(null)} onSaved={() => {
      setImageSnapshot(null); setMessage({ text: "成绩图已保存", id: ++messageSequence.current });
    }}/>}
    {editorSnapshot && <PlayerSaveEditor snapshot={editorSnapshot} music={music} anchor={editorTrigger} onClose={() => setEditorSnapshot(null)}
      isCurrent={() => mounted.current && currentGroup.current === `${editorSnapshot.playerId}:${editorSnapshot.serverId ?? ""}:${editorSnapshot.cardId ?? ""}`}
      onBusyChange={value => setBusy(value ? "edit" : "")} onSaved={async result => {
        setSelected(result.id, result.scope); await load();
        if (mounted.current && currentGroup.current === `${editorSnapshot.playerId}:${editorSnapshot.serverId ?? ""}:${editorSnapshot.cardId ?? ""}`) setMessage({ text: "修改已保存在本地", id: ++messageSequence.current });
      }}/>}
    {profileEdit && <PlayerProfileEditor key={profileEdit.profile?.id ?? "new"} root={root} profile={profileEdit.profile} automaticName={automaticProfileName} machines={machines} cards={cards} defaultMachineId={players.find(player => player.id === (playerId || profiles?.selectedPlayerId))?.machineId ?? profiles?.activeMachineId ?? machines[0]?.id ?? ""}
      defaultCardId={cardId} anchor={profileTrigger} onClose={() => setProfileEdit(null)} onEditMachine={onEditMachine} onSaved={async (id, isEditorCurrent) => {
        const existing = !!profileEdit.profile, owner = playerId;
        if (!mounted.current || !isEditorCurrent() || currentGroup.current.split(":")[0] !== owner) return;
        if (!await selectPlayer(id)) return;
        if (mounted.current && currentGroup.current.startsWith(`${id}:`)) { setProfileEdit(null); setMessage({ text: existing ? "玩家已保存" : "玩家已添加", id: ++messageSequence.current }); }
      }} onDeleted={async isEditorCurrent => {
        if (!mounted.current || !isEditorCurrent()) return;
        if (!await refreshPlayerProfiles()) return;
        if (mounted.current) { setProfileEdit(null); setMessage({ text: "玩家已删除", id: ++messageSequence.current }); }
      }}/>}
  </div>;
}
