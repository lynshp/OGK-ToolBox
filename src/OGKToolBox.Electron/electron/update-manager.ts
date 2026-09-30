import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import { autoUpdater } from "electron-updater";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fastGithubManager } from "./fastgithub-manager";
import { probeUpdateChannel, safeUpdateError, selectUpdateChannel, type UpdateFeed } from "./update-network";
import { githubSources } from "./github-sources";
import { createReleaseAssetProvider } from "./release-asset-provider";
import { channelName, type DownloadSource, type UpdateChannel, type UpdateSource, type UpdateStatus } from "../src/update-models";

export type { UpdateStatus } from "../src/update-models";

const tokenHelp = "需要更新令牌。请在设置「关于」中填写对私有仓库具有 Contents: Read 权限的 GitHub fine-grained token。";

type Hooks = {
  stopSidecar(): Promise<void>;
  stopController(): Promise<void>;
  beginInstallQuit(): void;
  getWindow(): BrowserWindow | undefined;
};

export class UpdateManager {
  private readonly listeners = new Set<(status: UpdateStatus) => void>();
  private status: UpdateStatus = {
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    state: app.isPackaged ? "idle" : "unsupported",
    hasToken: false, source: "auto", downloadSource: "auto", ghproxy: { state: "unknown" },
    channels: { fastgithub: { state: "unknown" }, github: { state: "unknown" } }, diagnostics: []
  };
  private installing = false;
  private promptedVersion?: string;
  private configured = false;
  private readonly fastGithub = fastGithubManager;
  private operation?: Promise<UpdateStatus>;
  private stopped = false;
  private diagnosticToken?: string;
  private downloadCancellation?: Parameters<typeof autoUpdater.downloadUpdate>[0];
  private releaseAssets: string[] = [];
  private activeProxyNode?: string;
  private probeGeneration = 0;

  constructor(private readonly hooks: Hooks) {}

  get isInstalling(): boolean {
    return this.installing;
  }

  async start(): Promise<void> {
    await githubSources.load();
    Object.assign(this.status, githubSources.get());
    githubSources.onNodes = (results, selected) => {
      this.patch({ proxyNodes: results, proxyNode: selected,
        ghproxy: { state: selected ? "reachable" : "failed", checkedAt: new Date().toISOString(), latencyMs: results.find(row => row.node === selected)?.latencyMs } });
      for (const result of results) this.record(`GH-Proxy ${result.node} · ${result.error || `可达 ${result.latencyMs} ms`}`);
    };
    this.status.hasToken = Boolean(await this.readToken());
    this.emit();
    this.registerIpc();
    if (!app.isPackaged) return;

    // Await both checking and downloading under one operation lock.
    autoUpdater.autoDownload = false;
    // Avoid differential reconstruction failing at 100% then silently downloading again.
    autoUpdater.disableDifferentialDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.autoRunAppAfterInstall = true;

    autoUpdater.on("checking-for-update", () => this.patch({ state: "checking", phase: "读取版本信息", error: undefined }));
    autoUpdater.on("update-available", info => {
      this.patch({ state: "available", availableVersion: info.version, error: undefined });
    });
    autoUpdater.on("update-not-available", () => {
      this.patch({ state: "not-available", availableVersion: undefined, progress: undefined, error: undefined });
    });
    autoUpdater.on("download-progress", progress => {
      this.patch({ state: progress.percent >= 100 ? "verifying" : "downloading",
        phase: progress.percent >= 100 ? "校验安装包" : "下载完整安装包",
        progress: Math.min(99, Math.max(this.status.progress ?? 0, progress.percent)), error: undefined });
    });
    autoUpdater.on("update-downloaded", info => {
      this.patch({
        state: "ready",
        availableVersion: info.version,
        progress: 100,
        error: undefined
      });
    });
    autoUpdater.on("error", error => {
      // The awaited operation handles failures and fallback exactly once.
      if (!this.operation) this.patch({ state: "error", error: mapUpdateError(safeUpdateError(error, this.diagnosticToken)) });
    });

    await this.check();
  }

