import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { HddSetupInspection } from "./bridge";
import type { ControllerModuleStatus, ControllerSnapshot } from "./controller-models";
import "./hdd-setup-wizard.css";

type Step = "segatools" | "icf" | "vfs" | "mod" | "server" | "controller" | "complete" | "incomplete";
type Change = { section: string; key: string; value: string; removeIfEmpty?: boolean };

const steps: readonly { id: Exclude<Step, "complete" | "incomplete">; label: string }[] = [
  { id: "segatools", label: "Segatools" }, { id: "icf", label: "ICF" }, { id: "vfs", label: "目录" },
  { id: "mod", label: "Mod" }, { id: "server", label: "网络" }, { id: "controller", label: "控制器" }
];
const serverOptions = [
  { value: "ea.naominet.live", label: "Rin Net", portal: "rinnet", needsKeychip: true },
  { value: "nageki-net.com", label: "Nageki Net", portal: "nageki", needsKeychip: false },
  { value: "play.mumur.net", label: "MuNet", portal: "munet", needsKeychip: true }
] as const;

function findEntry(file: any, section: string, key: string) {
  return (file?.entries ?? []).find((entry: any) => String(entry.section).toLowerCase() === section.toLowerCase() && String(entry.key).toLowerCase() === key.toLowerCase());
}

function isKeychipEntry(entry: any) {
  return String(entry?.section).toLowerCase() === "keychip" && String(entry?.key).toLowerCase() === "id";
}

function makeEdit(entry: any, change: Change) {
  return {
    lineNumber: entry.lineNumber, locator: entry.locator, originalValue: entry.value, newValue: change.value,
    section: entry.section, key: entry.key, remove: Boolean(change.removeIfEmpty && change.value === "" && entry.isPresent)
  };
}

async function saveSegatools(root: string, changes: Change[]): Promise<void> {
  const configuration = await window.ogk.inspectConfiguration(root);
  const file = (configuration.files ?? []).find((item: any) => item.kind === "SegaTools");
  if (!file?.exists) throw new Error("未找到 segatools.ini，请返回 Segatools 步骤安装后重试。");
  const edits = changes.map(change => {
    const entry = findEntry(file, change.section, change.key);
    if (!entry) throw new Error(`未找到 [${change.section}] ${change.key} 配置项。`);
    const edit = makeEdit(entry, change);
    const shouldCommentKeychip = isKeychipEntry(entry) && Number(entry.lineNumber) > 0 && change.value.trim() === "";
    return { edit, shouldCommentKeychip };
  }).filter(({ edit, shouldCommentKeychip }: any) =>
    edit.remove || shouldCommentKeychip || String(edit.originalValue ?? "") !== edit.newValue
  ).map(({ edit }: any) => edit);
  if (!edits.length) return;
  const preview = await window.ogk.previewConfiguration({ gameRoot: root, kind: file.kind, baselineHash: file.contentHash, edits });
  if (!preview?.canSave) throw new Error(preview?.validationErrors?.join(" ") || "Segatools 配置未通过校验。");
  await window.ogk.saveConfiguration({ gameRoot: root, preview });
  window.dispatchEvent(new Event("ogk:configuration-changed"));
}

function StepState({ ok, children }: { ok: boolean; children: ReactNode }) {
  return <span className={ok ? "hdd-state is-ok" : "hdd-state is-warn"}><i aria-hidden="true">{ok ? "✓" : "!"}</i>{children}</span>;
}

