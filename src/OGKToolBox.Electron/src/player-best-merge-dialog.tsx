import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { MusicEntry } from "./player-library";
import type { PlayerSave } from "./player-save-models";
import { mergeBestScores } from "./player-best-merge";
import { best110 } from "./player-rating";
import { shortSaveDate } from "./player-save-context";
import { PlayerPopover } from "./player-popover";
import { SaveFeedback } from "./player-score-ui";
import { libraryFailureMessage } from "./library-startup";
import type { PlayerUploadPolicy } from "./player-upload-policy";

type Snapshot = { root: string; target: PlayerSave; cardId: string; serverId: string; serverLabel: string };
export type BestMergeSnapshot = Snapshot;

export function PlayerBestMergeDialog({ snapshot, saves, music, anchor, onClose, onBusyChange, onComplete, reload }: {
  snapshot: Snapshot; saves: PlayerSave[]; music: MusicEntry[]; anchor: RefObject<HTMLButtonElement | null>;
  onClose(): void; onBusyChange(value: boolean): void; onComplete(save: PlayerSave, message: string): void; reload(): Promise<void>;
}) {
  const { root, target, cardId, serverId, serverLabel } = snapshot;
  const candidates = useMemo(() => saves.filter(item => item.id !== target.id && item.scope?.cardId === cardId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (b.sequence ?? 0) - (a.sequence ?? 0)), [saves, target.id, cardId]);
  const [selected, setSelected] = useState<string[]>(() => {
    const seen = new Set<string>();
    return candidates.filter(item => {
      const id = item.scope!.serverId;
      if (id === serverId || seen.has(id)) return false;
      seen.add(id); return true;
    }).map(item => item.id);
  });
  const [busy, setBusy] = useState<"" | "saving" | "uploading" | "exporting" | "portal">("");
  const [saved, setSaved] = useState<PlayerSave | null>(null);
  const [error, setError] = useState("");
  const [policy, setPolicy] = useState<PlayerUploadPolicy | null>(null), [policyError, setPolicyError] = useState(""), [policyAttempt, setPolicyAttempt] = useState(0), [actionMessage, setActionMessage] = useState("");
  const scope = `${root}\u001f${target.id}\u001f${cardId}\u001f${serverId}`;
  const currentScope = useRef(scope); currentScope.current = scope;
  const alive = useRef(true), uploading = useRef(false), busyRef = useRef(false), policyRequest = useRef(0), callbacks = useRef({ onBusyChange, onComplete, reload });
  callbacks.current = { onBusyChange, onComplete, reload };
  const valid = () => alive.current && currentScope.current === scope;
  useEffect(() => { alive.current = true; return () => { alive.current = false; policyRequest.current++; if (uploading.current) window.ogk.cancelPlayerRefresh(); callbacks.current.onBusyChange(false); }; }, []);
  useEffect(() => {
    const owner = ++policyRequest.current; setPolicy(null); setPolicyError("");
    void Promise.resolve().then(() => window.ogk.playerUploadPolicy(root, cardId, serverId)).then(result => {
      if (owner === policyRequest.current && valid()) setPolicy(result);
    }).catch(reason => { if (owner === policyRequest.current && valid()) setPolicyError(libraryFailureMessage(reason)); });
    return () => { policyRequest.current++; };
  }, [root, cardId, serverId, policyAttempt]);
  const chosen = candidates.filter(item => selected.includes(item.id));
  const platinumMaximum = useMemo(() => new Map(music.flatMap(song => (song.rating?.charts ?? [])
    .filter(chart => chart.platinumMax !== undefined).map(chart => [`${Number(song.id)}:${chart.difficulty}`, chart.platinumMax!] as const))), [music]);
  const preview = useMemo(() => mergeBestScores(target.scores, chosen.map(item => item.scores), platinumMaximum), [target.scores, chosen, platinumMaximum]);
  const before = useMemo(() => best110(target.scores, music).total, [target.scores, music]);
  const after = useMemo(() => best110(preview.scores, music).total, [preview.scores, music]);
  const groups = useMemo(() => {
    const result = new Map<string, { label: string; current: boolean; entries: PlayerSave[] }>();
    for (const item of candidates) {
      const id = item.scope!.serverId;
      let group = result.get(id);
      if (!group) {
        group = { label: id === serverId ? serverLabel : item.serverLabel ?? `其他服务器 ${result.size + 1}`, current: id === serverId, entries: [] };
        result.set(id, group);
      }
      group.entries.push(item);
    }
    return [...result].sort((a, b) => Number(a[1].current) - Number(b[1].current));
  }, [candidates, serverId, serverLabel]);
  const changed = preview.addedCharts + preview.improvedCharts;
  const dialogId = useId();
  const commit = async (upload: boolean) => {
    if (busyRef.current || !valid() || (!saved && !chosen.length) || upload && policy?.scoreUpload !== "direct") return;
    busyRef.current = true;
    setError(""); setBusy(saved && upload ? "uploading" : "saving"); callbacks.current.onBusyChange(true);
    let local = saved;
    try {
      local ??= await window.ogk.mergePlayerBest(root, target.id, chosen.map(item => item.id), cardId, serverId);
      if (!valid()) return;
      setSaved(local);
      if (upload) {
        setBusy("uploading");
        uploading.current = true;
        let result: Awaited<ReturnType<typeof window.ogk.uploadPlayerBest>>;
        try { result = await window.ogk.uploadPlayerBest(root, local.id, cardId, serverId); }
        finally { uploading.current = false; }
        if (!valid()) return;
        await callbacks.current.reload();
        if (valid()) callbacks.current.onComplete(result.save, result.uploadedCharts ? `已合并并上传 ${result.uploadedCharts} 张谱面` : "服务器成绩已是最佳");
      } else {
        await callbacks.current.reload();
        if (valid() && policy?.scoreUpload === "direct") callbacks.current.onComplete(local, changed ? "最佳成绩已合并" : "当前存档已是最佳");
      }
    } catch (reason) {
      if (valid()) {
        setError(`${local ? "本地已保存。" : ""}${libraryFailureMessage(reason)}`);
        if (local) { try { await callbacks.current.reload(); } catch { /* Keep the saved result available for retry. */ } }
      }
    } finally {
      busyRef.current = false;
      if (valid()) { setBusy(""); callbacks.current.onBusyChange(false); }
    }
  };
  const frontendAction = async (action: "exporting" | "portal") => {
    if (busyRef.current || !saved || !valid() || action === "portal" && !policy?.frontendService) return;
    busyRef.current = true; setBusy(action); setError(""); callbacks.current.onBusyChange(true);
    try {
      if (action === "exporting") {
        const exported = await window.ogk.exportPlayerSave(root, saved.id);
        if (valid()) setActionMessage(exported ? "备份已导出" : "已取消导出");
      } else await window.ogk.openHddPortal(policy!.frontendService!);
    } catch (reason) { if (valid()) setError(libraryFailureMessage(reason)); }
    finally { busyRef.current = false; if (valid()) { setBusy(""); callbacks.current.onBusyChange(false); } }
  };

  return <PlayerPopover id={dialogId} title="合并最佳成绩" anchor={anchor} width={620} bodyClassName="player-merge-popover-body" onClose={() => { if (!busy) onClose(); }}>
    <div className="player-best-merge">
      <div className="player-merge-target"><div><span>当前存档</span><b>{serverLabel}</b><time dateTime={target.updatedAt}>{shortSaveDate(target.updatedAt)}</time></div><span>同一卡号</span></div>
      <div className="player-merge-source-heading"><h3>来源存档</h3><div className="player-save-actions"><button type="button" data-merge-select-all disabled={!!busy || !!saved || !candidates.length} onClick={() => setSelected(candidates.map(item => item.id))}>全选</button><button type="button" data-merge-clear disabled={!!busy || !!saved || !chosen.length} onClick={() => setSelected([])}>清空</button></div></div>
      <div className="player-merge-sources" aria-label="来源存档">
        {groups.map(([id, group]) => <section key={id}><h4>{group.label}{group.current && <span>当前服务器</span>}</h4><div className="filter-options">{group.entries.map(item => <button key={item.id} type="button" role="checkbox" aria-checked={selected.includes(item.id)} data-merge-source={item.id} disabled={!!busy || !!saved}
          className={`filter-check${selected.includes(item.id) ? " selected-option" : ""}`} onClick={() => setSelected(ids => ids.includes(item.id) ? ids.filter(value => value !== item.id) : [...ids, item.id])}>
          <span className="filter-box" aria-hidden="true">✓</span><span className="player-merge-source-copy"><b>{item.playerName}{item.bestMerge && <small>已合并</small>}</b><time dateTime={item.updatedAt}>{shortSaveDate(item.updatedAt)}</time></span><span className="player-merge-chart-count">{item.scores.length} 谱面</span>
        </button>)}</div></section>)}
        {!candidates.length && <p className="player-merge-empty">没有其他存档，先获取或导入同一卡号的记录。</p>}
      </div>
      <dl className="player-merge-preview" aria-label="合并预览" aria-live="polite"><div><dt>新增谱面</dt><dd data-merge-added>+{preview.addedCharts}</dd></div><div><dt>提升谱面</dt><dd data-merge-improved>{preview.improvedCharts}</dd></div><div className="player-merge-rating"><dt>本地 Rating</dt><dd data-merge-rating>{before?.toFixed(3) ?? "—"}<span aria-hidden="true"> → </span>{after?.toFixed(3) ?? "—"}</dd></div></dl>
      {(error || policyError) && <SaveFeedback error>{error || policyError}</SaveFeedback>}
      <div className="player-merge-footer"><span role="status">{busy === "uploading" ? `正在上传至 ${serverLabel}…` : policy?.scoreUpload === "frontend" ? saved ? `成绩已保存本地，请按 NET 前端支持的方式上传。${policy.frontendService ? "" : "请打开所用服务器的 NET 前端。"}${actionMessage ? ` ${actionMessage}` : ""}` : "合并后保存在本地，请按 NET 前端支持的方式上传。" : saved ? "最佳成绩已保存本地" : "原存档保留 · 仅同步成绩"}</span><div className="player-save-actions">
        {busy === "uploading" && <button type="button" data-merge-cancel onClick={() => window.ogk.cancelPlayerRefresh()}>取消上传</button>}
        {policyError && <button type="button" data-merge-policy-retry disabled={!!busy} onClick={() => setPolicyAttempt(value => value + 1)}>重新确认</button>}
        {saved ? <button type="button" data-merge-local disabled={!!busy} onClick={() => onComplete(saved, "最佳成绩已保存在本地")}>查看本地</button> : <button type="button" data-merge-local disabled={!!busy || !chosen.length} onClick={() => void commit(false)}>保存本地</button>}
        {saved && policy?.scoreUpload === "frontend" && <><button type="button" data-merge-export disabled={!!busy} onClick={() => void frontendAction("exporting")}>{busy === "exporting" ? "导出中…" : "导出备份"}</button>{policy.frontendService && <button type="button" className="primary" data-merge-net disabled={!!busy} onClick={() => void frontendAction("portal")}>打开 NET 前端</button>}</>}
        {policy?.scoreUpload === "direct" && <button type="button" className="primary" data-merge-upload disabled={!!busy || !saved && !chosen.length} onClick={() => void commit(true)}>{busy === "saving" ? "合并中…" : busy === "uploading" ? "上传中…" : saved ? "重试上传" : "保存并上传"}</button>}
      </div></div>
    </div>
  </PlayerPopover>;
}
