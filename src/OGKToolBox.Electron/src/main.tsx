import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./pencil.css";
import "./page-transition.css";
import { loadInitialLibrary, libraryFailureMessage } from "./library-startup";
import { usePageTransition } from "./use-page-transition";
import { ChartPlayer } from "./chart-player";
import "./chart-player.css";
import "./portrait.css";
import "./adaptive-layout.css";
import { useLayout, type LayoutMode } from "./use-layout";
import type { Config, LibrarySection, Scan, Summary, ThumbnailCache } from "./models";
import type { OptionDirectory, PackageManifest, PackageProgress, ScanProgress } from "./bridge";
import { installPreviewBridge, previewConfig, previewScan, previewSummary } from "./preview-data";
import { SettingsPage } from "./settings-page";
import { Mods, Sega } from "./configuration-pages";
import { OptionPackagesPage } from "./option-packages-page";
import { useVirtualCardGrid, useVirtualList } from "./virtual-window";
import { ControllerPage, ControllerStatusCard, controllerStatusView, useController } from "./controller-page";
import { BundleThumbnail, useThumbnail } from "./bundle-thumbnail";
import { musicScore, sortPlayerMusic } from "./player-library";
import { PlayerPicker } from "./player-picker";
import { PlayerSavesPage } from "./player-saves-page";
import { PlayerSaveProvider, scoreKey, usePlayerSave } from "./player-save-context";
import { DifficultyBadge, MusicSaveSource, MusicScoreDetails, ScoreAchievements } from "./player-score-ui";
import { HddSetupWizard } from "./hdd-setup-wizard";

