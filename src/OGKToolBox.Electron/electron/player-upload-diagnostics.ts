import type { IncomingHttpHeaders } from "node:http";

const categories = ["server_error", "server_rejected", "missing_field", "type_mismatch", "value_out_of_range", "database_constraint", "authentication", "session_required", "unsupported_api", "rate_limited", "identity_mismatch", "invalid_response", "transport_failure", "timeout", "cancelled", "response_too_large", "response_interrupted"] as const;
export type PlayerUploadErrorCategory = typeof categories[number];
export type PlayerUploadDiagnostic = Readonly<{
  stage: "transport" | "http" | "protocol";
  category: PlayerUploadErrorCategory;
  status?: number;
  returnCode?: number;
  fields?: readonly string[];
  traceId?: string;
}>;
const fieldNames = (`nonce_ userId regionId placeId clientId accessCode apiName returnCode upsertUserAll
userData userOption userPlaylogList userJewelboostlogList userSessionlogList userActivityList userRecentRatingList userBpBaseList
userRatingBaseBestNewList userRatingBaseBestList userRatingBaseHotList userRatingBaseNextNewList userRatingBaseNextList userRatingBaseHotNextList
userNewRatingBasePScoreList userNewRatingBaseBestList userNewRatingBaseBestNewList userNewRatingBaseNextPScoreList userNewRatingBaseNextBestList userNewRatingBaseNextBestNewList
userMusicDetailList userCharacterList userCardList userDeckList userTrainingRoomList userStoryList userChapterList userMemoryChapterList userItemList userMusicItemList userLoginBonusList userEventPointList userMissionPointList userRatinglogList userBossList userTechCountList userScenarioList userTradeItemList userEventMusicList userTechEventList userKopList userEventMap clientSystemInfo
isNewMusicDetailList isNewCharacterList isNewCardList isNewDeckList isNewTrainingRoomList isNewStoryList isNewChapterList isNewMemoryChapterList isNewItemList isNewMusicItemList isNewLoginBonusList isNewEventPointList isNewMissionPointList isNewRatinglogList isNewBossList isNewTechCountList isNewScenarioList isNewTradeItemList isNewEventMusicList isNewTechEventList isNewKopList
musicId level playCount techScoreMax techScoreRank battleScoreMax battleScoreRank platinumScoreMax platinumScoreStar maxComboCount maxOverKill maxTeamOverKill isFullBell isFullCombo isAllBreake isLock clearStatus isStoryWatched
userName reincarnationNum exp point totalPoint jewelCount totalJewelCount medalCount shizukuCount playerRating highestRating newPlayerRating newHighestRating battlePoint bestBattlePoint overDamageBattlePoint
isDialogWatchedSuggestMemory nameplateId trophyId cardId characterId characterVoiceNo tabSetting tabSortSetting cardCategorySetting cardSortSetting rivalScoreCategorySetting playedTutorialBit firstTutorialCancelNum
sumTechHighScore sumTechBasicHighScore sumTechAdvancedHighScore sumTechExpertHighScore sumTechMasterHighScore sumTechLunaticHighScore sumBattleHighScore sumBattleBasicHighScore sumBattleAdvancedHighScore sumBattleExpertHighScore sumBattleMasterHighScore sumBattleLunaticHighScore
eventWatchedDate cmEventWatchedDate firstGameId firstRomVersion firstDataVersion firstPlayDate lastGameId lastRomVersion lastDataVersion compatibleCmVersion lastPlayDate lastPlaceId lastPlaceName lastRegionId lastRegionName lastAllNetId lastClientId lastUsedDeckId lastPlayMusicLevel lastEmoneyBrand sumPlatinumScoreStar sumBasicPlatinumScoreStar sumAdvancedPlatinumScoreStar sumExpertPlatinumScoreStar sumMasterPlatinumScoreStar sumLunaticPlatinumScoreStar
itemKind itemId stock isValid chapterId storyId lastChapterId lastPlayMusicId lastPlayMusicCategory lastPlayMusicMinorCategory lastPlayMusicLevel isClear skipTiming1 skipTiming2
boardId count flags version machineName`).split(/\s+/).filter(Boolean);
const fields = new Map(fieldNames.map(name => [name.toLowerCase(), name]));
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fieldPath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,4}\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,4}\])?){0,4}$/.test(value)) return;
  const parts = value.replace(/\[\d+\]/g, "").split(".").map(part => fields.get(part.toLowerCase()));
  if (parts.every((part): part is string => !!part)) return parts.join(".");
}
function trace(value: unknown, privateValues: readonly string[] = []): string | undefined {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i.test(value)) return;
  const compact = value.replace(/-/g, "").toLowerCase();
  if (/^0+$/.test(compact) || /\d{20}/.test(compact) || !/[a-f]/.test(compact)) return;
  if (privateValues.some(secret => {
    const normalized = secret.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return normalized.length >= 6 && compact.includes(normalized);
  })) return;
  return value.toLowerCase();
}