  private registerIpc(): void {
    ipcMain.handle("app:get-version", () => app.getVersion());
    ipcMain.handle("update:status", () => this.status);
    ipcMain.handle("update:set-sources", async (_event, source: UpdateSource, downloadSource: DownloadSource = "auto") => {
      if (this.operation) throw new Error("应用更新进行中，请完成后再修改来源。");
      await githubSources.save(source, downloadSource);
      this.patch({ source, downloadSource });
      return this.status;
    });
    ipcMain.handle("update:set-token", async (_event, token: unknown) => {
      if (this.operation) throw new Error("更新进行中，请完成后再修改令牌。");
      if (typeof token !== "string") throw new Error("更新令牌无效。");
      await this.writeToken(token.trim());
      this.status.hasToken = Boolean(token.trim());
      this.configured = false;
      this.emit();
      return this.status;
    });
    ipcMain.handle("update:check", (_event, source?: unknown, downloadSource?: unknown) => {
      if (source !== undefined && source !== "auto" && source !== "fastgithub" && source !== "github" && source !== "ghproxy") throw new Error("更新通道无效。");
      if (downloadSource !== undefined && downloadSource !== "auto" && downloadSource !== "ghproxy" && downloadSource !== "origin") throw new Error("下载线路无效。");
      return this.check(source as UpdateSource | undefined, downloadSource as DownloadSource | undefined);
    });
    ipcMain.handle("update:install", () => this.install());
    ipcMain.on("update:subscribe", event => {
      const send = (status: UpdateStatus) => {
        if (!event.sender.isDestroyed()) event.sender.send("update:status", status);
      };
      this.listeners.add(send);
      send(this.status);
      event.sender.once("destroyed", () => this.listeners.delete(send));
    });
  }

