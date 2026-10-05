export type PlayerUploadPolicy = {
  scoreUpload: "direct" | "frontend";
  frontendService: "munet" | "nageki" | "rinnet" | null;
  serverHost: string;
};

// Match the configured game host, never a display name or a domain substring.
export function playerUploadPolicyForServer(server: string): PlayerUploadPolicy {
  let serverHost = "";
  if (typeof server === "string") {
    const value = server.trim();
    try {
      // URL tolerates control characters, backslashes and escaped host names.
      // Those are not configuration spellings that may enable a write policy.
      if (!value || /[\s\\%]/.test(value) || !/^(?:https?:\/\/)?[^/]+\/?$/i.test(value)) throw new Error();
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
      serverHost = url.hostname.toLowerCase().replace(/\.$/, "");
    } catch { /* Invalid configurations stay local; do not expose their contents. */ }
  }
  const frontendService = serverHost === "play.mumur.net" ? "munet"
    : serverHost === "nageki-net.com" ? "nageki"
    : ["ea.naominet.live", "aqua.naominet.live"].includes(serverHost) ? "rinnet"
    : null;
  return { scoreUpload: frontendService === "munet" ? "direct" : "frontend", frontendService, serverHost };
}

export function requirePlayerScoreUpload(server: string): PlayerUploadPolicy {
  const policy = playerUploadPolicyForServer(server);
  if (policy.scoreUpload !== "direct") throw new Error("此服务器的成绩仅保存本地，请导出后到 Net 前端上传。");
  return policy;
}
