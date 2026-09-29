import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Device, HIDAsync } from "node-hid";
import type { ControllerCommandResult, ControllerModuleStatus, ControllerSnapshot, HallRequest, LeverRequest,
  PicoLightingRequest } from "../src/controller-models";

type HidModule = typeof import("node-hid");
type SnapshotListener = (snapshot: ControllerSnapshot) => void;
type StatusListener = (status: ControllerModuleStatus) => void;
type ConfigPending = { command: number; resolve(value: Buffer): void; reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout> };
type ProductNameResolver = (device: Device) => Promise<string | undefined>;

const execFileAsync = promisify(execFile);

const inputReportId = 0x01;
const configReportId = 0xaa;
const commands = { inputModeGet: 0x01, inputModeSet: 0x02, save: 0x81, rollerSetOffset: 0xa0 } as const;
const inputModes = [
  { id: "1", label: "IO4" }, { id: "2", label: "DLL" }, { id: "3", label: "模拟键盘" }
];
const io4Ids = new Set(["0ca3:0021", "8088:0101"]);
const buttons = {
  leftA: [0, 0x01], leftB: [0, 0x20], leftC: [0, 0x10], rightSide: [1, 0x40, true],
  rightA: [0, 0x02], rightB: [2, 0x01], rightC: [1, 0x80], leftSide: [3, 0x80, true],
  leftMenu: [3, 0x40], rightMenu: [1, 0x20], service: [0, 0x40], test: [1, 0x02]
} as const;

const emptyInput = (): ControllerSnapshot["input"] => ({
  leftA: false, leftB: false, leftC: false, leftSide: false, leftMenu: false,
  rightA: false, rightB: false, rightC: false, rightSide: false, rightMenu: false,
  test: false, service: false, lever: 0x8000, rawLever: 0x8000, mappedLever: 512
});

const capabilities = (writable: boolean, inputMonitor = true): ControllerSnapshot["capabilities"] => ({
  inputMonitor, virtualKeys: false, mode: writable, basicLighting: false, picoLighting: false,
  hallConfiguration: false, hallCalibration: false, leverConfiguration: false,
  leverCalibration: writable, cardReader: false, bootloader: false
});

const emptySnapshot = (): ControllerSnapshot => ({
  sequence: 0, sampledAt: new Date().toISOString(), state: "Searching", error: null,
  identity: { kind: "Unknown", displayName: "未连接", vendorId: 0, productId: 0,
    firmware: "—", hardwareVersion: 0, protocolVersion: 1 },
  capabilities: capabilities(false), input: emptyInput(),
  card: { present: false, cardType: 0, type: "", identifier: "" },
  hall: { configurationValid: false, abcTravel: 0, abcRtTrigger: 0, abcRtRelease: 0, abcDead: 0,
    sideTravel: 0, sideRtTrigger: 0, sideRtRelease: 0, sideDead: 0, rtEnabledAbc: 0,
    rtEnabledSide: 0, delta: [], maxDelta: [], baseline: [], calibrationState: 0, calibrationSamples: 0 },
  lever: { calibrationMin: 0, calibrationMax: 65535, inverted: true, sensitivity: 0,
    outputDeadband: 0, calibrationState: 0, pendingCalibrationMin: 0, pendingCalibrationMax: 0,
    leftNoise: 0, rightNoise: 0 },
  deviceConfig: { valid: false, brightness: 0, groundColor: [0, 0, 0], sideColor: [0, 0, 0],
    cabPreset: 0, cabGameMapping: false, inputMode: 1, isKmMode: false, capabilities: 0,
    protocolSupported: true },
  operation: null, canWrite: false, readbackComplete: false, deviceConfigRevision: 0,
  hallConfigRevision: 0
});

const keyOf = (device: Device) =>
  `${device.vendorId.toString(16).padStart(4, "0")}:${device.productId.toString(16).padStart(4, "0")}`;