// This is an allowlist, not free-text redaction. Nothing else from a response,
// transport exception, URL or request can become an enumerable error property.
export function safePlayerUploadDiagnostic(value: unknown): PlayerUploadDiagnostic | undefined {
  if (!record(value) || typeof value.stage !== "string" || !["transport", "http", "protocol"].includes(value.stage) || !(categories as readonly unknown[]).includes(value.category)) return;
  const result: { stage: PlayerUploadDiagnostic["stage"]; category: PlayerUploadErrorCategory; status?: number; returnCode?: number; fields?: readonly string[]; traceId?: string } = { stage: value.stage as PlayerUploadDiagnostic["stage"], category: value.category as PlayerUploadErrorCategory };
  if (Number.isInteger(value.status) && Number(value.status) >= 100 && Number(value.status) <= 599) result.status = Number(value.status);
  if (Number.isInteger(value.returnCode) && Math.abs(Number(value.returnCode)) <= 32767) result.returnCode = Number(value.returnCode);
  if (Array.isArray(value.fields)) {
    const names = [...new Set(value.fields.slice(0, 24).map(fieldPath).filter((field): field is string => !!field))];
    if (names.length) result.fields = Object.freeze(names);
  }
  const id = trace(value.traceId); if (id) result.traceId = id;
  return Object.freeze(result);
}

const categoryLabels: Record<PlayerUploadErrorCategory, string> = {
  server_error: "服务端异常", server_rejected: "服务器拒绝", missing_field: "字段缺失", type_mismatch: "字段类型不匹配", value_out_of_range: "字段超出范围", database_constraint: "数据库约束", authentication: "身份校验失败", session_required: "会话检查失败", unsupported_api: "接口不支持", rate_limited: "请求过于频繁", identity_mismatch: "返回身份不匹配", invalid_response: "响应格式不兼容", transport_failure: "连接失败", timeout: "连接超时", cancelled: "已取消", response_too_large: "响应超限", response_interrupted: "响应中断"
};
export class PlayerUploadError extends Error {
  readonly diagnostic: PlayerUploadDiagnostic;
  constructor(value: PlayerUploadDiagnostic) {
    const diagnostic: PlayerUploadDiagnostic = safePlayerUploadDiagnostic(value) ?? Object.freeze({ stage: "protocol" as const, category: "invalid_response" as const });
    const fieldSummary = diagnostic.fields?.length ? `字段 ${diagnostic.fields.slice(0, 4).join("、")}${diagnostic.fields.length > 4 ? ` 等 ${diagnostic.fields.length} 项` : ""}` : "";
    const details = [diagnostic.status ? `HTTP ${diagnostic.status}` : "", categoryLabels[diagnostic.category], diagnostic.returnCode !== undefined ? `返回码 ${diagnostic.returnCode}` : "", fieldSummary, diagnostic.traceId ? `追踪号 ${diagnostic.traceId}` : ""].filter(Boolean).join("；");
    const prefix = diagnostic.stage === "http" ? "服务器未接受存档上传" : diagnostic.stage === "protocol" ? "服务器未确认存档上传" : "存档上传未完成";
    super(`${prefix}（${details}），本地存档保留。`);
    this.name = "PlayerUploadError";
    this.diagnostic = diagnostic;
    this.stack = undefined;
  }
}

