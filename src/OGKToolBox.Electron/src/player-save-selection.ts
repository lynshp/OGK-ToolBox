import type { PlayerProfile } from "./machine-profile-models";
import type { PlayerSave } from "./player-save-models";

export function belongsToPlayer(save: PlayerSave, serverId: string, cardId: string, player?: PlayerProfile) {
  if (save.localPlayerId) return save.localPlayerId === player?.id;
  if (player?.importedSaveIds?.includes(save.id)) return true;
  if (player && (!cardId || !serverId)) return false;
  return !!serverId && !!cardId && save.scope?.serverId === serverId && save.scope.cardId === cardId;
}

const dateValue = (value?: string) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const captureId = /^game-[a-f0-9]{32}$/;
function confirmedCapture(save: PlayerSave) {
  const marker = save.latestCapture;
  if (!marker || typeof marker.id !== "string" || !captureId.test(marker.id)) return null;
  const at = dateValue(marker.at);
  return at === null ? null : { id: marker.id, at };
}
export function latestSave(saves: PlayerSave[], serverId: string, cardId: string, player?: PlayerProfile) {
  const owned = saves.filter(save => belongsToPlayer(save, serverId, cardId, player));
  // Local edits are exportable history, not evidence of the server's score.
  // Explicit history selection still works; automatic selection prefers reads.
  const hasRead = owned.some(save => !save.edit && (captureRevision(save) || save.source === "direct" && dateValue(save.updatedAt) !== null && !save.warnings.some(warning => incompleteCapture.test(warning))));
  return owned.filter(save => !hasRead || !save.edit)
    .sort((a, b) => Math.max(dateValue(b.updatedAt) ?? 0, confirmedCapture(b)?.at ?? 0) - Math.max(dateValue(a.updatedAt) ?? 0, confirmedCapture(a)?.at ?? 0)
      || (b.sequence ?? 0) - (a.sequence ?? 0))[0];
}

const incompleteCapture = /^(?:Data|Music|Card|Character|Item|Option)(?:（类别 [^）]+）)?：(尚未读取|分页未收齐)。$/;
function captureRevision(save: PlayerSave) {
  const confirmed = confirmedCapture(save);
  if (confirmed) return confirmed;
  // Legacy game summaries retain the six read APIs' explicit completeness
  // warnings. Imported/direct summaries need the confirmed capture marker:
  // an alias alone cannot prove a newly captured session was complete.
  if (save.latestCapture || save.source !== "game" || save.warnings.some(warning => incompleteCapture.test(warning))) return null;
  const at = dateValue(save.updatedAt);
  if (at === null) return null;
  const id = /^[a-f0-9]{32}$/.test(save.sessionId ?? "") ? `game-${save.sessionId}` : save.id;
  return { id, at };
}

type CompletedCapture = { serverId: string; cardId: string; playerId: string; revision: { id: string; at: number } };
export type CaptureSelectionBaseline = Map<string, CompletedCapture>;
const captureScope = (save: PlayerSave) => ({ serverId: save.scope?.serverId ?? "", cardId: save.scope?.cardId ?? "", playerId: save.localPlayerId ?? "" });
const sameCaptureScope = (before: CompletedCapture, save: PlayerSave) => before.serverId === (save.scope?.serverId ?? "")
  && before.cardId === (save.scope?.cardId ?? "") && before.playerId === (save.localPlayerId ?? "");

// Keep only small completion witnesses for archives still present. A partial
// rescan must not erase an already observed completion and announce it again.
export function rememberCompletedCaptures(previous: CaptureSelectionBaseline, saves: PlayerSave[]): CaptureSelectionBaseline {
  const next: CaptureSelectionBaseline = new Map();
  for (const save of saves) {
    const before = previous.get(save.id), revision = captureRevision(save);
    const retained = before && sameCaptureScope(before, save) ? before : undefined;
    if (revision && (!retained || revision.at > retained.revision.at)) next.set(save.id, { ...captureScope(save), revision });
    else if (retained) next.set(save.id, retained);
  }
  return next;
}

export function hasCompletedCaptureUpdate(previous: PlayerSave[] | null, next: PlayerSave[], serverId: string, cardId: string, player?: PlayerProfile, baseline?: CaptureSelectionBaseline) {
  if (!previous || !serverId || !cardId) return false;
  const inScope = (save: PlayerSave) => save.scope?.serverId === serverId && save.scope.cardId === cardId
    && belongsToPlayer(save, serverId, cardId, player);
  const before = new Map(previous.filter(inScope).map(save => [save.id, captureRevision(save)]));
  return next.some(save => {
    if (!inScope(save)) return false;
    const revision = captureRevision(save);
    const remembered = baseline?.get(save.id);
    const old = remembered && sameCaptureScope(remembered, save) ? remembered.revision : before.get(save.id);
    return !!revision && (!old || revision.at > old.at);
  });
}
