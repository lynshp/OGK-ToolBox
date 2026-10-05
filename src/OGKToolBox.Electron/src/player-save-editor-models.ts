export type EditorResource = {
  key: string; name: string; category: string; value: number | null; max: number;
  binary?: boolean; editable: boolean; reason?: string;
  limitKind?: "game" | "field"; removable?: boolean;
};
export type EditorChartConstraint = {
  musicId: number; difficulty: number; platinumMax: number | null; battleMax: number | null;
  editable: boolean; reason?: string;
};
export type EditorScorePatch = {
  musicId: number; difficulty: number; techScore: number; platinumScore: number; battleScore: number;
  fullCombo: boolean; fullBell: boolean; allBreak: boolean;
  playCount?: number; maxComboCount?: number; maxOverKill?: number; maxTeamOverKill?: number; battleScoreRank?: number; clearStatus?: number;
  fields?: string[];
};
export type PlayerSaveEditorPatch = { resources: { key: string; value: number }[]; scores: EditorScorePatch[] };
export type PendingPlayerEdit = PlayerSaveEditorPatch & { id: string; status: "pending" | "active" | "complete"; issue?: "incompatible" | "interrupted" };
export type PlayerSaveEditorState = {
  saveId: string; playerId: string; techScoreMax: number; resources: EditorResource[]; scoreConstraints: EditorChartConstraint[];
  pendingEdit?: PendingPlayerEdit;
  gameEditEnabled?: boolean;
  scores?: import("./player-save-models").PlayerScore[];
};
export type PlayerSaveEditMetadata = PlayerSaveEditorPatch & {
  version: 1; parentId: string; playerId: string; createdAt: string;
};
