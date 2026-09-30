import { createHash } from "node:crypto";

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const identityFields = ["musicId", "cardId", "itemId", "characterId", "chapterId", "storyId", "trophyId", "deckId", "level", "difficulty"];
// Preserve positional arrays (e.g. a deck's card slots). Only keyed record lists are unordered.
function canonical(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new Error("存档嵌套过深。");
  if (Array.isArray(value)) {
    const rows = value.map(item => canonical(item, depth + 1));
    if (value.length && value.every(item => record(item) && identityFields.some(key => key in item))) {
      return rows.map(item => JSON.stringify(item)).sort().map(item => JSON.parse(item));
    }
    return rows;
  }
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  return value;
}
export function saveFingerprint(raw: unknown): string {
  let payload: unknown = raw;
  if (record(raw) && record(raw.summary) && "raw" in raw) payload = raw.raw;
  if (record(payload) && Array.isArray(payload.events)) {
    // Timestamps, sessions, user-agent, API connection and pagination cursors are transport metadata.
    // Keep every actual response field, including options, character levels and gameplay dates.
    const pages = payload.events.map((event: any) => {
      const response = record(event?.response) ? { ...event.response } : event?.response;
      if (record(response)) delete response.nextIndex;
      return canonical({ api: event?.api, response });
    });
    payload = pages.map(page => JSON.stringify(page)).sort();
  } else payload = canonical(payload);
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
