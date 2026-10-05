import { createPlayerReadError } from "./player-read-error";

type Row = Record<string, unknown>;
const record = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);
const int32 = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2147483647;
function readInt32(api: string, row: Row, field: string): number {
  if (!Object.hasOwn(row, field)) throw createPlayerReadError(api, "payload", "missing_field", [field]);
  const value = row[field];
  if (typeof value !== "number" || !Number.isInteger(value)) throw createPlayerReadError(api, "payload", "invalid_type", [field]);
  if (!int32(value)) throw createPlayerReadError(api, "payload", "value_out_of_range", [field]);
  return value;
}
function readRomVersionCode(api: string, row: Row): number {
  const field = "romVersionCode";
  if (!Object.hasOwn(row, field)) throw createPlayerReadError(api, "payload", "missing_field", [field]);
  const value = row[field];
  // AquaDX and MuNET publish this one integer as a decimal string.
  // Keep the raw response intact; only the initialized Rating projection is numeric.
  if (typeof value !== "string") return readInt32(api, row, field);
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw createPlayerReadError(api, "payload", "invalid_type", [field]);
  if (value.length > 10 || !int32(Number(value))) throw createPlayerReadError(api, "payload", "value_out_of_range", [field]);
  return Number(value);
}
// These two initialization reads are single responses, not paged music lists.
// Recent order and repeated charts are meaningful to the game's Hot rating.
export function playerGameRatingReadRows(api: string, response: Row): Row[] {
  const recent = api === "GetUserRecentRatingApi", field = recent ? "userRecentRatingList" : "userRatinglogList";
  if (!recent && api !== "GetUserRatinglogApi") throw new Error("Rating 读取接口无效。");
  const values = response[field];
  if (!Object.hasOwn(response, field)) throw createPlayerReadError(api, "payload", "missing_field", [field]);
  if (!Array.isArray(values)) throw createPlayerReadError(api, "payload", "invalid_type", [field]);
  const length = readInt32(api, response, "length");
  if (length !== values.length) throw createPlayerReadError(api, "payload", "count_mismatch", ["length", field]);
  if (values.length > (recent ? 30 : 1000)) throw createPlayerReadError(api, "payload", "value_out_of_range", [field]);
  const versions = new Set<string>();
  return values.map(value => {
    if (!record(value)) throw createPlayerReadError(api, "payload", "invalid_type", [field]);
    const fields = recent ? ["musicId", "difficultId", "romVersionCode", "score"] : ["highestRating", "newHighestRating"];
    const row: Row = Object.fromEntries(fields.map(field => [field, recent && field === "romVersionCode" ? readRomVersionCode(api, value) : readInt32(api, value, field)]));
    if (recent && ![0, 1, 2, 3, 10].includes(Number(row.difficultId))) throw createPlayerReadError(api, "payload", "value_out_of_range", ["difficultId"]);
    if (!recent) {
      if (!Object.hasOwn(value, "dataVersion")) throw createPlayerReadError(api, "payload", "missing_field", ["dataVersion"]);
      const parts = typeof value.dataVersion === "string" && /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value.dataVersion) ? value.dataVersion.split(".").map(Number) : undefined;
      const version = parts ? `${parts[0]}.${parts[1]}` : "";
      if (!parts) throw createPlayerReadError(api, "payload", "invalid_type", ["dataVersion"]);
      if (parts.some(part => part > 255)) throw createPlayerReadError(api, "payload", "value_out_of_range", ["dataVersion"]);
      if (versions.has(version)) throw createPlayerReadError(api, "payload", "duplicate_version", ["dataVersion"]);
      versions.add(version);
      const [major, minor] = parts;
      row.dataVersion = `${major}.${String(minor).padStart(2, "0")}`;
    }
    return row;
  });
}
