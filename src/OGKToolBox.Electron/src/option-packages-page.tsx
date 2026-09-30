import { GithubSourceHelp } from "./github-source-help";
import { useEffect, useMemo, useState } from "react";
import type { OptionDirectory, OptionPackage, PackageManifest, PackageProgress, RemoteOptionPackage } from "./bridge";

type PackageFilter = "all" | "installed" | "missing";
type DisplayPackage = OptionPackage & {
  remote?: RemoteOptionPackage;
  remoteOnly?: boolean;
  remoteState?: "current" | "update" | "unknown";
};

function formatSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function formatDate(value?: string): string { return value ? new Date(value).toLocaleString() : "—"; }
function formatVersion(value?: { major: number; minor: number; release: number }): string {
  return value ? `${value.major}.${value.minor}.${value.release}` : "未识别";
}
function localVersion(value: string): [number, number, number] {
  const numbers = value.match(/\d+/g)?.map(Number) ?? [];
  return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0];
}
function compareVersions(local: string, remote: RemoteOptionPackage): number {
  const left = localVersion(local);
  const right = [remote.version.major, remote.version.minor, remote.version.release];
  for (let index = 0; index < right.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
function formatRate(value: number): string { return value > 0 ? `${formatSize(value)}/秒` : "—"; }
function phaseLabel(phase: PackageProgress["phase"]): string {
  return phase === "downloading" ? "下载中" : phase === "verifying" ? "校验中" : phase === "extracting" ? "解压中" : phase === "installing" ? "安装中" : phase === "completed" ? "已完成" : phase === "cancelled" ? "已取消" : phase === "error" ? "失败" : "处理中";
}
export function OptionPackagesPage({ root, initialManifest, initialDirectory, activeDownloads, onDirectoryLoaded, onDownloadStarted, onRepositoryConnected }: { root: string; initialManifest?: PackageManifest | null; initialDirectory?: OptionDirectory | null; activeDownloads?: PackageProgress[]; onDirectoryLoaded?: (directory: OptionDirectory) => void; onDownloadStarted?: (progress: PackageProgress) => void; onRepositoryConnected?: (manifest: PackageManifest) => void }) {
  const [directory, setDirectory] = useState<OptionDirectory | null>(initialDirectory ?? null);
  const [selected, setSelected] = useState<DisplayPackage | undefined>();
  const [filter, setFilter] = useState<PackageFilter>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [manifest, setManifest] = useState<PackageManifest | null>(initialManifest ?? null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [manifestError, setManifestError] = useState("");
  const [batchDownloading, setBatchDownloading] = useState(false);
  const [downloads, setDownloads] = useState<Record<string, PackageProgress>>(() => Object.fromEntries((activeDownloads ?? []).filter(item => item.kind === "option").map(item => [item.downloadId, item])));
  const [deleting, setDeleting] = useState("");
  const openOption = async (directoryPath?: string) => {
    try { await window.ogk.openOptionDirectory(root, directoryPath); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "无法打开 option 文件夹。"); }
  };
  const refresh = async (showLoading = true) => {
    if (!root) return;
    if (showLoading) setLoading(true); setError("");
    try {
      const next = await window.ogk.optionPackages(root);
      setDirectory(next);
      onDirectoryLoaded?.(next);
      setSelected(current => next.packages.find(item => item.directoryPath === current?.directoryPath) ?? next.packages[0]);
    } catch (reason) {
      setDirectory(null); setSelected(undefined);
      setError(reason instanceof Error ? reason.message : "读取 option 文件夹失败。");
    } finally { if (showLoading) setLoading(false); }
  };
  const checkUpdates = async () => {
    if (manifestLoading) return;
    setManifestLoading(true); setManifestError(""); setUpdateMessage("");
    try {
      const next = await window.ogk.packageManifest();
      setManifest(next);
      onRepositoryConnected?.(next);
    }
    catch (reason) {
      setManifestError(reason instanceof Error ? reason.message : "读取 GitHub 更新清单失败。");
    }
    finally { setManifestLoading(false); }
  };
  useEffect(() => {
    setDirectory(initialDirectory ?? null);
    setSelected(initialDirectory?.packages[0]);
    setFilter("all");
    setUpdateMessage("");
    setManifestError("");
    if (!initialDirectory) void refresh();
  }, [root, initialDirectory?.directoryPath]);
  useEffect(() => { if (initialManifest) setManifest(initialManifest); }, [initialManifest]);
  useEffect(() => {
    if (!activeDownloads) return;
    setDownloads(current => {
      const next = { ...current };
      let changed = false;
      for (const progress of activeDownloads) {
        if (progress.kind !== "option") continue;
        if (["completed", "cancelled", "error"].includes(progress.phase)) {
          if (next[progress.downloadId]) { delete next[progress.downloadId]; changed = true; }
        } else if (next[progress.downloadId] !== progress) {
          next[progress.downloadId] = progress;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [activeDownloads]);
  useEffect(() => window.ogk.onPackageProgress(progress => {
    if (progress.kind !== "option") return;
    setDownloads(current => {
      if (["completed", "cancelled", "error"].includes(progress.phase)) {
        if (!current[progress.downloadId]) return current;
        const next = { ...current };
        delete next[progress.downloadId];
        return next;
      }
      return current[progress.downloadId] === progress ? current : { ...current, [progress.downloadId]: progress };
    });
  }), []);
  const remoteById = useMemo(() => new Map((manifest?.optionPackages ?? []).map(item => [item.id.toLowerCase(), item])), [manifest]);
  const localPackages = useMemo<DisplayPackage[]>(() => (directory?.packages ?? []).map(item => {
    const remote = remoteById.get(item.name.toLowerCase());
    return { ...item, remote, remoteState: remote ? (compareVersions(item.version, remote) < 0 ? "update" : "current") : "unknown" };
  }), [directory, remoteById]);
  const missingPackages = useMemo<DisplayPackage[]>(() => (manifest?.optionPackages ?? [])
    .filter(item => !directory?.packages.some(local => local.name.toLowerCase() === item.id.toLowerCase()))
    .map(item => ({ name: item.id, directoryPath: "", isValid: true, isLoaded: false, statusText: "未下载",
      version: formatVersion(item.version), fileCount: item.fileCount ?? 0, size: item.size, remote: item, remoteOnly: true,
      remoteState: "unknown" })), [directory, manifest]);
  const packages = useMemo(() => {
    if (filter === "installed") return localPackages;
    if (filter === "missing") return missingPackages;
    return [...localPackages, ...missingPackages].sort((left, right) => {
      const leftAvailable = left.remoteOnly || left.remoteState === "update";
      const rightAvailable = right.remoteOnly || right.remoteState === "update";
      return Number(rightAvailable) - Number(leftAvailable);
    });
  }, [filter, localPackages, missingPackages]);
  useEffect(() => { if (!selected || !packages.some(item => item.name === selected.name && item.directoryPath === selected.directoryPath)) setSelected(packages[0]); }, [packages, selected]);
  const invalidCount = directory?.packages.filter(item => !item.isValid).length ?? 0;
  const packageCount = directory?.packages.length ?? 0;
  const remove = async (item: DisplayPackage) => {
    if (item.remoteOnly) return;
    if (!window.confirm(`确定删除更新包“${item.name}”吗？该文件夹及其全部内容将被永久删除。\n${item.directoryPath}`)) return;
    setDeleting(item.directoryPath); setError("");
    try {
      await window.ogk.deleteOptionPackage({ root, directoryPath: item.directoryPath });
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除更新包失败。");
    } finally { setDeleting(""); }
  };
  const downloadFor = (item: DisplayPackage): PackageProgress | undefined => {
    const matches = Object.values(downloads).filter(progress => progress.kind === "option" && progress.id.toLowerCase() === item.name.toLowerCase());
    return matches[matches.length - 1];
  };
  const isDownloadActive = (progress?: PackageProgress): boolean => Boolean(progress && !["completed", "cancelled", "error"].includes(progress.phase));
  const startDownload = (item: DisplayPackage) => {
    const current = downloadFor(item);
    if (!item.remote || !root || isDownloadActive(current)) return;
    const downloadId = `option-${item.name}-${Date.now()}`;
    const initial: PackageProgress = { downloadId, kind: "option", id: item.name, phase: "downloading", received: 0,
      total: item.remote.size, percent: 0, speed: 0, message: "准备下载…" };
    setDownloads(currentDownloads => ({ ...currentDownloads, [downloadId]: initial })); onDownloadStarted?.(initial); setManifestError(""); setUpdateMessage("");
    void window.ogk.downloadPackage({ downloadId, kind: "option", id: item.name, root }).then(() => {
      setDownloads(currentDownloads => { if (!currentDownloads[downloadId]) return currentDownloads; const next = { ...currentDownloads }; delete next[downloadId]; return next; });
      void refresh();
    }).catch(reason => {
      const message = reason instanceof Error ? reason.message : "下载或安装失败。";
      if (message.includes("下载已取消")) { setDownloads(currentDownloads => { const next = { ...currentDownloads }; delete next[downloadId]; return next; }); return; }
      setDownloads(currentDownloads => currentDownloads[downloadId] ? { ...currentDownloads, [downloadId]: { ...currentDownloads[downloadId], phase: "error", error: message, message } } : currentDownloads);
    });
  };
  const downloadAllMissing = async () => {
    if (!root || batchDownloading || manifestLoading) return;
    setBatchDownloading(true); setManifestError(""); setUpdateMessage("");
    try {
      let sourceManifest = manifest;
      if (!sourceManifest) {
        sourceManifest = await window.ogk.packageManifest();
        setManifest(sourceManifest);
        onRepositoryConnected?.(sourceManifest);
      }
      const localIds = new Set((directory?.packages ?? []).map(item => item.name.toLowerCase()));
      const pending = sourceManifest.optionPackages.filter(item => !localIds.has(item.id.toLowerCase()) &&
        !Object.values(downloads).some(progress => progress.kind === "option" && progress.id.toLowerCase() === item.id.toLowerCase() && isDownloadActive(progress)));
      if (pending.length === 0) {
        setUpdateMessage("没有可下载的 Option 安装包。");
        return;
      }
      const jobs = pending.map(item => {
        const downloadId = `option-${item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const initial: PackageProgress = { downloadId, kind: "option", id: item.id, phase: "downloading", received: 0,
          total: item.size, percent: 0, speed: 0, message: "准备下载…" };
        setDownloads(current => ({ ...current, [downloadId]: initial })); onDownloadStarted?.(initial);
        const clearLocalDownload = () => setDownloads(current => {
          if (!current[downloadId]) return current;
          const next = { ...current };
          delete next[downloadId];
          return next;
        });
        return window.ogk.downloadPackage({ downloadId, kind: "option", id: item.id, root })
          .then(() => { clearLocalDownload(); return { id: item.id, ok: true as const }; })
          .catch(error => { clearLocalDownload(); return { id: item.id, ok: false as const, message: error instanceof Error ? error.message : "下载或安装失败。" }; });
      });
      const results = await Promise.all(jobs);
      const failed = results.filter(result => !result.ok);
      if (failed.length > 0) setManifestError(`批量下载完成：${results.length - failed.length} 个成功，${failed.length} 个失败（${failed.map(result => result.id).join("、")}）。`);
      else setUpdateMessage(`已完成 ${results.length} 个 Option 安装包的下载。`);
      await refresh(false);
    } catch (reason) {
      setManifestError(reason instanceof Error ? reason.message : "读取更新清单失败，无法开始批量下载。");
    } finally { setBatchDownloading(false); }
  };
  const cancelDownload = (downloadId: string) => { if (isDownloadActive(downloads[downloadId])) window.ogk.cancelPackage(downloadId); };
  const renderPackage = (item: DisplayPackage) => {
    const progress = downloadFor(item);
    const downloadActive = isDownloadActive(progress);
    return <div role="button" tabIndex={0} key={item.directoryPath || `remote-${item.name}`} className={selected?.directoryPath === item.directoryPath && selected?.name === item.name ? "option-package-row selected-row" : "option-package-row"} onClick={() => setSelected(item)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") setSelected(item); }}><span className={item.remoteOnly ? "option-package-mark missing" : item.remoteState === "update" ? "option-package-mark update" : item.isLoaded ? "option-package-mark loaded" : item.isValid ? "option-package-mark" : "option-package-mark invalid"} aria-hidden="true"/><span className="option-package-copy"><b>{item.name}</b><small>{item.remoteOnly ? `远程版本 ${item.version} · ${formatSize(item.size)}` : `${item.version} · ${formatSize(item.size)} · ${item.fileCount.toLocaleString()} 个文件`}</small>{progress && <span className={`option-row-download ${progress.phase === "error" ? "error" : ""}`} role={progress.phase === "error" ? "alert" : "status"}><span>{progress.message || phaseLabel(progress.phase)}</span><span>{progress.percent.toFixed(0)}% · {formatRate(progress.speed)}</span><i><b style={{ width: `${Math.max(0, Math.min(100, progress.percent))}%` }}/></i>{downloadActive && <button type="button" onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); cancelDownload(progress.downloadId); }}>取消</button>}</span>}</span><em className={item.remoteOnly ? "option-status missing" : item.remoteState === "update" ? "option-status update" : item.isLoaded ? "option-status loaded" : item.isValid ? "option-status" : "option-status invalid"}>{item.remoteOnly ? "未下载" : item.remoteState === "update" ? `有新版本 · ${formatVersion(item.remote?.version)}` : item.statusText}</em>{item.remote && (item.remoteOnly || item.remoteState === "update") ? <button type="button" className="option-download-row-button" aria-label={`下载 ${item.name}`} disabled={downloadActive} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); startDownload(item); }}><DownloadIcon/><span>下载</span></button> : <span className="option-delete-placeholder" aria-hidden="true"/>}{item.remoteOnly ? <span className="option-delete-placeholder" aria-hidden="true"/> : <button type="button" className="option-delete-button" aria-label={`删除 ${item.name}`} disabled={deleting === item.directoryPath} onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={event => { event.preventDefault(); event.stopPropagation(); void remove(item); }}><TrashIcon/></button>}</div>;
  };
  const category = (id: PackageFilter, label: string, count: number) => <button type="button" role="tab" aria-selected={filter === id} className={filter === id ? "option-category active" : "option-category"} onClick={() => setFilter(id)}><span>{label}</span><b>{count}</b></button>;
  const selectedStatus = selected?.remoteOnly ? "未下载" : selected?.remoteState === "update" ? `有新版本 · ${formatVersion(selected.remote?.version)}` : selected?.statusText;
  return <div className="option-packages-page">
    <div className="page-title"><div><h1>更新包管理</h1><p>同时识别 option 与 mu3_Data/StreamingAssets/GameData 中的更新包。</p></div><div className="option-page-actions"><button type="button" onClick={() => void checkUpdates()} disabled={!root || !directory || manifestLoading || batchDownloading}><span aria-hidden="true">⌁</span>{manifestLoading ? "连接中…" : "检查更新"}</button><button type="button" onClick={() => void openOption()} disabled={!root || batchDownloading}><span aria-hidden="true">□</span>打开文件夹</button><button type="button" className="primary" onClick={() => void refresh()} disabled={!root || loading || batchDownloading}><span aria-hidden="true">↻</span>{loading ? "读取中…" : "刷新"}</button></div></div>
    {(manifestError || Object.values(downloads).some(item => item.phase === "error")) && <GithubSourceHelp/>}
    {(updateMessage || manifestError) && <div className={manifestError ? "option-placeholder-notice error" : "option-placeholder-notice"} role={manifestError ? "alert" : "status"}><span aria-hidden="true">{manifestError ? "!" : "i"}</span><span>{manifestError || updateMessage}</span><button type="button" aria-label="关闭提示" onClick={() => { setUpdateMessage(""); setManifestError(""); }}>×</button></div>}
    {!root ? <div className="surface option-state"><b>尚未选择游戏目录</b><span>先在首页选择游戏目录，才能读取 option 文件夹。</span></div> : error ? <div className="surface option-state error-state"><b>读取失败</b><span>{error}</span><button type="button" onClick={() => void refresh()}>重试</button></div> : !directory ? <div className="surface option-state"><b>正在读取 option 文件夹…</b><span>正在计算更新包文件数量与大小。</span></div> : !directory.exists ? <div className="surface option-state"><b>未找到更新包目录</b><span>未找到 option 或 GameData 目录，请检查所选游戏目录。</span><code>{directory.directoryPath}</code></div> : <>
      <div className="option-directory-summary surface"><div><small>更新包目录 · Option / GameData</small><code title={(directory.directoryPaths ?? [directory.directoryPath]).join("\n")}>{(directory.directoryPaths ?? [directory.directoryPath]).join(" · ")}</code></div><div className="option-summary-stat"><b>{directory.packages.length}</b><span>个目录</span></div><div className="option-summary-stat"><b>{directory.totalFiles.toLocaleString()}</b><span>个文件</span></div><div className="option-summary-stat"><b>{formatSize(directory.totalSize)}</b><span>总大小</span></div>{invalidCount > 0 && <span className="option-warning"><span aria-hidden="true">!</span>{invalidCount} 个目录需要检查</span>}</div>
  <div className="two-pane option-package-pane"><article className="surface option-package-list"><div className="option-list-toolbar"><div className="option-category-tabs" role="tablist" aria-label="更新包分类">{category("all", "全部更新包", packageCount + missingPackages.length)}{category("installed", "本机已安装", packageCount)}{category("missing", "未下载", missingPackages.length)}</div><span>{manifest ? `${packages.length} / ${filter === "installed" ? packageCount : packageCount + missingPackages.length}` : `${packages.length} 个本地目录`}</span><button type="button" className="option-batch-download primary" onClick={() => void downloadAllMissing()} disabled={!root || !directory || manifestLoading || batchDownloading}>{batchDownloading ? "批量下载中…" : "一键下载"}</button></div><div className="scroll">{loading ? <div className="option-list-message">正在刷新…</div> : packages.length ? packages.map(renderPackage) : <div className="option-list-message">{filter === "missing" ? (manifest ? "暂无未下载更新包。" : "点击检查更新读取 GitHub 清单。") : directory.packages.length ? "没有符合条件的更新包。" : "option 文件夹为空。"}</div>}</div></article><article className="surface option-package-inspector">{selected ? <>{selected.remoteOnly ? <><div className="option-inspector-heading"><span className="option-large-mark missing">↓</span><div><h2>{selected.name}</h2><p>未下载 · 远程版本 {selected.version}</p></div></div><dl className="option-meta"><div><dt>发布资产</dt><dd title={selected.remote?.asset}>{selected.remote?.asset}</dd></div><div><dt>下载大小</dt><dd>{formatSize(selected.size)}</dd></div><div><dt>SHA-256</dt><dd title={selected.remote?.sha256}>{selected.remote?.sha256 || "—"}</dd></div><div><dt>Release</dt><dd>{manifest?.release || "—"}</dd></div></dl><div className="option-inspector-note"><span>点击从GitHub拉取更新包。</span></div></> : <><div className="option-inspector-heading"><span className={selected.isLoaded ? "option-large-mark loaded" : selected.isValid ? "option-large-mark" : "option-large-mark invalid"}>{selected.isLoaded ? <CheckIcon/> : selected.isValid ? "A" : "!"}</span><div><h2>{selected.name}</h2><p>{selectedStatus} · 版本 {selected.version}</p></div></div><dl className="option-meta"><div><dt>目录路径</dt><dd title={selected.directoryPath}>{selected.directoryPath}</dd></div><div><dt>文件数量</dt><dd>{selected.fileCount.toLocaleString()}</dd></div><div><dt>占用空间</dt><dd>{formatSize(selected.size)}</dd></div><div><dt>最后修改</dt><dd>{formatDate(selected.lastWriteTime)}</dd></div>{selected.remote && <div><dt>远程版本</dt><dd>{formatVersion(selected.remote.version)}</dd></div>}</dl>{!selected.isValid && <div className="option-inspector-note"><b>这个目录不会被扫描器加载</b><span>请确认目录名为 Axxx，并且包含可识别的 DataConfig.xml 版本信息。</span></div>}{selected.remoteState === "update" && <div className="option-inspector-note"><b>发现可用更新</b><span>远程清单版本为 {formatVersion(selected.remote?.version)}，当前目录为 {selected.version}。</span></div>}<button type="button" onClick={() => void openOption(selected.directoryPath)}><span aria-hidden="true">□</span>在文件夹中查看</button></>}</> : <div className="option-inspector-empty"><b>选择一个更新包</b><span>从列表选择目录以查看详细信息。</span></div>}</article></div>
    </>}
  </div>;
}

function TrashIcon() {
  return <svg className="material-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12m-9 0V4h6v3m-7 3v7m4-7v7m4-7v7M5 7l1 14h12l1-14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function DownloadIcon() {
  return <svg className="download-row-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
function CheckIcon() {
  return <svg className="option-check-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}