export function HddSetupWizard({ root, snapshot, moduleStatus, onClose, onChanged }: {
  root: string; snapshot: ControllerSnapshot; moduleStatus: ControllerModuleStatus; onClose(): void; onChanged(): Promise<void>;
}) {
  const [step, setStep] = useState<Step>("segatools");
  const [inspection, setInspection] = useState<HddSetupInspection | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [server, setServer] = useState("");
  const [customServer, setCustomServer] = useState("");
  const [keychip, setKeychip] = useState("");
  const [currentKeychip, setCurrentKeychip] = useState("");
  const [controllerChoice, setControllerChoice] = useState<"mu3io" | "keyboard" | "io4" | "">("");
  const [selectedMu3ioFile, setSelectedMu3ioFile] = useState("");
  const [confirmSegatools, setConfirmSegatools] = useState(false);
  const [confirmIcf, setConfirmIcf] = useState(false);
  // Installing the game IO only needs a connected, recognized device. Home's
  // online status also requires input/configuration readback, which can still
  // be pending (or have timed out) on hardware supported by NYAGEKI_IO.
  const detectedController = moduleStatus.state === "ready" &&
    (snapshot.identity.kind === "Leonardo" || snapshot.identity.kind === "Pico") &&
    !["Disabled", "Searching", "BootloaderPending", "Faulted"].includes(snapshot.state);
  const supportedController = detectedController && snapshot.state !== "Unsupported";
  const controllerName = snapshot.identity.kind === "Pico" ? "LUXIS" : "NYAGEKI";
  const otherControllerDetected = moduleStatus.state === "ready" && snapshot.identity.kind !== "Unknown" &&
    !["Disabled", "Searching", "BootloaderPending", "Faulted"].includes(snapshot.state);
  const manualControllerMessage = detectedController ? `已检测到 ${controllerName}，当前固件协议不受支持`
    : otherControllerDetected ? `已检测到 ${snapshot.identity.displayName}，请选择游戏输入方式` : "未检测到支持的控制器";
  const stepIndex = steps.findIndex(item => item.id === step);

  useEffect(() => {
    let active = true;
    void Promise.all([window.ogk.inspectHddSetup(root), window.ogk.inspectConfiguration(root)]).then(([next, configuration]) => {
      if (!active) return;
      setInspection(next);
      const file = (configuration.files ?? []).find((item: any) => item.kind === "SegaTools");
      const currentServer = String(findEntry(file, "dns", "default")?.value ?? "");
      const knownServer = serverOptions.some(option => option.value === currentServer);
      setServer(currentServer === "aqua.naominet.live" ? "" : knownServer ? currentServer : currentServer ? "custom" : "");
      setCustomServer(knownServer || currentServer === "aqua.naominet.live" ? "" : currentServer);
      const existingKeychip = String(findEntry(file, "keychip", "id")?.value ?? "");
      setCurrentKeychip(existingKeychip);
      setKeychip(existingKeychip);
    }).catch(caught => { if (active) setError(caught instanceof Error ? caught.message : "无法检查 HDD 配置。"); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [root]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败。"); }
    finally { setBusy(false); }
  };
  const advance = (next: Step) => { setNotice(""); setError(""); setStep(next); };
  const installSegatools = () => run(async () => {
    const next = await window.ogk.installHddSegatools(root);
    await saveSegatools(root, [
      { section: "vfs", key: "amfs", value: "amfs" },
      { section: "vfs", key: "option", value: "option" },
      { section: "vfs", key: "appdata", value: "appdata" }
    ]);
    setInspection(next);
    await onChanged();
    setConfirmSegatools(false); setNotice("Segatools 已完成合并覆盖安装，segatools.ini 已补齐目录配置。");
  });
  const installIcf = (overwrite = false) => run(async () => {
    setInspection(await window.ogk.installHddIcf(root, overwrite));
    setConfirmIcf(false);
    setNotice("ICF1 和 ICF2 已放置到 amfs 目录。");
  });
  const save = (changes: Change[], next: Step) => run(async () => {
    await saveSegatools(root, changes); await onChanged(); advance(next);
  });
  const continueFromSegatools = () => {
    if (!inspection?.segatools.hasIni) { advance("incomplete"); return; }
    advance("icf");
  };
  const installMod = () => run(async () => {
    const next = await window.ogk.installHddBepinex(root); setInspection(next);
    await saveSegatools(root, [{ section: "unity", key: "enable", value: "1" }, { section: "unity", key: "targetAssembly", value: "BepInEx\\core\\BepInEx.Preloader.dll" }]);
    await onChanged(); advance("server");
  });
  const continueExistingMod = () => save([
    { section: "unity", key: "enable", value: "1" },
    { section: "unity", key: "targetAssembly", value: "BepInEx\\core\\BepInEx.Preloader.dll" }
  ], "server");
  const saveServer = (later = false) => {
    const selected = server === "custom" ? customServer.trim() : server;
    if (!selected) { setError("请选择服务器，或填写自定义服务器地址。"); return; }
    const needsKeychip = selected === "ea.naominet.live" || selected === "play.mumur.net";
    if (needsKeychip && !later && !keychip.trim()) { setError("请填写 Keychip，或选择“稍后填写”保留当前设置。"); return; }
    const changes: Change[] = [{ section: "dns", key: "default", value: selected }];
    if (selected === "ea.naominet.live") changes.push({ section: "dns", key: "replaceHost", value: "1" });
    const aimeDb = selected === "play.mumur.net" ? "aime.mumur.net" : "";
    changes.push({ section: "dns", key: "aimedb", value: aimeDb, removeIfEmpty: true });
    if (selected === "nageki-net.com") changes.push({ section: "keychip", key: "id", value: "" });
    if (needsKeychip && !later) changes.push({ section: "keychip", key: "id", value: keychip.trim() });
    void save(changes, "controller");
  };
  const configureController = () => run(async () => {
    await window.ogk.installControllerIo(root);
    const changes: Change[] = [
      { section: "io4", key: "keyboard", value: "0" }, { section: "io4", key: "mouse", value: "0" },
      { section: "mu3io", key: "path", value: "NYAGEKI_IO.dll" }
    ];
    if (snapshot.identity.kind === "Pico") {
      changes.push({ section: "aimeio", key: "path", value: "NYAGEKI_IO.dll" });
      changes.push({ section: "aime", key: "enable", value: "1" });
    }
    await saveSegatools(root, changes); await onChanged(); advance("complete");
  });
  const chooseControllerOption = (choice: "mu3io" | "keyboard" | "io4") => {
    if (choice !== "mu3io") { setControllerChoice(choice); setSelectedMu3ioFile(""); return; }
    void run(async () => {
      const selected = await window.ogk.chooseHddMu3io(root);
      if (selected.canceled || !selected.fileName) { setControllerChoice(""); setSelectedMu3ioFile(""); return; }
      setControllerChoice("mu3io"); setSelectedMu3ioFile(selected.fileName);
    });
  };
  const applyControllerChoice = () => {
    if (controllerChoice === "keyboard") { void save([
      { section: "io4", key: "keyboard", value: "1" }, { section: "io4", key: "mouse", value: "1" },
      { section: "mu3io", key: "path", value: "" }
    ], "complete"); return; }
    if (controllerChoice === "io4") { advance("complete"); return; }
    if (controllerChoice === "mu3io" && selectedMu3ioFile) void run(async () => {
      await saveSegatools(root, [
        { section: "io4", key: "keyboard", value: "0" }, { section: "io4", key: "mouse", value: "0" },
        { section: "mu3io", key: "path", value: selectedMu3ioFile }
      ]);
      await onChanged(); advance("complete");
    });
  };

  const heading = useMemo(() => step === "complete" ? "HDD 配置完成" : step === "incomplete" ? "HDD 配置未完成" : steps.find(item => item.id === step)?.label ?? "一键配置 HDD", [step]);
  const content = (() => {
    if (busy && !inspection) return <div className="hdd-loading" role="status"><i /><span>正在检查游戏目录…</span></div>;
    if (step === "segatools") {
      const installed = Boolean(inspection?.segatools.installed);
      return <><StepState ok={installed}>{installed ? "Segatools 已安装" : `缺少 ${inspection?.segatools.missing.length ?? 0} 项内容`}</StepState>
        {!installed && <p>将覆盖 Segatools 资源包。</p>}
        {installed && <p>当前目录已包含完整的 Segatools 资源包。你可以重新安装以恢复为内置版本，或直接进入下一步。</p>}
        {!!inspection?.segatools.missing.length && <div className="hdd-file-list">{inspection.segatools.missing.map(name => <code key={name}>{name}</code>)}</div>}
        <div className="hdd-actions">{installed ? <><button type="button" onClick={onClose}>取消</button><button type="button" disabled={busy} onClick={() => setConfirmSegatools(true)}>重新安装</button><button type="button" className="primary" onClick={continueFromSegatools}>下一步</button></> : <><button type="button" onClick={continueFromSegatools}>暂不安装</button><button type="button" className="primary" disabled={busy} onClick={() => setConfirmSegatools(true)}>安装 Segatools</button></>}</div></>;
    }
    if (step === "icf") {
      const installed = Boolean(inspection?.icf.installed);
      return <><StepState ok={installed}>{installed ? "ICF1 和 ICF2 已安装" : `缺少 ${inspection?.icf.missing.join("、")}`}</StepState><p>文件将放置在 <code>package\\amfs</code> 中；重新安装会替换现有的 ICF1 和 ICF2。</p>
        <div className="hdd-actions"><button type="button" onClick={() => advance("segatools")}>上一步</button>{installed ? <><button type="button" disabled={busy} onClick={() => setConfirmIcf(true)}>重新安装</button><button type="button" className="primary" onClick={() => advance("vfs")}>下一步</button></> : <button type="button" className="primary" disabled={busy} onClick={() => installIcf(false)}>补齐 ICF</button>}</div></>;
    }
    if (step === "vfs") return <><StepState ok={true}>准备设置相对目录</StepState><article className="surface config-table hdd-config-table"><div className="entry-list"><section className="config-section"><h2 className="config-section-title">虚拟文件系统</h2>{[["AMFS 数据目录", "amfs"], ["Option 数据包目录", "option"], ["应用数据目录", "appdata"]].map(([label, value]) => <div className="config-entry" key={label}><span><b>{label}</b><small>写入 segatools.ini</small></span><div className="config-value"><input value={value} readOnly /></div></div>)}</section></div></article><div className="hdd-actions"><button type="button" onClick={() => advance("icf")}>上一步</button><button type="button" className="primary" disabled={busy} onClick={() => void save([{ section: "vfs", key: "amfs", value: "amfs" }, { section: "vfs", key: "option", value: "option" }, { section: "vfs", key: "appdata", value: "appdata" }], "mod")}>应用并继续</button></div></>;
    if (step === "mod") {
      const complete = Boolean(inspection?.bepinex.directoryExists && inspection?.bepinex.preloaderExists);
      const partial = Boolean(inspection?.bepinex.directoryExists && !inspection?.bepinex.preloaderExists);
      return <><StepState ok={complete}>{complete ? "BepInEx 与 Preloader 已安装" : partial ? "BepInEx 不完整，缺少 Preloader" : "尚未安装 BepInEx"}</StepState><article className="surface config-table hdd-config-table"><div className="entry-list"><section className="config-section"><h2 className="config-section-title">Unity Hook</h2><div className="config-entry"><span><b>启用 Unity Hook</b><small>用于加载 BepInEx Mod 框架</small></span><div className="config-value"><button type="button" className="switch-control is-on" role="switch" aria-checked="true" aria-label="启用 Unity Hook" tabIndex={-1}><i /></button></div></div><div className="config-entry"><span><b>启动前加载的 .NET DLL</b><small>游戏启动前运行指定程序集</small></span><div className="config-value"><input value="BepInEx\core\BepInEx.Preloader.dll" readOnly /></div></div></section></div></article><div className="hdd-actions"><button type="button" onClick={() => advance("vfs")}>上一步</button>{complete ? <button type="button" className="primary" disabled={busy} onClick={continueExistingMod}>确认并继续</button> : <><button type="button" onClick={() => advance("server")}>暂不安装</button><button type="button" className="primary" disabled={busy} onClick={installMod}>{partial ? "修复安装" : "安装 Mod"}</button></>}</div></>;
    }
    if (step === "server") {
      const selected = server === "custom" ? customServer : server;
      const option = serverOptions.find(item => item.value === selected);
      const needsKeychip = Boolean(option?.needsKeychip);
      return <><p className="hdd-lead">选择服务器。保存行为与 Segatools 页面一致，向导中不显示 aqua.naominet.live。</p><div className="hdd-choice-list">{serverOptions.map(item => <button type="button" key={item.value} className={server === item.value ? "is-selected" : ""} onClick={() => setServer(item.value)}><i aria-hidden="true" /><span><b>{item.label}</b><small>{item.value}</small></span></button>)}<button type="button" className={server === "custom" ? "is-selected" : ""} onClick={() => setServer("custom")}><i aria-hidden="true" /><span><b>自定义</b><small>手动填写服务器地址</small></span></button></div>{server === "custom" && <label className="hdd-field"><span>服务器地址</span><input value={customServer} placeholder="输入主机名或 IP 地址" onChange={event => setCustomServer(event.currentTarget.value)} /></label>}{option && <section className="hdd-ea-panel"><div><b>{needsKeychip ? "申请 Keychip" : "Nageki Net"}</b>{needsKeychip && <p>前往服务器网站注册并申请 Keychip，然后在下方填写。</p>}</div><button type="button" onClick={() => void window.ogk.openHddPortal(option.portal)}>{option.portal === "rinnet" ? "打开 RinNet" : option.portal === "munet" ? "打开 MuNet" : "打开 Nageki Net"}</button>{needsKeychip && <label className="hdd-field"><span>Keychip</span><input value={keychip} placeholder="填写服务器提供的 Keychip" onChange={event => setKeychip(event.currentTarget.value)} /><small>{currentKeychip ? "稍后填写会保留当前值。" : "稍后填写会继续保持为空。"}</small></label>}</section>}<div className="hdd-actions"><button type="button" onClick={() => advance("mod")}>上一步</button>{needsKeychip && <button type="button" disabled={busy} onClick={() => saveServer(true)}>稍后填写</button>}<button type="button" className="primary" disabled={busy || !selected} onClick={() => saveServer(false)}>保存并继续</button></div></>;
    }
    if (step === "controller") {
      if (supportedController) return <><StepState ok={true}>已检测到 {controllerName}</StepState><p>将复制内置 NYAGEKI_IO.dll，关闭键盘与鼠标输入，并自动配置 MU3IO。{snapshot.identity.kind === "Pico" ? "LUXIS 的 Aime IO 也会设置为该 DLL。" : ""}</p><div className="hdd-actions"><button type="button" onClick={() => advance("server")}>上一步</button><button type="button" className="primary" disabled={busy} onClick={configureController}>自动配置控制器</button></div></>;
      const choices = [["mu3io", "选择 MU3IO DLL", "从本机选择 DLL，复制到 package 并写入其文件名。"], ["keyboard", "使用键盘鼠标", "启用 Segatools 键盘输入和鼠标模拟摇杆。"], ["io4", "使用 IO4 / 暂不配置", "不修改当前输入配置，直接完成向导。"]] as const;
      return <><StepState ok={false}>{manualControllerMessage}</StepState><div className="hdd-choice-list is-detailed">{choices.map(([value, title, detail]) => <button type="button" key={value} className={controllerChoice === value ? "is-selected" : ""} onClick={() => chooseControllerOption(value)} disabled={busy}><i aria-hidden="true" /><span><b>{title}</b><small>{value === "mu3io" && selectedMu3ioFile ? `已选择 ${selectedMu3ioFile}` : detail}</small></span></button>)}</div><div className="hdd-actions"><button type="button" onClick={() => advance("server")}>上一步</button><button type="button" className="primary" disabled={busy || !controllerChoice} onClick={applyControllerChoice}>{controllerChoice === "io4" ? "使用 IO4 / 直接下一步" : "应用并完成"}</button></div></>;
    }
    if (step === "incomplete") return <div className="hdd-finish is-incomplete"><span aria-hidden="true">!</span><h3>配置未完成</h3><p>未安装 Segatools，且目标目录中没有可继续配置的 segatools.ini。</p><button type="button" className="primary" onClick={onClose}>关闭</button></div>;
    return <div className="hdd-finish"><span aria-hidden="true">✓</span><h3>配置完成</h3><p>Segatools、数据目录、网络和输入设备已按你的选择完成配置。</p><button type="button" className="primary" onClick={onClose}>完成</button></div>;
  })();

  return createPortal(<div className="hdd-wizard-backdrop" role="presentation"><section className="hdd-wizard" role="dialog" aria-modal="true" aria-labelledby="hdd-wizard-title"><header><div><small>一键配置 HDD</small><h2 id="hdd-wizard-title">{heading}</h2></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></header>{stepIndex >= 0 && <nav aria-label="配置进度">{steps.map((item, index) => <span key={item.id} className={index === stepIndex ? "is-current" : index < stepIndex ? "is-done" : ""}><i>{index < stepIndex ? "✓" : index + 1}</i><b>{item.label}</b></span>)}</nav>}<main aria-busy={busy}>{notice && <div className="hdd-notice" role="status">{notice}</div>}{error && <div className="hdd-error" role="alert">{error}</div>}<div className="hdd-step-content">{content}</div></main></section>{confirmSegatools && <div className="hdd-confirm-backdrop"><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="确认安装 Segatools"><h2>{inspection?.segatools.installed ? "重新安装 Segatools？" : "安装 Segatools？"}</h2><p>将合并复制完整资源包并替换所有同名文件。目标目录中的额外文件会保留。</p><div><button type="button" onClick={() => setConfirmSegatools(false)}>取消</button><button type="button" className="primary" disabled={busy} onClick={installSegatools}>确认覆盖</button></div></section></div>}{confirmIcf && <div className="hdd-confirm-backdrop"><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-label="确认重新安装 ICF"><h2>重新安装 ICF？</h2><p>现有 ICF1 和 ICF2 将被内置版本覆盖。</p><div><button type="button" onClick={() => setConfirmIcf(false)}>取消</button><button type="button" className="primary" disabled={busy} onClick={() => installIcf(true)}>确认覆盖</button></div></section></div>}</div>, document.body);
}
