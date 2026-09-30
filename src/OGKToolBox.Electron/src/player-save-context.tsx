import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PlayerProfiles, PlayerSave, PlayerSaveState, PlayerScore } from "./player-save-models";

export const difficultyNames = ["BASIC", "ADVANCED", "EXPERT", "MASTER", "LUNATIC"];
export const saveSourceName = { json: "JSON 导入", game: "随游戏采集", direct: "服务器获取" };
export function shortSaveDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
export function scoreKey(musicId: unknown, difficulty: unknown) {
  if (musicId === null || musicId === undefined || musicId === "" || difficulty === null || difficulty === undefined || difficulty === "") return "";
  const id = Number(musicId), level = Number(difficulty);
  return Number.isInteger(id) && id >= 0 && Number.isInteger(level) && level >= 0 && level <= 4 ? `${id}:${level}` : "";
}

type SavesContext = {
  state: PlayerSaveState | null;
  save: PlayerSave | undefined;
  selectSave: (id: string, scope?: PlayerSave["scope"] | null, serverId?: string | null) => void;
  cardId: string;
  selectCard: (id: string) => void;
  unassigned: boolean;
  unknownSource: boolean;
  showUnknown: () => void;
  showUnassigned: (value: boolean) => void;
  saves: PlayerSave[];
  reload: () => Promise<void>;
  loadError: string;
  scoreIndex: Map<string, PlayerScore>;
};
const Context = createContext<SavesContext | null>(null);
const currentCard = (profiles: PlayerProfiles, selected: string) => profiles.cards.find(card => card.id === selected)?.id
  ?? profiles.cards.find(card => card.id === profiles.defaultCardId)?.id ?? profiles.cards[0]?.id ?? "";
function latestSave(saves: PlayerSave[], serverId: string, cardId: string) {
  return saves.filter(save => save.scope?.serverId === serverId && save.scope.cardId === cardId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || (b.sequence ?? 0) - (a.sequence ?? 0))[0];
}

// The provider is keyed by game root, but remains mounted across page navigation.
// A score always belongs to the selected snapshot, never a merge of player histories.
export function PlayerSaveProvider({ root, active, savePageActive, children }: { root: string; active: boolean; savePageActive: boolean; children: ReactNode }) {
  const [state, setState] = useState<PlayerSaveState | null>(null);
  const storageKey = `ogk-player-selection:${root.toLowerCase()}`;
  const [selection, setSelection] = useState<{ card: string; saves: Record<string, string> }>(() => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) ?? "null"); if (typeof value?.card === "string" && value.saves && typeof value.saves === "object") return value; } catch {}
    return { card: "", saves: {} };
  });
  const [unknownSource, setUnknownSource] = useState(false);
  const [unassignedServer, setUnassignedServer] = useState<string | null>(null);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(selection)); } catch {} }, [selection, storageKey]);
  const [loadError, setLoadError] = useState("");
  const mounted = useRef(true), request = useRef(0);
  const selectionVersion = useRef(0), lastServer = useRef<string | undefined>(undefined);
  const savePage = useRef(savePageActive); savePage.current = savePageActive;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const reload = useCallback(async (preferLatest = false) => {
    if (!root) return;
    const version = ++request.current, selectionAtStart = selectionVersion.current;
    try {
      const next = await window.ogk.playerSaves(root);
      if (mounted.current && version === request.current) {
        const serverId = next.profiles.server?.id ?? "";
        const serverChanged = lastServer.current !== undefined && lastServer.current !== serverId;
        lastServer.current = serverId;
        setState(next); setLoadError("");
        if (savePage.current && selectionAtStart === selectionVersion.current && (preferLatest || serverChanged)) {
          setUnassignedServer(null); setUnknownSource(false);
          setSelection(value => {
            const cardId = currentCard(next.profiles, value.card), latest = latestSave(next.saves, serverId, cardId);
            return { card: cardId, saves: { ...value.saves, [`${serverId}:${cardId}`]: latest?.id ?? "" } };
          });
        }
      }
    } catch (error) {
      if (mounted.current && version === request.current) setLoadError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [root]);
  useEffect(() => {
    if (!active || !root) return;
    let pending = false, stopped = false, selectOnRefresh = savePageActive;
    const refresh = async () => {
      if (pending || stopped) return;
      pending = true;
      try { await reload(selectOnRefresh); selectOnRefresh = false; } catch { /* The context exposes read errors without discarding the last snapshot. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, savePageActive, root, reload]);
  const profiles = state?.profiles, serverId = profiles?.server?.id ?? "";
  const cardId = profiles ? currentCard(profiles, selection.card) : "";
  const unassigned = unassignedServer === serverId;
  const group = unassigned ? `${unknownSource ? "unknown" : "unassigned"}:${serverId}` : `${serverId}:${cardId}`;
  const saves = useMemo(() => (state?.saves ?? []).filter(item => unassigned ? !item.scope && (unknownSource ? !item.serverId : !!serverId && item.serverId === serverId) : !!serverId && !!cardId && item.scope?.serverId === serverId && item.scope.cardId === cardId), [state, unassigned, unknownSource, serverId, cardId]);
  const save = saves.find(item => item.id === selection.saves[group]);
  const selectCard = (id: string) => {
    selectionVersion.current++;
    const latest = latestSave(state?.saves ?? [], serverId, id);
    setSelection(value => ({ card: id, saves: { ...value.saves, [`${serverId}:${id}`]: latest?.id ?? "" } }));
    setUnassignedServer(null); setUnknownSource(false);
  };
  const showUnassigned = (value: boolean) => { selectionVersion.current++; setUnassignedServer(value ? serverId : null); setUnknownSource(false); };
  const showUnknown = () => { selectionVersion.current++; setUnassignedServer(serverId); setUnknownSource(true); };
  const selectSave = (id: string, scope?: PlayerSave["scope"] | null, importedServer?: string | null) => {
    selectionVersion.current++;
    const target = scope === null ? `${importedServer === null ? "unknown" : "unassigned"}:${importedServer ?? serverId}` : scope ? `${scope.serverId}:${scope.cardId}` : group;
    setSelection(value => ({ ...value, saves: { ...value.saves, [target]: id } }));
    if (scope === null) { setUnassignedServer(importedServer ?? serverId); setUnknownSource(importedServer === null); }
  };
  const scoreIndex = useMemo(() => new Map((save?.scores ?? []).map(score => [scoreKey(score.musicId, score.difficulty), score])), [save]);
  return <Context.Provider value={{ state, save, selectSave, cardId, selectCard, unassigned, unknownSource, showUnknown, showUnassigned, saves, reload, loadError, scoreIndex }}>{children}</Context.Provider>;
}
export function usePlayerSave() {
  const value = useContext(Context);
  if (!value) throw new Error("PlayerSaveProvider is required");
  return value;
}
