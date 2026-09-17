import type { Config, LibrarySection, ResourcePage, Scan, Summary, ThumbnailCache } from "./models";
import type { ControllerCommandResult, ControllerModuleStatus, ControllerSnapshot, HallRequest, LeverRequest, PicoLightingRequest } from "./controller-models";

export type GameLaunchOptions = { width: number; height: number; fullscreen: boolean };
export type HddSetupInspection = {
  root: string;
  segatools: { installed: boolean; hasIni: boolean; missing: string[] };
  icf: { installed: boolean; missing: string[] };
  bepinex: { directoryExists: boolean; preloaderExists: boolean };
};

export interface OgkBridge {
  chooseGameDirectory(): Promise<string | null>;
  prepareGameLauncher(root: string, options?: GameLaunchOptions): Promise<{ fileName: string }>;
  launchGame(root: string, options?: GameLaunchOptions): Promise<{ fileName: string }>;
  scan(root: string): Promise<Scan>;
  onScanProgress(callback: (progress: ScanProgress) => void): () => void;
  librarySummary(root: string): Promise<Summary>;
  optionDirectoryIndex(root: string): Promise<OptionDirectoryIndex>;
  optionPackages(root: string): Promise<OptionDirectory>;
  packageManifest(): Promise<PackageManifest>;
  downloadPackage(request: PackageDownloadRequest): Promise<PackageInstallResult>;
  cancelPackage(downloadId: string): void;
  onPackageProgress(callback: (progress: PackageProgress) => void): () => void;
  deleteOptionPackage(request: { root: string; directoryPath: string }): Promise<boolean>;
  openOptionDirectory(root: string, directoryPath?: string): Promise<boolean>;
  cachedScan(root: string): Promise<Scan | null>;
  librarySection(root: string, kind: LibrarySection, requestId?: string): Promise<any[]>;
  cancelLibrarySection(requestId: string): void;
  resourcePage(root: string, request: { offset: number; limit: number; search: string }): Promise<ResourcePage>;
  inspectConfiguration(root: string): Promise<Config>;
  segatoolsDlls(root: string): Promise<{ directory: string; dlls: string[] }>;
  backupSegatools(root: string): Promise<any[]>;
  segatoolsBackups(root: string): Promise<any[]>;
  restoreSegatoolsBackup(request: any): Promise<any>;
  thumbnail(resourceId: string, cache?: ThumbnailCache, priority?: "visible" | "prefetch", requestId?: string): Promise<string | null>;
  cancelThumbnail(requestId: string): void;
  originalImage(resourceId: string, root?: string): Promise<string | null>;
  previewConfiguration(request: any): Promise<any>;
  gameRunningProcesses(): Promise<string[]>;
  stopGameProcesses(): Promise<void>;
  saveConfiguration(request: any): Promise<any>;
  installControllerIo(root: string): Promise<{ path: string; installed: boolean }>;
  inspectHddSetup(root: string): Promise<HddSetupInspection>;
  installHddSegatools(root: string): Promise<HddSetupInspection>;
  installHddIcf(root: string, overwrite?: boolean): Promise<HddSetupInspection>;
  installHddBepinex(root: string): Promise<HddSetupInspection>;
  chooseHddMu3io(root: string): Promise<{ canceled: boolean; fileName?: string; path?: string }>;
  openHddPortal(service: "rinnet" | "munet" | "nageki"): Promise<void>;
  toggleMod(request: any): Promise<any>;
  chartPreview(chartId: string, root?: string): Promise<any>;
  chartAudio?(audio: unknown, root?: string): Promise<unknown>;
  chartSound?(name: string): Promise<unknown>;
  chartImage?(name: string): Promise<unknown>;
  chartEffectTextures?(root: string): Promise<any[]>;
  characterExpressions(request: any): Promise<any[]>;
  characterExpressionPreview(request: any, root?: string): Promise<string | null>;
  exportResource(request: { root: string; kind: string; itemId?: string }): Promise<boolean>;
  setUiScale(scale: number): Promise<number>;
  minimizeWindow(): Promise<void>;
  toggleWindowMaximize(): Promise<boolean>;
  closeWindow(): Promise<void>;
  isWindowMaximized(): Promise<boolean>;
  onWindowStateChange(callback: (maximized: boolean) => void): () => void;
  getVersion(): Promise<string>;
  getUpdateStatus(): Promise<UpdateStatus>;
  setUpdateToken(token: string): Promise<UpdateStatus>;
  checkForUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  controllerSnapshot(): Promise<ControllerSnapshot | null>;
  controllerStatus(): Promise<ControllerModuleStatus>;
  onControllerSnapshot(callback: (snapshot: ControllerSnapshot) => void): () => void;
  onControllerStatus(callback: (status: ControllerModuleStatus) => void): () => void;
  controllerRescan(): Promise<ControllerCommandResult>;
  controllerRetrySync(): Promise<ControllerCommandResult>;
  controllerRestart(): Promise<void>;
  controllerReleaseAll(): Promise<ControllerCommandResult>;
  controllerVirtualKey(key: string, pressed: boolean): Promise<ControllerCommandResult>;
  controllerSetMode(keyboardMouse: boolean): Promise<ControllerCommandResult>;
  controllerSetInputMode(mode: number): Promise<ControllerCommandResult>;
  controllerSetBrightness(brightness: number): Promise<ControllerCommandResult>;
  controllerSetCustomColor(red: number, green: number, blue: number): Promise<ControllerCommandResult>;
  controllerSetPicoLighting(request: PicoLightingRequest): Promise<ControllerCommandResult>;
  controllerSetHall(request: HallRequest): Promise<ControllerCommandResult>;
  controllerHallCalibration(action: string): Promise<ControllerCommandResult>;
  controllerHallQuery(): Promise<ControllerCommandResult>;
  controllerDeviceQuery(): Promise<ControllerCommandResult>;
  controllerSetLever(request: LeverRequest): Promise<ControllerCommandResult>;
  controllerLeverCalibration(action: string): Promise<ControllerCommandResult>;
  controllerBootloader(): Promise<ControllerCommandResult>;
}

