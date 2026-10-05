const readApis = [
  "GetUserDataApi", "GetUserMusicApi", "GetUserCardApi", "GetUserCharacterApi", "GetUserItemApi", "GetUserOptionApi",
  "GetUserActivityApi", "GetUserChapterApi", "GetUserStoryApi", "GetUserPreviewApi", "GetUserRecentRatingApi", "GetUserRatinglogApi"
] as const;
export type PlayerReadApi = typeof readApis[number];
const stages = ["http", "codec", "json", "shape", "identity", "payload"] as const;
export type PlayerReadErrorStage = typeof stages[number];
const reasons = [
  "unsupported_encoding", "decompression_failed", "invalid_json", "invalid_root", "missing_field", "invalid_type",
  "identity_mismatch", "count_mismatch", "value_out_of_range", "duplicate_version", "activity_mismatch", "invalid_response", "http_rejected"
] as const;
export type PlayerReadErrorReason = typeof reasons[number];
export type PlayerReadDiagnostic = Readonly<{
  api?: PlayerReadApi;
  stage: PlayerReadErrorStage;
  reason: PlayerReadErrorReason;
  fields?: readonly string[];
  status?: number;
}>;
const fieldNames = new Set([
  "userId", "kind", "userData", "userMusicList", "userCardList", "userCharacterList", "userItemList", "userOption",
  "userActivityList", "userChapterList", "userStoryList", "isLogin", "banStatus", "isWarningConfirmed", "length",
  "userRecentRatingList", "userRatinglogList", "musicId", "difficultId", "romVersionCode", "score", "highestRating",
  "newHighestRating", "dataVersion"
]);
const labels: Record<PlayerReadErrorReason, string> = {
  unsupported_encoding: "响应压缩格式不支持", decompression_failed: "响应解压失败", invalid_json: "响应不是有效 JSON",
  invalid_root: "响应应为对象", missing_field: "响应缺少字段", invalid_type: "响应字段类型无效",
  identity_mismatch: "返回玩家身份不一致", count_mismatch: "记录数量不一致", value_out_of_range: "响应字段超出范围",
  duplicate_version: "Rating 版本记录重复", activity_mismatch: "返回活动类别不一致", invalid_response: "响应格式无效", http_rejected: "服务器拒绝读取"
};

// Only source-defined tokens become error metadata. Never retain a response,
// request, URL, arbitrary field path, original exception or player value here.
export class PlayerReadError extends Error {
  readonly diagnostic: PlayerReadDiagnostic;
  constructor(api: string, stage: PlayerReadErrorStage, reason: PlayerReadErrorReason, requestedFields?: readonly string[], status?: unknown) {
    const valid = (readApis as readonly unknown[]).includes(api) && (stages as readonly unknown[]).includes(stage)
      && (reasons as readonly unknown[]).includes(reason)
      && (stage === "http" ? reason === "http_rejected" && typeof status === "number" && Number.isSafeInteger(status) && status >= 100 && status <= 599 : reason !== "http_rejected");
    const fields = valid && stage !== "http" && Array.isArray(requestedFields)
      ? [...new Set(requestedFields.slice(0, 24).filter(field => typeof field === "string" && fieldNames.has(field)))] : [];
    const diagnostic: PlayerReadDiagnostic = Object.freeze(valid
      ? { api: api as PlayerReadApi, stage, reason, ...(stage === "http" ? { status: status as number } : {}), ...(fields.length ? { fields: Object.freeze(fields) } : {}) }
      : { stage: "payload" as const, reason: "invalid_response" as const });
    const detail = fields.length ? `（${fields.slice(0, 4).join("、")}${fields.length > 4 ? ` 等 ${fields.length} 项` : ""}）` : "";
    const description = diagnostic.stage === "http"
      ? `HTTP ${diagnostic.status}，${diagnostic.status === 401 || diagnostic.status === 403 ? "服务器拒绝授权" : labels.http_rejected}`
      : `${labels[diagnostic.reason]}${detail}`;
    super(`读取${diagnostic.api ? ` ${diagnostic.api}` : "存档"}失败：${description}。原存档保留。`);
    this.name = "Error";
    this.diagnostic = diagnostic;
    this.stack = undefined;
  }
}

export function createPlayerReadError(api: string, stage: PlayerReadErrorStage, reason: PlayerReadErrorReason, fields?: readonly string[], status?: unknown): PlayerReadError {
  return new PlayerReadError(api, stage, reason, fields, status);
}
