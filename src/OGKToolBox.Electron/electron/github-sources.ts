import { app, session } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fastGithubManager } from "./fastgithub-manager";
import { proxyNodes, probeProxyNodes, releaseAssetRepository, type ProxyNodeResult } from "./github-assets";
import type { DownloadSource, UpdateSource } from "../src/update-models";

export type GithubSettings = { source: UpdateSource; downloadSource: DownloadSource };
export class GithubSources {
  private settings: GithubSettings = { source: "auto", downloadSource: "auto" };
  private loaded?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  onNodes?: (results: ProxyNodeResult[], selected?: string) => void;
  async load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const data = JSON.parse(await fs.readFile(this.file(), "utf8"));
        const source = data.schema === 2 ? data.source : "auto";
        this.validate(source, "auto"); this.settings = { source, downloadSource: "auto" };
      } catch { /* Missing or invalid preferences use safe defaults. */ }
    })();
    return this.loaded;
  }
  get() { return { ...this.settings }; }
  private file() { return path.join(app.getPath("userData"), "github-sources.json"); }
  validate(source: unknown, downloadSource: unknown): asserts source is UpdateSource {
    if (typeof source !== "string" || typeof downloadSource !== "string" || !["auto", "fastgithub", "github", "ghproxy"].includes(source) || !["auto", "ghproxy", "origin"].includes(downloadSource)) throw new Error("GitHub 来源设置无效");
  }
  async save(source: UpdateSource, downloadSource: DownloadSource = "auto"): Promise<void> {
    this.validate(source, downloadSource); await this.load();
    const value = { schema: 2, source, downloadSource: "auto" as const };
    const write = this.writes.catch(() => {}).then(async () => {
      await fs.writeFile(this.file(), JSON.stringify(value), "utf8"); this.settings = {source, downloadSource:"auto"};
    });
    this.writes = write; await write;
  }
  private async direct(input: string, init?: RequestInit) {
    const target = session.fromPartition("ogk-github-direct", { cache: false });
    // This session is always direct; no other workload can switch its proxy.
    await target.setProxy({ mode: "direct" });
    return target.fetch(input, init);
  }
  async selectAsset(asset: string, signal?: AbortSignal, executable = false) {
    const result = await probeProxyNodes(asset, (input, init) => this.direct(String(input), init), signal, executable);
    this.onNodes?.(result.results, result.node);
    return result;
  }
  private preferred?: "fastgithub" | "github" | "ghproxy";
  useChannel(channel: "fastgithub" | "github" | "ghproxy") { this.preferred = channel; }
  async probeMetadata(input: string, onProgress?: (results: ProxyNodeResult[], selected?: string) => void) {
    const results: ProxyNodeResult[] = [];
    let selected: ProxyNodeResult | undefined;
    const probes = proxyNodes.map(async node => {
      const start = Date.now();
      try { const response = await this.request(`${node}/${input}`, {cache:"no-store",credentials:"omit"}, false, true);
        const body = await response.text();
        const info = require("js-yaml").load(body);
        if (!response.ok || typeof info?.version !== "string" || !Array.isArray(info.files)) throw new Error(`版本信息无效 HTTP ${response.status}`);
        const file = info.files.find((item: any) => typeof item.url === "string" && item.url.endsWith(".exe") && item.sha512);
        if (!file || !/^[A-Za-z0-9_.%-]+$/.test(file.url)) throw new Error("版本清单缺少有效安装包");
        const controller = new AbortController(); const deadline = setTimeout(()=>controller.abort(),10000);
        try {
          const asset = await this.direct(`${node}/${input.replace(/latest\.yml$/, file.url)}`, {signal:controller.signal,headers:{Range:"bytes=0-1"},credentials:"omit",cache:"no-store"});
          if (![200,206].includes(asset.status)) throw new Error(`安装包 HTTP ${asset.status}`);
          const reader = asset.body?.getReader(); if (!reader) throw new Error("安装包响应为空");
          const bytes: number[]=[];
          while(bytes.length<2){const chunk=await reader.read();if(chunk.done)break;bytes.push(...chunk.value.subarray(0,2-bytes.length));}
          if(bytes[0]!==0x4d || bytes[1]!==0x5a)throw new Error("安装包响应无效");
        } finally {controller.abort();clearTimeout(deadline);}
        return {node,latencyMs:Date.now()-start};
      } catch(error) { return {node,error:String(error)}; }
    }).map(probe => probe.then(result => {
      results.push(result);
      if (result.latencyMs !== undefined && !selected) selected = result;
      onProgress?.([...results], selected?.node);
      if (result.latencyMs === undefined) throw new Error(result.error);
      return result;
    }));
    // Promise.any observes every rejection, while slow nodes keep reporting in the background.
    try { await Promise.any(probes); } catch { /* All nodes failed; return their diagnostics. */ }
    return {node:selected?.node,latencyMs:selected?.latencyMs,results:[...results]};
  }
  async fetch(input: string, init: RequestInit = {}): Promise<Response> {
    await this.load(); const policy = this.get();
    const repository = releaseAssetRepository(input);
    const headers = new Headers(init.headers);
    const url = new URL(input);
    const canProxy = !headers.has("authorization") && !headers.has("cookie") && !url.username && !url.password &&
      ["github.com", "api.github.com", "raw.githubusercontent.com"].includes(url.hostname) && url.protocol === "https:";
    const errors: string[] = [];
    const defaults = ["fastgithub", "ghproxy", "github"] as const;
    const routes = policy.source === "auto" ? [...new Set([...(this.preferred ? [this.preferred] : []), ...defaults])] : [policy.source];
    for (const route of routes) {
      if (init.signal?.aborted) throw new Error("请求已取消");
      if (route === "ghproxy") {
        if (!canProxy) { errors.push("GH-Proxy 不转发带凭据或非公开 GitHub 请求"); continue; }
        const nodes = repository ? (await this.selectAsset(input, init.signal ?? undefined)).results
          .filter(row=>row.latencyMs!==undefined).sort((a,b)=>a.latencyMs!-b.latencyMs!).map(row=>row.node) : [...proxyNodes];
        for (const node of nodes) {
          try {
            const response = await this.request(`${node}/${input}`, {...init, credentials:"omit"}, false, !repository);
            if (!response.ok) { void response.body?.cancel().catch(()=>{}); throw new Error(`HTTP ${response.status}`); }
            return response;
          } catch(error) { errors.push(`${node}: ${String(error)}`); }
        }
        if (!nodes.length) errors.push("GH-Proxy 所有节点检测失败");
        continue;
      }
      try {
        const response = await this.request(input, init, route === "fastgithub", !repository);
        if (!response.ok) { void response.body?.cancel().catch(()=>{}); throw new Error(`HTTP ${response.status}`); }
        return response;
      } catch (error) { errors.push(`${route}: ${String(error)}`); }
    }
    throw new Error(`GitHub 拉取失败，请前往设置检查来源。${errors.join("；")}`);
  }
  private async request(input: string, init: RequestInit, fast: boolean, metadata: boolean): Promise<Response> {
    const controller = new AbortController(), abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
    const timer = setTimeout(abort, 15000);
    try {
      const request = { ...init, signal: controller.signal };
      const response = fast ? await fastGithubManager.fetch(input, request, true) : await this.direct(input, request);
      // Buffer only small metadata responses so body timeouts can also switch routes.
      if (!metadata || !response.ok) return response;
      const body = await response.text();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } finally {
      clearTimeout(timer);
      // Asset streams retain cancellation until the owning package request ends.
      if (metadata) init.signal?.removeEventListener("abort", abort);
    }
  }
}
export const githubSources = new GithubSources();
