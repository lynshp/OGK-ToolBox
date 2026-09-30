import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playerItemKinds, type CaptureState, type PlayerSave } from "./player-save-models";
import { shortSaveDate, usePlayerSave } from "./player-save-context";
import { PlayerPicker, CardVisibilityButton } from "./player-picker";
import { PlayerPopover } from "./player-popover";
import { BundleThumbnail } from "./bundle-thumbnail";
import type { MusicEntry } from "./player-library";
import { SaveFeedback } from "./player-score-ui";
import { best110 } from "./player-rating";
import { Best110 } from "./player-rating-ui";
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
  if (capture.status.startsWith("unsupported")) return "初始化失败";
  if (capture.status.startsWith("capture-error:")) return "采集失败";
  if (capture.status.startsWith("read-error:")) return "读取失败";
  if (capture.status === "initializing") return "初始化中…";
  if (capture.status === "ready") return "已连接 · 等待刷卡";
  if (capture.status === "capturing") return "采集中";
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
export function PlayerSavesPage({ root, music }: { root: string; music: MusicEntry[] }) {
  const { state, save, saves, cardId, selectCard, unassigned, unknownSource, showUnknown, showUnassigned, selectSave: setSelected, reload: load, loadError } = usePlayerSave();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ text: string; id: number } | null>(null);
  const messageSequence = useRef(0);
  const [error, setError] = useState("");
  const [newCard, setNewCard] = useState<string | null>(null);
  const [cardVisible, setCardVisible] = useState(false);
  const [dialog, setDialog] = useState<"capture" | "archives" | null>(null);
  const [view, setView] = useState<"best" | "recent">("best");
  const viewId = useId();
  const rating = useMemo(() => best110(save?.scores ?? [], music), [save?.scores, music]);
  const currentRating = save?.newPlayerRating !== undefined ? save.newPlayerRating / 1000 : save?.scores.length ? rating.total : undefined;
  const captureTrigger = useRef<HTMLButtonElement>(null), archiveTrigger = useRef<HTMLButtonElement>(null), popoverId = useId();
  const [deleteMode, setDeleteMode] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const pendingDeletion = deleteIds.filter(id => saves.some(item => item.id === id));
  const profiles = state?.profiles, server = profiles?.server, cards = profiles?.cards ?? [];
  const selectedCard = cards.find(card => card.id === cardId);
  const operationGroup = `${server?.id ?? ""}:${cardId}`, currentGroup = useRef(operationGroup);
  currentGroup.current = operationGroup;
  const unassignedCount = state?.saves.filter(item => !item.scope && item.serverId === server?.id && !!server).length ?? 0;
  const unknownCount = state?.saves.filter(item => !item.scope && !item.serverId).length ?? 0;
  const cardName = (id: string) => {
    const candidate = (save?.scope?.cardId === id && save.scope.serverId === server?.id ? save : undefined) ?? state?.saves.find(item => item.scope?.cardId === id && item.scope.serverId === server?.id);
    return candidate?.playerName;
  };
  const cardText = (code: string) => cardVisible ? code.replace(/(.{4})(?=.)/g, "$1 ") : `${code.slice(0, 4)} •••• •••• •••• ••••`;
  const mounted = useRef(true);
  useEffect(() => { setDeleteMode(false); setDeleteIds([]); }, [operationGroup, unassigned, unknownSource]);
  useEffect(() => { setCardVisible(false); setNewCard(null); setError(""); setMessage(null); }, [operationGroup]);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    const hideCard = () => setCardVisible(false);
    const onVisibility = () => { if (document.visibilityState !== "visible") hideCard(); };
    window.addEventListener("blur", hideCard);
    document.addEventListener("visibilitychange", onVisibility);
    return () => { window.removeEventListener("blur", hideCard); document.removeEventListener("visibilitychange", onVisibility); };
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; window.ogk.cancelPlayerRefresh(); };
  }, [root]);
  const captureFailed = !!state?.capture.enabled && (!state.capture.installed || /^(unsupported|capture-error:|read-error:)/.test(state.capture.status));
  const run = async (name: string, action: () => Promise<string>) => {
    if (busy) return; setBusy(name); setError(""); setMessage(null); setCardVisible(false);
    if (name !== "delete") { setDeleteMode(false); setDeleteIds([]); }
    const group = currentGroup.current;
    try { const text = await action(); await load(); if (mounted.current && group === currentGroup.current) setMessage({ text, id: ++messageSequence.current }); }
    catch (e) { if (mounted.current && group === currentGroup.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (mounted.current) setBusy(""); }
  };
  if (!root) return <div className="empty"><b>请选择游戏目录</b><span>游玩数据会保存在该游戏的工具箱数据目录中。</span></div>;
  const closeDialog = () => { setDialog(null); setDeleteMode(false); setDeleteIds([]); };
  const feedback = (error || loadError) && <SaveFeedback error>{error || loadError}</SaveFeedback>;
  const fc = save?.scores.filter(score => score.fullCombo || score.allBreak).length ?? 0;
  const ab = save?.scores.filter(score => score.allBreak).length ?? 0;
  return <div className="player-saves-page">
    {message && createPortal(<div key={message.id} className="save-toast player-save-toast" role="status" aria-live="polite" aria-atomic="true">{message.text}</div>, document.querySelector(".app") ?? document.body)}
    <div className="page-title"><h1>游玩数据</h1><div className="player-utility-actions">
      <button ref={captureTrigger} data-capture-toggle aria-haspopup="dialog" aria-expanded={dialog === "capture"} aria-controls={dialog === "capture" ? popoverId : undefined} onClick={() => dialog === "capture" ? closeDialog() : setDialog("capture")}>自动读取 Mod<span className={`player-utility-state${captureFailed ? " is-error" : state?.capture.enabled ? " is-on" : ""}`} aria-label={captureFailed ? "读取异常" : state?.capture.enabled ? "已启用" : "未启用"}/></button>
      <button ref={archiveTrigger} data-archives-toggle aria-haspopup="dialog" aria-expanded={dialog === "archives"} aria-controls={dialog === "archives" ? popoverId : undefined} onClick={() => dialog === "archives" ? closeDialog() : setDialog("archives")}>本地存档<span className="player-archive-count">{saves.length}</span></button>
    </div></div>
    <article className="surface settings-panel player-direct-panel" aria-labelledby="player-direct-title">
      <div className="player-save-section-head"><span id="player-direct-title">当前玩家</span><span className="player-server-label" title="来自 segatools.ini"><span>当前服务器</span><b>{server?.label ?? (state ? "未配置" : "读取中…")}</b></span></div>
      <div className="player-direct-form">
        <div className="player-connection-card"><span>Aime 卡号</span><div className="player-card-controls">
          <PlayerPicker label="选择卡号" value={cardId} placeholder={state ? "添加卡号" : "读取中…"} disabled={!!busy || !state} options={cards.map((card, index) => ({ id: card.id, title: cardName(card.id) ?? `卡号 ${index + 1}`, detail: `${cardName(card.id) ? `卡号 ${index + 1} · ` : ""}${cardText(card.accessCode)}` }))}
            onChange={id => { selectCard(id); setNewCard(null); setCardVisible(false); }} onAdd={() => { setNewCard(""); setCardVisible(false); }}
            onReorder={ids => void run("cards", async () => { await window.ogk.reorderPlayerCards(root, ids); return "排序已保存"; })}/>
          <CardVisibilityButton visible={cardVisible} disabled={!!busy || !cards.length && newCard === null} onToggle={() => setCardVisible(value => !value)}/>
        </div></div>
        <div className="player-save-actions"><button className="primary" disabled={!!busy || !server || !selectedCard} onClick={() => void run("configured", async () => { const result = await window.ogk.fetchConfiguredPlayerSave(root, cardId, server!.id); setSelected(result.id, result.scope); showUnassigned(false); return result.unchanged ? "存档无变化" : "获取成功"; })}>{busy === "configured" ? "获取中…" : "获取存档"}</button>{busy === "configured" && <button onClick={() => window.ogk.cancelPlayerRefresh()}>取消获取</button>}</div>
      </div>
      {newCard !== null && <form className="player-add-card" onSubmit={event => { event.preventDefault(); void run("cards", async () => { const id = await window.ogk.addPlayerCard(root, newCard); await load(); selectCard(id); setNewCard(null); return "卡号已保存"; }); }}>
        <label>新卡号<input autoFocus name="player-access-code" type={cardVisible ? "text" : "password"} inputMode="numeric" autoComplete="off" spellCheck={false} value={newCard} disabled={!!busy} maxLength={28} onChange={event => setNewCard(event.target.value)} placeholder="20 位 Aime 卡号"/></label>
        <button type="submit" disabled={!!busy || !/^\d{20}$/.test(newCard.replace(/[\s-]/g, ""))}>添加</button><button type="button" disabled={!!busy} onClick={() => setNewCard(null)}>取消</button>
      </form>}
      {profiles?.configurationError && <SaveFeedback error>{profiles.configurationError}</SaveFeedback>}
    </article>
    {!dialog && feedback}
    {!save ? <div className="empty"><b>{loadError ? "存档读取失败" : !state ? "读取中…" : saves.length ? "请选择存档" : "当前分组暂无存档"}</b>{saves.length > 0 && <button onClick={() => setDialog("archives")}>选择本地存档</button>}</div> : <article className="surface player-save-results">
      <header className="player-results-heading"><div className="player-name-rating"><h2 id="player-save-name">{save.playerName}</h2><div className="player-current-rating" aria-label="当前 Rating"><span>{save.newPlayerRating === undefined && currentRating !== undefined ? "本地 Rating" : "Rating"}</span><b>{currentRating?.toFixed(3) ?? "—"}</b></div></div><time dateTime={save.updatedAt}>{shortSaveDate(save.updatedAt)}</time></header>
      <dl className="player-save-overview">
        <div className="player-score-count"><dt>游玩乐曲数</dt><dd><strong>{new Set(save.scores.map(score => score.musicId)).size.toLocaleString()}</strong><span>首</span></dd></div>
        <div className="player-fc-count"><dt>FULL COMBO</dt><dd><strong>{fc.toLocaleString()}</strong><span>谱面</span></dd></div>
        <div className="player-ab-count"><dt>ALL BREAK</dt><dd><strong>{ab.toLocaleString()}</strong><span>谱面</span></dd></div>
      </dl>
      <div className="player-results-body"><div className="player-play-records">
        <div className="segmented player-record-tabs" role="tablist" aria-label="游玩记录视图" onKeyDown={event => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault(); const next = event.key === "Home" ? "best" : event.key === "End" ? "recent" : view === "best" ? "recent" : "best";
          setView(next); document.getElementById(`${viewId}-${next}`)?.focus();
        }}>{([ ["best", "BEST 110"], ["recent", "最近游玩"] ] as const).map(([id, label]) => <button key={id} id={`${viewId}-${id}`} data-record-tab={id} role="tab" aria-selected={view === id} aria-controls={`${viewId}-panel`} tabIndex={view === id ? 0 : -1} className={view === id ? "selected-row" : ""} onClick={() => setView(id)}>{label}</button>)}</div>
        <div id={`${viewId}-panel`} role="tabpanel" aria-labelledby={`${viewId}-${view}`} className="player-record-panel">{view === "best" ? <Best110 key={save.id} groups={rating.groups} root={root}/> : <RecentPlays key={save.id} save={save} music={music} root={root}/>}</div>
      </div><aside className="player-resource-aside"><PlayerInventoryDetails save={save}/></aside></div>
    </article>}
    {dialog && <PlayerPopover key={dialog} id={popoverId} title={dialog === "capture" ? "自动读取 Mod" : "本地存档"} anchor={dialog === "capture" ? captureTrigger : archiveTrigger} width={dialog === "capture" ? 360 : 520} onClose={closeDialog}>
      {feedback}
      {dialog === "capture" ? <section className="player-capture-panel">
        <div className="player-capture-row"><div><h3>自动读取游玩数据</h3><p>启用后，打开游戏自动获取游玩数据。</p></div><button className={`switch-control${state?.capture.enabled ? " is-on" : ""}`} role="switch" aria-label="自动读取 Mod" aria-checked={!!state?.capture.enabled} disabled={!!busy || !state} onClick={() => void run("capture", async () => { const enabled = !state?.capture.enabled; await window.ogk.setPlayerCapture(root, enabled); return enabled ? "已启用" : "已关闭"; })}><i/></button></div>
        <span className={`player-status-badge${captureFailed ? " is-error" : state?.capture.enabled && ["ready", "capturing"].includes(state.capture.status) ? " is-connected" : ""}`} data-capture-status role="status">{captureStatusText(state?.capture)}</span>
        {captureFailed && <SaveFeedback error>{!state?.capture.installed ? "模块缺失，请关闭后重新启用。" : "读取异常，请检查游戏日志后重启。"}</SaveFeedback>}
      </section> : <>
    <section className="player-archive-panel">
      <div className="player-save-section-head"><h2>{unassigned ? unknownSource ? "来源未知存档" : "未归属存档" : "本地存档"}<span className="player-archive-count">{saves.length}</span></h2>
        <div className="player-save-actions">{!deleteMode && <button disabled={!!busy || !saves.length} onClick={() => { setDeleteMode(true); setDeleteIds([]); }}>删除存档</button>}{deleteMode && <button disabled={!!busy} onClick={() => { setDeleteMode(false); setDeleteIds([]); }}>取消删除</button>}{unknownCount > 0 && !unknownSource && <button disabled={!!busy} onClick={showUnknown}>来源未知（{unknownCount}）</button>}{(unassignedCount > 0 || unassigned) && <button disabled={!!busy} aria-pressed={unassigned} onClick={() => showUnassigned(!unassigned)}>{unassigned ? "返回当前卡号" : `未归属存档（${unassignedCount}）`}</button>}</div>
      </div>
      <div className={`player-save-history${deleteMode ? " is-deleting" : ""}`} aria-label="本地存档记录">{saves.map(item => <button key={item.id} data-save-id={item.id} disabled={!!busy} title={new Date(item.updatedAt).toLocaleString()} aria-label={`${deleteMode ? "选择删除" : "选择存档"} ${archiveDate(item.updatedAt)}`}
        className={deleteMode ? deleteIds.includes(item.id) ? "is-delete-selected" : "" : save?.id === item.id ? "selected-row" : ""} aria-pressed={deleteMode ? deleteIds.includes(item.id) : save?.id === item.id}
        onClick={() => deleteMode ? setDeleteIds(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id]) : (setSelected(item.id), setDialog(null))}>
        {deleteMode && <span className="player-delete-check" aria-hidden="true">{deleteIds.includes(item.id) ? "✓" : ""}</span>}<time dateTime={item.updatedAt}>{archiveDate(item.updatedAt)}</time>
      </button>)}</div>
      {deleteMode && <div className="player-delete-controls"><span>{pendingDeletion.length ? `已选 ${pendingDeletion.length} 份` : "选择要删除的存档"}</span><button className="player-delete-confirm" disabled={!!busy || !pendingDeletion.length} onClick={() => void run("delete", async () => { await window.ogk.deletePlayerSaves(root, pendingDeletion, unassigned ? unknownSource ? null : { serverId: server!.id } : { serverId: server!.id, cardId }); setDeleteMode(false); setDeleteIds([]); return "已删除"; })}>{busy === "delete" ? "删除中…" : `确认删除（${pendingDeletion.length}）`}</button></div>}
      {!saves.length && <p>当前分组暂无存档</p>}
      <div className="player-archive-actions">
        <button disabled={!!busy} onClick={() => void run("import", async () => { const group = currentGroup.current; const result = await window.ogk.importPlayerSave(root, server?.id ?? null); if (result && mounted.current && group === currentGroup.current) { if (result.scope) { selectCard(result.scope.cardId); setSelected(result.id, result.scope); } else setSelected(result.id, null, result.serverId ?? null); setDialog(null); } return result ? "导入成功" : "已取消导入"; })}>{busy === "import" ? "导入中…" : "导入 JSON"}</button>
        {save && !deleteMode && <button disabled={!!busy} onClick={() => void run("export", async () => await window.ogk.exportPlayerSave(root, save.id) ? "导出成功" : "已取消导出")}>导出</button>}

      </div>
      {unassigned && <p>{unknownSource ? "这些记录缺少服务器来源，单独保留。" : `这些记录属于 ${server?.label}，尚未关联卡号。`}</p>}
    </section>
      </>}
    </PlayerPopover>}
  </div>;
}
