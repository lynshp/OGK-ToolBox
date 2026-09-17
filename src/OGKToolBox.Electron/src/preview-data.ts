import type { Config, LibrarySection, ResourcePage, Scan, Summary } from "./models";
import type { ControllerCommandResult, ControllerModuleStatus, ControllerSnapshot, HallRequest, LeverRequest, PicoLightingRequest } from "./controller-models";

export const previewSummary: Summary = {
  gameRoot: "",
  musicCount: 1284,
  cardCount: 3412,
  characterCount: 17,
  resourceCount: 12842,
  diagnosticCount: 0,
  gameVersion: "1.51-I"
};

export const previewScan: Scan = {
  summary: previewSummary,
  music: ["ONGEKI bright MEMORY", "Ai Nov", "Transcend Lights", "LiftOff"].map((title, index) => ({
    id: index + 1,
    title,
    artist: ["曲師A", "光吉猛修", "baker", "Hiro"][index],
    genre: index % 2 ? "VARIETY" : "ONGEKI",
    versionName: "bright MEMORY",
    origin: { packageId: index < 3 ? "A000" : "Option A" },
    charts: [{ filePath: `preview-${index}.ogkr`, difficultyName: "MASTER", levelConstant: 12 + index,
      exists: true, creator: "OGK Team", mainBpm: 180, totalNotes: 968 }]
  })),
  cards: [
    { id: 1, name: "皇城 セツナ", characterName: "皇城 セツナ", rarity: "SSR", attribute: "FIRE" },
    { id: 2, name: "柏木 咲姫", characterName: "柏木 咲姫", rarity: "SSR", attribute: "AQUA" }
  ],
  characters: ["高瀬 梨緒", "逢坂 茜", "藍原 椿", "柏木 咲姫"].map((name, index) =>
    ({ id: 1000 + index, name, modelId: 1000 + index })),
  resources: ["ui_card_0001", "card_100001", "chara_1000_face", "music_0001_jacket"].map((key, index) => ({
    key, kind: index % 2 ? "Card" : "Jacket", size: 54000 + index * 16384,
    versionName: "1.51-I", bundlePath: "", origin: { packageId: index < 3 ? "A000" : "Option A" }
  })),
  diagnostics: [
    { severity: "Warning", code: "MISSING_AUDIO", message: "缺少对应的音频资源", sourcePath: "package/audio.bin" },
    { severity: "Information", code: "OPTION_ORDER", message: "Option 加载顺序已记录", sourcePath: "option/DataConfig.xml" }
  ]
};

export const previewConfig: Config = {
  hookVersion: "0.1.3",
  files: [{
    displayName: "segatools.ini", kind: "SegaTools", exists: true, encodingName: "UTF-8",
    lastWriteText: "今天 08:16", contentHash: "preview",
    entries: [
      { lineNumber: 1, locator: "[vfs] amfs", section: "vfs", key: "amfs", value: "amfs", valueKind: "Path", description: "AMFS 数据目录" },
      { lineNumber: 2, locator: "[vfs] option", section: "vfs", key: "option", value: "option", valueKind: "Path", description: "Option 数据目录" },
      { lineNumber: 3, locator: "[vfs] appdata", section: "vfs", key: "appdata", value: "appdata", valueKind: "Path", description: "应用数据目录" },
      { lineNumber: 1, locator: "[aime] enable", section: "aime", key: "enable", value: "1",
        valueKind: "Boolean", description: "启用 Aime 服务" },
      { lineNumber: 5, locator: "[aimeio] path", section: "aimeio", key: "path", value: "", valueKind: "Path", description: "Aime IO" },
      { lineNumber: 6, locator: "[dns] default", section: "dns", key: "default", value: "nageki-net.com", valueKind: "String", description: "服务器" },
      { lineNumber: 7, locator: "[dns] replaceHost", section: "dns", key: "replaceHost", value: "0", valueKind: "Boolean", description: "替换主机" },
      { lineNumber: 8, locator: "[dns] aimedb", section: "dns", key: "aimedb", value: "", valueKind: "String", description: "读卡器服务器" },
      { lineNumber: 9, locator: "[keychip] id", section: "keychip", key: "id", value: "", valueKind: "String", description: "Keychip" },
      { lineNumber: 10, locator: "[unity] enable", section: "unity", key: "enable", value: "0", valueKind: "Boolean", description: "Unity Hook" },
      { lineNumber: 11, locator: "[unity] targetAssembly", section: "unity", key: "targetAssembly", value: "", valueKind: "Path", description: "启动程序集" },
      { lineNumber: 12, locator: "[mu3io] path", section: "mu3io", key: "path", value: "", valueKind: "Path", description: "MU3IO" },
      { lineNumber: 13, locator: "[io4] keyboard", section: "io4", key: "keyboard", value: "1", valueKind: "Boolean", description: "键盘输入" },
      { lineNumber: 14, locator: "[io4] mouse", section: "io4", key: "mouse", value: "1", valueKind: "Boolean", description: "鼠标摇杆" },
      { lineNumber: 2, locator: "[gfx] windowed", section: "gfx", key: "windowed", value: "1",
        valueKind: "Boolean", description: "窗口模式" }
    ]
  }, {
    displayName: "mu3.ini", kind: "Mu3", exists: true, encodingName: "UTF-8", lastWriteText: "今天 08:16", contentHash: "preview-mu3",
    entries: []
  }],
  mods: [{ name: "FrameRate", nameText: "帧率解锁与修复", kind: "BepInEx", kindText: "BepInEx 插件",
    version: "1.3.0", statusText: "已启用", isEnabled: true, description: "修复高刷新率或多显示器环境，并可调整或解除帧率限制。",
    lastWriteText: "今天 08:12", configurationEntries: [{ section: "Video", key: "Framerate", value: "", displayValue: "", valueKind: "Integer",
      lineNumber: 0, locator: "Video:Framerate", description: "帧率上限；设为 0 可解锁帧率", isSensitive: false, isKnown: true,
      isPresent: false, defaultValue: "-1", requiredMods: ["FrameRate"] }] }],
  diagnostics: []
};

