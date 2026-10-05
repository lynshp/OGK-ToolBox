import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { MusicEntry } from "./player-library";
import type { PlayerSave, PlayerScore } from "./player-save-models";
import type { EditorChartConstraint, EditorScorePatch, PlayerSaveEditorPatch, PlayerSaveEditorState, PendingPlayerEdit } from "./player-save-editor-models";
import { chartConstant, formatChartConstant } from "./player-library";
import { DifficultyBadge, SaveFeedback } from "./player-score-ui";
import { difficultyNames, shortSaveDate } from "./player-save-context";
import { BundleThumbnail } from "./bundle-thumbnail";
import { useVirtualList } from "./virtual-window";
import { playerResourceIconUrl } from "./player-resource-icons";
import { libraryFailureMessage } from "./library-startup";
import type { PlayerUploadPolicy } from "./player-upload-policy";
import { playerBestPlatinumRank } from "./player-best-merge";
import { useAnchoredMenu } from "./use-anchored-menu";
import { PencilChevronDownIcon } from "./pencil-icons";
import "./player-save-editor.css";

export type PlayerSaveEditorSnapshot = { root: string; save: PlayerSave; playerId: string; cardId?: string; serverId?: string; serverLabel?: string };
type NumberField = "techScore" | "platinumScore" | "battleScore" | "playCount" | "maxComboCount" | "maxOverKill" | "maxTeamOverKill" | "battleScoreRank" | "clearStatus";
type Flag = "fullCombo" | "fullBell" | "allBreak";
type ScoreDraft = Record<NumberField, string> & Record<Flag, boolean>;
type ChartRow = { key: string; musicId: number; difficulty: number; music?: MusicEntry; constraint?: EditorChartConstraint };
const numberFields: [NumberField, string][] = [["techScore", "技术分"], ["platinumScore", "白金分"], ["battleScore", "战斗分"], ["playCount", "游玩次数"], ["maxComboCount", "最大连击"], ["maxOverKill", "个人 OVER DAMAGE ×100"], ["maxTeamOverKill", "队伍 OVER DAMAGE ×100"], ["battleScoreRank", "战斗评级（0–11）"], ["clearStatus", "通关（0 未通关 / 1 已通关）"]];
const flags: [Flag, string][] = [["fullCombo", "FULL COMBO"], ["fullBell", "FULL BELL"], ["allBreak", "ALL BREAK"]];
const resourceTypes = [
  { key: "data:point", name: "金币" }, { key: "data:jewelCount", name: "通用珠" },
  { key: "data:medalCount", name: "勋章" }, { key: "data:shizukuCount", name: "雫" },
  { key: "item:11", name: "抽卡券" }, { key: "item:12", name: "开花券" },
  { key: "item:13", name: "强化道具" }, { key: "item:14", name: "亲密度道具" },
  { key: "chapter", name: "章节珠" }, { key: "item:20", name: "解锁道具" },
  { key: "other", name: "其他" }
];
const resourceTypeKeys = new Set(resourceTypes.map(type => type.key));
const resourceType = (key: string) => {
  const parts = key.split(":"), type = parts[0] === "item" ? `item:${parts[1]}` : parts[0] === "chapter" || parts[0] === "story" ? "chapter" : key;
  return resourceTypeKeys.has(type) ? type : "other";
};
const keyOf = (musicId: number, difficulty: number) => `${musicId}:${difficulty}`;
const numberValue = (value: string, maximum: number | null) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && (maximum === null || Number(value) <= maximum) ? Number(value) : undefined;
const draftOf = (score?: PlayerScore): ScoreDraft => ({ techScore: String(score?.techScore ?? 0), platinumScore: String(score?.platinumScore ?? 0), battleScore: String(score?.battleScore ?? 0), playCount: String(score?.playCount ?? 1), maxComboCount: String(score?.maxComboCount ?? 0), maxOverKill: String(score?.maxOverKill ?? 0), maxTeamOverKill: String(score?.maxTeamOverKill ?? 0), battleScoreRank: String(score?.battleScoreRank ?? 0), clearStatus: String(score?.clearStatus ?? 0), fullCombo: score?.fullCombo ?? false, fullBell: score?.fullBell ?? false, allBreak: score?.allBreak ?? false });
const constantLabel = (row: ChartRow) => formatChartConstant(row.music ? row.music.rating?.charts.find(chart => chart.difficulty === row.difficulty)?.constant ?? chartConstant(row.music, row.difficulty) : undefined);

