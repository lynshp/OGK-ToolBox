import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PlayerProfiles, PlayerSave, PlayerSaveState, PlayerScore } from "./player-save-models";
import type { PlayerProfile } from "./machine-profile-models";
import { belongsToPlayer, hasCompletedCaptureUpdate, latestSave, rememberCompletedCaptures, type CaptureSelectionBaseline } from "./player-save-selection";

export const difficultyNames = ["BASIC", "ADVANCED", "EXPERT", "MASTER", "LUNATIC"];
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
  playerId: string;
  selectPlayer: (id: string, saveId?: string) => Promise<boolean>;
  selectImportedSave: (save: PlayerSave) => Promise<boolean>;
  refreshPlayerProfiles: () => Promise<boolean>;
  selectingPlayer: boolean;
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
function profileScope(profiles: PlayerProfiles, selected: string) {
  if (profiles.players !== undefined) {
    const player = profiles.players.find(player => player.id === profiles.selectedPlayerId);
    const machine = profiles.machines?.find(machine => machine.id === player?.machineId);
    return { serverId: machine?.server?.id ?? "", cardId: player?.cardId ?? "" };
  }
  return { serverId: profiles.server?.id ?? "", cardId: currentCard(profiles, selected) };
}
function playerSaveGroup(serverId: string, cardId: string, player?: PlayerProfile) {
  return player && (!cardId || !serverId) ? `player:${player.id}` : `${serverId}:${cardId}`;
}