export function previewControllerSnapshot(): ControllerSnapshot {
  const requested = new URLSearchParams(window.location.search).get("controllerState");
  const requestedInputMode = new URLSearchParams(window.location.search).get("inputMode");
  const state = requested === "device-sync" ? "SyncingDevice" : requested === "syncing" ? "SyncingHall" : requested === "leonardo" ? "Ready"
    : requested === "unsupported" ? "Unsupported" : requested === "calibrating" ? "CalibratingHall"
      : requested === "fault" ? "Faulted" : requested === "offline" ? "Searching" : "Ready";
  const offline = requested === "offline";
  const pico = !offline && requested !== "leonardo";
  // Leonardo publishes its mode/lever fields in the normal input stream;
  // only Pico needs the separate Device Config page in the preview.
  const deviceConfigFresh = !offline && (!pico || state !== "SyncingDevice");
  const hallConfigFresh = pico && deviceConfigFresh && state !== "SyncingHall";
  return {
    sequence: 42, sampledAt: new Date().toISOString(), state,
    error: state === "Unsupported" ? "检测到 protocol 2；当前版本仅支持 protocol 1。" : state === "Faulted" ? "ControllerHost 无法读取 HID 设备。" : null,
    identity: { kind: offline ? "Unknown" : pico ? "Pico" : "Leonardo", displayName: offline ? "未连接" : pico ? "NIA Controller Pro" : "Leonardo", vendorId: pico ? 0xCAFE : 0x2341, productId: pico ? 0x4000 : 0x8036, firmware: offline ? "—" : pico ? "1.4.2" : "legacy", hardwareVersion: offline ? 0 : 2, protocolVersion: pico ? 1 : 0 },
    capabilities: { inputMonitor: !offline, virtualKeys: !offline, mode: !offline, basicLighting: !offline, picoLighting: pico, hallConfiguration: hallConfigFresh, hallCalibration: hallConfigFresh, leverConfiguration: !offline, leverCalibration: !offline, cardReader: !offline, bootloader: !offline },
    input: { leftA: false, leftB: false, leftC: false, leftSide: false, leftMenu: false, rightA: false, rightB: false, rightC: false, rightSide: false, rightMenu: false, test: false, service: false, lever: 0, rawLever: 4258, mappedLever: 512 },
    card: { present: !offline, cardType: 1, type: "MIFARE", identifier: offline ? "" : "OGK-0219-9048" },
    hall: { configurationValid: hallConfigFresh, abcTravel: 100, abcRtTrigger: 35, abcRtRelease: 25, abcDead: 10, sideTravel: 120, sideRtTrigger: 40, sideRtRelease: 30, sideDead: 10, rtEnabledAbc: 1, rtEnabledSide: 1, delta: [74, 46, 24, 18, 86, 50, 17, 70], maxDelta: [700, 700, 700, 700, 700, 700, 700, 700], baseline: [4, 4, 3, 4, 4, 5, 4, 3], calibrationState: state === "CalibratingHall" ? 1 : 0, calibrationSamples: state === "CalibratingHall" ? 184 : 0 },
    lever: { calibrationMin: 1200, calibrationMax: 64500, inverted: false, sensitivity: 0, outputDeadband: 2, calibrationState: 0, pendingCalibrationMin: 0, pendingCalibrationMax: 0, leftNoise: 3, rightNoise: 4 },
    deviceConfig: { valid: deviceConfigFresh, brightness: 173, groundColor: [255, 122, 69], sideColor: [109, 93, 251], cabPreset: 1, cabGameMapping: true, inputMode: requestedInputMode === "magnetic" ? 0 : 1, isKmMode: true, capabilities: 0x7FF, protocolSupported: !["Unsupported"].includes(state) && !offline },
    operation: state === "CalibratingHall" ? { id: "preview-calibration", name: "hall-calibration", status: "Accepted", startedAt: new Date().toISOString(), message: "Hall 校准进行中。" } : null,
    canWrite: !offline && (state === "Ready" || state === "CalibratingHall"), readbackComplete: deviceConfigFresh && (!pico || hallConfigFresh),
    deviceConfigRevision: deviceConfigFresh ? 1 : 0, hallConfigRevision: hallConfigFresh ? 1 : 0
  };
}

