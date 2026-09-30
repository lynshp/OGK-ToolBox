import { session } from "electron";
import { fastGithubManager } from "./fastgithub-manager";
import type { UpdateChannel } from "../src/update-models";

export type UpdateFeed = { owner: string; repo: string; privateFeed: boolean };
export const selectUpdateChannel = (channel: UpdateChannel) => fastGithubManager.configureUpdater(channel === "fastgithub");

// Diagnostics may be copied to a public issue. Never include credentials or signed URL queries.
export function safeUpdateError(error: unknown, token?: string): string {
  let value = error instanceof Error ? error.message : String(error);
  if (token) value = value.split(token).join("[已隐藏令牌]");
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return "[URL]"; }
  }).replace(/((?:authorization|token|signature)\s*[:=]\s*)[^\s,}\r\n]+/gi, "$1[已隐藏]")
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[已隐藏令牌]").slice(0, 1600);
}

export async function probeUpdateChannel(feed: UpdateFeed, token?: string, channel: "fastgithub" | "github" = "github"): Promise<number> {
  const url = feed.privateFeed
    ? `https://api.github.com/repos/${feed.owner}/${feed.repo}/releases/latest`
    : `https://github.com/${feed.owner}/${feed.repo}/releases/latest/download/latest.yml`;
  const controller = new AbortController();
  const started = Date.now();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const init: RequestInit = {
      cache: "no-store", signal: controller.signal,
      headers: feed.privateFeed && token ? { Authorization: `Bearer ${token}` } : undefined
    };
    // Never reconfigure the updater session while another probe or download is active.
    const direct = session.fromPartition("ogk-update-probe-direct", { cache: false });
    const response = channel === "fastgithub"
      ? await fastGithubManager.fetch(url, init, true)
      : await (async () => { await direct.setProxy({ mode: "direct" }); return direct.fetch(url, init); })();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${response.status} ${response.statusText} · ${url}`);
    }
    // Reading the body is covered by the same timeout (a 200 header alone is not connectivity).
    const body = await response.text();
    if (feed.privateFeed ? !JSON.parse(body).tag_name : !/^version:\s*\S+/m.test(body)) {
      throw new Error(`更新源返回内容无效，未取得版本信息 · ${url}`);
    }
    return Date.now() - started;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`连通检测超时（10 秒）· ${url}`);
    throw new Error(`${safeUpdateError(error, token)} · ${url}`);
  } finally { clearTimeout(timeout); }
}
