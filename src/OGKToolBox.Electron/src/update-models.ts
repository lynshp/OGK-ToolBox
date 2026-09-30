export type UpdateChannel = "fastgithub" | "github" | "ghproxy";
export type UpdateSource = "auto" | UpdateChannel;
export type DownloadSource = "auto" | "ghproxy" | "origin";
export type ChannelStatus = {
  state: "unknown" | "checking" | "reachable" | "failed";
  checkedAt?: string;
  latencyMs?: number;
  error?: string;
};
export type UpdateState = "idle" | "unsupported" | "checking" | "available" |
  "not-available" | "downloading" | "verifying" | "ready" | "error";
export type UpdateStatus = {
  packaged: boolean;
  currentVersion: string;
  availableVersion?: string;
  state: UpdateState;
  progress?: number;
  error?: string;
  hasToken: boolean;
  source?: UpdateSource;
  activeChannel?: UpdateChannel;
  channels?: Partial<Record<UpdateChannel, ChannelStatus>>;
  phase?: string;
  diagnostics?: string[];
  downloadSource?: DownloadSource;
  activeDownload?: "ghproxy" | UpdateChannel;
  ghproxy?: ChannelStatus;
  proxyNode?: string;
  proxyNodes?: { node: string; latencyMs?: number; error?: string }[];
};
export const channelName = (channel: UpdateChannel) => channel === "fastgithub" ? "FastGithub" : channel === "ghproxy" ? "GH-Proxy" : "原生 GitHub";