export interface ScanProgress {
  root: string;
  phase: string;
  completed: number;
  total: number;
  currentItem?: string | null;
  percent: number;
  overallCompleted: number;
  overallTotal: number;
  overallPercent: number;
  state: "Pending" | "Running" | "Completed" | "Failed" | "Cancelled";
  error?: string;
}

export type OptionPackage = {
  name: string;
  directoryPath: string;
  isValid: boolean;
  isLoaded: boolean;
  statusText: string;
  version: string;
  fileCount: number;
  size: number;
  lastWriteTime?: string;
};

export type OptionDirectory = {
  directoryPaths?: string[];
  directoryPath: string;
  exists: boolean;
  totalFiles: number;
  totalSize: number;
  lastWriteTime?: string;
  packages: OptionPackage[];
};

export type OptionDirectoryIndexPackage = {
  name: string;
  directoryPath: string;
  size: number;
};

export type OptionDirectoryIndex = {
  directoryPaths?: string[];
  directoryPath: string;
  exists: boolean;
  packages: OptionDirectoryIndexPackage[];
};

export type PackageVersion = { major: number; minor: number; release: number };

export type RemoteOptionPackage = {
  id: string;
  version: PackageVersion;
  cardMakerVersion?: PackageVersion;
  asset: string;
  size: number;
  sha256: string;
  fileCount?: number;
  required?: boolean;
  release?: string;
};

export type RemoteMod = {
  id: string;
  displayName: string;
  chineseName?: string;
  description?: string;
  version: string;
  kind: string;
  asset: string;
  size: number;
  sha256: string;
  installPath: string;
  category?: string;
  gameVersion?: string;
  requiresRestart?: boolean;
  release?: string;
};

export type PackageManifest = {
  schemaVersion: number;
  repository: string;
  release: string;
  gameVersion?: { major: number; minor: number };
  optionPackages: RemoteOptionPackage[];
  mods: RemoteMod[];
  sourceUrl: string;
  checkedAt: string;
};

export type PackageDownloadKind = "option" | "mod";
export type PackageDownloadRequest = {
  downloadId: string;
  kind: PackageDownloadKind;
  id: string;
  root: string;
};
export type PackageDownloadPhase = "downloading" | "verifying" | "extracting" | "installing" | "completed" | "cancelled" | "error";
export type PackageProgress = {
  downloadId: string;
  kind: PackageDownloadKind;
  id: string;
  phase: PackageDownloadPhase;
  received: number;
  total: number;
  percent: number;
  speed: number;
  message?: string;
  error?: string;
};
export type PackageInstallResult = { kind: PackageDownloadKind; id: string; path: string };

export type UpdateState =
  | "idle"
  | "unsupported"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "ready"
  | "error";

export type UpdateStatus = {
  packaged: boolean;
  currentVersion: string;
  availableVersion?: string;
  state: UpdateState;
  progress?: number;
  error?: string;
  hasToken: boolean;
};

declare global { interface Window { ogk: OgkBridge } }
