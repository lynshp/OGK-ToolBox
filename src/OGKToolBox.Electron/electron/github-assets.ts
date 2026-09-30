// Verified against gh-proxy.com's link converter on 2026-09-18.
export const proxyNodes = ["https://gh-proxy.org", "https://v4.gh-proxy.org", "https://v6.gh-proxy.org",
  "https://cdn.gh-proxy.org", "https://axisnow.gh-proxy.org"] as const;
export type ProxyNodeResult = { node: string; latencyMs?: number; error?: string };
export function releaseAssetRepository(raw: string): { owner: string; repo: string } | undefined {
  const url = new URL(raw);
  const match = /^\/([^/]+)\/([^/]+)\/releases\/download\/[^/]+\/[^/]+$/.exec(url.pathname);
  return url.protocol === "https:" && url.hostname === "github.com" && !url.port && !url.username &&
    !url.password && !url.search && !url.hash && match ? { owner: match[1], repo: match[2] } : undefined;
}
export function proxyReleaseAsset(raw: string, owner: string, repo: string, node: string = proxyNodes[0]): string {
  const repository = releaseAssetRepository(raw);
  if (!repository || repository.owner !== owner || repository.repo !== repo || !(proxyNodes as readonly string[]).includes(node)) {
    throw new Error("GH-Proxy 仅用于公开仓库的带版本 Release 资产和已知节点");
  }
  return `${node}/${new URL(raw).href}`;
}

export async function probeProxyNodes(asset: string, fetcher: typeof fetch, signal?: AbortSignal, executable = false) {
  const repository = releaseAssetRepository(asset);
  if (!repository) throw new Error("不是可转换的公开 Release 资产链接");
  const results: ProxyNodeResult[] = await Promise.all(proxyNodes.map(async node => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 10000), start = Date.now();
    try {
      const response = await fetcher(proxyReleaseAsset(asset, repository.owner, repository.repo, node), {
        headers: { Range: "bytes=0-1" }, credentials: "omit", cache: "no-store", signal: controller.signal
      });
      if (![200, 206].includes(response.status)) throw new Error(`HTTP ${response.status}`);
      if (/text\/html/i.test(response.headers.get("content-type") ?? "")) throw new Error("返回网页而非资产");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("空响应");
      const bytes: number[] = [];
      while (bytes.length < 2) {
        const chunk = await reader.read(); if (chunk.done) break;
        for (const byte of chunk.value.subarray(0, 2 - bytes.length)) bytes.push(byte);
      }
      if (!bytes.length || (executable && (bytes[0] !== 0x4d || bytes[1] !== 0x5a))) throw new Error("资产响应无效");
      return { node, latencyMs: Date.now() - start };
    } catch (error) {
      return { node, error: controller.signal.aborted ? "检测超时或已取消" : String(error).slice(0, 300) };
    } finally { controller.abort(); clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }));
  if (signal?.aborted) throw new Error("下载已取消");
  const selected = results.filter(result => result.latencyMs !== undefined).sort((a, b) => a.latencyMs! - b.latencyMs!)[0];
  return { node: selected?.node, latencyMs: selected?.latencyMs, results };
}