export function PlayerSaveEditor({ snapshot, music, anchor, onClose, onBusyChange, onSaved, isCurrent }: {
  snapshot: PlayerSaveEditorSnapshot; music: MusicEntry[]; anchor: RefObject<HTMLButtonElement | null>;
  onClose(): void; onBusyChange(value: boolean): void; onSaved(save: PlayerSave): void | Promise<void>;
  isCurrent(): boolean;
}) {
  const [state, setState] = useState<PlayerSaveEditorState | null>(null), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<"resources" | "scores">("resources"), [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState(3);
  const [excludedResourceTypes, setExcludedResourceTypes] = useState<ReadonlySet<string>>(() => new Set());
  const [resourceBase, setResourceBase] = useState<Record<string, number | null>>({}), [resourceDraft, setResourceDraft] = useState<Record<string, string>>({});
  const [scoreDraft, setScoreDraft] = useState<Record<string, ScoreDraft>>({}), [selected, setSelected] = useState("");
  const [saved, setSaved] = useState<PlayerSave | null>(() => snapshot.save.edit?.playerId === snapshot.playerId ? snapshot.save : null), [busy, setBusy] = useState<"" | "saving" | "exporting" | "portal">(""), [error, setError] = useState("");
  const [policy, setPolicy] = useState<PlayerUploadPolicy | null>(null), [policyError, setPolicyError] = useState(""), [policyAttempt, setPolicyAttempt] = useState(0), [policyLoading, setPolicyLoading] = useState(false);
  const [queued, setQueued] = useState<PendingPlayerEdit | undefined>(), [actionMessage, setActionMessage] = useState("");
  const [moreActions, setMoreActions] = useState(false), [localGuide, setLocalGuide] = useState(false), [discardPrompt, setDiscardPrompt] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const { menu: saveMenuPosition } = useAnchoredMenu(moreButton, moreActions, () => setMoreActions(false), { width: 138, maxHeight: 48, align: "end", gap: 0 });
  const policyRequest = useRef(0);
  const dialog = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null), alive = useRef(false), busyRef = useRef(false), request = useRef(0);
  const callbacks = useRef({ onClose, onBusyChange, onSaved, isCurrent }); callbacks.current = { onClose, onBusyChange, onSaved, isCurrent };
  const titleId = useId(), resourcesId = useId(), scoresId = useId();
  const valid = () => alive.current && callbacks.current.isCurrent();
  useLayoutEffect(() => {
    alive.current = true; closeButton.current?.focus({ preventScroll: true });
    const focusable = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),[tabindex='0']") ?? []).filter(node => node.getClientRects().length > 0);
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (dialog.current?.querySelector(".player-editor-save-menu")) { setMoreActions(false); moreButton.current?.focus(); } else if (!busyRef.current) callbacks.current.onClose(); }
      if (event.key !== "Tab") return;
      const nodes = focusable(), first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const contain = (event: FocusEvent) => { if (!dialog.current?.contains(event.target as Node)) (focusable()[0] ?? dialog.current)?.focus({ preventScroll: true }); };
    document.addEventListener("keydown", keyboard, true); document.addEventListener("focusin", contain);
    return () => {
      alive.current = false; request.current++; callbacks.current.onBusyChange(false);
      document.removeEventListener("keydown", keyboard, true); document.removeEventListener("focusin", contain);
      if (anchor.current?.isConnected) anchor.current.focus({ preventScroll: true });
    };
  }, [anchor]);
  useEffect(() => {
    if (!moreActions) return;
    dialog.current?.querySelector<HTMLButtonElement>("[data-save-editor-local]")?.focus();
    const outside = (event: MouseEvent) => { if (!(event.target as HTMLElement).closest(".player-editor-save-split")) setMoreActions(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [moreActions]);
  useEffect(() => {
    const owner = ++request.current; setLoading(true); setError("");
    void Promise.resolve().then(() => window.ogk.getPlayerSaveEditor(snapshot.root, snapshot.save.id, snapshot.playerId)).then(result => {
      if (owner !== request.current || !valid()) return;
      if (result.saveId !== snapshot.save.id || result.playerId !== snapshot.playerId) throw Error("存档归属已变化，请重新打开。");
      setState(result); setQueued(result.pendingEdit);
      if (result.pendingEdit && result.pendingEdit.status !== "complete") {
        setResourceDraft(Object.fromEntries(result.pendingEdit.resources.map(row => [row.key, String(row.value)])));
        setScoreDraft(Object.fromEntries(result.pendingEdit.scores.map(row => {
          const key = keyOf(row.musicId, row.difficulty), baseline = draftOf((result.scores ?? snapshot.save.scores).find(score => keyOf(score.musicId, score.difficulty) === key));
          for (const [field] of numberFields) if ((!row.fields || row.fields.includes(field)) && row[field] !== undefined) baseline[field] = String(row[field]);
          for (const [field] of flags) if (!row.fields || row.fields.includes(field)) baseline[field] = row[field];
          return [key, baseline];
        })));
      } setResourceBase(Object.fromEntries(result.resources.map(row => [row.key, row.value])));
    }).catch(reason => { if (owner === request.current && valid()) setError(libraryFailureMessage(reason)); })
      .finally(() => { if (owner === request.current && valid()) setLoading(false); });
  }, [snapshot, attempt]);
  useEffect(() => {
    const owner = ++policyRequest.current;
    setPolicy(null); setPolicyError("");
    if (!snapshot.cardId || !snapshot.serverId) { setPolicyLoading(false); return; }
    setPolicyLoading(true);
    void Promise.resolve().then(() => window.ogk.playerUploadPolicy(snapshot.root, snapshot.cardId!, snapshot.serverId!)).then(result => {
      if (owner === policyRequest.current && valid()) setPolicy(result);
    }).catch(reason => { if (owner === policyRequest.current && valid()) setPolicyError(libraryFailureMessage(reason)); })
      .finally(() => { if (owner === policyRequest.current && valid()) setPolicyLoading(false); });
    return () => { policyRequest.current++; };
  }, [snapshot, policyAttempt]);
  useEffect(() => {
    if (!queued || queued.status === "complete") return;
    let stopped = false, reading = false;
    const timer = window.setInterval(() => {
      if (reading || busyRef.current || !valid()) return;
      reading = true;
      void window.ogk.playerSaveEditStatus(snapshot.root, snapshot.save.id, snapshot.playerId).then(next => {
        if (!stopped && valid()) {
          setQueued(next);
          if (next?.status !== queued.status || next?.issue !== queued.issue) setActionMessage("");
          if (next?.status === "complete") { setResourceDraft({}); setScoreDraft({}); setActionMessage("游戏已完成改动，请关闭编辑器查看最新结算存档。"); }
        }
      }).catch(() => {}).finally(() => { reading = false; });
    }, 5000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [queued?.id, queued?.status, queued?.issue, snapshot]);
  const baseScores = useMemo(() => new Map((saved?.id !== snapshot.save.id && saved ? saved.scores : state?.scores ?? (saved ?? snapshot.save).scores).map(score => [keyOf(score.musicId, score.difficulty), score])), [saved, snapshot.save, state?.scores]);
  const songIndex = useMemo(() => new Map(music.map(song => [Number(song.id), song])), [music]);
  const rows = useMemo(() => {
    const result = new Map<string, ChartRow>();
    for (const constraint of state?.scoreConstraints ?? []) result.set(keyOf(constraint.musicId, constraint.difficulty), { key: keyOf(constraint.musicId, constraint.difficulty), musicId: constraint.musicId, difficulty: constraint.difficulty, music: songIndex.get(constraint.musicId), constraint });
    for (const score of snapshot.save.scores) if (!result.has(keyOf(score.musicId, score.difficulty))) result.set(keyOf(score.musicId, score.difficulty), {key: keyOf(score.musicId, score.difficulty), musicId: score.musicId, difficulty: score.difficulty, music: songIndex.get(score.musicId)});
    return [...result.values()].sort((a, b) => Number(baseScores.has(b.key)) - Number(baseScores.has(a.key)) || (baseScores.get(b.key)?.techScore ?? 0) - (baseScores.get(a.key)?.techScore ?? 0) || (baseScores.get(b.key)?.platinumScore ?? 0) - (baseScores.get(a.key)?.platinumScore ?? 0) || a.musicId - b.musicId || a.difficulty - b.difficulty);
  }, [state, songIndex, snapshot.save.scores, baseScores]);
  const chartIndex = useMemo(() => new Map(rows.map(row => [row.key, row])), [rows]);
  const filtered = useMemo(() => rows.filter(row => {
    if (row.difficulty !== difficulty) return false;
    return `${row.music?.title ?? row.musicId} ${row.music?.artist ?? ""} ${constantLabel(row)} ${difficultyNames[row.difficulty] ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
  }), [rows, query, difficulty]);
  const commonResources = useMemo(() => (state?.resources ?? []).filter(row => !/^item:(?:4|9):/.test(row.key)), [state]);
  const availableResourceTypes = useMemo(() => {
    const available = new Set(commonResources.map(row => resourceType(row.key)));
    return resourceTypes.filter(type => available.has(type.key));
  }, [commonResources]);
  const selectedResourceTypes = availableResourceTypes.filter(type => !excludedResourceTypes.has(type.key)).length;
  const allResourceTypesSelected = selectedResourceTypes === availableResourceTypes.length;
  const resources = useMemo(() => commonResources.filter(row => !excludedResourceTypes.has(resourceType(row.key))), [commonResources, excludedResourceTypes]);
  const resourceFilterKey = [...excludedResourceTypes].sort().join(",");
  const chartWindow = useVirtualList(filtered.length, 68, 4, `${difficulty}\u001f${query}`), resourceWindow = useVirtualList(resources.length, 60, 3, resourceFilterKey);
  const active = filtered.find(row => row.key === selected) ?? filtered[0], activeDraft = active ? scoreDraft[active.key] ?? draftOf(baseScores.get(active.key)) : undefined;
  const maximum = (row: ChartRow, field: NumberField): number | null => field === "techScore" ? state?.techScoreMax ?? null : field === "platinumScore" ? row.constraint?.platinumMax ?? null : field === "battleScore" ? row.constraint?.battleMax ?? null : field === "battleScoreRank" ? 11 : field === "clearStatus" ? 1 : 2147483647;
  const preview = useMemo(() => {
    const patch: PlayerSaveEditorPatch = { resources: [], scores: [] }; let invalid = false;
    for (const resource of commonResources) {
      if (!(resource.key in resourceDraft)) continue;
      const value = numberValue(resourceDraft[resource.key], resource.max);
      if (value === undefined) { invalid = true; continue; }
      if (value !== resourceBase[resource.key]) patch.resources.push({ key: resource.key, value });
    }
    for (const [key, draft] of Object.entries(scoreDraft)) {
      const row = chartIndex.get(key); if (!row) { invalid = true; continue; }
      const baseline = draftOf(baseScores.get(key)), edited: EditorScorePatch = {musicId: row.musicId, difficulty: row.difficulty, techScore: 0, platinumScore: 0, battleScore: 0, fullCombo: draft.fullCombo, fullBell: draft.fullBell, allBreak: draft.allBreak};
      for (const [field] of numberFields) {
        const value = numberValue(draft[field], maximum(row, field));
        if (value === undefined || field === "playCount" && value < 1) invalid = true; else if (["techScore", "platinumScore", "battleScore"].includes(field) || Number(draft[field]) !== Number(baseline[field])) edited[field] = value;
      }
      if (numberFields.some(([field]) => Number(draft[field]) !== Number(baseline[field])) || flags.some(([field]) => draft[field] !== baseline[field])) {
        edited.fields = [...numberFields.filter(([field]) => Number(draft[field]) !== Number(baseline[field])).map(([field]) => field), ...flags.filter(([field]) => draft[field] !== baseline[field]).map(([field]) => field)];
        patch.scores.push(edited);
      }
    }
    return {patch, invalid};
  }, [state, commonResources, resourceDraft, resourceBase, scoreDraft, baseScores, chartIndex]);
  const dirty = preview.patch.resources.length + preview.patch.scores.length > 0 || preview.invalid;
  const pending = queued && queued.status !== "complete";
  const scoresLocalOnly = tab === "scores" && policy?.scoreUpload !== "direct";
  const selectedPatch = scoresLocalOnly ? { resources: [], scores: preview.patch.scores } : policy?.scoreUpload === "direct" ? preview.patch : { resources: preview.patch.resources, scores: [] };
  const selectedDirty = selectedPatch.resources.length + selectedPatch.scores.length > 0;
  const beginEdit = () => { setError(""); setActionMessage(""); setLocalGuide(false); };
  const setScore = (row: ChartRow, updates: Partial<ScoreDraft>) => {
    beginEdit(); setScoreDraft(previous => ({...previous, [row.key]: {...(previous[row.key] ?? draftOf(baseScores.get(row.key))), ...updates}}));
  };
  const commit = async (archiveOnly = false) => {
    const local = archiveOnly || scoresLocalOnly, patch = archiveOnly ? preview.patch : selectedPatch;
    if (busyRef.current || !state || preview.invalid || !valid() || !patch.resources.length && !patch.scores.length || !local && (pending || !policy || !state.gameEditEnabled)) return;
    busyRef.current = true; const owner = ++request.current; setError(""); setBusy("saving"); setMoreActions(false); callbacks.current.onBusyChange(true);
    try {
      if (!local) {
        const result = await window.ogk.queuePlayerSaveEdit(snapshot.root, (saved ?? snapshot.save).id, snapshot.playerId, patch);
        if (owner !== request.current || !valid()) return;
        setQueued(result); setActionMessage(policy?.scoreUpload === "frontend" && preview.patch.scores.length ? "资源改动已保存，下次游戏自动应用；谱面成绩请另行保存存档。" : "改动已保存，下次进行游戏时自动修改。"); setLocalGuide(false);
      } else {
        const result = await window.ogk.savePlayerSaveEditor(snapshot.root, (saved ?? snapshot.save).id, snapshot.playerId, patch);
        if (owner !== request.current || !valid()) return;
        setSaved(result); setLocalGuide(true); setActionMessage(scoresLocalOnly && !archiveOnly && preview.patch.resources.length ? "成绩存档已保存，请到 NET 上传；资源改动仍未保存。" : "存档已保存，请导出后按 NET 支持的方式上传。");
        setResourceBase(previous => ({...previous, ...Object.fromEntries(patch.resources.map(row => [row.key, row.value]))}));
        setResourceDraft(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !patch.resources.some(row => row.key === key))));
        setScoreDraft(previous => Object.fromEntries(Object.entries(previous).filter(([key]) => !patch.scores.some(row => keyOf(row.musicId, row.difficulty) === key))));
        await callbacks.current.onSaved(result);
      }
    } catch (reason) { if (owner === request.current && valid()) setError(libraryFailureMessage(reason)); }
    finally { busyRef.current = false; if (alive.current && owner === request.current) { setBusy(""); callbacks.current.onBusyChange(false); } }
  };
  const cancelPending = async () => {
    if (!queued || busyRef.current || !valid()) return;
    if (queued.status === "active" && !discardPrompt) { setDiscardPrompt(true); return; }
    busyRef.current = true; const owner = ++request.current; setBusy("saving"); setError(""); callbacks.current.onBusyChange(true);
    try {
      await window.ogk.cancelPlayerSaveEdit(snapshot.root, snapshot.save.id, snapshot.playerId, queued.id, queued.status === "active");
      if (owner !== request.current || !valid()) return;
      setQueued(undefined); setDiscardPrompt(false); setActionMessage(queued.status === "pending" ? "已取消待应用改动。" : "待办已清除；游戏中已应用的内容不会撤销。");
    } catch (reason) { if (owner === request.current && valid()) setError(libraryFailureMessage(reason)); }
    finally { busyRef.current = false; if (alive.current && owner === request.current) { setBusy(""); callbacks.current.onBusyChange(false); } }
  };
  const frontendAction = async (action: "exporting" | "portal") => {
    if (busyRef.current || !saved || !valid() || action === "portal" && !policy?.frontendService) return;
    busyRef.current = true; const owner = ++request.current; setBusy(action); setError(""); callbacks.current.onBusyChange(true);
    try {
      if (action === "exporting") {
        const exported = await window.ogk.exportPlayerSave(snapshot.root, saved.id);
        if (owner === request.current && valid()) setActionMessage(exported ? "备份已导出" : "已取消导出");
      } else await window.ogk.openHddPortal(policy!.frontendService!);
    } catch (reason) { if (owner === request.current && valid()) setError(libraryFailureMessage(reason)); }
    finally { busyRef.current = false; if (alive.current && owner === request.current) { setBusy(""); callbacks.current.onBusyChange(false); } }
  };
  const locked = loading || !!busy || !callbacks.current.isCurrent();
  const tabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? "resources" : event.key === "End" ? "scores" : tab === "resources" ? "scores" : "resources";
    setTab(next); dialog.current?.querySelector<HTMLButtonElement>(`[data-editor-tab='${next}']`)?.focus();
  };
  const chooseDifficulty = (next: number) => {
    setDifficulty(next);
    if (active) setSelected(keyOf(active.musicId, next));
  };
  const difficultyKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? difficultyNames.length - 1 : (difficulty + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + difficultyNames.length) % difficultyNames.length;
    chooseDifficulty(next); dialog.current?.querySelector<HTMLButtonElement>(`[data-editor-difficulty='${next}']`)?.focus();
  };
  return createPortal(<div className="image-viewer-backdrop player-save-editor-backdrop" role="presentation" onMouseDown={event => {if (event.target === event.currentTarget && !busyRef.current) onClose();}}>
    <section ref={dialog} data-save-editor className="surface player-save-editor" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header className="player-save-editor-heading"><div><h2 id={titleId}>编辑存档</h2><p>{snapshot.save.playerName}<span> · {snapshot.serverLabel ?? "本地玩家"} · {shortSaveDate(snapshot.save.updatedAt)}</span></p></div><button ref={closeButton} data-save-editor-close type="button" disabled={!!busy} onClick={onClose}>关闭</button></header>
      <div className="segmented player-record-tabs player-save-editor-tabs" role="tablist" aria-label="存档内容">
        {(["resources", "scores"] as const).map(value => <button key={value} data-editor-tab={value} type="button" role="tab" aria-selected={tab === value} aria-controls={value === "resources" ? resourcesId : scoresId} tabIndex={tab === value ? 0 : -1} className={tab === value ? "selected-row" : ""} onKeyDown={tabKey} onClick={() => setTab(value)}>{value === "resources" ? "游戏资源" : "谱面成绩"}</button>)}
      </div>
      <div className="player-save-editor-body" aria-busy={loading}>
        {loading && <div className="empty" role="status"><b>正在读取可编辑内容…</b></div>}
        {!loading && !state && <div className="empty"><b>内容读取失败</b><button type="button" data-save-editor-retry onClick={() => setAttempt(value => value + 1)}>重新读取</button></div>}
        <div id={resourcesId} className="player-editor-resource-panel" role="tabpanel" aria-label="游戏资源" hidden={tab !== "resources" || !state || loading}>
          <div className="player-editor-resource-types" role="group" aria-label="显示的资源类型">
            <button type="button" data-editor-resource-type="all" role="checkbox" aria-checked={allResourceTypesSelected ? true : selectedResourceTypes === 0 ? false : "mixed"} disabled={locked || !availableResourceTypes.length} className={`filter-check${selectedResourceTypes ? " selected-option selected-row" : ""}`} onClick={() => setExcludedResourceTypes(allResourceTypesSelected ? new Set(availableResourceTypes.map(type => type.key)) : new Set())}><span className="filter-box" aria-hidden="true">{allResourceTypesSelected ? "✓" : selectedResourceTypes ? "−" : ""}</span>全选</button>
            {availableResourceTypes.map(type => {
              const checked = !excludedResourceTypes.has(type.key);
              return <button key={type.key} type="button" data-editor-resource-type={type.key} role="checkbox" aria-checked={checked} disabled={locked} className={`filter-check${checked ? " selected-option selected-row" : ""}`} onClick={() => setExcludedResourceTypes(previous => { const next = new Set(previous); if (next.has(type.key)) next.delete(type.key); else next.add(type.key); return next; })}><span className="filter-box" aria-hidden="true">{checked ? "✓" : ""}</span>{type.name}</button>;
            })}
          </div>
          <div className="player-editor-resource-list" ref={resourceWindow.ref}>
            <div style={{height:resourceWindow.paddingTop}} aria-hidden="true"/>
            {resources.slice(resourceWindow.startIndex, resourceWindow.endIndex).map(row => {
              const value = resourceDraft[row.key] ?? (resourceBase[row.key] === null ? "" : String(resourceBase[row.key] ?? row.value ?? "")), invalid = row.key in resourceDraft && numberValue(value, row.max) === undefined;
              const icon = playerResourceIconUrl(row.key);
              return <div key={row.key} className="player-editor-resource-row"><div className="player-editor-resource-label"><span className="player-editor-resource-icon" aria-hidden="true">{icon && <img src={icon} alt="" decoding="async"/>}</span><span className="player-editor-resource-caption"><b>{row.name}</b><small>{row.category}{!row.editable && row.reason ? ` · ${row.reason}` : ""}</small></span></div>
                {row.binary ? <button type="button" data-editor-resource={row.key} role="checkbox" aria-checked={value === "1"} disabled={locked || !row.editable || row.removable === false && resourceBase[row.key] === 1} title={row.removable === false && resourceBase[row.key] === 1 ? "已解锁" : undefined} onClick={() => {beginEdit();setResourceDraft(previous => ({...previous,[row.key]:value === "1" ? "0" : "1"}));}}>{value === "1" ? row.removable === false ? "已解锁" : "已拥有" : "未拥有"}</button> : <label><input data-editor-resource={row.key} aria-label={`${row.name} 数量`} type="number" inputMode="numeric" step="1" min="0" max={row.max} value={value} placeholder="未记录" disabled={locked || !row.editable} aria-invalid={invalid} onChange={event => {beginEdit();setResourceDraft(previous => ({...previous,[row.key]:event.target.value}));}}/><small className={invalid ? "is-error" : ""}>{invalid ? `请输入 0–${row.max.toLocaleString()} 的整数` : `${row.limitKind === "field" ? "数值上限" : "上限"} ${row.max.toLocaleString()}`}</small></label>}
              </div>;
            })}
            <div style={{height:resourceWindow.paddingBottom}} aria-hidden="true"/>
            {!resources.length && <div className="empty"><b>{selectedResourceTypes ? "没有匹配的资源" : "选择要显示的资源类型"}</b></div>}
          </div>
        </div>
        <div id={scoresId} className="player-editor-score-panel" role="tabpanel" aria-label="谱面成绩" hidden={tab !== "scores" || !state || loading}>
          <div className="segmented player-record-tabs player-editor-difficulty-tabs" role="radiogroup" aria-label="成绩难度">{difficultyNames.map((name, index) => <button key={index} type="button" role="radio" data-editor-difficulty={index} aria-checked={difficulty === index} tabIndex={difficulty === index ? 0 : -1} disabled={locked} className={difficulty === index ? "selected-row" : ""} onKeyDown={difficultyKey} onClick={() => chooseDifficulty(index)}><DifficultyBadge difficulty={index}>{name}</DifficultyBadge></button>)}</div>
          <div className="player-editor-score-content">
          <div className="player-editor-score-browser"><div className="player-editor-searchbar"><input data-editor-search aria-label="搜索曲名、作者或定数" value={query} onChange={event => setQuery(event.target.value)} placeholder="曲名 / 作者 / 定数"/><span>{filtered.length}</span></div><div ref={chartWindow.ref} className="player-editor-chart-list" aria-label="可编辑谱面">
            <div style={{height:chartWindow.paddingTop}} aria-hidden="true"/>
            {filtered.slice(chartWindow.startIndex, chartWindow.endIndex).map(row => <button key={row.key} data-editor-chart={row.key} type="button" aria-pressed={active?.key === row.key} className={`player-editor-chart${active?.key === row.key ? " selected-row" : ""}`} onClick={() => setSelected(row.key)}><span><b>{row.music?.title ?? `乐曲 ${row.musicId}`}</b><small>{baseScores.has(row.key) ? `技术分 ${baseScores.get(row.key)!.techScore.toLocaleString()}` : "尚无成绩"} · {row.music?.artist ?? "作者未记录"}</small></span><DifficultyBadge difficulty={row.difficulty}>{difficultyNames[row.difficulty]} {constantLabel(row)}</DifficultyBadge></button>)}
            <div style={{height:chartWindow.paddingBottom}} aria-hidden="true"/>
            {!filtered.length && <div className="empty"><b>没有匹配的谱面</b></div>}
          </div></div>
          <div className="player-editor-score-fields">
            {active && activeDraft ? <><div className="player-editor-song-heading"><BundleThumbnail className="player-editor-cover" bundlePath={active.music?.jacket?.bundlePath} alt="" fallback="♫" cache={{gameRoot:snapshot.root,kind:"music"}}/><div><h3>{active.music?.title ?? `乐曲 ${active.musicId}`}</h3><DifficultyBadge difficulty={active.difficulty}>{difficultyNames[active.difficulty]} {constantLabel(active)}</DifficultyBadge></div></div>
              {!active.constraint?.editable && <p className="player-editor-unavailable">{active.constraint?.reason ?? "未找到本地谱面，无法编辑此成绩。"}</p>}
              <div className="player-editor-score-numbers">{numberFields.map(([field,label]) => {
                const cap = maximum(active,field), unavailable = cap === null, invalid = numberValue(activeDraft[field],cap) === undefined || field === "playCount" && Number(activeDraft[field]) < 1;
                return <label key={field}><span>{label}</span><input data-editor-score={field} aria-label={label} type="number" inputMode="numeric" min={field === "playCount" ? 1 : 0} max={cap ?? undefined} step="1" value={activeDraft[field]} aria-invalid={invalid} disabled={locked || !active.constraint?.editable || unavailable} onChange={event => setScore(active,{[field]:event.target.value})}/><small className={invalid ? "is-error" : ""}>{unavailable ? "未取得谱面上限" : invalid ? `请输入 ${field === "playCount" ? 1 : 0}–${cap.toLocaleString()} 的整数` : `${["techScore", "platinumScore"].includes(field) ? "上限" : "数值上限"} ${cap.toLocaleString()}`}{field === "platinumScore" && <span data-editor-platinum-stars>白金星：{active.constraint?.platinumMax ? (() => { const stars = playerBestPlatinumRank(Number(activeDraft.platinumScore), active.constraint.platinumMax!); return `★${Math.min(5, stars)}${stars === 6 ? " EX" : ""}`; })() : "未取得谱面上限"}</span>}</small></label>;
              })}</div>

              <div className="player-editor-score-flags">{flags.map(([field,label]) => <button key={field} data-editor-flag={field} type="button" role="checkbox" aria-checked={activeDraft[field]} disabled={locked || !active.constraint?.editable} className={`filter-check${activeDraft[field] ? " selected-option" : ""}`} onClick={() => setScore(active,{[field]:!activeDraft[field],...(field === "allBreak" && !activeDraft.allBreak ? {fullCombo:true} : {})})}><span className="filter-box" aria-hidden="true">{activeDraft[field] ? "✓" : ""}</span>{label}</button>)}</div>
            </> : <div className="empty"><b>选择一张谱面</b></div>}
          </div>
          </div>
        </div>
      </div>
      {(error || policyError) && <SaveFeedback error>{error || policyError}</SaveFeedback>}
      {queued?.issue && <SaveFeedback error>{queued.issue === "incompatible" ? "游戏资料与这份改动不匹配，尚未应用；请取消待应用改动，重新读取后编辑。" : "游戏未能完整应用改动；请退出游戏、核对最新存档后清除待办。"}</SaveFeedback>}
      {discardPrompt && <SaveFeedback>请先退出游戏并读取最新存档。清除待办只解除任务记录，不会撤销游戏内已应用的改动，也不会自动重试。</SaveFeedback>}
      <footer className="player-save-editor-footer"><span role="status">{busy === "saving" ? "正在保存…" : preview.invalid ? "请检查超出范围或未填写的数值" : actionMessage || (!scoresLocalOnly && state && !state.gameEditEnabled ? "请先在自动读取中启用 Mod，再保存改动。" : queued?.status === "pending" ? "改动已保存，下次进行游戏时自动修改。" : queued?.status === "active" ? "游戏已领取改动，等待正常保存；若游戏中断，请核对最新存档后清除待办。" : queued?.status === "complete" ? "上次改动已完成。" : scoresLocalOnly ? "此服务器的成绩仅保存存档，请到 NET 手动上传。" : "下次进行游戏时自动修改，随游戏正常结算保存。")}</span><div className="player-save-actions">
        {policyError && <button data-save-editor-policy-retry type="button" disabled={locked} onClick={() => setPolicyAttempt(value => value + 1)}>重新确认</button>}
        {pending && <button data-save-editor-cancel-pending type="button" disabled={locked} onClick={() => void cancelPending()}>{queued.status === "pending" ? "取消待应用" : discardPrompt ? "确认清除待办" : "清除待办"}</button>}
        {localGuide && saved && <><button data-save-editor-export type="button" disabled={locked} onClick={() => void frontendAction("exporting")}>{busy === "exporting" ? "导出中…" : "导出存档"}</button>{policy?.frontendService && <button data-save-editor-net type="button" disabled={locked} onClick={() => void frontendAction("portal")}>打开 NET 前端</button>}</>}
        <div data-placement={moreButton.current?.dataset.menuPlacement} className={`player-editor-save-split${!scoresLocalOnly ? " has-more" : ""}${moreActions ? " is-open" : ""}`}>
          <button data-save-editor-commit type="button" className="primary" disabled={locked || policyLoading || preview.invalid || !selectedDirty || !scoresLocalOnly && (!!pending || !policy || !state?.gameEditEnabled || !snapshot.cardId || !snapshot.serverId)} onClick={() => void commit()}>{busy === "saving" ? "保存中…" : scoresLocalOnly ? "保存存档" : "保存改动"}</button>
          {!scoresLocalOnly && <button ref={moreButton} data-save-editor-more type="button" className="primary player-editor-more" aria-label="更多保存操作" aria-haspopup="menu" aria-expanded={moreActions} aria-controls={`${titleId}-actions`} disabled={locked} onClick={() => setMoreActions(value => !value)}><PencilChevronDownIcon /></button>}
          {moreActions && <div id={`${titleId}-actions`} className="filter-popover player-popover player-editor-save-menu" role="menu" aria-label="更多保存操作" data-placement={moreButton.current?.dataset.menuPlacement} style={saveMenuPosition} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setMoreActions(false); moreButton.current?.focus(); } }}><button data-save-editor-local role="menuitem" type="button" disabled={locked || preview.invalid || !dirty} onClick={() => void commit(true)}>仅保存存档</button></div>}
        </div>
      </div></footer>
    </section>
  </div>, document.querySelector(".app") ?? document.body);
}
