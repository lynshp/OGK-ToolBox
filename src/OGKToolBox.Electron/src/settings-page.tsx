import React, { useEffect, useState } from "react";
import type { UpdateStatus } from "./bridge";
import type { LayoutMode } from "./use-layout";
import { channelName, type UpdateSource } from "./update-models";
import { UpdateChannelPicker } from "./update-channel-picker";

const scales = [1, 1.25, 1.5, 1.75, 2] as const;
const defaultTitle = "春菜的便当盒";
const defaultIcon = "/sidebar-brand-default.jpg";

type Props = {
  layout: LayoutMode; setLayout(value: LayoutMode): void;
  dark: boolean; setDark(value: boolean): void;
  uiScale: number; setUiScale(value: number): void;
  textScale: number; setTextScale(value: number): void;
  sidebarTitle: string; setSidebarTitle(value: string): void;
  sidebarIcon: string; setSidebarIcon(value: string): void;
};

export function SettingsPage(props: Props) {
  const [section, setSection] = useState<"appearance" | "brand" | "about">(() => sessionStorage.getItem("ogk:github-settings") ? "about" : "appearance");
  useEffect(() => { sessionStorage.removeItem("ogk:github-settings"); }, []);
  const textOptions = scales.filter(scale => scale >= props.uiScale);
  return <div className="settings-page">
    <div className="settings-titlebar"><PageTitle title="设置" desc="调整外观、界面大小、文字与本地数据偏好。"/></div>
    <div className="settings-layout">
      <aside className="surface settings-nav">
        <button type="button" className={section === "appearance" ? "selected-row" : ""} onClick={() => setSection("appearance")}>外观</button>
        <button type="button" className={section === "brand" ? "selected-row" : ""} onClick={() => setSection("brand")}>自定义</button>
        <button type="button" className={section === "about" ? "selected-row" : ""} onClick={() => setSection("about")}>关于</button>
      </aside>
      <div key={section} className="settings-content">
        {section === "appearance"
          ? <>
              <article className="surface settings-panel">
              <section>
                <h2>外观</h2><p>选择适合当前工作环境的界面主题。</p>
                <div className="theme-options">
                  <button className={!props.dark ? "theme-choice selected" : "theme-choice"} onClick={() => props.setDark(false)}><i className="theme-swatch light"/>浅色</button>
                  <button className={props.dark ? "theme-choice selected" : "theme-choice"} onClick={() => props.setDark(true)}><i className="theme-swatch dark"/>深色</button>
                </div>
              </section>
              <section className="setting-row scale-setting">
                <div><h2>界面布局</h2><p>自动跟随窗口方向。竖屏布局适合 1080 × 1920 显示器，使用顶部导航并纵向排列内容。</p></div>
                <div className="scale-options" role="group" aria-label="界面布局">
                  {([["auto", "自动"], ["standard", "标准"], ["portrait", "竖屏"]] as const).map(([value, label]) =>
                    <button type="button" key={value} aria-pressed={props.layout === value} className={props.layout === value ? "selected-row" : ""} onClick={() => props.setLayout(value)}>{label}</button>)}
                </div>
              </section>
              <ScaleSetting label="UI 大小" description="调整控件、图标、间距和文字。提高 UI 大小时，文字大小会同步提高到相同档位。"
                value={props.uiScale} options={scales} onChange={props.setUiScale}/>
              <ScaleSetting label="文字大小" description={`仅提高文字及相关行距、按钮内边距与列表行高，不能低于当前 UI 大小。`}
                value={props.textScale} options={textOptions} onChange={props.setTextScale}/>
              </article>
            </>
          : section === "brand" ? <BrandSettings title={props.sidebarTitle} onTitleChange={props.setSidebarTitle}
              icon={props.sidebarIcon} onIconChange={props.setSidebarIcon}/> : <AboutPanel/>}
      </div>
    </div>
  </div>;
}


function statusLabel(status: UpdateStatus): string {
  switch (status.state) {
    case "unsupported": return status.error || "开发模式不检查更新。";
    case "checking": return `${status.phase || "正在检查更新"}…`;
    case "available": return status.phase === "检测 GH-Proxy 安装包线路" ? `${status.phase}…`
      : status.availableVersion ? `发现新版本 ${status.availableVersion}，准备下载。` : "发现新版本。";
    case "downloading": return `正在下载更新${status.progress != null ? `（${Math.round(status.progress)}%）` : "…"}`;
    case "verifying": return "下载传输结束，正在校验安装包，请稍候…";
    case "not-available": return "已是最新版本。";
    case "ready": return status.availableVersion ? `新版本 ${status.availableVersion} 已就绪，重启后完成更新。` : "更新已就绪，重启后完成更新。";
    case "error": return status.error || "检查更新失败。";
    default: return "尚未检查更新。";
  }
}

