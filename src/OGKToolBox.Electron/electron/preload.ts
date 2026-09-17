import { contextBridge, ipcRenderer } from "electron";

let controllerSubscriptionRequested = false;
const subscribeToController = () => {
  if (controllerSubscriptionRequested) return;
  controllerSubscriptionRequested = true;
  ipcRenderer.send("controller:subscribe");
};

contextBridge.exposeInMainWorld("ogk", {
  chooseGameDirectory: () => ipcRenderer.invoke("dialog:game-directory"),
  prepareGameLauncher: (root: string, options?: unknown) => ipcRenderer.invoke("game:prepare-launcher", root, options),
  launchGame: (root: string, options?: unknown) => ipcRenderer.invoke("game:launch", root, options),
  scan: (root: string) => ipcRenderer.invoke("library:scan", root),
  onScanProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on("library:scan-progress", listener);
    return () => ipcRenderer.removeListener("library:scan-progress", listener);
  },
  librarySummary: (root: string) => ipcRenderer.invoke("library:summary", root),
  optionDirectoryIndex: (root: string) => ipcRenderer.invoke("library:option-directory-index", root),
  optionPackages: (root: string) => ipcRenderer.invoke("library:option-packages", root),
  packageManifest: () => ipcRenderer.invoke("packages:manifest"),
  downloadPackage: (request: unknown) => ipcRenderer.invoke("packages:download", request),
  cancelPackage: (downloadId: string) => ipcRenderer.send("packages:cancel", downloadId),
  onPackageProgress: (callback: (progress: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress);
    ipcRenderer.on("packages:progress", listener);
    return () => ipcRenderer.removeListener("packages:progress", listener);
  },
  deleteOptionPackage: (request: unknown) => ipcRenderer.invoke("library:delete-option-package", request),
  openOptionDirectory: (root: string, directoryPath?: string) => ipcRenderer.invoke("dialog:open-option-directory", root, directoryPath),
  cachedScan: (root: string) => ipcRenderer.invoke("library:cached-scan", root),
  librarySection: (root: string, kind: string, requestId?: string) => ipcRenderer.invoke("library:section", root, kind, requestId),
  cancelLibrarySection: (requestId: string) => ipcRenderer.send("library:section:cancel", requestId),
  resourcePage: (root: string, request: unknown) => ipcRenderer.invoke("library:resource-page", root, request),
  inspectConfiguration: (root: string) => ipcRenderer.invoke("configuration:inspect", root),
  segatoolsDlls: (root: string) => ipcRenderer.invoke("configuration:segatools-dlls", root),
  backupSegatools: (root: string) => ipcRenderer.invoke("configuration:segatools-backup", root),
  segatoolsBackups: (root: string) => ipcRenderer.invoke("configuration:segatools-backups", root),
  restoreSegatoolsBackup: (request: unknown) => ipcRenderer.invoke("configuration:restore-segatools-backup", request),
  previewConfiguration: (request: unknown) => ipcRenderer.invoke("configuration:preview", request),
  gameRunningProcesses: () => ipcRenderer.invoke("game:running-processes"),
  stopGameProcesses: () => ipcRenderer.invoke("game:stop-processes"),
  saveConfiguration: (request: unknown) => ipcRenderer.invoke("configuration:save", request),
  installControllerIo: (root: string) => ipcRenderer.invoke("configuration:install-controller-io", root),
  inspectHddSetup: (root: string) => ipcRenderer.invoke("hdd-setup:inspect", root),
  installHddSegatools: (root: string) => ipcRenderer.invoke("hdd-setup:install-segatools", root),
  installHddIcf: (root: string, overwrite?: boolean) => ipcRenderer.invoke("hdd-setup:install-icf", root, overwrite),
  installHddBepinex: (root: string) => ipcRenderer.invoke("hdd-setup:install-bepinex", root),
  chooseHddMu3io: (root: string) => ipcRenderer.invoke("hdd-setup:choose-mu3io", root),
  openHddPortal: (service: "rinnet" | "munet" | "nageki") => ipcRenderer.invoke("hdd-setup:open-portal", service),
  toggleMod: (request: unknown) => ipcRenderer.invoke("mods:toggle", request),
  chartPreview: (chartId: string, root?: string) => ipcRenderer.invoke("chart:preview", chartId, root),
  chartAudio: (audio: unknown, root?: string) => ipcRenderer.invoke("chart:audio", audio, root),
  chartSound: (fileName: string) => ipcRenderer.invoke("chart:sound", fileName),
  chartImage: (fileName: string) => ipcRenderer.invoke("chart:image", fileName),
  chartEffectTextures: (root: string) => ipcRenderer.invoke("chart:effect-textures", root),
  characterExpressions: (request: unknown) => ipcRenderer.invoke("characters:expressions", request),
  characterExpressionPreview: (request: unknown, root?: string) => ipcRenderer.invoke("characters:expression-preview", request, root),
  thumbnail: (resourceId: string, cache?: unknown, priority?: "visible" | "prefetch", requestId?: string) =>
    ipcRenderer.invoke("resource:thumbnail", resourceId, cache, priority, requestId),
  cancelThumbnail: (requestId: string) => ipcRenderer.send("resource:thumbnail:cancel", requestId),
  originalImage: (resourceId: string, root?: string) => ipcRenderer.invoke("resource:original", resourceId, root),
  exportResource: (request: unknown) => ipcRenderer.invoke("export:save", request),
  setUiScale: (scale: number) => ipcRenderer.invoke("app:set-ui-scale", scale),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleWindowMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  isWindowMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  onWindowStateChange: (callback: (maximized: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, maximized: boolean) => callback(Boolean(maximized));
    ipcRenderer.on("window:state-changed", listener);
    return () => ipcRenderer.removeListener("window:state-changed", listener);
  },
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getUpdateStatus: () => ipcRenderer.invoke("update:status"),
  setUpdateToken: (token: string) => ipcRenderer.invoke("update:set-token", token),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("update:status", listener);
    ipcRenderer.send("update:subscribe");
    return () => ipcRenderer.removeListener("update:status", listener);
  },
  controllerSnapshot: () => ipcRenderer.invoke("controller:snapshot"),
  controllerStatus: () => ipcRenderer.invoke("controller:status"),
  onControllerSnapshot: (callback: (snapshot: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: unknown) => callback(snapshot);
    ipcRenderer.on("controller:snapshot", listener);
    subscribeToController();
    return () => ipcRenderer.removeListener("controller:snapshot", listener);
  },
  onControllerStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("controller:status", listener);
    subscribeToController();
    return () => ipcRenderer.removeListener("controller:status", listener);
  },
  controllerRescan: () => ipcRenderer.invoke("controller:rescan"),
  controllerRetrySync: () => ipcRenderer.invoke("controller:retry-sync"),
  controllerRestart: () => ipcRenderer.invoke("controller:restart"),
  controllerReleaseAll: () => ipcRenderer.invoke("controller:release-all"),
  controllerVirtualKey: (key: string, pressed: boolean) => ipcRenderer.invoke("controller:virtual-key", key, pressed),
  controllerSetMode: (keyboardMouse: boolean) => ipcRenderer.invoke("controller:mode", keyboardMouse),
  controllerSetInputMode: (mode: number) => ipcRenderer.invoke("controller:input-mode", mode),
  controllerSetBrightness: (brightness: number) => ipcRenderer.invoke("controller:brightness", brightness),
  controllerSetCustomColor: (red: number, green: number, blue: number) => ipcRenderer.invoke("controller:custom-color", red, green, blue),
  controllerSetPicoLighting: (request: unknown) => ipcRenderer.invoke("controller:pico-lighting", request),
  controllerSetHall: (request: unknown) => ipcRenderer.invoke("controller:hall", request),
  controllerHallCalibration: (action: string) => ipcRenderer.invoke("controller:hall-calibration", action),
  controllerHallQuery: () => ipcRenderer.invoke("controller:hall-query"),
  controllerDeviceQuery: () => ipcRenderer.invoke("controller:device-query"),
  controllerSetLever: (request: unknown) => ipcRenderer.invoke("controller:lever", request),
  controllerLeverCalibration: (action: string) => ipcRenderer.invoke("controller:lever-calibration", action),
  controllerBootloader: () => ipcRenderer.invoke("controller:bootloader")
});
