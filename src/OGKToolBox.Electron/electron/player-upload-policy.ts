import { requirePlayerScope } from "./player-profiles";
import { playerUploadPolicyForServer, type PlayerUploadPolicy } from "../src/player-upload-policy";

export { playerUploadPolicyForServer, requirePlayerScoreUpload, type PlayerUploadPolicy } from "../src/player-upload-policy";

export async function getPlayerUploadPolicy(root: string, cardId: string, serverId: string): Promise<PlayerUploadPolicy> {
  const { config } = await requirePlayerScope(root, cardId, serverId);
  return playerUploadPolicyForServer(config.server);
}