async function settleWithin(task: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([task.catch(() => undefined), new Promise<void>(resolve => {
      timer = setTimeout(resolve, milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

const resolveUsbProductName: ProductNameResolver = async device => {
  if (process.platform !== "win32" || !device.serialNumber) return undefined;
  const vendorId = device.vendorId.toString(16).padStart(4, "0").toUpperCase();
  const productId = device.productId.toString(16).padStart(4, "0").toUpperCase();
  const instanceId = `USB\\VID_${vendorId}&PID_${productId}\\${device.serialNumber}`;
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);` +
    `(Get-PnpDeviceProperty -InstanceId $env:OGK_USB_INSTANCE_ID ` +
    `-KeyName 'DEVPKEY_Device_BusReportedDeviceDesc' -ErrorAction SilentlyContinue).Data`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf8",
      env: { ...process.env, OGK_USB_INSTANCE_ID: instanceId } });
  return stdout.trim() || undefined;
};

export const isIo4InputDevice = (device: Device): boolean =>
  io4Ids.has(keyOf(device)) && device.usagePage === 0x01 && device.usage === 0x04 && typeof device.path === "string";

const isSimGekiConfigDevice = (device: Device, input: Device): boolean =>
  device.vendorId === input.vendorId && device.productId === input.productId &&
  device.usagePage === 0xff00 && typeof device.path === "string" &&
  (!input.serialNumber || !device.serialNumber || input.serialNumber === device.serialNumber);

export function parseIo4InputReport(report: Uint8Array): ControllerSnapshot["input"] | null {
  const bytes = Buffer.from(report);
  if (bytes.length !== 34 && bytes[0] !== inputReportId) return null;
  const payload = bytes.length === 34 ? bytes : bytes.subarray(1);
  if (payload.length < 34) return null;
  const roller = payload[0] | (payload[1] << 8);
  const buttonBytes = payload.subarray(28, 34);
  const input = { ...emptyInput(), lever: roller, rawLever: roller,
    mappedLever: Math.round(((0xffff - roller) * 1023) / 0xffff) };
  for (const [name, [byte, mask, inverted]] of Object.entries(buttons)) {
    const set = (buttonBytes[byte] & mask) !== 0;
    input[name as keyof typeof buttons] = inverted ? !set : set;
  }
  return input;
}

export class SimGekiIo4Controller {
  private hid?: HidModule;
  private inputDevice?: HIDAsync;
  private configDevice?: HIDAsync;
  private inputPath?: string;
  private configPending?: ConfigPending;
  private scanPromise?: Promise<boolean>;
  private scanTimer?: ReturnType<typeof setInterval>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private running = false;
  private lifecycle = 0;
  private generation = 0;
  private readonly closingDevices = new WeakMap<HIDAsync, Promise<void>>();
  private sequence = 0;
  private snapshotValue = emptySnapshot();
  private status: ControllerModuleStatus = { state: "stopped" };
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(private readonly loadHid: () => Promise<HidModule> = () => import("node-hid"),
    private readonly resolveProductName: ProductNameResolver = resolveUsbProductName) {}

  getSnapshot(): ControllerSnapshot { return this.snapshotValue; }
  getStatus(): ControllerModuleStatus { return this.status; }
  onSnapshot(listener: SnapshotListener): () => void { this.snapshotListeners.add(listener); listener(this.snapshotValue); return () => this.snapshotListeners.delete(listener); }
  onStatus(listener: StatusListener): () => void { this.statusListeners.add(listener); listener(this.status); return () => this.statusListeners.delete(listener); }

  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    if (this.starting) return this.starting;
    if (this.status.state === "ready") return Promise.resolve();
    this.running = true;
    const lifecycle = ++this.lifecycle;
    this.setStatus({ state: "starting" });
    const task = this.startCore(lifecycle).finally(() => {
      if (this.starting === task) this.starting = undefined;
    });
    this.starting = task;
    return task;
  }

  private async startCore(lifecycle: number): Promise<void> {
    try {
      const hid = this.hid ?? await this.loadHid();
      if (!this.isActive(lifecycle)) return;
      this.hid = hid;
      await this.scan(lifecycle);
      if (!this.isActive(lifecycle)) return;
      this.scanTimer ??= setInterval(() => {
        if (this.isActive(lifecycle) && (this.snapshotValue.identity.kind === "Unknown"
          || ((this.snapshotValue.identity.kind === "SimGEKI"
            || this.snapshotValue.identity.kind === "IO4Compatible") && !this.configDevice))) {
          void this.scan(lifecycle).catch(error => {
            if (this.isActive(lifecycle)) this.reportScanError(error);
          });
        }
      }, 3000);
      this.setStatus({ state: "ready" });
    } catch (error) {
      if (!this.isActive(lifecycle)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus({ state: "fault", error: `SimGEKI/IO4 HID 初始化失败：${message}` });
      throw error;
    }
  }

  async restart(): Promise<void> { await this.stop(); await this.start(); }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.running = false;
    const lifecycle = ++this.lifecycle;
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
    const pending = [this.starting, this.scanPromise, this.disconnect()];
    this.starting = undefined;
    this.scanPromise = undefined;
    const task = settleWithin(Promise.allSettled(pending), 500).then(() => {
      if (this.lifecycle !== lifecycle) return;
      this.publish(emptySnapshot());
      this.setStatus({ state: "stopped" });
    }).finally(() => { if (this.stopping === task) this.stopping = undefined; });
    this.stopping = task;
    return task;
  }

  async rescan(): Promise<ControllerCommandResult> {
    await this.ensureStarted();
    const found = await this.scan();
    return this.result("Verified", found ? "IO4 控制器已连接。" : "未发现 IO4 兼容控制器。");
  }

  async retrySync(): Promise<ControllerCommandResult> { return this.rescan(); }
  async releaseAll(): Promise<ControllerCommandResult> { return this.result("Verified", "IO4 物理输入无需释放。"); }
  async releaseAllIfRunning(): Promise<void> { /* Physical IO4 input does not synthesize keys. */ }
  async setVirtualKey(_key: string, _pressed: boolean): Promise<ControllerCommandResult> { return this.unsupported(); }
  async setBrightness(_brightness: number): Promise<ControllerCommandResult> { return this.unsupported(); }
  async setCustomColor(_red: number, _green: number, _blue: number): Promise<ControllerCommandResult> { return this.unsupported(); }
  async setPicoLighting(_request: PicoLightingRequest): Promise<ControllerCommandResult> { return this.unsupported(); }
  async setHall(_request: HallRequest): Promise<ControllerCommandResult> { return this.unsupported(); }
  async hallCalibration(_action: string): Promise<ControllerCommandResult> { return this.unsupported(); }
  async hallQuery(): Promise<ControllerCommandResult> { return this.unsupported(); }
  async deviceQuery(): Promise<ControllerCommandResult> { return this.unsupported(); }
  async setLever(_request: LeverRequest): Promise<ControllerCommandResult> { return this.unsupported(); }
  async leverCalibration(action: string): Promise<ControllerCommandResult> {
    if (action !== "center") return this.result("Rejected", "SimGEKI 仅支持摇杆中心校准。");
    if (!this.configDevice || !this.snapshotValue.capabilities.leverCalibration)
      return this.result("Rejected", "当前 IO4 控制器没有可用的 SimGEKI 配置通道。");
    const generation = this.generation;
    const device = this.configDevice;
    const connected = () => this.running && this.generation === generation && this.configDevice === device;
    try {
      const calibrationResponse = await this.configCommand(commands.rollerSetOffset);
      if (!connected()) return this.result("Failed", "摇杆校准期间设备已断开。");
      if (calibrationResponse.length < 3 || calibrationResponse[2] !== 0x01)
        return this.result("Failed", "SimGEKI 拒绝了摇杆校准。");
      const saveResponse = await this.configCommand(commands.save);
      if (!connected()) return this.result("Failed", "摇杆校准保存期间设备已断开。");
      if (saveResponse.length < 3 || saveResponse[2] !== 0x01)
        return this.result("Failed", "SimGEKI 摇杆已校准，但保存失败。");
      return this.result("Verified", "SimGEKI 摇杆中心已校准并保存。");
    } catch (error) {
      return this.result("Failed", error instanceof Error ? error.message : "SimGEKI 摇杆校准失败。");
    }
  }
  async bootloader(): Promise<ControllerCommandResult> { return this.unsupported(); }
  async setMode(keyboardMouse: boolean): Promise<ControllerCommandResult> { return this.setInputMode(keyboardMouse ? 3 : 1); }

  async setInputMode(mode: number): Promise<ControllerCommandResult> {
    if (!Number.isInteger(mode) || mode < 1 || mode > 3)
      return this.result("Rejected", "输入模式必须是 1、2 或 3。");
    if (!this.configDevice || !this.snapshotValue.capabilities.mode)
      return this.result("Rejected", "当前 IO4 控制器没有可用的 SimGEKI 配置通道。");
    const generation = this.generation;
    const device = this.configDevice;
    // A configuration collection may reconnect while the input collection keeps its generation.
    const connected = () => this.running && this.generation === generation && this.configDevice === device;
    const disconnected = () => this.result("Failed", "输入模式更新期间设备已断开。");
    try {
      const setResponse = await this.configCommand(commands.inputModeSet, mode);
      if (!connected()) return disconnected();
      if (setResponse.length < 3 || setResponse[2] !== 0x01)
        return this.result("Failed", "SimGEKI 拒绝了输入模式更改。");
      const saveResponse = await this.configCommand(commands.save);
      if (!connected()) return disconnected();
      if (saveResponse.length < 3 || saveResponse[2] !== 0x01)
        return this.result("Failed", "SimGEKI 输入模式已设置，但保存失败。");
      const readback = await this.readInputMode();
      if (!connected()) return disconnected();
      if (readback !== mode)
        return this.result("Failed", `SimGEKI 模式回读不一致（期望 ${mode}，实际 ${readback}）。`);
      this.setInputModeState(readback, true);
      return this.result("Verified", `SimGEKI 输入模式已切换为 ${["", "IO4", "DLL", "模拟键盘"][mode]}。`);
    } catch (error) {
      return this.result("Failed", error instanceof Error ? error.message : "SimGEKI 模式切换失败。");
    }
  }

  private async ensureStarted(): Promise<void> { if (this.status.state !== "ready") await this.start(); }

  private isActive(lifecycle: number): boolean { return this.running && this.lifecycle === lifecycle; }

  private async scan(lifecycle = this.lifecycle): Promise<boolean> {
    if (!this.isActive(lifecycle)) return false;
    if (this.scanPromise) return this.scanPromise;
    const task = this.scanCore(lifecycle).finally(() => { if (this.scanPromise === task) this.scanPromise = undefined; });
    this.scanPromise = task;
    return task;
  }

  private async scanCore(lifecycle: number): Promise<boolean> {
    if (!this.hid) return false;
    const devices = await this.hid.devicesAsync();
    if (!this.isActive(lifecycle)) return false;
    const input = devices.find(isIo4InputDevice);
    if (!input) {
      await this.disconnect();
      if (this.isActive(lifecycle)) this.publish(emptySnapshot());
      return false;
    }
    const config = devices.find(candidate => isSimGekiConfigDevice(candidate, input));
    if (this.inputDevice && this.inputPath === input.path) {
      if (!this.configDevice && config) await this.openConfig(config, this.generation, lifecycle);
      return this.isActive(lifecycle) && Boolean(this.inputDevice);
    }
    await this.disconnect();
    if (!this.isActive(lifecycle)) return false;
    const generation = ++this.generation;
    const device = await this.hid.HIDAsync.open(input.path!);
    if (!this.isActive(lifecycle) || this.generation !== generation) {
      await this.closeDevice(device);
      return false;
    }
    this.inputDevice = device;
    this.inputPath = input.path;
    this.publish({
      ...emptySnapshot(), state: "ConnectedWaitingForData",
      identity: { kind: "IO4Compatible", displayName: "IO4 兼容控制器",
        vendorId: input.vendorId, productId: input.productId, firmware: "—",
        hardwareVersion: Number(input.release) || 0, protocolVersion: 1 },
      deviceConfig: { ...emptySnapshot().deviceConfig, valid: true }
    });
    device.on("data", data => {
      if (!this.isActive(lifecycle) || this.generation !== generation) return;
      const parsed = parseIo4InputReport(data);
      if (!parsed) return;
      this.publish({ ...this.snapshotValue, input: parsed, state: "Ready", error: null, readbackComplete: true });
    });
    device.on("error", error => {
      if (this.isActive(lifecycle) && this.generation === generation) void this.deviceFailed(error, lifecycle);
    });
    const productName = await this.resolveProductName(input).catch(() => undefined);
    if (!this.isActive(lifecycle) || this.generation !== generation) return false;
    if (productName)
      this.publish({ ...this.snapshotValue, identity: { ...this.snapshotValue.identity, displayName: productName } });
    if (config) await this.openConfig(config, generation, lifecycle);
    return this.isActive(lifecycle) && this.generation === generation;
  }

  private async openConfig(descriptor: Device, generation: number, lifecycle: number): Promise<void> {
    let device: HIDAsync | undefined;
    try {
      device = await this.hid!.HIDAsync.open(descriptor.path!);
      if (!this.isActive(lifecycle) || this.generation !== generation) { await this.closeDevice(device); return; }
      this.configDevice = device;
      const opened = device;
      device.on("data", data => { if (this.configDevice === opened) this.resolveConfig(data, generation); });
      device.on("error", error => {
        if (this.generation !== generation || this.configDevice !== opened) return;
        this.failConfig(opened, error);
      });
      const mode = await this.readInputMode();
      if (this.isActive(lifecycle) && this.generation === generation && this.configDevice === device)
        this.setInputModeState(mode, true);
    } catch {
      if (device) {
        if (this.configDevice === device) this.failConfig(device, new Error("SimGEKI 配置同步失败。"));
        await this.closeDevice(device);
      }
      if (this.isActive(lifecycle) && this.generation === generation && !this.configDevice) this.disableConfig();
    }
  }

  private disableConfig(): void {
    this.publish({ ...this.snapshotValue,
      capabilities: capabilities(false, this.snapshotValue.deviceConfig.inputMode === 1),
      canWrite: false, inputModes: undefined,
      deviceConfig: { ...this.snapshotValue.deviceConfig, valid: false } });
  }

  private failConfig(device: HIDAsync, error: unknown): void {
    if (this.configDevice !== device) return;
    this.configDevice = undefined;
    this.rejectConfig(error);
    this.disableConfig();
    void this.closeDevice(device);
  }

  private async readInputMode(): Promise<number> {
    const response = await this.configCommand(commands.inputModeGet);
    if (response.length < 4 || response[2] !== 0x01 || response[3] < 1 || response[3] > 3)
      throw new Error("SimGEKI 返回了无效的输入模式。");
    return response[3];
  }

  private setInputModeState(mode: number, writable: boolean): void {
    const inputReady = mode === 1 && this.snapshotValue.capabilities.inputMonitor &&
      this.snapshotValue.readbackComplete;
    this.publish({ ...this.snapshotValue,
      state: mode === 1 && !inputReady ? "ConnectedWaitingForData" : "Ready",
      identity: { ...this.snapshotValue.identity, kind: "SimGEKI" },
      capabilities: capabilities(writable, mode === 1), canWrite: writable,
      readbackComplete: mode !== 1 || inputReady,
      inputModes: { current: String(mode), options: inputModes.map(option => ({ ...option })) },
      deviceConfig: { ...this.snapshotValue.deviceConfig, valid: true, inputMode: mode,
        isKmMode: mode === 3, protocolSupported: true },
      deviceConfigRevision: this.snapshotValue.deviceConfigRevision + 1 });
  }

  private async configCommand(command: number, value?: number): Promise<Buffer> {
    if (!this.configDevice) throw new Error("SimGEKI 配置通道不可用。");
    if (this.configPending) throw new Error("SimGEKI 配置命令正在执行。");
    const device = this.configDevice;
    const generation = this.generation;
    const report = Buffer.alloc(64);
    report[0] = configReportId;
    report[2] = command;
    if (value !== undefined) report[4] = value;
    const response = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.configPending?.timer !== timer) return;
        this.configPending = undefined;
        reject(new Error("SimGEKI 配置通信超时。"));
      }, 1000);
      this.configPending = { command, resolve, reject, timer };
    });
    try {
      // Attach handlers to both promises before a write, timeout or device error can reject either one.
      const [, data] = await Promise.all([Promise.resolve().then(() => {
        if (!this.running || this.generation !== generation || this.configDevice !== device)
          throw new Error("IO4 设备已断开。");
        return device.write(report);
      }), response]);
      return data;
    } catch (error) {
      this.failConfig(device, error);
      throw error;
    }
  }

  private resolveConfig(data: Buffer, generation: number): void {
    if (this.generation !== generation || !this.configPending) return;
    if (data[0] !== configReportId) return;
    const payload = data[0] === configReportId ? data.subarray(1) : data;
    if (payload[1] !== this.configPending.command) return;
    const pending = this.configPending;
    this.configPending = undefined;
    clearTimeout(pending.timer);
    pending.resolve(payload);
  }

  private rejectConfig(error: unknown): void {
    if (!this.configPending) return;
    const pending = this.configPending;
    this.configPending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private async deviceFailed(error: unknown, lifecycle: number): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.disconnect();
    if (this.isActive(lifecycle)) this.publish({ ...emptySnapshot(), error: `IO4 设备已断开：${message}` });
  }

  private reportScanError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.publish({ ...(this.inputDevice ? this.snapshotValue : emptySnapshot()), error: `IO4 扫描失败：${message}` });
  }

  private closeDevice(device: HIDAsync): Promise<void> {
    const existing = this.closingDevices.get(device);
    if (existing) return existing;
    const closing = Promise.resolve().then(() => device.close()).catch(() => undefined);
    this.closingDevices.set(device, closing);
    return closing;
  }

  private async disconnect(): Promise<void> {
    ++this.generation;
    this.rejectConfig(new Error("IO4 设备已断开。"));
    const input = this.inputDevice;
    const config = this.configDevice;
    this.inputDevice = undefined;
    this.configDevice = undefined;
    this.inputPath = undefined;
    await Promise.all([input, config].filter((device): device is HIDAsync => Boolean(device))
      .map(device => this.closeDevice(device)));
  }

  private unsupported(): ControllerCommandResult {
    return this.result("Rejected", "当前 IO4 控制器不支持该命令。");
  }

  private result(status: ControllerCommandResult["status"], message: string): ControllerCommandResult {
    return { commandId: randomUUID(), status, message, snapshot: this.snapshotValue };
  }

  private publish(snapshot: ControllerSnapshot): void {
    this.snapshotValue = { ...snapshot, sequence: ++this.sequence, sampledAt: new Date().toISOString() };
    for (const listener of this.snapshotListeners) listener(this.snapshotValue);
  }

  private setStatus(status: ControllerModuleStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