export function playerUploadResponseDiagnostic(status: number, body: unknown, headers: IncomingHttpHeaders = {}, privateValues: readonly string[] = []): PlayerUploadDiagnostic {
  const messages: string[] = [], names = new Set<string>();
  // Only structured error channels are inspected. HTML, raw text, stack traces,
  // echoed requests and arbitrary JSON values are never copied or traversed.
  const addField = (value: unknown) => { const name = fieldPath(value); if (name && names.size < 24) names.add(name); };
  const addMessage = (value: unknown) => {
    if (typeof value !== "string" || messages.length >= 32) return;
    const text = value.slice(0, 4096); messages.push(text);
    for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,4}\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,4}\])?){0,4}/g) ?? []) addField(token);
  };
  let inspected = 0;
  const inspect = (value: unknown, depth = 0) => {
    if (++inspected > 128 || depth > 3) return;
    if (typeof value === "string") { addMessage(value); return; }
    if (Array.isArray(value)) { value.slice(0, 24).forEach(item => inspect(item, depth + 1)); return; }
    if (!record(value)) return;
    for (const [key, item] of Object.entries(value).slice(0, 32)) {
      if (["message", "detail", "title", "error", "code", "type"].includes(key)) {
        if (typeof item === "string") addMessage(item); else if (key === "error") inspect(item, depth + 1);
      } else if (["field", "property", "path", "propertyPath"].includes(key)) addField(item);
      else if (["errors", "violations"].includes(key)) inspect(item, depth + 1);
      else if (fieldPath(key)) { addField(key); inspect(item, depth + 1); }
    }
  };
  if (record(body)) {
    for (const name of ["message", "detail", "title", "error", "code", "type", "errors", "violations"]) if (body[name] !== undefined) inspect({ [name]: body[name] });
  }
  const description = messages.join(" ").toLowerCase();
  let category: PlayerUploadErrorCategory = status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limited" : status === 404 || status === 405 || status === 501 ? "unsupported_api" : status >= 500 ? "server_error" : "server_rejected";
  if (/not.?null constraint|foreign.?key|unique constraint|constraintviolation|dataintegrityviolation|duplicate key/.test(description)) category = "database_constraint";
  else if (/not logged in|login required|gamelogin.{0,24}required|session.{0,32}(expired|required|missing|invalid)|no.{0,12}session/.test(description)) category = "session_required";
  else if (/unauthori[sz]ed|authentication.{0,24}(failed|required)|access denied|forbidden/.test(description)) category = "authentication";
  else if (/missing.{0,32}(field|property|parameter)|required.{0,32}(field|property|parameter)|field.{0,32}required|property.{0,32}required|cannot read propert.{0,40}(undefined|null)/.test(description)) category = "missing_field";
  else if (/type mismatch|cannot deserialize|invalid.{0,16}type|jsonmappingexception|invalidcastexception|must be.{0,16}(integer|number|boolean|array|object|string)/.test(description)) category = "type_mismatch";
  else if (/out of range|overflow|too (large|small)|must be.{0,16}(less|greater|between)/.test(description)) category = "value_out_of_range";
  const diagnostic: { stage: "http" | "protocol"; category: PlayerUploadErrorCategory; status: number; fields?: string[]; returnCode?: number; traceId?: string } = { stage: status === 200 ? "protocol" : "http", category, status };
  if (names.size) diagnostic.fields = [...names];
  if (record(body) && Number.isInteger(body.returnCode) && Math.abs(Number(body.returnCode)) <= 32767 && !privateValues.includes(String(body.returnCode))) diagnostic.returnCode = Number(body.returnCode);
  const traceparent = typeof headers.traceparent === "string" ? /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(headers.traceparent)?.[1] : undefined;
  for (const value of [headers["x-request-id"], headers["x-correlation-id"], headers["x-trace-id"], traceparent, ...(record(body) ? [body.traceId, body.requestId, body.correlationId] : [])]) {
    const id = trace(value, privateValues); if (id) { diagnostic.traceId = id; break; }
  }
  return safePlayerUploadDiagnostic(diagnostic)!;
}
