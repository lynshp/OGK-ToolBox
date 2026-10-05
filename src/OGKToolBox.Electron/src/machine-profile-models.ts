export type MachineValues = {
  dns: Record<string, string>;
  netenv: Record<string, string>;
  keychip: Record<string, string>;
};
export type MachineProfile = {
  id: string;
  name: string;
  values: MachineValues;
  server?: { id: string; label: string };
  keychipHint: string;
  importSourceKey?: string;
};
export type PlayerProfile = { id: string; name: string; machineId: string; cardId: string; importedSaveIds?: string[]; importSourceKeys?: string[] };
export type MachineProfilesState = {
  machines: MachineProfile[];
  activeMachineId: string;
  cards: import("./player-save-models").PlayerCard[];
  virtualCard: { path: string; cardId: string; accessCode: string };
  configurationError: string;
};
export type SaveMachineProfileRequest = { id?: string; name: string; values: MachineValues };
export type SavePlayerProfileRequest = { id?: string; name: string; machineId: string; cardId: string };