// The provider is keyed by game root, but remains mounted across page navigation.
// Scores come from one selected snapshot; an explicit best merge creates its own snapshot.
export function PlayerSaveProvider({ root, active, savePageActive, children }: { root: string; active: boolean; savePageActive: boolean; children: ReactNode }) {
  const [state, setState] = useState<PlayerSaveState | null>(null);
  const latestState = useRef<PlayerSaveState | null>(null);
  const completedCaptures = useRef<CaptureSelectionBaseline>(new Map());
  const storageKey = `ogk-player-selection:${root.toLowerCase()}`;
  const [selection, setSelection] = useState<{ card: string; saves: Record<string, string> }>(() => {
    try { const value = JSON.parse(localStorage.getItem(storageKey) ?? "null"); if (typeof value?.card === "string" && value.saves && typeof value.saves === "object") return value; } catch {}
    return { card: "", saves: {} };
  });
  const [unknownSource, setUnknownSource] = useState(false);
  const [unassignedServer, setUnassignedServer] = useState<string | null>(null);
  const [playerOverride, setPlayerOverride] = useState<string | null>(null);
  const [legacyCardOverride, setLegacyCardOverride] = useState<string | null>(null);
  const [selectingPlayer, setSelectingPlayer] = useState(false);
  const playerRequest = useRef(0);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(selection)); } catch {} }, [selection, storageKey]);
  const [loadError, setLoadError] = useState("");
  const mounted = useRef(true), request = useRef(0);
  const selectionVersion = useRef(0), lastServer = useRef<string | undefined>(undefined);
  const entryLatestSelection = useRef<number | null>(null);
  const displayedScope = useRef({ playerId: "", serverId: "", cardId: "", unassigned: false });
  const displayedSave = useRef<PlayerSave | undefined>(undefined);
  const savePage = useRef(savePageActive); savePage.current = savePageActive;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current++; }; }, []);
  const reload = useCallback(async () => {
    if (!root) return;
    const version = ++request.current, selectionAtStart = selectionVersion.current, scopeAtStart = displayedScope.current;
    try {
      const next = await window.ogk.playerSaves(root);
      if (mounted.current && version === request.current) {
        const { serverId, cardId } = profileScope(next.profiles, "");
        const player = next.profiles.players?.find(player => player.id === next.profiles.selectedPlayerId);
        const current = displayedScope.current;
        const completedCapture = !current.unassigned && !scopeAtStart.unassigned
          && current.playerId === scopeAtStart.playerId && current.serverId === scopeAtStart.serverId && current.cardId === scopeAtStart.cardId
          && current.playerId === (player?.id ?? "") && current.serverId === serverId && current.cardId === cardId
          && hasCompletedCaptureUpdate(latestState.current?.saves ?? null, next.saves, serverId, cardId, player, completedCaptures.current);
        const serverChanged = lastServer.current !== undefined && lastServer.current !== serverId;
        lastServer.current = serverId;
        completedCaptures.current = rememberCompletedCaptures(completedCaptures.current, next.saves);
        latestState.current = next; setState(next); setLoadError("");
        const replaceLocalEdit = !!displayedSave.current?.edit && completedCapture;
        if ((savePage.current || replaceLocalEdit) && selectionAtStart === selectionVersion.current && (entryLatestSelection.current === selectionAtStart || serverChanged || completedCapture)) {
          entryLatestSelection.current = null;
          setLegacyCardOverride(null); setUnassignedServer(null); setUnknownSource(false);
          setSelection(value => {
            const { cardId } = profileScope(next.profiles, value.card), player = next.profiles.players?.find(player => player.id === next.profiles.selectedPlayerId);
            const latest = latestSave(next.saves, serverId, cardId, player);
            return { card: cardId, saves: { ...value.saves, [playerSaveGroup(serverId, cardId, player)]: latest?.id ?? "" } };
          });
        }
      }
    } catch (error) {
      if (mounted.current && version === request.current) setLoadError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }, [root]);
  useEffect(() => {
    entryLatestSelection.current = active && savePageActive && root ? selectionVersion.current : null;
    if (!active || !root) return;
    let pending = false, stopped = false;
    const refresh = async () => {
      if (pending || stopped) return;
      pending = true;
      try { await reload(); } catch { /* The context exposes read errors without discarding the last snapshot. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 5000);
    return () => { stopped = true; clearInterval(timer); entryLatestSelection.current = null; };
  }, [active, savePageActive, root, reload]);
  const selectedPlayer = state?.profiles.players?.find(player => player.id === (playerOverride ?? state.profiles.selectedPlayerId));
  const selectedMachine = state?.profiles.machines?.find(machine => machine.id === selectedPlayer?.machineId);
  const profiles = state?.profiles, noSelectedProfile = profiles?.players !== undefined && !selectedPlayer;
  const serverId = noSelectedProfile ? "" : selectedPlayer ? selectedMachine?.server?.id ?? "" : profiles?.server?.id ?? "";
  const cardId = noSelectedProfile ? "" : legacyCardOverride ?? selectedPlayer?.cardId ?? (profiles ? currentCard(profiles, selection.card) : "");
  const playerId = legacyCardOverride && legacyCardOverride !== selectedPlayer?.cardId ? "" : selectedPlayer?.id ?? "";
  const effectiveState = useMemo(() => state && ({ ...state, profiles: { ...state.profiles,
    ...(selectedPlayer ? { server: selectedMachine?.server, selectedPlayerId: selectedPlayer.id } : noSelectedProfile ? { server: undefined, selectedPlayerId: "" } : {}) } }), [state, selectedPlayer, selectedMachine, noSelectedProfile]);
  const unassigned = unassignedServer === serverId;
  displayedScope.current = { playerId, serverId, cardId, unassigned };
  const group = unassigned ? `${unknownSource ? "unknown" : "unassigned"}:${serverId}` : playerSaveGroup(serverId, cardId, selectedPlayer);
  const saves = useMemo(() => (state?.saves ?? []).filter(item => unassigned
    ? !item.scope && !state?.profiles.players?.some(player => item.localPlayerId === player.id || player.importedSaveIds?.includes(item.id)) && (unknownSource ? !item.serverId : !!serverId && item.serverId === serverId)
    : belongsToPlayer(item, serverId, cardId, selectedPlayer)), [state, unassigned, unknownSource, serverId, cardId, selectedPlayer]);
  const save = saves.find(item => item.id === selection.saves[group]);
  displayedSave.current = save;
  const selectPlayer = async (id: string, saveId?: string) => {
    entryLatestSelection.current = null;
    const version = ++playerRequest.current;
    const selectionAtStart = ++selectionVersion.current; request.current++;
    window.ogk.cancelPlayerRefresh();
    setSelectingPlayer(true); setLoadError("");
    try {
      let snapshot = latestState.current;
      let player = snapshot?.profiles.players?.find(player => player.id === id);
      // A poll can supersede an editor's reload before that read installs its
      // snapshot. Look up a newly saved ID directly, with selection ownership.
      if (!player) {
        snapshot = await window.ogk.playerSaves(root);
        if (!mounted.current || version !== playerRequest.current) return false;
        player = snapshot.profiles.players?.find(player => player.id === id);
        if (!player) throw new Error("玩家已变化，请刷新后重试。");
        completedCaptures.current = rememberCompletedCaptures(completedCaptures.current, snapshot.saves);
        request.current++; latestState.current = snapshot; setState(snapshot);
      }
      const machine = snapshot?.profiles.machines?.find(machine => machine.id === player.machineId);
      setPlayerOverride(id); setLegacyCardOverride(null); setUnassignedServer(null); setUnknownSource(false);
      const nextServer = machine?.server?.id ?? "", latest = latestSave(snapshot?.saves ?? [], nextServer, player.cardId, player);
      const desired = (snapshot?.saves ?? []).find(save => save.id === saveId && belongsToPlayer(save, nextServer, player!.cardId, player));
      setSelection(value => ({ card: player!.cardId, saves: { ...value.saves, [playerSaveGroup(nextServer, player!.cardId, player)]: desired?.id ?? latest?.id ?? "" } }));
      await window.ogk.selectPlayerProfile(root, id);
      if (!mounted.current || version !== playerRequest.current) return false;
      // Finish this explicit selection with its own read. A periodic reload may
      // supersede ordinary reload(), including edits to an existing player's card.
      const next = await window.ogk.playerSaves(root);
      if (!mounted.current || version !== playerRequest.current) return false;
      completedCaptures.current = rememberCompletedCaptures(completedCaptures.current, next.saves);
      request.current++; latestState.current = next; setState(next); setLoadError("");
      const { serverId: nextServerId, cardId: nextCardId } = profileScope(next.profiles, "");
      lastServer.current = nextServerId;
      if (selectionVersion.current === selectionAtStart) {
        const nextPlayer = next.profiles.players?.find(player => player.id === next.profiles.selectedPlayerId);
        const latest = latestSave(next.saves, nextServerId, nextCardId, nextPlayer);
        const desired = next.saves.find(save => save.id === saveId && belongsToPlayer(save, nextServerId, nextCardId, nextPlayer));
        setSelection(value => ({ card: nextCardId, saves: { ...value.saves, [playerSaveGroup(nextServerId, nextCardId, nextPlayer)]: desired?.id ?? latest?.id ?? "" } }));
      }
      setPlayerOverride(null);
      return true;
    } catch (error) {
      if (mounted.current && version === playerRequest.current) { setPlayerOverride(null); setLoadError(error instanceof Error ? error.message : String(error)); }
      throw error;
    } finally { if (mounted.current && version === playerRequest.current) setSelectingPlayer(false); }
  };
  const refreshPlayerProfiles = async () => {
    entryLatestSelection.current = null;
    const version = ++playerRequest.current;
    selectionVersion.current++; request.current++;
    window.ogk.cancelPlayerRefresh(); setSelectingPlayer(true); setLoadError("");
    try {
      const next = await window.ogk.playerSaves(root);
      if (!mounted.current || version !== playerRequest.current) return false;
      const fallback = next.profiles.players?.find(player => player.id === next.profiles.selectedPlayerId);
      if (fallback && fallback.id !== selectedPlayer?.id) return await selectPlayer(fallback.id);
      completedCaptures.current = rememberCompletedCaptures(completedCaptures.current, next.saves);
      request.current++; latestState.current = next; setState(next); setLoadError("");
      setPlayerOverride(null); setLegacyCardOverride(null);
      if (!fallback) {
        lastServer.current = ""; setUnassignedServer(null); setUnknownSource(false);
        setSelection(value => ({ ...value, card: "" }));
      }
      return true;
    } catch (error) {
      if (mounted.current && version === playerRequest.current) setLoadError(error instanceof Error ? error.message : String(error));
      throw error;
    } finally { if (mounted.current && version === playerRequest.current) setSelectingPlayer(false); }
  };
  const selectCard = (id: string) => {
    entryLatestSelection.current = null;
    const player = profiles?.players?.find(player => player.cardId === id && profiles.machines?.find(machine => machine.id === player.machineId)?.server?.id === serverId);
    if (player) { void selectPlayer(player.id).catch(() => {}); return; }
    selectionVersion.current++;
    request.current++; window.ogk.cancelPlayerRefresh(); setLegacyCardOverride(id);
    const latest = latestSave(state?.saves ?? [], serverId, id);
    setSelection(value => ({ card: id, saves: { ...value.saves, [`${serverId}:${id}`]: latest?.id ?? "" } }));
    setUnassignedServer(null); setUnknownSource(false);
  };
  const showUnassigned = (value: boolean) => { entryLatestSelection.current = null; selectionVersion.current++; setUnassignedServer(value ? serverId : null); setUnknownSource(false); };
  const showUnknown = () => { entryLatestSelection.current = null; selectionVersion.current++; setUnassignedServer(serverId); setUnknownSource(true); };
  const selectSave = (id: string, scope?: PlayerSave["scope"] | null, importedServer?: string | null) => {
    entryLatestSelection.current = null;
    selectionVersion.current++;
    const target = scope === null ? `${importedServer === null ? "unknown" : "unassigned"}:${importedServer ?? serverId}` : scope ? `${scope.serverId}:${scope.cardId}` : group;
    setSelection(value => ({ ...value, saves: { ...value.saves, [target]: id } }));
    if (scope === null) { setUnassignedServer(importedServer ?? serverId); setUnknownSource(importedServer === null); }
  };
  const selectImportedSave = async (imported: PlayerSave) => {
    if (imported.localPlayerId) return await selectPlayer(imported.localPlayerId, imported.id);
    // Keep compatibility with older unassigned archives and import bridges.
    if (imported.scope) {
      const player = latestState.current?.profiles.players?.find(player => player.cardId === imported.scope!.cardId
        && latestState.current?.profiles.machines?.find(machine => machine.id === player.machineId)?.server?.id === imported.scope!.serverId);
      if (player) return await selectPlayer(player.id, imported.id);
      selectCard(imported.scope.cardId); selectSave(imported.id, imported.scope);
    } else selectSave(imported.id, null, imported.serverId ?? null);
    await reload();
    return mounted.current;
  };
  const scoreIndex = useMemo(() => new Map((save?.scores ?? []).map(score => [scoreKey(score.musicId, score.difficulty), score])), [save]);
  return <Context.Provider value={{ state: effectiveState, save, selectSave, cardId, selectCard, playerId, selectPlayer, selectImportedSave, refreshPlayerProfiles, selectingPlayer, unassigned, unknownSource, showUnknown, showUnassigned, saves, reload, loadError, scoreIndex }}>{children}</Context.Provider>;
}
export function usePlayerSave() {
  const value = useContext(Context);
  if (!value) throw new Error("PlayerSaveProvider is required");
  return value;
}
