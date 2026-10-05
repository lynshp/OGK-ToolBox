// The local game uses chart index 4 for LUNATIC and server difficulty 10.
// Match NetPacketUtil's conversion at the data boundaries, retaining raw saves.
export function localPlayerDifficulty(serverLevel: number): number {
  return serverLevel === 10 ? 4 : serverLevel;
}
export function serverPlayerDifficulty(localLevel: number): number {
  return localLevel === 4 ? 10 : localLevel;
}