function AboutPanel() {
  const [status, setStatus] = useState<UpdateStatus>({
    packaged: false, currentVersion: "", state: "idle", hasToken: false
  });
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<UpdateSource>("auto");
  const running = busy || ["checking", "available", "downloading", "verifying"].includes(status.state);
  useEffect(() => {
    let active = true;
    void window.ogk.getUpdateStatus().then(value => { if (active) { setStatus(value); setSource(value.source ?? "auto"); } });
    const stop = window.ogk.onUpdateStatus(value => { if (active) setStatus(value); });
    return () => { active = false; stop(); };
  }, []);
  const check = async () => {
    setBusy(true);
    try { setStatus(await window.ogk.checkForUpdate(source)); }
    catch (error) {
      setStatus(current => ({
        ...current, state: "error",
        error: error instanceof Error ? error.message : "检查更新失败。"
      }));
    } finally { setBusy(false); }
  };
  const saveSources = async (nextSource: UpdateSource) => {
    setBusy(true);
    try {
      const next = await window.ogk.setGithubSources(nextSource, "auto");
      setStatus(next); setSource(nextSource);
    } catch (error) {
      setStatus(current => ({ ...current, error: String(error), state: "error" }));
    } finally { setBusy(false); }
  };
  const install = async () => {
    setBusy(true);
    try { await window.ogk.installUpdate(); }
    catch (error) {
      setStatus(current => ({
        ...current, state: "error",
        error: error instanceof Error ? error.message : "安装更新失败。"
      }));
      setBusy(false);
    }
  };
  return <article className="surface settings-panel about-panel">
    <section>
      <h2>关于</h2>
      <dl className="about-meta">
        <div><dt>当前版本</dt><dd>{status.currentVersion || "—"}</dd></div>
        <div><dt>更新源</dt><dd>github.com/lynshp/OGKToolBox-releases</dd></div>
        <div><dt>GitHub 来源</dt><dd><UpdateChannelPicker value={source} onChange={value => void saveSources(value as UpdateSource)} status={status} disabled={running}/></dd></div>
        {status.activeChannel && <div><dt>本次使用来源</dt><dd>{channelName(status.activeChannel)}</dd></div>}
        {status.activeChannel === "ghproxy" && status.proxyNode && <div><dt>GH-Proxy 可用节点</dt><dd>{status.proxyNode.replace("https://", "")}</dd></div>}
        <div><dt>更新状态</dt><dd role="status">{statusLabel(status)}</dd></div>
      </dl>
      {["downloading", "verifying"].includes(status.state) && <div className="update-progress" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.progress ?? 0}>
        <i style={{ width: `${Math.max(0, Math.min(100, status.progress ?? 0))}%` }}/>
      </div>}
      <div className="update-actions">
        <button type="button" onClick={() => void check()} disabled={running || status.state === "unsupported"}>{running ? "更新处理中…" : "检查更新"}</button>
        <button type="button" onClick={() => void install()} disabled={busy || status.state !== "ready"}>重启并安装</button>
      </div>
      <p className="update-community">加入群聊：827579852获取更新。</p>
      {!!status.diagnostics?.length && <details className="update-diagnostics">
        <summary>诊断详情</summary>
        <textarea readOnly rows={7} aria-label="更新诊断详情，可选择复制" value={`当前版本：${status.currentVersion}\n本次选择：${status.source === "auto" || !status.source ? "自动选择" : channelName(status.source)}\n${status.diagnostics.join("\n")}`}/>
      </details>}
    </section>
  </article>;
}

function PageTitle({ title, desc }: { title: string; desc: string }) {
  return <div className="page-title"><div><h1>{title}</h1><p>{desc}</p></div></div>;
}

function ScaleSetting({ label, description, value, options, onChange }: {
  label: string; description: string; value: number; options: readonly number[]; onChange(value: number): void;
}) {
  return <section className="setting-row scale-setting">
    <div><h2>{label}</h2><p>{description}</p></div>
    <div className="scale-options" role="group" aria-label={label}>
      {options.map(scale => <button type="button" key={scale} className={value === scale ? "selected-row" : ""}
        aria-pressed={value === scale} onClick={() => onChange(scale)}>{scale === 1 ? "默认" : `${scale * 100}%`}</button>)}
    </div>
  </section>;
}

function BrandSettings({ title, onTitleChange, icon, onIconChange }: {
  title: string; onTitleChange(value: string): void; icon: string; onIconChange(value: string): void;
}) {
  const [error, setError] = useState("");
  const chooseIcon = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("请选择图片文件。"); return; }
    if (file.size > 1_500_000) { setError("图片请控制在 1.5 MB 以内。"); return; }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      onIconChange(reader.result);
      setError("");
    };
    reader.onerror = () => setError("图片读取失败，请重试。");
    reader.readAsDataURL(file);
  };
  const reset = () => { onTitleChange(defaultTitle); onIconChange(defaultIcon); setError(""); };
  return <article className="surface settings-panel sidebar-brand-panel">
    <section className="sidebar-brand-heading"><h2>侧栏品牌</h2><p>自定义左侧顶部显示的标题和图标；会保存在本机。</p></section>
    <section className="sidebar-brand-controls">
      <label>标题<input value={title} maxLength={24} onChange={event => onTitleChange(event.target.value)} placeholder={defaultTitle}/></label>
      <div className="sidebar-icon-control"><img src={icon} alt="当前侧栏图标预览"/><div>
        <b>侧栏图标</b><span>支持常见图片格式，最大 1.5 MB。</span>
        <div className="sidebar-icon-actions">
          <label className="button-like">选择图片<input type="file" accept="image/*" onChange={chooseIcon}/></label>
          <button type="button" onClick={reset}>恢复默认</button>
        </div>
        {error && <small className="sidebar-brand-error">{error}</small>}
      </div></div>
    </section>
  </article>;
}