const previewSections: Record<LibrarySection, any[]> = {
  music: previewScan.music,
  cards: previewScan.cards,
  characters: previewScan.characters,
  resources: previewScan.resources,
  diagnostics: previewScan.diagnostics
};

export function installPreviewBridge(expressionError: boolean): void {
  if (!import.meta.env.DEV || window.ogk) return;
  const controllerSnapshot = previewControllerSnapshot();
  const controllerStatus: ControllerModuleStatus = { state: "ready" };
  const controllerResult = (message: string, status: ControllerCommandResult["status"] = "Accepted"): ControllerCommandResult => ({ commandId: "preview", status, message, snapshot: { ...controllerSnapshot } });
  const applyHall = (request: HallRequest) => {
    Object.assign(controllerSnapshot.hall, request);
    if (request.save) controllerSnapshot.hall.configurationValid = true;
  };
  let keyboardMouseCabGameMapping = controllerSnapshot.deviceConfig.cabGameMapping;
  const applyLighting = (request: PicoLightingRequest) => {
    controllerSnapshot.deviceConfig.brightness = request.brightness;
    controllerSnapshot.deviceConfig.groundColor = [request.groundR, request.groundG, request.groundB];
    controllerSnapshot.deviceConfig.sideColor = [request.sideR, request.sideG, request.sideB];
    controllerSnapshot.deviceConfig.cabPreset = request.cabPreset;
    keyboardMouseCabGameMapping = request.cabGameMapping;
    controllerSnapshot.deviceConfig.cabGameMapping = request.cabGameMapping;
  };
  window.ogk = {
  chooseGameDirectory: async () => previewSummary.gameRoot,
  prepareGameLauncher: async () => ({ fileName: "OGKToolBox-Launch.bat" }),
  launchGame: async () => ({ fileName: "preview" }),
  scan: async () => previewScan,
  onScanProgress: () => () => {},
  librarySummary: async () => previewSummary,
  optionDirectoryIndex: async () => ({ directoryPath: "", exists: true, packages: [] }),
  packageManifest: async () => ({
    schemaVersion: 1, repository: "lynshp/OptionPackage", release: "option",
    optionPackages: [], mods: [], sourceUrl: "https://raw.githubusercontent.com/lynshp/OptionPackage/main/manifest.json",
    checkedAt: new Date().toISOString()
  }),
  downloadPackage: async (request: { kind: "option" | "mod"; id: string }) => ({ kind: request.kind, id: request.id, path: "preview" }),
  cancelPackage: () => {},
  onPackageProgress: () => () => {},
  optionPackages: async () => ({ directoryPath: "", exists: true, totalFiles: 0, totalSize: 0, packages: [] }),
  deleteOptionPackage: async () => true,
  openOptionDirectory: async () => true,
  cachedScan: async () => previewScan,
    librarySection: async (_root: string, kind: LibrarySection) => previewSections[kind] ?? [],
    cancelLibrarySection: () => {},
    resourcePage: async (_root: string, request: { offset: number; limit: number; search: string }): Promise<ResourcePage> => {
      const needle = request.search.trim().toLowerCase();
      const filtered = previewScan.resources.filter(item =>
        !needle || `${item.key} ${item.kind} ${item.origin?.packageId ?? ""}`.toLowerCase().includes(needle));
      const offset = Math.max(0, request.offset);
      const limit = Math.max(1, request.limit);
      return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
    },
    inspectConfiguration: async () => previewConfig,
    segatoolsDlls: async () => ({ directory: previewSummary.gameRoot, dlls: [] }),
    backupSegatools: async () => [], segatoolsBackups: async () => [],
    restoreSegatoolsBackup: async () => ({}), thumbnail: async () => null, cancelThumbnail: () => {}, originalImage: async () => null,
    previewConfiguration: async () => ({ canSave: true, changes: [{}] }), gameRunningProcesses: async () => [], stopGameProcesses: async () => {}, saveConfiguration: async () => ({}), installControllerIo: async () => ({ path: "preview", installed: false }),
    inspectHddSetup: async root => ({ root, segatools: { installed: true, hasIni: true, missing: [] }, icf: { installed: true, missing: [] }, bepinex: { directoryExists: false, preloaderExists: false } }),
    installHddSegatools: async root => ({ root, segatools: { installed: true, hasIni: true, missing: [] }, icf: { installed: true, missing: [] }, bepinex: { directoryExists: false, preloaderExists: false } }),
    installHddIcf: async root => ({ root, segatools: { installed: true, hasIni: true, missing: [] }, icf: { installed: true, missing: [] }, bepinex: { directoryExists: false, preloaderExists: false } }),
    installHddBepinex: async root => ({ root, segatools: { installed: true, hasIni: true, missing: [] }, icf: { installed: true, missing: [] }, bepinex: { directoryExists: true, preloaderExists: true } }),
    chooseHddMu3io: async () => ({ canceled: false, fileName: "custom_io.dll", path: "preview" }), openHddPortal: async () => {},
    toggleMod: async () => ({}), exportResource: async () => true,
    chartPreview: async () => ({
      durationSeconds: 120, maxTick: 230400, resolution: 1920, measureCount: 30, unknownCommandCount: 0,
      lanes: [[-24, "LeftWall"], [-12, "Left"], [0, "Center"], [12, "Right"], [24, "RightWall"]]
        .map(([x, kind], id) => ({ id, kind, points: [{ tick: 0, xFore: x, xRear: x },
          { tick: 230400, xFore: x, xRear: x }] })),
      tempos: [{ tick: 0, seconds: 0, bpm: 180 }], scrollRanges: [],
      notes: Array.from({ length: 48 }, (_, index) => ({ tick: index * 4200, x: index % 5 * 6 - 12,
        kind: index % 9 === 0 ? "Flick" : index % 7 === 0 ? "Hold" : "Tap", laneKind: "Center",
        isCritical: index % 12 === 0 }))
    }),
    characterExpressions: async () => {
      if (expressionError) throw new Error("表情资源读取失败");
      return ["默认", "微笑", "惊讶", "认真"].map((name, index) =>
        ({ bundlePath: "", spritePathId: String(index + 1), name, bundleKey: `face_0${index}` }));
    },
    characterExpressionPreview: async () => null, setUiScale: async scale => scale,
    minimizeWindow: async () => {}, toggleWindowMaximize: async () => false, closeWindow: async () => {},
    isWindowMaximized: async () => false, onWindowStateChange: () => () => {},
    getVersion: async () => "preview",
    getUpdateStatus: async () => ({
      packaged: false, currentVersion: "preview", state: "unsupported", hasToken: false,
      error: "开发模式不检查更新。"
    }),
    setUpdateToken: async () => ({
      packaged: false, currentVersion: "preview", state: "unsupported", hasToken: false,
      error: "开发模式不检查更新。"
    }),
    checkForUpdate: async () => ({
      packaged: false, currentVersion: "preview", state: "unsupported", hasToken: false,
      error: "开发模式不检查更新。"
    }),
    installUpdate: async () => {},
    onUpdateStatus: () => () => {},
    controllerSnapshot: async () => controllerSnapshot,
    controllerStatus: async () => controllerStatus,
    onControllerSnapshot: (callback: (snapshot: ControllerSnapshot) => void) => { callback(controllerSnapshot); return () => {}; },
    onControllerStatus: (callback: (status: ControllerModuleStatus) => void) => { callback(controllerStatus); return () => {}; },
    controllerRescan: async () => ({ commandId: "preview", status: "Accepted", message: "已接受重新检测请求。", snapshot: controllerSnapshot }),
    controllerRetrySync: async () => ({ commandId: "preview", status: "Accepted", message: "已重新开始同步。", snapshot: controllerSnapshot }),
    controllerRestart: async () => {},
    controllerReleaseAll: async () => ({ commandId: "preview", status: "Verified", message: "虚拟按键已全部释放。", snapshot: controllerSnapshot }),
    controllerVirtualKey: async () => ({ commandId: "preview", status: "Accepted", message: "虚拟按键命令已接受。", snapshot: controllerSnapshot }),
    controllerSetMode: async (keyboardMouse: boolean) => { keyboardMouseCabGameMapping = controllerSnapshot.deviceConfig.cabGameMapping; controllerSnapshot.deviceConfig.isKmMode = keyboardMouse; controllerSnapshot.deviceConfig.cabGameMapping = keyboardMouseCabGameMapping; controllerSnapshot.state = "Ready"; return controllerResult(keyboardMouse ? "已切换到模拟键鼠模式。" : "已切换到 MU3IO 模式。"); },
    controllerSetInputMode: async (mode: number) => { controllerSnapshot.deviceConfig.inputMode = mode; controllerSnapshot.deviceConfig.isKmMode = mode === 3; return controllerResult("输入模式已更新。"); },
    controllerSetBrightness: async (brightness: number) => { controllerSnapshot.deviceConfig.brightness = Math.max(0, Math.min(255, Math.round(brightness))); return controllerResult("亮度已即时应用。"); },
    controllerSetCustomColor: async (red: number, green: number, blue: number) => { controllerSnapshot.deviceConfig.groundColor = [red, green, blue]; controllerSnapshot.deviceConfig.sideColor = [red, green, blue]; return controllerResult("按键灯颜色已即时应用。"); },
    controllerSetPicoLighting: async (request: PicoLightingRequest) => { applyLighting(request); return controllerResult("灯光已即时应用。"); },
    controllerSetHall: async (request: HallRequest) => { applyHall(request); return controllerResult(request.save ? "Hall 配置已保存。" : "Hall 预览已应用。"); },
    controllerHallCalibration: async (action: string) => {
      if (action === "start") { controllerSnapshot.state = "CalibratingHall"; controllerSnapshot.hall.calibrationState = 1; controllerSnapshot.hall.calibrationSamples = 0; }
      else if (action === "stop") { controllerSnapshot.state = "Ready"; controllerSnapshot.hall.calibrationState = 0; controllerSnapshot.hall.calibrationSamples = 128; controllerSnapshot.hall.configurationValid = true; }
      else if (action === "baseline" || action === "reset") { controllerSnapshot.hall.baseline = controllerSnapshot.hall.delta.map(() => 0); controllerSnapshot.hall.configurationValid = true; }
      return controllerResult(action === "start" ? "Hall 校准已开始。" : "Hall 校准已完成并回读。");
    },
    controllerHallQuery: async () => controllerResult("Hall 查询已接受。"),
    controllerDeviceQuery: async () => controllerResult("Device 查询已接受。"),
    controllerSetLever: async (request: LeverRequest) => { Object.assign(controllerSnapshot.lever, request); return controllerResult("摇杆配置已保存。"); },
    controllerLeverCalibration: async (action: string) => {
      if (action === "start") { controllerSnapshot.state = "CalibratingLever"; controllerSnapshot.lever.calibrationState = 0; controllerSnapshot.lever.pendingCalibrationMin = 1200; controllerSnapshot.lever.pendingCalibrationMax = 64500; }
      else if (action === "left") { controllerSnapshot.state = "CalibratingLever"; controllerSnapshot.lever.calibrationState = 2; controllerSnapshot.lever.pendingCalibrationMin = 1200; }
      else if (action === "right") { controllerSnapshot.state = "CalibratingLever"; controllerSnapshot.lever.calibrationState = 4; controllerSnapshot.lever.pendingCalibrationMax = 64500; }
      else if (action === "stop" || action === "complete") { controllerSnapshot.state = "Ready"; controllerSnapshot.lever.calibrationState = 0; controllerSnapshot.lever.calibrationMin = controllerSnapshot.lever.pendingCalibrationMin || 1200; controllerSnapshot.lever.calibrationMax = controllerSnapshot.lever.pendingCalibrationMax || 64500; }
      return controllerResult(action === "stop" || action === "complete" ? "摇杆端点已记录并完成映射回读。" : action === "start" ? "摇杆校准已开始，请将摇杆左右推到最大行程。" : `摇杆${action === "left" ? "左" : "右"}端采样已开始。`);
    },
    controllerBootloader: async () => { controllerSnapshot.state = "BootloaderPending"; return controllerResult("Bootloader 命令已接受，等待设备重新枚举。" ); }
  };
}