  private check(source = this.status.source ?? "auto", downloadSource = this.status.downloadSource ?? "auto"): Promise<UpdateStatus> {
    if (this.operation) return this.operation;
    if (this.stopped || this.installing) return Promise.resolve(this.status);
    const operation = Promise.resolve().then(() => this.runCheck(source, downloadSource)).catch(error => {
      this.patch({ state: "error", error: mapUpdateError(safeUpdateError(error, this.diagnosticToken)) });
      return this.status;
    });
    this.operation = operation;
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined; });
    return operation;
  }

  private async runCheck(source: UpdateSource, downloadSource: DownloadSource): Promise<UpdateStatus> {
    await githubSources.save(source, downloadSource);
    this.activeProxyNode = undefined;
    const generation = ++this.probeGeneration;
    const isCurrent = () => !this.stopped && generation === this.probeGeneration;
    if (!app.isPackaged) {
      this.patch({ state: "unsupported", error: "开发模式不检查更新。" });
      return this.status;
    }

    this.patch({ source, downloadSource, activeChannel: undefined, activeDownload: undefined, proxyNode: undefined, proxyNodes: [],
      ghproxy: { state: "unknown" }, progress: undefined, error: undefined,
      state: "checking", phase: "检测更新通道", diagnostics: [],
      channels: { fastgithub: { state: "unknown" }, github: { state: "unknown" } } });
    const feed = readUpdateFeed();
    if (!feed) {
      this.patch({
        state: "error",
        error: "未配置更新源。安装包缺少 app-update.yml。"
      });
      return this.status;
    }

    const token = await this.readToken();
    this.diagnosticToken = token;
    this.status.hasToken = Boolean(token);
    if (feed.privateFeed && !token) {
      this.patch({ state: "error", error: tokenHelp });
      return this.status;
    }

    // Probe independent sessions concurrently. Only the selected route configures the updater.
    const pending = new Map<UpdateChannel, Promise<{channel: UpdateChannel; reachable: boolean}>>();
    const launch = (channel: UpdateChannel) => {
      this.patchChannel(channel, {state:"checking"});
      const probe = (async () => {
        try {
          let latencyMs: number | undefined;
          if (channel === "ghproxy") {
            if (feed.privateFeed) throw new Error("GH-Proxy 不支持私有更新源");
            const proxy = await githubSources.probeMetadata(
              `https://github.com/${feed.owner}/${feed.repo}/releases/latest/download/latest.yml`,
              (results, selected) => {
                if (!isCurrent()) return;
                this.patch({proxyNodes:results, proxyNode:selected});
              });
            if (!proxy.node) throw new Error("所有 GH-Proxy 版本节点不可用");
            if (isCurrent()) this.activeProxyNode = proxy.node;
            latencyMs = proxy.latencyMs;
          } else latencyMs = await probeUpdateChannel(feed, token, channel);
          if (isCurrent()) {
            this.patchChannel(channel, {state:"reachable",latencyMs,checkedAt:new Date().toISOString()});
            this.record(`${channelName(channel)}：更新源可达（${latencyMs} ms）`);
          }
          return {channel, reachable:true};
        } catch (error) {
          if (isCurrent()) {
            const detail = safeUpdateError(error, token);
            this.patchChannel(channel, {state:"failed",error:detail,checkedAt:new Date().toISOString()});
            this.record(`${channelName(channel)} · 连通检测失败：${detail}`);
          }
          return {channel, reachable:false};
        }
      })();
      pending.set(channel, probe);
    };
    for (const channel of ["fastgithub", "github", "ghproxy"] as const) launch(channel);
    while (pending.size) {
      const candidate = source === "auto"
        ? await Promise.race(pending.values())
        : await pending.get(source);
      if (!candidate || !isCurrent()) return this.status;
      const {channel, reachable} = candidate;
      pending.delete(channel);
      if (source !== "auto") pending.clear();
      if (!reachable) continue;
      this.patch({ activeChannel: channel, state: "checking", phase: "读取版本信息", progress: undefined });
      try {
        await selectUpdateChannel(channel);
        if (this.stopped) return this.status;
        this.configured = false;
        if (channel === "ghproxy") {
          autoUpdater.setFeedURL({provider:"generic",url:`${this.activeProxyNode}/https://github.com/${feed.owner}/${feed.repo}/releases/latest/download/`,useMultipleRangeRequest:false});
        } else this.configureFeed(feed, token);
        const result = await autoUpdater.checkForUpdates();
        this.downloadCancellation = result?.cancellationToken;
        if (this.getStatusState() === "checking") throw new Error("更新服务未返回版本检查结果");
      } catch (error) {
        const detail = safeUpdateError(error, token);
        this.patchChannel(channel, { ...this.status.channels![channel], state: "failed", error: detail });
        this.record(`${channelName(channel)} · 读取版本失败：${detail}`);
        continue;
      }
      if (this.stopped) return this.status;
      githubSources.useChannel(channel);
      this.patch({activeDownload: channel});
      if (this.status.state === "available") {
        if (this.stopped) return this.status;
        const downloadLabel = this.status.activeDownload === "ghproxy" ? "GH-Proxy" : channelName(channel);
        this.patch({ state: "downloading", phase: "下载完整安装包", progress: 0 });
        this.record(`${downloadLabel} · 下载完整安装包 ${this.status.availableVersion}`);
        try {
          await autoUpdater.downloadUpdate(this.downloadCancellation);
          if (this.getStatusState() !== "ready") throw new Error("下载结束但未收到安装包校验成功状态");
          this.record("安装包已校验，可重启安装");
          if (!this.stopped) void this.promptInstall(this.status.availableVersion);
        } catch (error) {
          const detail = safeUpdateError(error, token);
          this.record(`${downloadLabel} · ${this.status.phase}失败：${detail}`);
          // Do not silently restart a large download on another route after visible progress.
          this.patch({ state: "error", error: `${downloadLabel} · ${this.status.phase}失败：${mapUpdateError(detail)}。可切换下载线路后重新检查。` });
        }
      }
      return this.status;
    }
    this.patch({ state: "error", error: source === "auto"
      ? "所有更新通道均未能完成版本检查。展开诊断详情查看原因，可选择通道后重新检查。"
      : `${channelName(source)} 无法完成版本检查。可选择另一通道或自动选择后重试。` });
    return this.status;
  }

  private getStatusState() { return this.status.state; }

  private patchChannel(channel: UpdateChannel, value: NonNullable<UpdateStatus["channels"]>[UpdateChannel]): void {
    this.patch({ channels: { ...this.status.channels!, [channel]: value }, ...(channel === "ghproxy" ? {ghproxy:value} : {}) });
  }

  private record(message: string): void {
    this.patch({ diagnostics: [...(this.status.diagnostics ?? []), `${new Date().toISOString()} ${message}`].slice(-30) });
  }

  private async install(): Promise<void> {
    if (this.installing) return;
    if (this.status.state !== "ready") throw new Error("还没有下载完成的更新。");
    this.installing = true;
    try {
      await this.fastGithub.disable();
      await this.hooks.stopController();
      await this.hooks.stopSidecar();
      this.hooks.beginInstallQuit();
      autoUpdater.quitAndInstall(false, true);
    } catch (error) {
      this.installing = false;
      this.patch({ state: "error", error: mapUpdateError(error) });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    ++this.probeGeneration;
    this.downloadCancellation?.cancel();
    await this.fastGithub.disable();
  }

  private async promptInstall(version?: string): Promise<void> {
    if (!version || this.promptedVersion === version) return;
    const window = this.hooks.getWindow();
    if (!window || window.isDestroyed()) return;
    this.promptedVersion = version;
    const result = await dialog.showMessageBox(window, {
      type: "info",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1,
      title: "更新已就绪",
      message: `新版本 ${version} 已就绪，重启后完成更新。`
    });
    if (result.response === 0) await this.install();
  }

  private configureFeed(feed: UpdateFeed, token?: string): void {
    if (feed.privateFeed && token) process.env.GH_TOKEN = token;
    else delete process.env.GH_TOKEN;
    if (this.configured) return;
    if (!feed.privateFeed) {
      autoUpdater.setFeedURL({
        provider: "custom", owner: feed.owner, repo: feed.repo, releaseType: "release",
        updateProvider: createReleaseAssetProvider(urls => { this.releaseAssets = urls; }, () => undefined)
      });
      this.configured = true;
      return;
    }
    autoUpdater.setFeedURL({
      provider: "github",
      owner: feed.owner,
      repo: feed.repo,
      private: feed.privateFeed,
      token: token || undefined,
      releaseType: "release"
    });
    this.configured = true;
  }

  private tokenPath(): string {
    return path.join(app.getPath("userData"), "github-update-token");
  }

  private async readToken(): Promise<string | undefined> {
    const file = this.tokenPath();
    if (!existsSync(file)) return undefined;
    const raw = (await fs.readFile(file, "utf8")).trim();
    if (!raw) return undefined;
    if (raw.startsWith("enc:")) {
      if (!safeStorage.isEncryptionAvailable()) return undefined;
      try {
        return safeStorage.decryptString(Buffer.from(raw.slice(4), "base64")).trim() || undefined;
      } catch {
        return undefined;
      }
    }
    return raw;
  }

  private async writeToken(token: string): Promise<void> {
    const file = this.tokenPath();
    if (!token) {
      await fs.rm(file, { force: true });
      delete process.env.GH_TOKEN;
      return;
    }
    const payload = safeStorage.isEncryptionAvailable()
      ? `enc:${safeStorage.encryptString(token).toString("base64")}`
      : token;
    await fs.writeFile(file, payload, "utf8");
  }

  private patch(update: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...update, packaged: app.isPackaged, currentVersion: app.getVersion() };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.status);
  }
}

function readUpdateFeed(): UpdateFeed | undefined {
  const file = path.join(process.resourcesPath, "app-update.yml");
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const owner = /^owner:\s*(\S+)/m.exec(text)?.[1];
  const repo = /^repo:\s*(\S+)/m.exec(text)?.[1];
  if (!owner || !repo) return undefined;
  const privateLine = /^private:\s*(true|false)/m.exec(text)?.[1];
  return { owner, repo, privateFeed: privateLine === "true" };
}

function mapUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("bad credentials")) {
    return "GitHub 拒绝了更新请求。公开 Release 仓不需要令牌；若仍失败，请稍后重试。";
  }
  if (lower.includes("404") || lower.includes("not found") || lower.includes("rate limit")) {
    return "无法读取更新源。请确认 lynshp/OGKToolBox-releases 已发布包含 latest.yml 的正式版本。";
  }
  if (lower.includes("latest.yml") || lower.includes("cannot find channel") || lower.includes("no published versions")) {
    return "未找到可用的 GitHub Release。请确认已发布包含 latest.yml 的正式版本。";
  }
  return message || "检查更新失败。";
}