const pages = [["home","首页"],["music","乐曲"],["cards","卡片"],["characters","角色"],["option-packages","更新包管理"],["resources","资源浏览器"],["player-saves","游玩数据"],["controller","控制器"],["sega","Segatools"],["mods","Mod 管理"],["diagnostics","诊断"],["settings","设置"]] as const;
const homePage = pages.slice(0, 1);
const resourcePages = pages.slice(1, 6);
const toolPages = pages.slice(6);
const emptySummary: Summary = { gameRoot:"", musicCount:0, cardCount:0, characterCount:0, resourceCount:0, diagnosticCount:0, gameVersion:"未扫描" };
const gameRootStorageKey="ogk-toolbox.game-root.v1";
const uiScaleStorageKey="ogk-toolbox.ui-scale.v1";
const textScaleStorageKey="ogk-toolbox.text-scale.v1";
const sidebarTitleStorageKey="ogk-toolbox.sidebar-title.v1";
const sidebarIconStorageKey="ogk-toolbox.sidebar-icon.v1";
const launchOptionsStorageKey="ogk-toolbox.launch-options.v1";
type LaunchOptions={width:number;height:number;fullscreen:boolean};
const defaultLaunchOptions:LaunchOptions={width:1080,height:1920,fullscreen:true};
function storedLaunchOptions():LaunchOptions{try{const parsed=JSON.parse(window.localStorage.getItem(launchOptionsStorageKey)||"{}");return{width:Number.isInteger(parsed.width)?Math.max(320,Math.min(8192,parsed.width)):defaultLaunchOptions.width,height:Number.isInteger(parsed.height)?Math.max(320,Math.min(8192,parsed.height)):defaultLaunchOptions.height,fullscreen:parsed.fullscreen!==false};}catch{return defaultLaunchOptions;}}
const defaultSidebarTitle="春菜的便当盒";
const defaultSidebarIcon=`${import.meta.env.BASE_URL}sidebar-brand-default.jpg`;
const toolboxIcon=`${import.meta.env.BASE_URL}toolbox-icon.png`;
const uiScales=[1,1.25,1.5,1.75,2] as const;
const previewPageParam=import.meta.env.DEV?new URLSearchParams(window.location.search).get("preview"):null;
const previewPlayer=previewPageParam==="player";
const previewEmpty=import.meta.env.DEV&&new URLSearchParams(window.location.search).has("empty");
const previewError=import.meta.env.DEV&&new URLSearchParams(window.location.search).has("error");
const previewPage=(previewPlayer?"music":pages.some(([id])=>id===previewPageParam)?previewPageParam:null) as (typeof pages)[number][0]|null;
installPreviewBridge(previewError);
function App() {
 const { layout, setLayout, portrait } = useLayout();
 const loadedSections=useRef(new Set<string>());const sectionRequestSequence=useRef(0); const [bootAttempt,setBootAttempt]=useState(0); const [bootNeedsDirectory,setBootNeedsDirectory]=useState(!previewPage&&!window.localStorage.getItem(gameRootStorageKey));
 const appRef=useRef<HTMLDivElement>(null); const [page,setPage]=usePageTransition<(typeof pages)[number][0]>(previewPage??"home"); const [scan,setScan]=useState<Scan|null>(previewPage?(previewEmpty?{...previewScan,music:[],cards:[],characters:[],resources:[],diagnostics:[]}:previewScan):null); const [config,setConfigState]=useState<Config|null>(previewPage?(previewEmpty?{...previewConfig,files:[],mods:[]}:previewConfig):null); const [busy,setBusy]=useState(false); const [message,setMessage]=useState("选择游戏目录后即可建立资源索引。"); const [repositoryNotice,setRepositoryNotice]=useState(""); const [remoteManifest,setRemoteManifest]=useState<PackageManifest|null>(null); const [optionDirectory,setOptionDirectory]=useState<OptionDirectory|null>(null); const [packageDownloads,setPackageDownloads]=useState<Record<string,PackageProgress>>({}); const [scanProgress,setScanProgress]=useState<ScanProgress|null>(null); const [dark,setDark]=useState(false); const [maximized,setMaximized]=useState(false); const [bootProgress,setBootProgress]=useState(previewPage?100:0); const [bootLabel,setBootLabel]=useState(previewPage?"索引加载完成":"正在准备工作区"); const [bootReady,setBootReady]=useState(Boolean(previewPage)); const [uiScale,setUiScaleState]=useState<number>(()=>{const stored=Number(window.localStorage.getItem(uiScaleStorageKey));return uiScales.includes(stored as typeof uiScales[number])?stored:1;}); const [textScale,setTextScaleState]=useState<number>(()=>{const stored=Number(window.localStorage.getItem(textScaleStorageKey));return uiScales.includes(stored as typeof uiScales[number])&&stored>=uiScale?stored:uiScale;}); const [sidebarTitle,setSidebarTitleState]=useState(()=>window.localStorage.getItem(sidebarTitleStorageKey)||defaultSidebarTitle); const [sidebarIcon,setSidebarIconState]=useState(()=>{const stored=window.localStorage.getItem(sidebarIconStorageKey);return stored==="/sidebar-brand-default.jpg"?defaultSidebarIcon:(stored||defaultSidebarIcon)}); const [gameRoot,setGameRoot]=useState(()=>previewPage?previewSummary.gameRoot:(window.localStorage.getItem(gameRootStorageKey)??"")); const summary=scan?.summary??{...emptySummary,gameRoot};
 useEffect(()=>{const open=()=>{sessionStorage.setItem("ogk:github-settings","1");setPage("settings");};window.addEventListener("ogk:github-settings",open);return()=>window.removeEventListener("ogk:github-settings",open);},[setPage]);
 const setUiScale=(scale:number)=>{setUiScaleState(scale);window.localStorage.setItem(uiScaleStorageKey,String(scale));setTextScaleState(current=>{const next=Math.max(current,scale);window.localStorage.setItem(textScaleStorageKey,String(next));return next;});void window.ogk.setUiScale(scale);};
 const setTextScale=(scale:number)=>{const next=Math.max(scale,uiScale);setTextScaleState(next);window.localStorage.setItem(textScaleStorageKey,String(next));};
 const setSidebarTitle=(value:string)=>{const next=value.slice(0,24);setSidebarTitleState(next);window.localStorage.setItem(sidebarTitleStorageKey,next);};
 const setSidebarIcon=(value:string)=>{setSidebarIconState(value);window.localStorage.setItem(sidebarIconStorageKey,value);};
 const showRepositoryNotice=(manifest:PackageManifest)=>{setRemoteManifest(manifest);};
 useEffect(()=>{
  const preventBrowserDrag=(event:Event)=>{
   const node=event.target instanceof Node?event.target:null;
   const target=node instanceof Element?node:node?.parentElement??document.activeElement;
   const editable=target?.closest("input:not(:disabled):not([readonly]),textarea:not(:disabled):not([readonly]),[contenteditable]");
   const nativeEditing=editable instanceof HTMLInputElement||editable instanceof HTMLTextAreaElement||editable instanceof HTMLElement&&editable.isContentEditable;
   if(event.type!=="dragstart"&&nativeEditing)return;
   event.preventDefault();
  };
  document.addEventListener("dragstart",preventBrowserDrag,true);document.addEventListener("selectstart",preventBrowserDrag,true);document.addEventListener("copy",preventBrowserDrag,true);
  return()=>{document.removeEventListener("dragstart",preventBrowserDrag,true);document.removeEventListener("selectstart",preventBrowserDrag,true);document.removeEventListener("copy",preventBrowserDrag,true);};
 },[]);
 useEffect(()=>{if(previewPage)return;let active=true;void window.ogk.packageManifest().then(manifest=>{if(active)setRemoteManifest(manifest);}).catch(()=>{});return()=>{active=false;};},[]);
 useEffect(()=>window.ogk.onPackageProgress(progress=>{setPackageDownloads(current=>{if(["completed","cancelled","error"].includes(progress.phase)){if(!current[progress.downloadId])return current;const next={...current};delete next[progress.downloadId];return next;}return current[progress.downloadId]===progress?current:{...current,[progress.downloadId]:progress};});}),[]);
 const activePackageDownloads=useMemo(()=>Object.values(packageDownloads),[packageDownloads]);
 const trackPackageDownload=(progress:PackageProgress)=>setPackageDownloads(current=>({...current,[progress.downloadId]:progress}));
 useEffect(()=>{if(previewPage||!gameRoot){setOptionDirectory(null);return;}let active=true;setOptionDirectory(null);void window.ogk.optionPackages(gameRoot).then(directory=>{if(active)setOptionDirectory(directory);}).catch(()=>{if(active)setOptionDirectory(null);});return()=>{active=false;};},[gameRoot]);
 useEffect(()=>{void window.ogk.setUiScale(uiScale);},[]);
 useEffect(()=>{const root=appRef.current;if(!root)return;const growth=Math.round((textScale/uiScale-1)*10);root.style.setProperty("--titlebar-height",`${42+growth}px`);root.style.setProperty("--window-control-height",`${41+growth}px`);root.style.setProperty("--brand-height",`${72+Math.round(growth*1.5)}px`);},[textScale,uiScale]);
 useEffect(()=>{void window.ogk.isWindowMaximized().then(setMaximized);return window.ogk.onWindowStateChange(setMaximized);},[]);
 useEffect(()=>{const root=appRef.current;if(!root)return;const factor=textScale/uiScale;root.style.setProperty("--text-gap",`${Math.round((factor-1)*5)}px`);root.style.setProperty("--card-copy-min-height",`${Math.ceil(42*factor)}px`);root.style.setProperty("--card-tile-min-height","0px");const selector="button,input,select,textarea,h1,h2,h3,h4,p,b,strong,small,span,em,label,dt,dd,output,option,li";const apply=()=>{const elements=[...root.querySelectorAll<HTMLElement>(selector)];const pending=elements.filter(element=>!element.dataset.ogkTextBase);const baselines=new Map<HTMLElement,number>();for(const element of pending){const computed=Number.parseFloat(getComputedStyle(element).fontSize);if(!Number.isFinite(computed)||computed===0)continue;const inheritedFromScaledParent=Boolean(element.parentElement?.closest("[data-ogk-text-base]"));baselines.set(element,inheritedFromScaledParent?computed/factor:computed);}for(const [element,base] of baselines){element.dataset.ogkTextBase=String(base);const lineHeight=getComputedStyle(element).lineHeight;if(lineHeight.endsWith("px"))element.dataset.ogkLineBase=String(Number.parseFloat(lineHeight));}for(const element of elements){const base=Number(element.dataset.ogkTextBase);if(!Number.isFinite(base))continue;element.style.fontSize=`${base*factor}px`;const lineBase=Number(element.dataset.ogkLineBase);if(Number.isFinite(lineBase))element.style.lineHeight=`${lineBase*factor}px`;}};let frame=0;const schedule=()=>{if(frame)return;frame=requestAnimationFrame(()=>{frame=0;apply();});};apply();const observer=new MutationObserver(records=>{const hasNewTextElement=records.some(record=>[...record.addedNodes].some(node=>node instanceof Element&&(node.matches(selector)||Boolean(node.querySelector(selector)))));if(hasNewTextElement)schedule();});observer.observe(root,{childList:true,subtree:true});return()=>{observer.disconnect();if(frame)cancelAnimationFrame(frame);};},[page,scan,config,textScale,uiScale]);
 useEffect(()=>window.ogk.onScanProgress(progress=>{setScanProgress(progress);if(!bootReady){setBootProgress(progress.overallTotal>0?progress.overallPercent:progress.percent);setBootLabel(progress.phase);}}),[bootReady]);
 const configurationRequest=useRef(0);
 const refreshConfiguration=async()=>{const root=summary.gameRoot;if(!root)return;const requestId=++configurationRequest.current;try{const next=await window.ogk.inspectConfiguration(root);if(requestId===configurationRequest.current&&root===summary.gameRoot)setConfigState(next);}catch(error){if(requestId===configurationRequest.current)setMessage(error instanceof Error?error.message:"读取配置失败。");}};
 useEffect(()=>{const refresh=()=>void refreshConfiguration();window.addEventListener("ogk:configuration-changed",refresh);return()=>window.removeEventListener("ogk:configuration-changed",refresh);},[summary.gameRoot]);
 const setConfig=(next:Config|null)=>{setConfigState(next);};
 const onConfigChanged=async()=>{if(page==="sega"||page==="mods"){await refreshConfiguration();return;}setConfigState(null);};
 const scanRoot=async(root:string,navigate=true,background=false)=>{const duringBoot=!bootReady;setBusy(true);setScanProgress(null);if(duringBoot){setBootNeedsDirectory(false);setBootProgress(0);setBootLabel("正在准备扫描");}setMessage(background?"已恢复本机缓存，正在后台检查更新…":"正在扫描资源，请稍候…");try{const next=await window.ogk.scan(root);setScan(next);setGameRoot(next.summary.gameRoot);window.localStorage.setItem(gameRootStorageKey,next.summary.gameRoot);setConfig(null);setMessage(background?"缓存已在后台更新。":"扫描完成，资源索引已更新。");if(duringBoot){setBootProgress(100);setBootLabel("索引加载完成");window.setTimeout(()=>setBootReady(true),80);}if(navigate)setPage("home");}catch(error){setMessage(libraryFailureMessage(error));if(duringBoot){setBootNeedsDirectory(true);setBootProgress(0);setBootLabel("索引加载失败");}}finally{setBusy(false);}};
 const chooseAndScan=async()=>{const root=await window.ogk.chooseGameDirectory();if(!root)return;setScanProgress(null);setBootNeedsDirectory(false);setBootProgress(0);setBootLabel("正在准备工作区");setGameRoot(root);try{await window.ogk.prepareGameLauncher(root,storedLaunchOptions());}catch(error){setMessage(error instanceof Error?error.message:"启动脚本创建失败。");}await scanRoot(root);};
 const scanGame=async()=>{if(gameRoot){await scanRoot(gameRoot,false);return;}await chooseAndScan();};
 useEffect(()=>{const requestDirectory=()=>void chooseAndScan();window.addEventListener("ogk:choose-game-directory",requestDirectory);return()=>window.removeEventListener("ogk:choose-game-directory",requestDirectory);},[chooseAndScan]);
 useEffect(()=>{if(previewPage||!gameRoot)return;void window.ogk.prepareGameLauncher(gameRoot,storedLaunchOptions()).catch(error=>setMessage(error instanceof Error?error.message:"启动脚本创建失败。"));},[]);
 useEffect(()=>{
  let active=true;
  if(previewPage)return()=>{active=false;};
  const finish=()=>{if(!active)return;setBootProgress(100);setBootLabel("索引加载完成");window.setTimeout(()=>{if(active)setBootReady(true);},80);};
  void (async()=>{
   setBusy(true);setBootNeedsDirectory(false);setScanProgress(null);
   try{
    setBootProgress(12);setBootLabel("正在准备工作区");
    if(!gameRoot){setBootNeedsDirectory(true);setBootProgress(0);setBootLabel("尚未选择游戏目录");setMessage("选择游戏目录后即可建立资源索引。");return;}
    setBootProgress(28);setBootLabel("正在恢复本机索引");
    const result=await loadInitialLibrary(()=>window.ogk.cachedScan(gameRoot),()=>{
     setBootProgress(0);setBootLabel("正在准备扫描");return window.ogk.scan(gameRoot);
    },()=>active,bootAttempt>0);
    if(!result)return;
    setScan(result.value);
    setGameRoot(result.value.summary.gameRoot);window.localStorage.setItem(gameRootStorageKey,result.value.summary.gameRoot);
    setMessage(result.cached?"已从本机缓存恢复资源索引；需要更新时可手动重新扫描。":"扫描完成，资源索引已更新。");
    finish();
   }catch(error){
    if(!active)return;
    setMessage(libraryFailureMessage(error));
    setBootProgress(0);setBootLabel("索引加载失败");setBootNeedsDirectory(true);
   }finally{if(active)setBusy(false);}
  })();
  return()=>{active=false;};
 },[bootAttempt]);
 useEffect(()=>{if(previewPage||!gameRoot||!scan)return;let active=true;let attempts=0;let timer:number|undefined;const refresh=async()=>{try{const next=await window.ogk.librarySummary(gameRoot);if(!active)return;setScan(current=>current?.summary.gameRoot===gameRoot?{...current,summary:next}:current);if(/^\d+\.\d(?:-[A-Z]+)?$/.test(next.gameVersion)&&++attempts<35)timer=window.setTimeout(()=>void refresh(),1000);}catch{/* Background version detection is advisory and must not change the completed scan state. */}};timer=window.setTimeout(()=>void refresh(),500);return()=>{active=false;if(timer!==undefined)window.clearTimeout(timer);};},[gameRoot,scan?.summary.lastScanAt]);
 useEffect(()=>{const requested:LibrarySection[]=page==="cards"?["cards","characters"]:page==="player-saves"?["music"]:page==="music"||page==="characters"||page==="diagnostics"?[page]:[];if(previewPage||!gameRoot||!scan||requested.length===0)return;const scanStamp=scan.summary.lastScanAt??"";const activeRequests=new Map<string,string>();for(const kind of requested){const requestKey=`${gameRoot}\u001f${scanStamp}\u001f${kind}`;if(loadedSections.current.has(requestKey))continue;const requestId=`${requestKey}\u001f${++sectionRequestSequence.current}`;activeRequests.set(kind,requestId);void window.ogk.librarySection(gameRoot,kind,requestId).then(items=>{if(activeRequests.get(kind)!==requestId)return;loadedSections.current.add(requestKey);setScan(current=>current?.summary.gameRoot===gameRoot&&(current.summary.lastScanAt??"")===scanStamp?{...current,[kind]:items}:current);}).catch(error=>{if(activeRequests.get(kind)!==requestId)return;if(error instanceof DOMException&&error.name==="AbortError")return;setMessage(error instanceof Error?error.message:`${kind} 数据加载失败。`);}).finally(()=>{if(activeRequests.get(kind)===requestId)activeRequests.delete(kind);});}return()=>{for(const requestId of activeRequests.values())window.ogk.cancelLibrarySection(requestId);activeRequests.clear();};},[page,gameRoot,scan?.summary.lastScanAt]);
 useEffect(()=>{if(!summary.gameRoot||!["home","sega","mods"].includes(page)||config)return;void refreshConfiguration();},[page,summary.gameRoot,config]);
  return <div ref={appRef} data-layout={portrait?"portrait":"standard"} className={(dark?"app dark":"app")+(previewPage?" preview-frame":"")+(maximized?" window-maximized":"")+(bootReady?" boot-ready":" boot-active")}><BootLoadingScreen progress={bootProgress} label={bootLabel} details={scanProgress} needsDirectory={bootNeedsDirectory} error={bootLabel==="索引加载失败"?message:undefined} onRetry={gameRoot?()=>setBootAttempt(attempt=>attempt+1):undefined}/><WindowTitlebar maximized={maximized} onMinimize={()=>void window.ogk.minimizeWindow()} onToggleMaximize={()=>void window.ogk.toggleWindowMaximize().then(setMaximized)} onClose={()=>void window.ogk.closeWindow()}/>{repositoryNotice&&<div className="repository-toast" role="status" aria-live="polite"><span aria-hidden="true">✓</span><div><b>已连接仓库</b><small>{repositoryNotice.replace("已连接仓库 · ","")}</small></div><button type="button" aria-label="关闭提示" onClick={()=>setRepositoryNotice("")}>×</button></div>}<div className="app-shell"><aside><SidebarBrand title={sidebarTitle} icon={sidebarIcon}/><SidebarNavigation page={page} onNavigate={setPage}/></aside><main><header><div><strong>{pages.find(item=>item[0]===page)?.[1]}</strong>{page==="home"&&<span>{summary.gameRoot||"尚未选择游戏目录"}</span>}</div><div className="header-actions"><button onClick={chooseAndScan} disabled={busy}><MaterialIcon name="inventory_2"/>选择目录</button><button className="primary" onClick={scanGame} disabled={busy}><MaterialIcon name="refresh"/>{busy?"扫描中…":"重新扫描"}</button></div></header><section className="workspace">{content(page,summary,scan,config,message,busy,scanGame,setPage,dark,setDark,uiScale,setUiScale,textScale,setTextScale,sidebarTitle,setSidebarTitle,sidebarIcon,setSidebarIcon,onConfigChanged,remoteManifest,showRepositoryNotice,optionDirectory,activePackageDownloads,trackPackageDownload,setOptionDirectory,layout,setLayout,portrait)}</section></main></div></div>;
}
function BootLoadingScreen({progress,label,details,needsDirectory,error,onRetry}:{progress:number;label:string;details:ScanProgress|null;needsDirectory:boolean;error?:string;onRetry?:()=>void}){const firstIndexing=label==="正在扫描工具与资源"||label==="正在准备扫描"||details?.phase==="枚举资源";const percent=Math.round(Math.max(0,Math.min(100,details?.overallTotal?details.overallPercent:progress)));const directoryTitle=label==="索引加载失败"?"无法加载资源索引":"选择游戏目录";const directoryDescription=label==="索引加载失败"?"点击“重试加载”将重新扫描并建立资源清单。也可以重新选择游戏目录。":"请选择 package 或包含它的上层文件夹，软件会自动查找游戏目录。";const phaseTitle={"发现数据包":"发现数据包","建立资源文件清单":"建立资源文件清单","建立元数据清单":"建立元数据清单","枚举资源":"读取资源文件","读取元数据":"读取元数据","更新索引":"写入本地索引","完成":"索引加载完成"}[details?.phase??label]??(details?.phase??label);const count=details?.overallTotal?`已处理 ${details.overallCompleted.toLocaleString()} / ${details.overallTotal.toLocaleString()} 项` : details?.total?`当前阶段 ${details.completed.toLocaleString()} / ${details.total.toLocaleString()} 项`:details?.phase?.includes("清单")?`已发现 ${details.completed.toLocaleString()} 个文件`:"正在准备文件清单…";const determinate=Boolean(details?.overallTotal||details?.total);return <div className="boot-loading-screen" role="status" aria-live="polite"><div className="boot-loading-content"><strong>OGKToolBox</strong>{!needsDirectory&&<><div className="boot-loader-row"><div className="boot-loader-grid" aria-hidden="true">{"LOADING".split("").map((letter,index)=><div key={`${letter}-${index}`} className="boot-loader-cube" style={{animationDelay:`${index*.2}s`}}><div className="boot-loader-face boot-loader-face-front">{letter}</div><div className="boot-loader-face boot-loader-face-back"/><div className="boot-loader-face boot-loader-face-right"/><div className="boot-loader-face boot-loader-face-left"/><div className="boot-loader-face boot-loader-face-top"/><div className="boot-loader-face boot-loader-face-bottom"/></div>)}</div><span className="boot-loading-percent" aria-label={`索引加载进度 ${percent}%`}>{determinate?`${percent}%`:"…"}</span></div><progress className="boot-progress" max={100} value={determinate?percent:undefined} aria-label="索引加载进度"/><div className="boot-progress-meta"><span>{count}</span><b>{phaseTitle}</b></div>{details?.currentItem&&<code className="boot-current-file" title={details.currentItem}>当前文件：{details.currentItem}</code>}</>}<h1>{needsDirectory?directoryTitle:phaseTitle}</h1><p>{needsDirectory?directoryDescription:firstIndexing?"初次加载可能需要几分钟":"正在读取资源与建立索引，完成后将自动进入主界面"}</p>{needsDirectory&&error&&<pre className="boot-error-details" role="alert">{error}</pre>}{needsDirectory&&error&&onRetry&&<button type="button" className="boot-directory-action" onClick={onRetry}>重试加载</button>}{needsDirectory&&<button type="button" className="boot-directory-action" onClick={()=>window.dispatchEvent(new Event("ogk:choose-game-directory"))}>选择游戏目录</button>}</div></div>}
function SidebarBrand({title,icon}:{title:string;icon:string}){return <div className="brand"><b className="brand-badge">OGK</b><img className="brand-icon" src={icon} alt=""/><span>{title||defaultSidebarTitle}</span><small className="brand-subtitle">OGKToolBox · 0.3.0</small></div>}
function WindowTitlebar({maximized,onMinimize,onToggleMaximize,onClose}:{maximized:boolean;onMinimize():void;onToggleMaximize():void;onClose():void}){return <div className="window-titlebar"><div className="titlebar-drag" onDoubleClick={onToggleMaximize}><img src={toolboxIcon} alt=""/><span>OGKToolBox</span></div><div className="window-controls"><button type="button" aria-label="最小化" onClick={onMinimize}><WindowGlyph type="minimize"/></button><button type="button" aria-label={maximized?"还原窗口":"最大化窗口"} onClick={onToggleMaximize}><WindowGlyph type={maximized?"restore":"maximize"}/></button><button type="button" className="window-close" aria-label="关闭" onClick={onClose}><MaterialIcon name="close"/></button></div></div>}
function WindowGlyph({type}:{type:"minimize"|"maximize"|"restore"}){const paths={minimize:"M5 12h14",maximize:"M5 5h14v14H5z",restore:"M8 5h11v11M5 8v11h11"};return <svg className="material-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={paths[type]}/></svg>}
function SidebarNavigation({page,onNavigate}:{page:(typeof pages)[number][0];onNavigate:(page:(typeof pages)[number][0])=>void}) {
 const host=useRef<HTMLElement>(null);const indicator=useRef<HTMLSpanElement>(null);
 useLayoutEffect(()=>{const update=()=>{const nav=host.current;const active=indicator.current;const target=nav?.querySelector<HTMLElement>('button[data-nav-page="'+page+'"]');if(!nav||!active||!target)return;const navRect=nav.getBoundingClientRect();const targetRect=target.getBoundingClientRect();active.style.transform='translate3d(0, '+(targetRect.top-navRect.top)+'px, 0)';active.dataset.ready="true";};update();const nav=host.current;const target=nav?.querySelector<HTMLElement>('button[data-nav-page="'+page+'"]');const observer=typeof ResizeObserver==="undefined"?null:new ResizeObserver(update);if(nav)observer?.observe(nav);if(target)observer?.observe(target);window.addEventListener("resize",update);return()=>{observer?.disconnect();window.removeEventListener("resize",update);};},[page]);
 return <nav ref={host} aria-label="主导航"><span ref={indicator} className="nav-active-indicator" aria-hidden="true"/><NavSection items={homePage} page={page} onNavigate={onNavigate}/><NavSection label="资源" items={resourcePages} page={page} onNavigate={onNavigate}/><div className="nav-divider"/><NavSection label="工具" items={toolPages} page={page} onNavigate={onNavigate}/></nav>;
}
function NavSection({label,items,page,onNavigate}:{label?:string;items:readonly (typeof pages)[number][];page:string;onNavigate:(page:(typeof pages)[number][0])=>void}){return <section className={label?"nav-section":"nav-section home-nav-section"} aria-label={label??"首页"}>{label&&<span className="nav-section-label">{label}</span>}{items.map(([id,itemLabel])=><button key={id} data-nav-page={id} className={page===id?"selected":""} aria-current={page===id?"page":undefined} onClick={()=>onNavigate(id)}><span className="nav-icon" aria-hidden="true"><NavIcon page={id}/></span><span>{itemLabel}</span></button>)}</section>}
const iconPaths:Record<string,string>={home:"M3.5 10.5 12 3l8.5 7.5v9A1.5 1.5 0 0 1 19 21h-4.5v-6h-5v6H5a1.5 1.5 0 0 1-1.5-1.5z",library_music:"M5 4h15v13H5zM3 7v13h14M14 8v6.2a2.2 2.2 0 1 1-1.5-2.08V8h4",style:"m5 5 12-2 2 13-12 2zM5 8l-2 1 4 12 10-3",person:"M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 21a7.5 7.5 0 0 1 15 0",inventory_2:"M4 7h16v13H4zM3 4h18v3H3zM9 11h6",build:"m14.7 6.3 3-3a5 5 0 0 1-6.1 6.1L5.2 15.8a2.3 2.3 0 1 1 3 3l6.4-6.4a5 5 0 0 1 .1-6.1z",extension:"M8 3h4a2.5 2.5 0 1 0 5 0h4v6h-3a2.5 2.5 0 1 0 0 5h3v7h-7v-3a2.5 2.5 0 1 0-5 0v3H3v-7h3a2.5 2.5 0 1 0 0-5H3V3h5z",warning:"M12 3 22 20H2zM12 9v5M12 17.5v.1",settings:"M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM19 12a7 7 0 0 0-.12-1.28l2.02-1.57-2-3.46-2.5 1a7 7 0 0 0-2.2-1.28L13.82 3h-4l-.38 2.41a7 7 0 0 0-2.2 1.28l-2.5-1-2 3.46 2.02 1.57A7 7 0 0 0 4.64 12a7 7 0 0 0 .12 1.28l-2.02 1.57 2 3.46 2.5-1a7 7 0 0 0 2.2 1.28L9.82 21h4l.38-2.41a7 7 0 0 0 2.2-1.28l2.5 1 2-3.46-2.02-1.57A7 7 0 0 0 19 12z",sports_esports:"M7 8h10a4 4 0 0 1 3.8 5.3l-1 4a2 2 0 0 1-3.3 1L14.8 17H9.2l-1.7 1.3a2 2 0 0 1-3.3-1l-1-4A4 4 0 0 1 7 8zM8 11v4M6 13h4M16 12h.01M18 14h.01",gamepad:"M7 8h10a4 4 0 0 1 3.8 5.3l-1 4a2 2 0 0 1-3.3 1L14.8 17H9.2l-1.7 1.3a2 2 0 0 1-3.3-1l-1-4A4 4 0 0 1 7 8zM8 11v4M6 13h4M16 12h.01M18 14h.01",check:"m5 12 4 4L19 6",close:"M6 6l12 12M18 6 6 18",health_and_safety:"M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6zM12 8v8M8 12h8",check_circle:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm-4 9 2.5 2.5L16 9",cancel:"M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6m0-6-6 6",refresh:"M20 6v5h-5M4 18v-5h5M6.1 8A7 7 0 0 1 18 6l2 2M4 16l2 2a7 7 0 0 0 11.9-2"};function MaterialIcon({name}:{name:string}){return <svg className="material-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={iconPaths[name]??iconPaths.warning}/></svg>}
Object.assign(iconPaths,{folder_open:"M3 6.5h6l2 2h10v10H3zM3 8.5h18",manage_search:"M10.5 5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM15 15l5 5M3 3h6",troubleshoot:"M9 3a6 6 0 1 0 6 6M9 3v6h6M16 16l5 5",play_arrow:"M8 5v14l11-7z",hard_drive:"M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v10h16V7H4zm11 6h3v2h-3v-2zm-4 0h2v2h-2v-2z"});
function RoundedToolIcon(){return <svg className="material-icon nav-tool-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m22.7 19.3-9.3-9.3a5.1 5.1 0 0 0-6.8-6.8l3.1 3.1-2.4 2.4-3.1-3.1a5.1 5.1 0 0 0 6.8 6.8l9.3 9.3a1.7 1.7 0 0 0 2.4-2.4Z"/></svg>}
function NavIcon({page}:{page:string}){if(page==="sega")return <RoundedToolIcon/>;const names:Record<string,string>={home:"home",music:"library_music",cards:"style",characters:"person",resources:"inventory_2","player-saves":"folder_open",controller:"sports_esports","option-packages":"folder_open",mods:"extension",diagnostics:"warning",settings:"settings"};return <MaterialIcon name={names[page]??names.settings}/>}
 function content(page:string,summary:Summary,scan:Scan|null,config:Config|null,message:string,busy:boolean,scanGame:()=>void,setPage:(page:any)=>void,dark:boolean,setDark:(value:boolean)=>void,uiScale:number,setUiScale:(value:number)=>void,textScale:number,setTextScale:(value:number)=>void,sidebarTitle:string,setSidebarTitle:(value:string)=>void,sidebarIcon:string,setSidebarIcon:(value:string)=>void,onConfigChanged:()=>Promise<void>,remoteManifest:PackageManifest|null,onRepositoryConnected:(manifest:PackageManifest)=>void,optionDirectory:OptionDirectory|null,activeDownloads:PackageProgress[],onDownloadStarted:(progress:PackageProgress)=>void,onDirectoryLoaded:(directory:OptionDirectory)=>void,layout:LayoutMode,setLayout:(value:LayoutMode)=>void,portrait:boolean){const pageContent=(()=>{switch(page){case"home":return <Home summary={summary} config={config} message={message} busy={busy} onScan={scanGame} onChanged={onConfigChanged}/>;case"music":return <Music data={scan?.music??[]} root={summary.gameRoot}/>;case"cards":return <Cards portrait={portrait} data={scan?.cards??[]} root={summary.gameRoot} priorityCharacters={(scan?.characters??[]).filter(character=>character.modelId>=1000&&character.modelId<=1016)}/>;case"characters":return <Characters key={summary.gameRoot} data={scan?.characters??[]} root={summary.gameRoot} revision={summary.lastScanAt}/>;case"resources":return <LegacyResourceBrowser root={summary.gameRoot}/>;case"option-packages":return <OptionPackagesPage root={summary.gameRoot} initialManifest={remoteManifest} initialDirectory={optionDirectory} activeDownloads={activeDownloads} onDirectoryLoaded={onDirectoryLoaded} onDownloadStarted={onDownloadStarted} onRepositoryConnected={onRepositoryConnected}/>;case"player-saves":return <PlayerSavesPage key={summary.gameRoot} root={summary.gameRoot} music={scan?.music??[]}/>;case"controller":return <ControllerPage/>;case"sega":return <Sega config={config} root={summary.gameRoot} onChanged={onConfigChanged}/>;case"mods":return <Mods portrait={portrait} config={config} root={summary.gameRoot} onChanged={onConfigChanged} initialManifest={remoteManifest} activeDownloads={activeDownloads} onDownloadStarted={onDownloadStarted} onRepositoryConnected={onRepositoryConnected}/>;case"diagnostics":return <Diagnostics summary={summary} data={scan?.diagnostics??[]}/>;default:return <SettingsPage layout={layout} setLayout={setLayout} dark={dark} setDark={setDark} uiScale={uiScale} setUiScale={setUiScale} textScale={textScale} setTextScale={setTextScale} sidebarTitle={sidebarTitle} sidebarIcon={sidebarIcon} setSidebarTitle={setSidebarTitle} setSidebarIcon={setSidebarIcon}/>;}})();return <PlayerSaveProvider key={summary.gameRoot} root={summary.gameRoot} active={page==="music"||page==="player-saves"} savePageActive={page==="player-saves"}><div key={page} className="workspace-page-transition">{pageContent}</div></PlayerSaveProvider>;}
function Title({title,desc,action}:{title:string;desc:string;action?:React.ReactNode}){return <div className="page-title"><div><h1>{title}</h1><p>{desc}</p></div>{action}</div>;}
function Empty({text="请先在首页选择有效的游戏目录并扫描资源。"}:{text?:string}){return <div className="empty"><b>暂无内容</b><span>{text}</span></div>;}
function VirtualSpacer({height}:{height:number}){return height>0?<div className="virtual-spacer" style={{height}} aria-hidden="true"/>:null;}
function cardListBundle(card:any){return card.image?.bundlePath||card.fullIllustration?.bundlePath||card.characterImage?.bundlePath;}
function ManagedPreview({bundlePath,cache,onOpen}:{bundlePath?:string;cache?:ThumbnailCache;onOpen?():void}){const src=useThumbnail(bundlePath,cache);const contents=src?<img src={src} alt="" draggable={false} onDragStart={event=>event.preventDefault()}/>:<span>预览不可用</span>;return onOpen?<button type="button" className="preview preview-button" onClick={onOpen} disabled={!src}>{contents}</button>:<div className="preview">{contents}</div>;}
function ManagedResourcePreview({bundlePath,root}:{bundlePath?:string;root:string}){const src=useThumbnail(bundlePath,{gameRoot:root,kind:"resource"});return <div className="preview">{src?<img src={src} alt="" draggable={false} onDragStart={event=>event.preventDefault()}/>:<span>{bundlePath&&root?"正在读取图片预览…":"预览不可用"}</span>}</div>;}
function ImageViewer({title,load,onClose,alternate}:{title:string;load():Promise<string|null>;onClose():void;alternate?:{label:string;load():Promise<string|null>}}){const[src,setSrc]=useState<string|null>(null);const[showAlternate,setShowAlternate]=useState(false);const[scale,setScale]=useState(1);const[offset,setOffset]=useState({x:0,y:0});const stage=useRef<HTMLDivElement>(null);const image=useRef<HTMLImageElement>(null);const drag=useRef<{x:number;y:number;offsetX:number;offsetY:number}|null>(null);const clampOffset=(value:{x:number;y:number},targetScale=scale)=>{const host=stage.current;const target=image.current;if(!host||!target)return value;const maxX=Math.max(0,(target.offsetWidth*targetScale-(host.clientWidth-44))/2);const maxY=Math.max(0,(target.offsetHeight*targetScale-(host.clientHeight-44))/2);return{x:Math.max(-maxX,Math.min(maxX,value.x)),y:Math.max(-maxY,Math.min(maxY,value.y))}};useEffect(()=>{let active=true;setSrc(null);setScale(1);setOffset({x:0,y:0});(showAlternate&&alternate?alternate.load:load)().then(value=>{if(active)setSrc(value);}).catch(()=>{if(active)setSrc(null);});const close=(event:KeyboardEvent)=>{if(event.key==="Escape")onClose()};document.addEventListener("keydown",close);return()=>{active=false;document.removeEventListener("keydown",close);};},[showAlternate]);const exportImage=()=>{if(!src)return;const link=document.createElement("a");link.href=src;link.download=`${title||"原图"}.png`;link.click();};const zoom=(event:React.WheelEvent<HTMLDivElement>)=>{if(!src)return;event.preventDefault();setScale(value=>{const next=Math.max(1,Math.min(6,value*(event.deltaY<0?1.14:.88)));setOffset(current=>clampOffset(current,next));return next;});};const beginDrag=(event:React.PointerEvent<HTMLDivElement>)=>{if(!src||scale<=1)return;drag.current={x:event.clientX,y:event.clientY,offsetX:offset.x,offsetY:offset.y};event.currentTarget.setPointerCapture(event.pointerId);};const moveDrag=(event:React.PointerEvent<HTMLDivElement>)=>{if(!drag.current)return;setOffset(clampOffset({x:drag.current.offsetX+event.clientX-drag.current.x,y:drag.current.offsetY+event.clientY-drag.current.y}));};const endDrag=()=>{drag.current=null};const fitImage=()=>{setScale(1);setOffset({x:0,y:0});};return <div className="image-viewer-backdrop" role="presentation" onMouseDown={onClose}><section className="image-viewer" role="dialog" aria-modal="true" aria-label={`${title} 原图`} onMouseDown={event=>event.stopPropagation()}><div ref={stage} className={scale>1?"image-viewer-stage is-zoomed":"image-viewer-stage"} onDragStart={event=>event.preventDefault()} onWheel={zoom} onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>{src?<img ref={image} src={src} alt={title} draggable={false} onDragStart={event=>event.preventDefault()} onLoad={fitImage} style={{transform:`translate(${offset.x}px, ${offset.y}px) scale(${scale})`}}/>:<span>正在读取原图…</span>}</div><div className="image-viewer-actions"><button className="primary" type="button" disabled={!src} onClick={exportImage}>导出图片</button>{alternate&&<button type="button" onClick={()=>setShowAlternate(value=>!value)}>{showAlternate?"查看卡片图":alternate.label}</button>}<button type="button" onClick={onClose}>关闭</button></div></section></div>}
function Home({summary,config,message,busy,onScan,onChanged}:{summary:Summary;config:Config|null;message:string;busy:boolean;onScan():void;onChanged():Promise<void>}) {
  const { snapshot: controllerSnapshot, moduleStatus: controllerModuleStatus } = useController();
  const controllerStatus = controllerStatusView(controllerSnapshot, controllerModuleStatus);
  const [launching, setLaunching] = useState(false);
  const [launchStatus, setLaunchStatus] = useState("");
  const [launchOptions, setLaunchOptions] = useState<LaunchOptions>(storedLaunchOptions);
  const [resolutionDraft, setResolutionDraft] = useState(() => ({ width: String(launchOptions.width), height: String(launchOptions.height) }));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hddSetupOpen, setHddSetupOpen] = useState(false);
  const settingsHost = useRef<HTMLDivElement>(null);
  const hasRoot = !!summary.gameRoot;
  const hasIndex = summary.resourceCount > 0;
  const hasVersion = !!summary.gameVersion && summary.gameVersion !== "未扫描" && summary.gameVersion !== "Unknown";
  const diagnosticsReady = hasIndex && summary.diagnosticCount === 0;
  const segaToolsFile = config?.files?.find((file: any) => file.kind === "SegaTools");
  const segatoolsPending = hasRoot && !config;
  const segatoolsError = hasRoot && !!config && (!segaToolsFile?.exists || config.diagnostics.some((item: any) => String(item.code || "").startsWith("SEGATOOLS_")));
  const segatoolsReady = hasRoot && !!config && !segatoolsError;
  const healthyCount = [hasRoot, hasIndex, hasVersion, diagnosticsReady, segatoolsReady].filter(Boolean).length;
  const healthHealthy = healthyCount === 5 && controllerStatus.online;
  const controllerHealthText = controllerStatus.note;
  const controllerHealthBadge = summary.diagnosticCount ? `${summary.diagnosticCount} 项需处理` : controllerStatus.online ? "设备在线"
    : controllerStatus.detected ? controllerStatus.text : controllerModuleStatus.state === "starting" || controllerModuleStatus.state === "restarting" ? "检测中"
    : controllerModuleStatus.state === "fault" ? "模块故障" : "设备离线";
  const commitResolution = (): LaunchOptions => {
    const normalize = (value: string, fallback: number) => value.trim() && Number.isFinite(Number(value))
      ? Math.max(320, Math.min(8192, Math.round(Number(value)))) : fallback;
    const next = {
      ...launchOptions,
      width: normalize(resolutionDraft.width, launchOptions.width),
      height: normalize(resolutionDraft.height, launchOptions.height)
    };
    setResolutionDraft({ width: String(next.width), height: String(next.height) });
    setLaunchOptions(next);
    return next;
  };
  useEffect(() => { window.localStorage.setItem(launchOptionsStorageKey, JSON.stringify(launchOptions)); }, [launchOptions]);
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: MouseEvent) => {
      if (!settingsHost.current?.contains(event.target as Node)) { commitResolution(); setSettingsOpen(false); }
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { commitResolution(); setSettingsOpen(false); } };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", key); };
  }, [settingsOpen, resolutionDraft, launchOptions]);
  const updateOption = (key: "width" | "height", value: string) => setResolutionDraft(current => ({ ...current, [key]: value }));
  const launch = async () => {
    if (!hasRoot) return;
    const options = commitResolution();
    setLaunching(true);
    setLaunchStatus("");
    try {
      const result = await window.ogk.launchGame(summary.gameRoot, options);
      setLaunchStatus(`已执行 ${result.fileName}。`);
    } catch (error) {
      setLaunchStatus(error instanceof Error ? error.message : "游戏启动失败，请检查启动文件。");
    } finally {
      setLaunching(false);
    }
  };
  return <div className="home-page">
    <Title title="运行概览" desc="确认游戏环境与外设已就绪，再开始资源操作。" action={<span className="last-checked">最后检查：本次会话</span>} />
    <div className="status-grid">
      <Status icon="sports_esports" label="游戏版本" value={hasVersion ? summary.gameVersion : "—"} ok={hasVersion} note={hasVersion ? "已识别 SDDT 安装" : "等待扫描游戏目录"} />
      <Status icon="build" label="Segatools" value={segatoolsPending ? "待检测" : segatoolsReady ? "通过" : segatoolsError ? "错误" : "未检测"} note={segatoolsPending ? "正在读取 segatools.ini" : segatoolsReady ? "[vfs] 路径配置完整" : segatoolsError ? "请填写 [vfs] amfs、option、appdata" : "尚未选择游戏目录"} ok={segatoolsReady} />
      <Status icon="gamepad" label="控制器" value="未连接" note="未检测到兼容的 HID / COM 设备" muted />
    </div>
      <article className={`surface health ${healthHealthy ? "is-healthy" : ""}`}>
      <div className="health-head"><span className={`health-emblem ${healthHealthy ? "is-healthy" : ""}`}><MaterialIcon name="health_and_safety" /></span><div className="health-copy"><h2>系统健康度</h2><p>{healthyCount} 项检查通过，{controllerHealthText}</p></div><em className={healthHealthy ? "is-healthy" : controllerStatus.online && !summary.diagnosticCount ? "is-online" : undefined}>{controllerHealthBadge}</em></div>
      <div className="health-body"><div className="checks">
        <Check label="游戏目录" value={summary.gameRoot || "尚未选择游戏目录"} good={hasRoot} />
        <Check label="数据包结构" value={hasIndex ? "A000 / Option 资源已建立索引" : "等待扫描数据包结构"} good={hasIndex} />
        <Check label="游戏版本" value={hasVersion ? `检测到 ${summary.gameVersion}，资源格式可读取` : "尚未识别游戏版本"} good={hasVersion} />
        <Check label="Segatools" value={segatoolsPending ? "正在读取 segatools.ini" : segatoolsReady ? "[vfs] amfs、option、appdata 均已填写" : segatoolsError ? "[vfs] amfs、option、appdata 必须填写" : "选择目录后检测 segatools.ini"} good={segatoolsReady} />
        <Check label="资源诊断" value={summary.diagnosticCount ? `${summary.diagnosticCount} 项问题需要查看` : message} good={diagnosticsReady} />
        <Check label="控制器连接" value={controllerStatus.note} good={controllerStatus.online} />
      </div><div className="quick">
        <div className="launch-panel-heading"><h3>启动与状态</h3><div className="launch-settings" ref={settingsHost}><button type="button" className="launch-settings-trigger" aria-label="启动参数" title="启动参数" aria-expanded={settingsOpen} onClick={() => { if (settingsOpen) commitResolution(); setSettingsOpen(value => !value); }}><MaterialIcon name="settings" /></button>{settingsOpen && <section className="launch-settings-popover" role="dialog" aria-label="启动参数"><div className="launch-settings-title"><b>启动参数</b><small>下次启动时应用</small></div><label>宽度<input type="number" min="320" max="8192" step="1" value={resolutionDraft.width} onChange={event => updateOption("width", event.currentTarget.value)} onBlur={commitResolution} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label><label>高度<input type="number" min="320" max="8192" step="1" value={resolutionDraft.height} onChange={event => updateOption("height", event.currentTarget.value)} onBlur={commitResolution} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label><div className="fullscreen-setting"><span>全屏</span><button type="button" role="switch" aria-checked={launchOptions.fullscreen} className={launchOptions.fullscreen ? "setting-switch is-on" : "setting-switch"} onClick={() => setLaunchOptions(current => ({ ...current, fullscreen: !current.fullscreen }))}><i /></button></div></section>}</div></div>
        <button type="button" className="launch-game-card" onClick={() => void launch()} disabled={!hasRoot || launching}><span className="launch-copy"><small>{launching ? "正在启动…" : hasRoot ? "游戏环境已就绪" : "尚未选择游戏目录"}</small><strong>启动游戏</strong></span><span className="launch-play"><MaterialIcon name="play_arrow" /></span><span className="launch-description">{launchStatus || (hasVersion ? `${summary.gameVersion} 已识别 · 点击后将从当前目录启动游戏。` : "点击后将从当前目录启动游戏。")}</span></button>
        <span>快速操作</span><button type="button" className="hdd-setup-launch" disabled={!hasRoot || busy} onClick={() => setHddSetupOpen(true)}><MaterialIcon name="hard_drive" /><span><b>一键配置 HDD</b><small>{hasRoot ? "安装工具并完成基础运行配置" : "请先选择游戏目录"}</small></span></button>
      </div></div>
    </article>{hddSetupOpen && <HddSetupWizard root={summary.gameRoot} snapshot={controllerSnapshot} moduleStatus={controllerModuleStatus} onClose={() => setHddSetupOpen(false)} onChanged={onChanged}/>}
  </div>;
}
function ResourcePreview({bundlePath,root}:{bundlePath?:string;root:string}){const[src,setSrc]=useState<string|null>(null);const[loading,setLoading]=useState(false);const[failed,setFailed]=useState(false);useEffect(()=>{let active=true;setSrc(null);setFailed(false);if(!bundlePath||!root){setLoading(false);return()=>{active=false};}setLoading(true);void window.ogk.thumbnail(bundlePath,{gameRoot:root,kind:"resource"},"visible").then(image=>{if(active)setSrc(image);}).catch(()=>{if(active)setFailed(true);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false};},[bundlePath,root]);return <div className="preview">{src?<img src={src} alt="" draggable={false} onDragStart={event=>event.preventDefault()}/>:<span>{loading?"正在读取图片预览…":failed?"该资源没有可解码的图片":"预览不可用"}</span>}</div>}
function Status({icon,label,value,note,ok=false,muted=false}:{icon:string;label:string;value:string;note:string;ok?:boolean;muted?:boolean}){if(label==="控制器")return <ControllerStatusCard/>;return <article className={"surface status "+(muted?"muted":"")}><span className="status-leading"><MaterialIcon name={icon}/></span><div><small>{label}</small><b>{value}</b><span>{note}</span></div><span className={"status-result "+(ok?"ok":"")}><MaterialIcon name={ok?"check":"close"}/></span></article>;}
function StaticCheck({label,value,good}:{label:string;value:string;good:boolean}){return <div className="check"><span className={"check-status "+(good?"pass":"warn")}><MaterialIcon name={good?"check_circle":"cancel"}/></span><div><b>{label}</b><span>{value}</span></div><em>{good?"通过":"待处理"}</em></div>;}
function ControllerCheck(){const{snapshot,moduleStatus}=useController();const{online,note}=controllerStatusView(snapshot,moduleStatus);return <StaticCheck label="控制器连接" value={note} good={online}/>;}
function Check(props:{label:string;value:string;good:boolean}){return props.label==="控制器连接"?<ControllerCheck/>:<StaticCheck {...props}/>;}
function Music({data,root}:{data:any[];root:string}){
 const {scoreIndex}=usePlayerSave();
 const [selected,setSelected]=useState<any>();
 const [preferred,setPreferred]=useState(3),[sort,setSort]=useState("version");
 const [playerOpen,setPlayerOpen]=useState(previewPlayer),[viewerBundle,setViewerBundle]=useState<string>();
 const [q,setQ]=useState(""),[category,setCategory]=useState(""),[openFilter,setOpenFilter]=useState<string|null>(null);
 const selectedChart=selected?.charts?.find((chart:any)=>chart.difficulty===preferred);
 const categories=useMemo<FilterOption[]>(()=>[...new Set(data.map(item=>item.genre).filter(Boolean))].sort().map(value=>({value,label:value})),[data]);
 const filtered=useMemo(()=>{
   const matches=[...data].filter(item=>{
     const search=[item.title,item.artist,item.genre,item.origin?.packageId].filter(Boolean).join(" ").toLowerCase();
     return search.includes(q.toLowerCase())&&(!category||item.genre===category);
   }).sort((left,right)=>String(left.origin?.packageId||"ZZZ").localeCompare(String(right.origin?.packageId||"ZZZ"),undefined,{numeric:true})||(Number(left.id)||0)-(Number(right.id)||0));
   return sortPlayerMusic(matches,sort,preferred,scoreIndex);
 },[data,q,category,sort,preferred,scoreIndex]);
 const musicWindow=useVirtualList(filtered.length,92,4,`${q}\u001f${category}\u001f${sort}\u001f${preferred}`);
 useEffect(()=>{setSelected((value:any)=>data.find(item=>item.id===value?.id)??data[0]);setPlayerOpen(previewPlayer);},[data]);
 useEffect(()=>{if(selected&&!filtered.some(item=>item.id===selected.id))setSelected(filtered[0]);},[filtered,selected]);
 return <>
   <Title title="乐曲库" desc="乐曲、谱面与个人成绩" action={<span className="count">共 {filtered.length.toLocaleString()} 首</span>}/>
   <MusicSaveSource/>
   <div className="filter-toolbar music-filters">
     <input value={q} onChange={event=>setQ(event.target.value)} placeholder="搜索标题、作者或分类"/>
     <CardFilter id="category" label="分类" options={categories} value={category} open={openFilter==="category"} onOpenChange={setOpenFilter} onChange={setCategory}/>
     <PlayerPicker label="乐曲排序" value={sort} placeholder="排序" options={[{id:"version",title:"版本"},{id:"score",title:"游玩成绩"},{id:"constant",title:"谱面定数"}]} onChange={setSort}/>
   </div>
   <div className="two-pane music-layout music-with-scores"><article className="surface list-panel">
     <div className="music-grid-header"><span>乐曲</span><span>难度 / 成绩</span></div>
     <div className="scroll virtual-music-list" ref={musicWindow.ref}>{filtered.length?<><VirtualSpacer height={musicWindow.paddingTop}/>{filtered.slice(musicWindow.startIndex,musicWindow.endIndex).map(item=>{
       const rowScore=musicScore(scoreIndex,item.id,preferred);
       return <button className={selected?.id===item.id?"music-grid-row selected-row":"music-grid-row"} key={item.id} data-music-id={item.id} onClick={()=>setSelected(item)}>
         <span className="music-identity"><BundleThumbnail className="cover-dot row-thumb" bundlePath={item.jacket?.bundlePath} alt="" fallback="♫" cache={{gameRoot:root,kind:"music"}}/><span><b>{item.title}</b><small>{item.artist} · {item.genre}</small>{item.origin?.packageId && <span className="neutral-pill music-package-source" aria-label={`来源 ${item.origin.packageId}`}>{item.origin.packageId}</span>}</span></span>
         <span className="music-row-score">{rowScore?<><span><DifficultyBadge difficulty={rowScore.difficulty}/><strong>{rowScore.techScore.toLocaleString()}</strong></span><ScoreAchievements score={rowScore} compact/></>:<small>暂无成绩</small>}</span>
       </button>;
     })}<VirtualSpacer height={musicWindow.paddingBottom}/></>:<Empty text="没有符合当前筛选条件的乐曲。"/>}</div>
   </article><Inspector title={selected?.title} description={selected?.artist} bundle={selected?.jacket?.bundlePath} thumbnailCache={{gameRoot:root,kind:"music"}} onOpenImage={()=>setViewerBundle(selected?.jacket?.bundlePath)} headerClassName="music-inspector-heading" headerMeta={selected?.genre && <span className="neutral-pill music-genre">{selected.genre}</span>} previewAction={<button className="primary chart-open" onClick={()=>setPlayerOpen(true)} disabled={!selectedChart?.exists}>预览谱面</button>}>
     <section className="chart-picker" aria-label="关联谱面"><div className="chart-picker-heading"><b>关联谱面</b></div><div className="chart-picker-list" role="group" aria-label="选择谱面">{selected?.charts?.map((chart:any)=><button type="button" key={chart.filePath} className={selectedChart===chart?"chart-picker-row is-selected":"chart-picker-row"} aria-pressed={selectedChart===chart} onClick={()=>setPreferred(chart.difficulty)}><DifficultyBadge difficulty={chart.difficulty}/><span className="chart-level">{Number(chart.levelConstant).toFixed(2)}</span><strong className="chart-score" aria-label="技术分">{scoreIndex.get(scoreKey(selected?.id,chart.difficulty))?.techScore.toLocaleString()??"—"}</strong></button>)}</div></section>
     <MusicScoreDetails score={scoreIndex.get(scoreKey(selected?.id,selectedChart?.difficulty))} difficulty={selectedChart?.difficulty??preferred}/>
   </Inspector></div>
   {playerOpen&&selectedChart&&<ChartPlayer chart={selectedChart} music={selected} root={root} onClose={()=>setPlayerOpen(false)}/>}
   {viewerBundle&&<ImageViewer title={selected?.title||"乐曲原图"} load={()=>window.ogk.originalImage(viewerBundle)} onClose={()=>setViewerBundle(undefined)}/>}
 </>;
}
function Inspector({title,description,bundle,children,showDescription=true,thumbnailCache,onOpenImage,headerClassName,previewAction,headerMeta}:{title?:string;description?:string;bundle?:string;children?:React.ReactNode;showDescription?:boolean;thumbnailCache?:ThumbnailCache;onOpenImage?():void;headerClassName?:string;previewAction?:React.ReactNode;headerMeta?:React.ReactNode}){const preview=<ManagedPreview bundlePath={bundle} cache={thumbnailCache} onOpen={onOpenImage}/>;const heading=<>{previewAction?<div className="music-cover-actions">{preview}{previewAction}</div>:preview}<h2>{title||"选择一个项目"}</h2>{showDescription&&<p>{description||"从左侧选择资源以查看详细信息。"}</p>}{headerMeta}</>;return <article className="surface inspector">{headerClassName?<div className={headerClassName}>{heading}</div>:heading}<div className="inspector-body">{children}</div></article>;}
function ResourceInspector({root,selected}:{root:string;selected?:any}){return <article className="surface inspector"><ManagedResourcePreview bundlePath={selected?.bundlePath} root={root}/><h2>{selected?.key||"选择一个资源"}</h2><p>{selected?.bundlePath||"选择资源后将自动加载图片预览。"}</p><div className="inspector-body"><span className="neutral-pill">{selected?.kind||"未选择"}</span><Meta label="资源类型" value={selected?.kind}/><Meta label="数据包" value={selected?.origin?.packageId}/><Meta label="版本" value={selected?.versionName}/><Meta label="大小" value={selected?`${Math.round((selected.size||0)/1024)} KB`:undefined}/><button disabled={!selected} onClick={()=>void window.ogk.exportResource({root,kind:"resource-graph",itemId:selected?.id})}>导出资源引用图</button></div></article>}
function Meta({label,value}:{label:string;value?:string}){return <div className="meta"><span>{label}</span><b>{value||"—"}</b></div>;}
type FilterOption={value:string;label:string};
function CardFilter({id,label,options,value,values,open,onOpenChange,onChange,onValuesChange}:{id:string;label:string;options:FilterOption[];value?:string;values?:string[];open:boolean;onOpenChange:(id:string|null)=>void;onChange?:(value:string)=>void;onValuesChange?:(values:string[])=>void}){const host=useRef<HTMLDivElement>(null);const selected=values??[];useEffect(()=>{const close=(event:MouseEvent)=>{if(!host.current?.contains(event.target as Node))onOpenChange(null)};const key=(event:KeyboardEvent)=>{if(event.key==="Escape")onOpenChange(null)};document.addEventListener("mousedown",close);document.addEventListener("keydown",key);return()=>{document.removeEventListener("mousedown",close);document.removeEventListener("keydown",key)};},[onOpenChange]);const isMulti=!!onValuesChange;const text=isMulti?(selected.length?`${label} · ${selected.length} 项`:`全部${label}`):(value||`全部${label}`);const toggle=(option:string)=>{if(!isMulti){onChange?.(option);onOpenChange(null);return;}onValuesChange?.(selected.includes(option)?selected.filter(item=>item!==option):[...selected,option]);};return <div className="filter-control" ref={host}><button type="button" className={open?"filter-trigger open":"filter-trigger"} aria-haspopup="listbox" aria-expanded={open} onMouseDown={event=>{event.preventDefault();event.stopPropagation();onOpenChange(open?null:id)}} onClick={event=>{if(event.detail===0)onOpenChange(open?null:id)}}><span>{text}</span><span className="filter-caret" aria-hidden="true"/></button>{open&&<div className="filter-popover" role="listbox" aria-label={`${label}筛选`} aria-multiselectable={isMulti||undefined} onMouseDown={event=>event.stopPropagation()}> {isMulti&&<div className="filter-popover-head"><span>可多选</span><button type="button" onClick={()=>onValuesChange?.([])} disabled={!selected.length}>清除</button></div>}<div className="filter-options">{!isMulti&&<button type="button" role="option" aria-selected={!value} className={!value?"selected-option":""} onClick={()=>toggle("")}>全部{label}</button>}{options.map(option=>isMulti?<button type="button" role="option" aria-selected={selected.includes(option.value)} className={selected.includes(option.value)?"filter-check selected-option":"filter-check"} key={option.value} onMouseDown={event=>{event.preventDefault();event.stopPropagation();toggle(option.value)}} onClick={event=>{if(event.detail===0)toggle(option.value)}}><span className="filter-box" aria-hidden="true">✓</span><span>{option.label}</span></button>:<button type="button" role="option" aria-selected={value===option.value} className={value===option.value?"selected-option":""} key={option.value} onClick={()=>toggle(option.value)}>{option.label}</button>)}</div></div>}</div>}
function CardDetailsDialog({children,onClose,returnFocus}:{children:React.ReactNode;onClose():void;returnFocus:HTMLElement|null}) {
 const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const element=dialog.current;if(!element)return;element.showModal();return()=>{element.close();if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});};},[]);
 return createPortal(<dialog ref={dialog} className="card-details-dialog surface" aria-labelledby="card-details-title" onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===event.currentTarget){const rect=event.currentTarget.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)onClose();}}}>
   <div className="card-details-header"><b id="card-details-title">卡片详情</b><button type="button" autoFocus onClick={onClose} aria-label="关闭卡片详情">关闭</button></div>
   {children}
 </dialog>,document.querySelector(".app")!);
}
function Cards({data,root,portrait,priorityCharacters=[]}:{portrait:boolean;data:any[];root:string;priorityCharacters?:any[]}){
 const[selected,setSelected]=useState<any>();const[detailsOpen,setDetailsOpen]=useState(false);const detailsTrigger=useRef<HTMLButtonElement|null>(null);const[viewerBundle,setViewerBundle]=useState<string>();const[viewerAlternate,setViewerAlternate]=useState<string>();const[q,setQ]=useState("");const[selectedCharacters,setSelectedCharacters]=useState<string[]>([]);const[rarities,setRarities]=useState<string[]>([]);const[attributes,setAttributes]=useState<string[]>([]);const[openFilter,setOpenFilter]=useState<string|null>(null);
 const characterOptions=useMemo<FilterOption[]>(()=>{const nameCounts=priorityCharacters.reduce((counts,character)=>({...counts,[character.name]:(counts[character.name]??0)+1}),{} as Record<string,number>);const priority=priorityCharacters.filter(character=>character.name).map(character=>({value:`role:${character.id}:${encodeURIComponent(character.name)}`,label:nameCounts[character.name]>1?`${character.name} · Model ${character.modelId??character.id}`:character.name}));const knownNames=new Set(priorityCharacters.map(character=>character.name));const discovered=[...new Set(data.map(card=>card.characterName).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),"zh-Hans-CN")).filter(name=>!knownNames.has(name)).map(name=>({value:`name:${encodeURIComponent(name)}`,label:name}));return [...priority,...discovered];},[data,priorityCharacters]);
 const rarityOptions=useMemo<FilterOption[]>(()=>[...new Set(data.map(card=>card.rarity).filter(Boolean))].sort().map(value=>({value,label:value})),[data]);
 const attributeOptions=useMemo<FilterOption[]>(()=>[...new Set(data.map(card=>card.attribute).filter(Boolean))].sort().map(value=>({value,label:value})),[data]);
 const cards=useMemo(()=>data.filter(card=>{const searchable=[card.name,card.characterName,card.rarity,card.attribute].filter(Boolean).join(" ").toLowerCase();const roleMatches=selectedCharacters.some(value=>{const parts=value.split(":");return parts[0]==="role"?(String(card.characterId)===parts[1]||card.characterName===decodeURIComponent(parts[2]??"")):card.characterName===decodeURIComponent(parts[1]??"")});return searchable.includes(q.toLowerCase())&&(!selectedCharacters.length||roleMatches)&&(!rarities.length||rarities.includes(card.rarity))&&(!attributes.length||attributes.includes(card.attribute));}),[data,q,selectedCharacters,rarities,attributes]);
 const cardWindow=useVirtualCardGrid(cards.length,190,12,1,`${q}\u001f${selectedCharacters.join("|")}\u001f${rarities.join("|")}\u001f${attributes.join("|")}`);
 useEffect(()=>setSelected(cards[0]),[data]);useEffect(()=>{if(selected&&!cards.some(card=>card.id===selected.id))setSelected(cards[0]);},[cards,selected]);
 useEffect(()=>{if(!portrait)setDetailsOpen(false);},[portrait]);
 const details=<Inspector title={selected?.name} bundle={selected?.image?.bundlePath||selected?.fullIllustration?.bundlePath||selected?.characterImage?.bundlePath} thumbnailCache={{gameRoot:root,kind:"card"}} onOpenImage={()=>{setViewerBundle(selected?.image?.bundlePath||selected?.fullIllustration?.bundlePath||selected?.characterImage?.bundlePath);setViewerAlternate(selected?.characterImage?.bundlePath||selected?.fullIllustration?.bundlePath)}} showDescription={false}><span className="good-pill">{selected?.rarity||"未选择"}</span><Meta label="角色" value={selected?.characterName}/><Meta label="属性" value={selected?.attribute}/></Inspector>;
 return <><Title title="卡片库" desc="按角色、稀有度与来源浏览已扫描卡片。" action={<span className="count">共 {cards.length} 张</span>}/><div className="filter-toolbar card-filters"><input value={q} onChange={event=>setQ(event.target.value)} placeholder="搜索卡片或角色"/><CardFilter id="character" label="角色" options={characterOptions} values={selectedCharacters} open={openFilter==="character"} onOpenChange={setOpenFilter} onValuesChange={setSelectedCharacters}/><CardFilter id="rarity" label="稀有度" options={rarityOptions} values={rarities} open={openFilter==="rarity"} onOpenChange={setOpenFilter} onValuesChange={setRarities}/><CardFilter id="attribute" label="属性" options={attributeOptions} values={attributes} open={openFilter==="attribute"} onOpenChange={setOpenFilter} onValuesChange={setAttributes}/></div><div className="cards-layout"><article className="gallery virtual-card-gallery" ref={cardWindow.ref}>{cards.length?<><VirtualSpacer height={cardWindow.paddingTop}/>{cards.slice(cardWindow.startIndex,cardWindow.endIndex).map(card=><button className={selected?.id===card.id?"card-tile active":"card-tile"} key={card.id} aria-haspopup={portrait?"dialog":undefined} onClick={event=>{detailsTrigger.current=event.currentTarget;setSelected(card);setDetailsOpen(portrait)}}><BundleThumbnail className="card-art" bundlePath={cardListBundle(card)} alt={card.name} fallback={card.characterName?.slice(0,1)||"?"} cache={{gameRoot:root,kind:"card"}}/><span className="card-copy"><strong>{card.name}</strong><small>{card.characterName} · {card.rarity}</small></span></button>)}<VirtualSpacer height={cardWindow.paddingBottom}/></>:<Empty text="没有符合当前筛选条件的卡片。"/>}</article>{!portrait&&details}</div>{portrait&&detailsOpen&&selected&&!viewerBundle&&<CardDetailsDialog returnFocus={detailsTrigger.current} onClose={()=>setDetailsOpen(false)}>{details}</CardDetailsDialog>}{viewerBundle&&<ImageViewer title={selected?.name||"卡片原图"} load={()=>window.ogk.originalImage(viewerBundle)} alternate={viewerAlternate&&viewerAlternate!==viewerBundle?{label:"查看透明底插图",load:()=>window.ogk.originalImage(viewerAlternate)}:undefined} onClose={()=>{setViewerBundle(undefined);setViewerAlternate(undefined)}}/>}</>;
}
function CharacterAvatar({character,root}:{character:any;root:string}){const modelId=Number(character.modelId??character.id);const[bundled,setBundled]=useState(true);const[expressionSrc,setExpressionSrc]=useState<string|null>(null);const[loading,setLoading]=useState(false);useEffect(()=>{setBundled(true);setExpressionSrc(null);setLoading(false);},[modelId]);useEffect(()=>{let active=true;if(bundled||!root||!modelId)return()=>{active=false;};setLoading(true);window.ogk.characterExpressions({gameRoot:root,modelId}).then(items=>items[0]?window.ogk.characterExpressionPreview({bundlePath:items[0].bundlePath,spritePathId:items[0].spritePathId},root):null).then(image=>{if(active)setExpressionSrc(image);}).catch(()=>{if(active)setExpressionSrc(null);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[bundled,modelId,root]);const image=bundled?`./character-avatars/${modelId}.png`:expressionSrc;return <span className="avatar character-avatar" aria-busy={loading}>{image?<img src={image} alt="" onError={bundled?()=>setBundled(false):undefined}/>:loading?<ExpressionSkeleton/>:<MaterialIcon name="person"/>}</span>;}
function ExpressionSkeleton({className=""}:{className?:string}){return <span className={`expression-skeleton ${className}`} aria-label="正在加载表情" role="status"/>;}
const expressionPreviewKey=(expression:any)=>`${expression.bundlePath}\u001f${expression.spritePathId}`;
async function preloadExpressionPreviews(
 expressions:any[],root:string,onPreview:(expression:any,src:string|null)=>void,isActive:()=>boolean
){
 const result=new Map<string,string|null>();let next=0;
 const worker=async()=>{
  while(isActive()){
   const index=next++;if(index>=expressions.length)return;
   const expression=expressions[index];let src:string|null=null;
   try{src=await window.ogk.characterExpressionPreview({bundlePath:expression.bundlePath,spritePathId:expression.spritePathId},root);}catch{}
   if(!isActive())return;
   result.set(expressionPreviewKey(expression),src);onPreview(expression,src);
  }
 };
 await Promise.all(Array.from({length:Math.min(2,expressions.length)},worker));return result;
}
function ExpressionPreview({src,loading,onOpen}:{src:string|null;loading:boolean;onOpen?():void}){const contents=src?<img src={src} alt="" draggable={false} onDragStart={event=>event.preventDefault()}/>:<ExpressionSkeleton className="expression-preview-skeleton"/>;return onOpen?<button type="button" className="preview preview-button expression-preview" aria-busy={loading} disabled={!src} onClick={onOpen}>{contents}</button>:<div className="preview expression-preview" aria-busy={loading}>{contents}</div>;}
function Characters({data,root,revision}:{data:any[];root:string;revision?:string}){
 const characters=useMemo(()=>data.map(character=>({...character,modelId:Number(character.modelId??character.id)}))
  .filter(character=>character.modelId>=1000&&character.modelId<=1016),[data]);
 // Keep selection by identity: background updates can replace every character object.
 const[selectedModelId,setSelectedModelId]=useState<number>();
 const selected=characters.find(character=>character.modelId===selectedModelId)??characters[0];
 const modelId=selected?.modelId;
 const[expressions,setExpressions]=useState<any[]>([]);const[expressionPreviews,setExpressionPreviews]=useState<Map<string,string|null>>(new Map());const[selectedExpression,setSelectedExpression]=useState<any>();const[viewerExpression,setViewerExpression]=useState<any>();const[loading,setLoading]=useState(false);const[error,setError]=useState("");const expressionGroupKey=(expression:any)=>String(expression.name??"").match(/^Chara_\d{6}(\d{2})_Face_/i)?.[1]??String(expression.bundleKey??"");const expressionGroups=useMemo(()=>[...new Set(expressions.map(expressionGroupKey).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b),undefined,{numeric:true})),[expressions]);const expressionLetter=(index:number)=>{let value=index+1;let label="";while(value>0){value--;label=String.fromCharCode(65+value%26)+label;value=Math.floor(value/26);}return label;};const expressionInfo=(expression:any)=>{const key=expressionGroupKey(expression);const baseGroup=expressionGroups.indexOf(key);const members=expressions.filter(item=>expressionGroupKey(item)===key).sort((a,b)=>String(a.name??"").localeCompare(String(b.name??""),undefined,{numeric:true}));const position=members.indexOf(expression);const splitSecondGroup=selected?.modelId===1000&&baseGroup===1;if(splitSecondGroup)return{group:position%2===0?2:3,position:Math.floor(position/2),lettered:true,letterIndex:Math.floor(position/2)};return{group:baseGroup+1+(selected?.modelId===1000&&baseGroup>1?1:0),position,lettered:position>0,letterIndex:position-1};};const expressionLabel=(expression:any)=>{const info=expressionInfo(expression);return `${info.group}${info.lettered?`-${expressionLetter(info.letterIndex)}`:""}`;};const orderedExpressions=useMemo(()=>[...expressions].sort((a,b)=>{const left=expressionInfo(a);const right=expressionInfo(b);return left.group-right.group||left.position-right.position||String(a.name??"").localeCompare(String(b.name??""),undefined,{numeric:true});}),[expressions,expressionGroups,selected?.modelId]);

 useEffect(()=>{
  let active=true;
  setExpressions([]);setExpressionPreviews(new Map());setSelectedExpression(undefined);
  setViewerExpression(undefined);setError("");setLoading(Boolean(root&&modelId));
  if(!root||!modelId)return()=>{active=false;};
  void window.ogk.characterExpressions({gameRoot:root,modelId}).then(async items=>{
   if(!active)return;
   setExpressions(items);setSelectedExpression(items[0]);
   const previews=await preloadExpressionPreviews(items,root,(expression,src)=>{
    setExpressionPreviews(current=>{
     if(!active)return current;
     const next=new Map(current);next.set(expressionPreviewKey(expression),src);return next;
    });
   },()=>active);
   if(active)setExpressionPreviews(previews);
  }).catch(reason=>{if(active)setError(reason instanceof Error?reason.message:"表情资源读取失败。");})
   .finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[modelId,root,revision]);
 
 return <><Title title="角色库" desc="查看角色模型、立绘与旧版 UI 指定的表情精灵。"/><div className="character-layout"><article className="surface character-list">{characters.length?characters.map(character=><button className={modelId===character.modelId?"row selected-row":"row"} key={character.modelId} onClick={()=>setSelectedModelId(character.modelId)}><CharacterAvatar character={character} root={root}/><div><b>{character.name}</b><small>Model {character.modelId}</small></div></button>):<Empty/>}</article><article className="surface character-stage"><ExpressionPreview src={selectedExpression?expressionPreviews.get(expressionPreviewKey(selectedExpression))??null:null} loading={loading&&(!selectedExpression||!expressionPreviews.has(expressionPreviewKey(selectedExpression)))} onOpen={()=>setViewerExpression(selectedExpression)}/><h2>{selected?.name||"选择一个角色"}</h2><p>{selectedExpression?`表情 ${expressionLabel(selectedExpression)}`:(error||"选择左侧角色以加载可识别的表情资源。")}</p></article><article className="surface expressions"><b>表情</b>{orderedExpressions.length?orderedExpressions.map((expression:any)=><button className={selectedExpression===expression?"expression selected-row":"expression"} key={expression.bundlePath+expression.spritePathId} aria-label={`选择表情 ${expressionLabel(expression)}`} onClick={()=>setSelectedExpression(expression)}><span>{expressionLabel(expression)}</span></button>):loading?<div className="expression-loading" aria-label="正在读取表情" role="status">{Array.from({length:6},(_,index)=><ExpressionSkeleton key={index}/>)}</div>:<Empty text={error||"该角色没有可识别的旧版表情资源。"}/>}</article></div>{viewerExpression&&<ImageViewer title={`${selected?.name||"角色"} 表情 ${expressionLabel(viewerExpression)}`} load={()=>window.ogk.characterExpressionPreview({bundlePath:viewerExpression.bundlePath,spritePathId:viewerExpression.spritePathId},root)} onClose={()=>setViewerExpression(undefined)}/>}</>;
}
function Resources({data,root}:{data:any[];root:string}){const[selected,setSelected]=useState<any>();const[q,setQ]=useState("");const filtered=useMemo(()=>data.filter(item=>(item.key+item.kind+(item.origin?.packageId||"")).toLowerCase().includes(q.toLowerCase())),[data,q]);useEffect(()=>setSelected(data[0]),[data]);return <><Title title="资源浏览器" desc="浏览 UnityFS Bundle 与其中可读取的资源及来源。" action={<span className="count">共 {filtered.length.toLocaleString()} 项</span>}/><div className="filter-toolbar resource-filters"><input value={q} onChange={event=>setQ(event.target.value)} placeholder="搜索资源名、类型或数据包"/><select aria-label="资源类型"><option>全部类型</option></select><select aria-label="数据包"><option>全部数据包</option></select><button onClick={()=>void window.ogk.exportResource({root,kind:"index-json"})}>导出列表</button></div><div className="two-pane resource-pane"><article className="surface table-card"><div className="resource-grid-header"><span>资源名</span><span>类型</span><span>数据包</span><span>版本</span><span>大小</span></div>{filtered.length?<div className="scroll">{filtered.map((item,index)=><button className={selected===item?"resource-grid-row selected-row":"resource-grid-row"} key={index} onClick={()=>setSelected(item)}><span>{item.key}</span><span>{item.kind}</span><span>{item.origin?.packageId||"—"}</span><span>{item.versionName||"—"}</span><span>{Math.round((item.size||0)/1024)} KB</span></button>)}</div>:<Empty text="没有符合当前筛选条件的资源。"/>}</article><Inspector title={selected?.key} description={selected?.bundlePath||"资源预览与来源信息"} bundle={selected?.bundlePath}><span className="neutral-pill">{selected?.kind||"未选择"}</span><Meta label="资源类型" value={selected?.kind}/><Meta label="数据包" value={selected?.origin?.packageId}/><Meta label="版本" value={selected?.versionName}/><Meta label="大小" value={selected?`${Math.round((selected.size||0)/1024)} KB`:undefined}/><button disabled={!selected} onClick={()=>void window.ogk.exportResource({root,kind:"resource-graph",itemId:selected?.id})}>导出资源引用图</button></Inspector></div></>;}
function ResourceBrowser({root,data,rowHeight}:{root:string;data:any[];rowHeight:number}){
 const [selected,setSelected]=useState<any>();
 const [q,setQ]=useState("");
 const filtered=useMemo(()=>{
  const query=q.trim().toLowerCase();
  return query?data.filter(item=>[item.key,item.kind,item.origin?.packageId,item.versionName].filter(Boolean).join(" ").toLowerCase().includes(query)):data;
 },[data,q]);
 const resourceWindow=useVirtualList(filtered.length,rowHeight,8,`${root}\u001f${q}`);

 useEffect(()=>setSelected(data[0]),[data]);
 useEffect(()=>{if(selected&&!filtered.some(item=>item.id===selected.id))setSelected(filtered[0]);},[filtered,selected]);

 const rows=data.length?<div className="scroll virtual-resource-list" ref={resourceWindow.ref}>
  {filtered.length?<><VirtualSpacer height={resourceWindow.paddingTop}/>
   {filtered.slice(resourceWindow.startIndex,resourceWindow.endIndex).map(item=><button className={selected?.id===item.id?"resource-grid-row selected-row":"resource-grid-row"} key={item.id} onClick={()=>setSelected(item)}>
    <span>{item.key}</span><span>{item.kind}</span><span>{item.origin?.packageId||"—"}</span><span>{item.versionName||"—"}</span><span>{Math.round((item.size||0)/1024)} KB</span>
   </button>)}
   <VirtualSpacer height={resourceWindow.paddingBottom}/></>:<Empty text="没有符合当前筛选条件的资源。"/>}
 </div>:root?<div className="scroll resource-page-state" aria-live="polite">正在读取全部资源索引…</div>:<Empty/>;

 return <><Title title="资源浏览器" desc="已加载完整资源索引；列表采用虚拟渲染，滚动可直接定位到任意资源。" action={<span className="count">共 {data.length.toLocaleString()} 项</span>}/><div className="filter-toolbar resource-filters"><input value={q} onChange={event=>setQ(event.target.value)} placeholder="搜索资源名或数据包"/><button onClick={()=>void window.ogk.exportResource({root,kind:"index-json"})}>导出列表</button></div><div className="two-pane resource-pane"><article className="surface table-card"><div className="resource-grid-header"><span>资源名</span><span>类型</span><span>数据包</span><span>版本</span><span>大小</span></div>{rows}</article><ResourceInspector root={root} selected={selected}/></div></>
}

function LegacyResourceBrowser({root}:{root:string}){
 const pageSize=100;const[items,setItems]=useState<any[]>([]);const[total,setTotal]=useState(0);const[offset,setOffset]=useState(0);const[selected,setSelected]=useState<any>();const[previewBundle,setPreviewBundle]=useState<string>();const[q,setQ]=useState("");const[search,setSearch]=useState("");const[loading,setLoading]=useState(false);const[error,setError]=useState("");
 useEffect(()=>{const timer=setTimeout(()=>{setOffset(0);setSearch(q)},250);return()=>clearTimeout(timer)},[q]);
  useEffect(()=>{let active=true;if(!root){setItems([]);setTotal(0);setPreviewBundle(undefined);return()=>{active=false}}setLoading(true);setError("");void window.ogk.resourcePage(root,{offset,limit:pageSize,search}).then(result=>{if(!active)return;const next=result.items.find(item=>item.id===selected?.id)??result.items[0];setItems(result.items);setTotal(result.total);setSelected(next);setPreviewBundle(next?.bundlePath);}).catch(reason=>{if(active){setItems([]);setTotal(0);setPreviewBundle(undefined);setError(reason instanceof Error?reason.message:"资源读取失败。");}}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[root,offset,search]);
 const page=Math.floor(offset/pageSize)+1;const pageCount=Math.max(1,Math.ceil(total/pageSize));
 return <><Title title="资源浏览器" desc="浏览 UnityFS Bundle 与其中可读取的资源及来源。" action={<span className="count">共 {total.toLocaleString()} 项</span>}/><div className="filter-toolbar resource-filters"><input value={q} onChange={event=>setQ(event.target.value)} placeholder="搜索资源名或数据包"/><button onClick={()=>void window.ogk.exportResource({root,kind:"index-json"})}>导出列表</button></div><div className="two-pane resource-pane"><article className="surface table-card"><div className="resource-grid-header"><span>资源名</span><span>类型</span><span>数据包</span><span>版本</span><span>大小</span></div>{loading?<div className="resource-page-state">正在读取资源…</div>:items.length?<div className="scroll">{items.map(item=><button className={selected?.id===item.id?"resource-grid-row selected-row":"resource-grid-row"} key={item.id} onClick={()=>{setSelected(item);setPreviewBundle(item.bundlePath)}}><span>{item.key}</span><span>{item.kind}</span><span>{item.origin?.packageId||"—"}</span><span>{item.versionName||"—"}</span><span>{Math.round((item.size||0)/1024)} KB</span></button>)}</div>:<Empty text={error||"没有符合当前筛选条件的资源。"}/>}<div className="resource-pager"><button disabled={loading||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-pageSize))}>上一页</button><span>第 {page.toLocaleString()} / {pageCount.toLocaleString()} 页</span><button disabled={loading||offset+pageSize>=total} onClick={()=>setOffset(value=>value+pageSize)}>下一页</button></div></article><Inspector title={selected?.key} description={selected?.bundlePath||"资源预览与来源信息"} bundle={previewBundle} thumbnailCache={{gameRoot:root,kind:"resource"}}><span className="neutral-pill">{selected?.kind||"未选择"}</span><Meta label="资源类型" value={selected?.kind}/><Meta label="数据包" value={selected?.origin?.packageId}/><Meta label="版本" value={selected?.versionName}/><Meta label="大小" value={selected?`${Math.round((selected.size||0)/1024)} KB`:undefined}/><button disabled={!selected} onClick={()=>void window.ogk.exportResource({root,kind:"resource-graph",itemId:selected?.id})}>导出资源引用图</button></Inspector></div></>
}
function diagnosticSeverity(value: unknown): "严重" | "警告" | "信息" {
 const normalized=String(value??"").toLowerCase();
 if(normalized==="2"||normalized==="error"||normalized==="critical"||normalized.includes("错误")||normalized.includes("严重"))return "严重";
 if(normalized==="1"||normalized==="warning"||normalized.includes("警告"))return "警告";
 return "信息";
}
function Diagnostics({summary,data}:{summary:Summary;data:any[]}) {
 const [query,setQuery]=useState("");const [severity,setSeverity]=useState("");const [source,setSource]=useState("");const [openFilter,setOpenFilter]=useState<string|null>(null);
 const filtered=data.filter(item=>(!severity||diagnosticSeverity(item.severity)===severity)&&(!source||item.sourcePath===source)&&`${item.code} ${item.message} ${item.sourcePath??""}`.toLowerCase().includes(query.toLowerCase()));
 const errorCount=data.filter(item=>diagnosticSeverity(item.severity)==="严重").length;
 const warningCount=data.filter(item=>diagnosticSeverity(item.severity)==="警告").length;
 const informationCount=data.filter(item=>diagnosticSeverity(item.severity)==="信息").length;
 return <><Title title="诊断中心" desc="集中查看资源扫描、覆盖关系与兼容性问题。" action={<button onClick={()=>void window.ogk.exportResource({root:summary.gameRoot,kind:"index-json"})}>导出报告</button>}/>
 <div className="metric-row"><Metric label="严重" value={String(errorCount)}/><Metric label="警告" value={String(warningCount)}/><Metric label="信息" value={String(informationCount)}/><Metric label="已忽略" value="0"/></div>
 <div className="filter-toolbar diagnostic-filters"><input placeholder="搜索代码、消息或路径" value={query} onChange={event=>setQuery(event.currentTarget.value)}/><CardFilter id="severity" label="级别" options={["严重","警告","信息"].map(value=>({value,label:value}))} value={severity} onChange={setSeverity} open={openFilter==="severity"} onOpenChange={setOpenFilter}/><CardFilter id="source" label="来源" options={Array.from(new Set<string>(data.map(item=>item.sourcePath).filter(Boolean))).map(value=>({value,label:value}))} value={source} onChange={setSource} open={openFilter==="source"} onOpenChange={setOpenFilter}/></div>
 <article className="surface table-card diagnostic-table"><div className="diagnostic-header"><span>级别</span><span>代码</span><span>问题</span><span>来源</span></div>{filtered.length===0?<Empty text={data.length?"没有符合筛选条件的诊断问题。":"当前扫描未产生诊断问题。"}/>:filtered.map((item,index)=>(<div className="diagnostic-row" key={index}><span className="severity">{diagnosticSeverity(item.severity)}</span><b>{item.code}</b><span>{item.message}</span><small>{item.sourcePath}</small></div>))}</article></>;
}
function Metric({label,value}:{label:string;value:string}){return <article className="surface metric"><small>{label}</small><b>{value}</b></article>;}



const rootElement = document.getElementById("root")!;
const rootWindow = window as typeof window & { __ogkReactRoot?: ReturnType<typeof createRoot> };
(rootWindow.__ogkReactRoot ??= createRoot(rootElement)).render(<App />);
