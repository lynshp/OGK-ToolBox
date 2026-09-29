import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import type { ControllerCommandResult, ControllerModuleStatus, ControllerSnapshot, HallRequest, LeverRequest, PicoLightingRequest } from "./controller-models";
import "./controller-page.css";
import { PencilCheckIcon, PencilCloseIcon, PencilGamepadIcon } from "./pencil-icons";

const emptySnapshot = (): ControllerSnapshot => ({
  sequence: 0, sampledAt: new Date().toISOString(), state: "Searching", error: null,
  identity: { kind: "Unknown", displayName: "未连接", vendorId: 0, productId: 0, firmware: "—", hardwareVersion: 0, protocolVersion: 0 },
  capabilities: { inputMonitor: false, virtualKeys: false, mode: false, basicLighting: false, picoLighting: false, hallConfiguration: false, hallCalibration: false, leverConfiguration: false, leverCalibration: false, cardReader: false, bootloader: false },
  input: { leftA: false, leftB: false, leftC: false, leftSide: false, leftMenu: false, rightA: false, rightB: false, rightC: false, rightSide: false, rightMenu: false, test: false, service: false, lever: 0, rawLever: 0, mappedLever: 512 },
  card: { present: false, cardType: 0, type: "无卡", identifier: "" },
  hall: { configurationValid: false, abcTravel: 0, abcRtTrigger: 0, abcRtRelease: 0, abcDead: 0, sideTravel: 0, sideRtTrigger: 0, sideRtRelease: 0, sideDead: 0, rtEnabledAbc: 0, rtEnabledSide: 0, delta: [], maxDelta: [], baseline: [], calibrationState: 0, calibrationSamples: 0 },
  lever: { calibrationMin: 0, calibrationMax: 0, inverted: false, sensitivity: 0, outputDeadband: 0, calibrationState: 0, pendingCalibrationMin: 0, pendingCalibrationMax: 0, leftNoise: 0, rightNoise: 0 },
  deviceConfig: { valid: false, brightness: 0, groundColor: [0, 0, 0], sideColor: [0, 0, 0], cabPreset: 0, cabGameMapping: false, inputMode: 0, isKmMode: false, capabilities: 0, protocolSupported: false },
  operation: null, canWrite: false, readbackComplete: false, deviceConfigRevision: 0, hallConfigRevision: 0
});

let cachedControllerSnapshot = emptySnapshot();
let cachedControllerModuleStatus: ControllerModuleStatus = { state: "starting" };

type ControllerCommandInvoker = (task: () => Promise<ControllerCommandResult>, options?: { allowConnectionChange?: boolean }) => Promise<ControllerCommandResult | undefined>;
const controllerConnectionKey = (snapshot: ControllerSnapshot) => snapshot.source
  ? `${snapshot.source.backendId}:${snapshot.source.connectionId}` : snapshot.identity.kind;

export function useController(): { snapshot: ControllerSnapshot; moduleStatus: ControllerModuleStatus; invoke: ControllerCommandInvoker } {
  const [snapshot, setSnapshot] = useState<ControllerSnapshot>(() => cachedControllerSnapshot);
  const [moduleStatus, setModuleStatus] = useState<ControllerModuleStatus>(() => cachedControllerModuleStatus);
  useEffect(() => {
    let active = true;
    let snapshotReceived = false;
    let statusReceived = false;
    void window.ogk.controllerSnapshot().then(value => {
      if (!active || snapshotReceived || !value) return;
      cachedControllerSnapshot = value;
      if (active) setSnapshot(value);
    }).catch(() => {});
    void window.ogk.controllerStatus().then(value => {
      if (!active || statusReceived) return;
      cachedControllerModuleStatus = value;
      if (active) setModuleStatus(value);
    }).catch(error => {
      if (!active || statusReceived) return;
      const fault = { state: "fault", error: error instanceof Error ? error.message : String(error) } as ControllerModuleStatus;
      cachedControllerModuleStatus = fault;
      if (active) setModuleStatus(fault);
    });
    const removeSnapshot = window.ogk.onControllerSnapshot(value => {
      snapshotReceived = true;
      cachedControllerSnapshot = value;
      if (active) setSnapshot(value);
    });
    const removeStatus = window.ogk.onControllerStatus(value => {
      statusReceived = true;
      cachedControllerModuleStatus = value;
      if (active) setModuleStatus(value);
    });
    return () => { active = false; removeSnapshot(); removeStatus(); };
  }, []);
  const invoke: ControllerCommandInvoker = useCallback(async (task, options) => {
    const connection = controllerConnectionKey(cachedControllerSnapshot);
    try {
      const result = await task();
      // A late command response from an old connection cannot hydrate the new device's UI.
      const currentConnection = controllerConnectionKey(cachedControllerSnapshot);
      const resultConnection = controllerConnectionKey(result.snapshot);
      if (options?.allowConnectionChange
        ? currentConnection !== connection && resultConnection !== currentConnection
        : connection !== currentConnection || connection !== resultConnection) return undefined;
      cachedControllerSnapshot = result.snapshot;
      setSnapshot(result.snapshot);
      return result;
    }
    catch (error) {
      if (connection !== controllerConnectionKey(cachedControllerSnapshot)) return undefined;
      cachedControllerModuleStatus = { ...cachedControllerModuleStatus, state: "fault", error: error instanceof Error ? error.message : String(error) };
      setModuleStatus(cachedControllerModuleStatus);
      return undefined;
    }
  }, []);
  return { snapshot, moduleStatus, invoke };
}

const stateLabel: Record<ControllerSnapshot["state"], string> = {
  Disabled: "服务已停止", Searching: "搜索设备", ConnectedWaitingForData: "等待输入数据", SyncingDevice: "同步设备配置", SyncingHall: "同步 Hall 配置", Ready: "控制器就绪", CalibratingHall: "Hall 校准中", CalibratingLever: "摇杆校准中", SyncFailed: "同步失败", BootloaderPending: "等待重新枚举", Unsupported: "协议不支持", Faulted: "控制器故障"
};

const isOnline = (snapshot: ControllerSnapshot) => snapshot.identity.kind !== "Unknown" && snapshot.state !== "Faulted" && snapshot.state !== "Unsupported" && snapshot.state !== "SyncFailed" && snapshot.state !== "BootloaderPending";
export const isControllerOnline = isOnline;
const isInputReady = (snapshot: ControllerSnapshot) =>
  snapshot.capabilities.inputMonitor && snapshot.readbackComplete &&
  (snapshot.state === "Ready" || snapshot.state === "CalibratingHall" || snapshot.state === "CalibratingLever");
const isPicoConfigSyncing = (snapshot: ControllerSnapshot) => snapshot.identity.kind === "Pico" && (snapshot.state === "ConnectedWaitingForData" || snapshot.state === "SyncingDevice" || snapshot.state === "SyncingHall" || snapshot.state === "CalibratingHall" || snapshot.state === "CalibratingLever");
const isConfigurationUiWritable = (snapshot: ControllerSnapshot) => snapshot.canWrite;
const isDeviceConfigUiAvailable = (snapshot: ControllerSnapshot) => snapshot.identity.kind !== "Unknown" &&
  snapshot.state !== "Disabled" && snapshot.state !== "Searching" && snapshot.state !== "ConnectedWaitingForData" &&
  snapshot.state !== "CalibratingHall" && snapshot.state !== "CalibratingLever" && snapshot.state !== "SyncFailed" &&
  snapshot.state !== "Faulted" && snapshot.state !== "Unsupported" && snapshot.state !== "BootloaderPending";
const controllerDisplayName = (snapshot: { identity: Pick<ControllerSnapshot["identity"], "kind" | "displayName"> }) => snapshot.identity.kind === "Pico" ? "LUXIS" : snapshot.identity.displayName;
export const controllerStatusView = (snapshot: ControllerSnapshot, moduleStatus: ControllerModuleStatus) => {
  // A known VID/PID alone is not enough for a green status. The input stream
  // and configuration readback must both be valid before Home reports the
  // device as online.
  const online = moduleStatus.state === "ready" && isOnline(snapshot) && isInputReady(snapshot);
  const detected = moduleStatus.state === "ready" && snapshot.identity.kind !== "Unknown"
    && snapshot.state !== "Disabled" && snapshot.state !== "Searching" && snapshot.state !== "BootloaderPending";
  const text = moduleStatus.state === "fault" ? "模块故障" : moduleStatus.state === "restarting" ? "模块重启中" : moduleStatus.state === "starting" ? "正在检测" : moduleStatus.state === "stopped" ? "服务已停止"
    : detected && snapshot.state === "Ready" && !online ? !snapshot.readbackComplete ? "等待设备状态" : "设备已连接"
    : stateLabel[snapshot.state];
  const name = controllerDisplayName(snapshot);
  const readOnly = !snapshot.canWrite ? "（只读）" : "";
  const note = moduleStatus.error || snapshot.error ||
    (moduleStatus.state === "fault" ? "控制器服务发生故障，请重启服务" :
      moduleStatus.state === "stopped" || snapshot.state === "Disabled" ? "控制器服务已停止" :
      moduleStatus.state === "starting" || moduleStatus.state === "restarting" ? "正在检测兼容的 HID 设备" :
      snapshot.state === "BootloaderPending" ? "设备正在重新枚举，请稍候" :
      snapshot.state === "Faulted" ? "控制器发生故障，请重新连接后重试" :
      snapshot.state === "Unsupported" ? "已检测到控制器，当前协议不受支持" :
      snapshot.state === "SyncFailed" ? `${name} · 配置同步失败，请重新同步` :
      snapshot.state === "ConnectedWaitingForData" ? `${name} · 等待首帧输入数据` :
      snapshot.state === "SyncingDevice" || snapshot.state === "SyncingHall" ? `${name} · 正在读取控制器配置` :
      online ? `${name} · 输入监视已连接${readOnly}` :
      detected && !snapshot.readbackComplete ? `${name} · 已识别设备，等待状态回读${readOnly}` :
      detected ? `${name} · 已连接，未提供输入监视${readOnly}` : "未检测到兼容的 HID 设备");
  return { online, detected, text, note };
};
const leverPercent = (value: number) => Math.max(0, Math.min(100, (value / 1023) * 100));
const hexColor = (rgb: readonly number[]) => `#${rgb.slice(0, 3).map(value => Math.max(0, Math.min(255, Math.round(Number(value) || 0))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const sliderPositionStyle = (value: number): CSSProperties => ({ "--slider-position": `${Math.max(0, Math.min(100, value))}%` } as CSSProperties);

type ControllerPageProps = { gameRoot?: string; onConfigurationChanged?(): Promise<void> };

function segatoolsEdit(entry: any, newValue: string) {
  return {
    lineNumber: entry.lineNumber, locator: entry.locator, originalValue: entry.value,
    newValue, section: entry.section, key: entry.key, remove: false
  };
}

function findSegatoolsEntry(file: any, section: string, key: string) {
  return (file?.entries ?? []).find((entry: any) =>
    String(entry.section).toLowerCase() === section.toLowerCase() && String(entry.key).toLowerCase() === key.toLowerCase());
}
type KeyboardBinding = { label: string; eventKey: string | null; mouseButton: 0 | 2 | null };
type KeyboardBindingDefinition = { command: string; configKey: string; fallback: string; fallbackEventKey: string | null; side?: "left" | "right" };
const keyboardBindingDefinitions: readonly KeyboardBindingDefinition[] = [
  { command: "L_Side", configKey: "leftSide", fallback: "Q", fallbackEventKey: "q", side: "left" },
  { command: "L_Menu", configKey: "leftMenu", fallback: "U", fallbackEventKey: "u" },
  { command: "L_A", configKey: "left1", fallback: "A", fallbackEventKey: "a" },
  { command: "L_B", configKey: "left2", fallback: "S", fallbackEventKey: "s" },
  { command: "L_C", configKey: "left3", fallback: "D", fallbackEventKey: "d" },
  { command: "R_A", configKey: "right1", fallback: "J", fallbackEventKey: "j" },
  { command: "R_B", configKey: "right2", fallback: "K", fallbackEventKey: "k" },
  { command: "R_C", configKey: "right3", fallback: "L", fallbackEventKey: "l" },
  { command: "R_Menu", configKey: "rightMenu", fallback: "O", fallbackEventKey: "o" },
  { command: "R_Side", configKey: "rightSide", fallback: "E", fallbackEventKey: "e", side: "right" },
  { command: "Test", configKey: "test", fallback: "F1", fallbackEventKey: "f1" },
  { command: "Service", configKey: "service", fallback: "F2", fallbackEventKey: "f2" }
];
const keyboardBindingFromValue = (value: unknown, fallback: string, fallbackEventKey: string | null, side?: "left" | "right"): KeyboardBinding => {
  const raw = String(value ?? "").trim();
  if (!raw) return { label: fallback, eventKey: fallbackEventKey, mouseButton: null };
  const upper = raw.toUpperCase();
  const named: Record<string, KeyboardBinding> = {
    VK_SPACE: { label: "SPACE", eventKey: " ", mouseButton: null }, VK_RETURN: { label: "ENTER", eventKey: "enter", mouseButton: null }, VK_ENTER: { label: "ENTER", eventKey: "enter", mouseButton: null },
    VK_LBUTTON: { label: "L-CLK", eventKey: null, mouseButton: 0 }, VK_RBUTTON: { label: "R-CLK", eventKey: null, mouseButton: 2 }
  };
  if (named[upper]) return named[upper];
  const namedFunction = upper.match(/^VK_(F\d{1,2})$/);
  if (namedFunction) return { label: namedFunction[1], eventKey: namedFunction[1].toLowerCase(), mouseButton: null };
  const numeric = upper.match(/^(?:0X([\da-f]+)|([0-9]+))$/i);
  const code = numeric ? Number.parseInt(numeric[1] ?? numeric[2], numeric[1] ? 16 : 10) : Number.NaN;
  if (Number.isFinite(code)) {
    if (code === 1) return { label: "L-CLK", eventKey: null, mouseButton: 0 };
    if (code === 2) return { label: "R-CLK", eventKey: null, mouseButton: 2 };
    if (code === 13) return { label: "ENTER", eventKey: "enter", mouseButton: null };
    if (code === 32) return { label: "SPACE", eventKey: " ", mouseButton: null };
    if (code >= 48 && code <= 57) { const label = String.fromCharCode(code); return { label, eventKey: label.toLowerCase(), mouseButton: null }; }
    if (code >= 65 && code <= 90) { const label = String.fromCharCode(code); return { label, eventKey: label.toLowerCase(), mouseButton: null }; }
    if (code >= 112 && code <= 123) { const label = `F${code - 111}`; return { label, eventKey: label.toLowerCase(), mouseButton: null }; }
  }
  const textKey = upper.replace(/^VK_/, "");
  const textFunction = textKey.match(/^F\d{1,2}$/);
  if (textFunction) return { label: textFunction[0], eventKey: textFunction[0].toLowerCase(), mouseButton: null };
  return { label: textKey || fallback, eventKey: textKey.length === 1 ? textKey.toLowerCase() : null, mouseButton: null };
};
const monitorKeyStyle = (snapshot: ControllerSnapshot, placement: string): CSSProperties | undefined => {
  if (!snapshot.deviceConfig.isKmMode) return undefined;
  const color = placement.endsWith("side") ? snapshot.deviceConfig.sideColor : /-(a|b|c)$/.test(placement) ? snapshot.deviceConfig.groundColor : undefined;
  return color ? ({ "--key-accent": hexColor(color) } as CSSProperties) : undefined;
};
const lightingFromDeviceConfig = (snapshot: ControllerSnapshot): PicoLightingRequest => ({
  brightness: snapshot.deviceConfig.brightness,
  groundR: snapshot.deviceConfig.groundColor[0] ?? 0,
  groundG: snapshot.deviceConfig.groundColor[1] ?? 0,
  groundB: snapshot.deviceConfig.groundColor[2] ?? 0,
  sideR: snapshot.deviceConfig.sideColor[0] ?? 0,
  sideG: snapshot.deviceConfig.sideColor[1] ?? 0,
  sideB: snapshot.deviceConfig.sideColor[2] ?? 0,
  cabPreset: snapshot.deviceConfig.cabPreset,
  cabGameMapping: snapshot.deviceConfig.cabGameMapping
});
const sameLighting = (left: PicoLightingRequest, right: PicoLightingRequest) =>
  left.brightness === right.brightness && left.groundR === right.groundR && left.groundG === right.groundG && left.groundB === right.groundB &&
  left.sideR === right.sideR && left.sideG === right.sideG && left.sideB === right.sideB && left.cabPreset === right.cabPreset && left.cabGameMapping === right.cabGameMapping;
type ControllerGlyphName = "push_pin" | "memory" | "tune" | "sensors" | "monitoring" | "usb_off" | "usb" | "power" | "refresh";
const controllerGlyphPaths: Record<ControllerGlyphName, string> = {
  push_pin: "M23 12c0-6.08-4.92-11-11-11-6.08 0-11 4.92-11 11 0 6.08 4.92 11 11 11 6.08 0 11-4.92 11-11z m-13.11-5.45c-0.81 0.48-1.43 1.23-1.74 2.12-0.19 0.52 0.09 1.09 0.61 1.27 0.52 0.19 1.09-0.09 1.27-0.61 0.16-0.44 0.47-0.82 0.88-1.06 0.4-0.24 0.88-0.33 1.35-0.25 0.46 0.08 0.89 0.33 1.19 0.69 0.3 0.36 0.47 0.82 0.47 1.29 0 0.47-0.37 0.96-1.05 1.42-0.32 0.21-0.64 0.37-0.89 0.48-0.12 0.05-0.22 0.09-0.29 0.12-0.03 0.01-0.06 0.02-0.07 0.03l-0.02 0c-0.52 0.18-0.8 0.74-0.63 1.27 0.18 0.52 0.74 0.8 1.27 0.63 0 0 0 0 0 0 0.01 0 0.01-0.01 0.01-0.01 0.01 0 0.02 0 0.04-0.01 0.03-0.01 0.07-0.02 0.12-0.04 0.09-0.04 0.23-0.09 0.38-0.16 0.32-0.14 0.75-0.36 1.18-0.65 0.82-0.54 1.95-1.55 1.95-3.08 0-0.94-0.33-1.86-0.94-2.58-0.61-0.72-1.45-1.21-2.38-1.37-0.93-0.16-1.89 0.02-2.71 0.5z m2.12 9.45l-0.01 0c-0.55 0-1 0.45-1 1 0 0.55 0.45 1 1 1l0.01 0c0.55 0 1-0.45 1-1 0-0.55-0.45-1-1-1z m8.99-4c0 4.97-4.03 9-9 9-4.97 0-9-4.03-9-9 0-4.97 4.03-9 9-9 4.97 0 9 4.03 9 9z",
  memory: "M5.83 7.69V6.31c0-.2.14-.34.34-.34h1.39c.2 0 .34.14.34.34v1.38c0 .2-.14.34-.34.34H6.17c-.2 0-.34-.14-.34-.34zM5.54 11.1v-.61H4.44c-.4 0-.67-.27-.67-.67V8.72h-.61a.29.29 0 0 1-.29-.29c0-.12.04-.21.12-.29h.78v-1.75h-.61a.29.29 0 0 1-.29-.29c0-.13.04-.21.12-.29h.78V4.71c0-.4.27-.67.67-.67h1.1v-.61c0-.13.08-.21.21-.21s.21.08.21.21v.61h1.75v-.61c0-.13.08-.21.21-.21s.21.08.21.21v.61h1.1c.4 0 .67.27.67.67v1.1h.61c.13 0 .21.08.21.21s-.08.21-.21.21h-.61v1.75h.61c.13 0 .21.08.21.21s-.08.21-.21.21h-.61v1.1c0 .4-.27.67-.67.67h-1.1v.61c0 .13-.08.21-.21.21s-.21-.08-.21-.21v-.61H5.96v.61c0 .13-.08.21-.21.21s-.21-.08-.21-.21zm4.02-1.19c.14 0 .25-.11.25-.25V4.55c0-.14-.11-.25-.25-.25H4.44c-.14 0-.25.11-.25.25v5.11c0 .14.11.25.25.25h5.12z",
  tune: "M7 11.96c-.12 0-.21-.08-.21-.21V9.42c0-.13.09-.21.21-.21s.21.08.21.21v.88h4.38c.13 0 .21.08.21.21s-.08.21-.21.21H7.21v.88c0 .13-.09.21-.21.21zM2.33 10.79c-.13 0-.21-.08-.21-.21s.08-.21.21-.21h2.33c.13 0 .21.08.21.21s-.08.21-.21.21H2.33zm2.33-2.33c-.12 0-.21-.08-.21-.21V7.38H2.41c-.13 0-.21-.08-.21-.21s.08-.21.21-.21h2.04v-.88c0-.13.08-.21.21-.21s.21.08.21.21v2.33c0 .13-.08.22-.21.22zM7 7.29c-.12 0-.21-.08-.21-.21s.09-.21.21-.21h4.67c.13 0 .21.08.21.21s-.08.21-.21.21H7zm2.33-2.33c-.13 0-.21-.08-.21-.21V2.42c0-.13.08-.21.21-.21s.21.08.21.21v.88h2.04c.13 0 .21.08.21.21s-.08.21-.21.21H9.54v.88c0 .13-.08.21-.21.21zM2.33 3.79c-.13 0-.21-.08-.21-.21s.08-.21.21-.21H7c.12 0 .21.08.21.21s-.09.21-.21.21H2.33z",
  sensors: "M2.33447 7q0 0.89551 0.3042 1.6748 0.3042 0.77588 0.8374 1.38086 0.09229 0.10596 0.10254 0.22901 0.01367 0.11963-0.08545 0.21875-0.0957 0.0957-0.21533 0.08203-0.11621-0.01367-0.21191-0.11621-0.61182-0.70068-0.96387-1.58252-0.35205-0.88184-0.35205-1.88672 0-1.00488 0.35205-1.88672 0.35205-0.88525 0.96387-1.58252 0.0957-0.10254 0.21191-0.11621 0.11963-0.01367 0.21533 0.08203 0.09912 0.09912 0.08545 0.22217-0.01025 0.11963-0.10254 0.22559-0.5332 0.61865-0.8374 1.39795-0.3042 0.77588-0.3042 1.65771z m2.33106 0q0 0.40332 0.1333 0.76563 0.1333 0.35889 0.35888 0.65624 0.0752 0.10254 0.07862 0.22217 0.00684 0.11621-0.09229 0.21533-0.0957 0.0957-0.22216 0.08204-0.12305-0.01367-0.19825-0.11621-0.3042-0.37939-0.47168-0.84083-0.16748-0.46484-0.16748-0.98437 0-0.52295 0.16748-0.98438 0.16748-0.46143 0.47168-0.84082 0.07861-0.10254 0.20166-0.11279 0.12305-0.01367 0.21875 0.08203 0.09912 0.09912 0.09229 0.21533-0.00342 0.11621-0.07862 0.21875-0.22559 0.29736-0.35888 0.65967-0.1333 0.35889-0.1333 0.76221z m2.33447 0.58447q-0.23584 0-0.41016-0.17431-0.17432-0.17432-0.17431-0.41016 0-0.23584 0.17431-0.41016 0.17432-0.17431 0.41016-0.17431 0.23584 0 0.41016 0.17431 0.17431 0.17432 0.17431 0.41016 0 0.23584-0.17431 0.41016-0.17432 0.17431-0.41016 0.17431z m2.33447-0.58447q0-0.40332-0.1333-0.76221-0.1333-0.3623-0.35888-0.65966-0.0752-0.10254-0.07862-0.21875-0.00342-0.11963 0.0957-0.21875 0.0957-0.0957 0.21534-0.08204 0.12305 0.01367 0.20166 0.11621 0.3042 0.37939 0.47168 0.84083 0.16748 0.46143 0.16748 0.98437 0 0.51953-0.16748 0.98438-0.16748 0.46143-0.47168 0.84082-0.0752 0.10254-0.20166 0.11621-0.12305 0.01025-0.21875-0.08545-0.09912-0.09912-0.09571-0.21533 0.00684-0.11621 0.08204-0.21875 0.22559-0.29736 0.35888-0.65625 0.1333-0.3623 0.1333-0.76563z m2.33106 0q0-0.88525-0.3042-1.66113-0.3042-0.7793-0.8374-1.39453-0.09228-0.10596-0.10596-0.22559-0.01367-0.12305 0.08545-0.22217 0.0957-0.0957 0.21533-0.08203 0.11963 0.01367 0.21533 0.11621 0.61182 0.69727 0.96387 1.58252 0.35205 0.88184 0.35205 1.88672 0 1.00488-0.35205 1.88672-0.35205 0.88184-0.96387 1.58252-0.0957 0.10254-0.21533 0.11621-0.11621 0.01367-0.21191-0.08203-0.09912-0.09912-0.08887-0.21875 0.01367-0.12305 0.10596-0.22901 0.5332-0.61865 0.8374-1.39453 0.3042-0.7793 0.3042-1.66113z",
  monitoring: "M2.33447 11.95947q-0.12646 0-0.21191-0.08203-0.08203-0.08545-0.08203-0.21191l0-0.45801q0-0.12305 0.08203-0.2085 0.08545-0.08545 0.21191-0.08545 0.12305 0 0.20508 0.08545 0.08545 0.08545 0.08545 0.2085l0 0.45801q0 0.12646-0.08545 0.21191-0.08203 0.08203-0.20508 0.08203z m2.33106 0q-0.12305 0-0.2085-0.08203-0.08203-0.08545-0.08203-0.21191l0-3.08301q0-0.12305 0.08203-0.2085 0.08545-0.08545 0.2085-0.08545 0.12646 0 0.20849 0.08545 0.08545 0.08203 0.08545 0.2085l0 3.08301q0 0.12646-0.08545 0.21191-0.08203 0.08203-0.20849 0.08203z m2.33447 0q-0.12305 0-0.2085-0.08203-0.08203-0.08545-0.08203-0.21191l0-1.91748q0-0.12305 0.08203-0.20508 0.08545-0.08545 0.2085-0.08545 0.12305 0 0.20508 0.08545 0.08545 0.08203 0.08545 0.20508l0 1.91748q0 0.12646-0.08545 0.21191-0.08203 0.08203-0.20508 0.08203z m2.33447 0q-0.12646 0-0.21191-0.08203-0.08203-0.08545-0.08203-0.20508 0-0.12305 0.08203-0.20507 0.12646-0.08545 0.21191-0.08545 0.12305 0 0.20508 0.08545 0.08545 0.08204 0.08545 0.20507l0 2.79248q0 0.12305-0.08545 0.21191-0.08203 0.08203-0.20166 0.08203z m2.33106 0q-0.12646 0-0.2085-0.08203-0.08545-0.08545-0.08545-0.21191l0-5.12696q0-0.12305 0.08545-0.20507 0.08204-0.08545 0.2085-0.08545 0.12305 0 0.20508 0.08545 0.08545 0.08204 0.08545 0.20507l0 5.12696q0 0.12646-0.08545 0.21191-0.08203 0.08203-0.20508 0.08203z",
  usb: "M7 12.32c-.37 0-.62-.25-.62-.62 0-.27.05-.45.16-.5V9.61H4.79c-.4 0-.67-.27-.67-.67V7.71a.62.62 0 0 1-.42-.3.78.78 0 0 1-.16-.52c0-.37.25-.62.62-.62s.62.25.62.62c0 .3-.06.51-.17.51v1.23c0 .13.11.25.25.25h1.75V4.08h-.4c-.14 0-.21-.13-.21-.25s.07-.2.02-.25l.7-.92c.08-.09.19-.09.27 0l.7.92c.08.12.08.2.02.25s-.21.25-.4.25h-.4v4.8h1.75c.14 0 .25-.11.25-.25V7.46h-.35a.23.23 0 0 1-.17-.07.23.23 0 0 1-.07-.17V5.94c0-.09.02-.16.07-.16.05-.07.11-.07.16-.07h1.28c.09 0 .16.02.16.07.07.05.07.11.07.16v1.28c0 .1-.02.17-.07.17-.05.07-.11.07-.16.07h-.35v1.17c0 .4-.27.67-.67.67H7.71v1.59c.27.09.42.31.42.5 0 .37-.25.62-.62.62z",
  usb_off: "M7 12.31836q-0.36914 0-0.62207-0.25293-0.25293-0.25293-0.25293-0.62207 0-0.27344 0.16064-0.49561 0.16064-0.22559 0.42383-0.31787l0-1.58935-1.75 0q-0.40332 0-0.67334-0.27002-0.27002-0.27002-0.27002-0.66992l0-1.23047q-0.25293-0.08545-0.42041-0.29737-0.16406-0.21191-0.16406-0.51611 0-0.31787 0.19824-0.54004 0.19824-0.22559 0.49903-0.26318l-2.40284-2.40283q-0.08203-0.08203-0.08203-0.19141 0-0.11279 0.09571-0.21191 0.09912-0.0957 0.20849-0.09571 0.11279 0 0.2085 0.09571l9.56689 9.56689q0.08203 0.08203 0.08203 0.19482 0.00342 0.10938-0.0957 0.2085-0.0957 0.0957-0.2085 0.0957-0.10938 0-0.20507-0.0957l-3.38037-3.37695-0.62549 0 0 1.58935q0.2666 0.08887 0.42383 0.31446 0.16064 0.22217 0.16064 0.49902 0 0.36914-0.25293 0.62207-0.25293 0.25293-0.62207 0.25293z m3.56836-6.88721l0 1.2544q0 0.10596-0.07178 0.17773-0.07178 0.06836-0.17773 0.06836l-0.33496 0 0 0.99805q0 0.14697-0.09229 0.22217-0.09229 0.07178-0.19824 0.07177-0.10596 0-0.20166-0.07861-0.09229-0.08203-0.09229-0.229l0-0.98438-0.34521 0q-0.0957 0-0.16748-0.06836-0.06836-0.07178-0.06836-0.16748l0-1.26465q0-0.10596 0.06836-0.17773 0.07178-0.07178 0.17773-0.07178l1.2544 0q0.10596 0 0.17773 0.07178 0.07178 0.07178 0.07178 0.17773z m-5.60889 3.02832l1.75 0 0-0.62549-1.59619-1.59961q-0.01367 0.24268-0.16064 0.40674-0.14697 0.16406-0.35205 0.22901l0 1.23047q0 0.1333 0.10937 0.24609 0.11279 0.11279 0.24951 0.11279z m1.75-4.80224l-0.41699 0q-0.14014 0-0.20508-0.12647-0.06494-0.12646 0.02735-0.24951l0.68701-0.9126q0.04102-0.05811 0.19824-0.09228 0.06152 0 0.11279 0.02392 0.05469 0.02051 0.08545 0.06836l0.67334 0.88867q0.0957 0.12305 0.03076 0.26319-0.06494 0.13672-0.229 0.13672l-0.38281 0 0 1.58252q0 0.14355-0.09229 0.21875-0.09229 0.07178-0.19824 0.07177-0.10596 0-0.19824-0.07519-0.09229-0.0752-0.09229-0.21875l0-1.5791z",
  power: "M7 1.5v5.25M4.19 3.14a4.5 4.5 0 1 0 5.62 0",
  refresh: "M11.5 3.5v3h-3M2.5 10.5v-3h3M3.7 5.4A4.5 4.5 0 0 1 11 5.2M10.3 8.6A4.5 4.5 0 0 1 3 8.8"
};
function ControllerGlyph({ name }: { name: ControllerGlyphName }): ReactElement { const stroked = name === "power" || name === "refresh"; return <svg className="controller-glyph" viewBox={name === "push_pin" ? "0 0 24 24" : "0 0 14 14"} aria-hidden="true"><path d={controllerGlyphPaths[name]} fill={stroked ? "none" : "currentColor"} stroke={stroked ? "currentColor" : undefined} strokeLinecap={stroked ? "round" : undefined} strokeWidth={stroked ? 1.25 : undefined} /></svg>; }

const isControllerSyncing = (snapshot: ControllerSnapshot) => snapshot.state === "Searching" ||
  snapshot.state === "ConnectedWaitingForData" || snapshot.state === "SyncingDevice" || snapshot.state === "SyncingHall";

function ControllerSkeleton(): ReactElement {
  return <div className="controller-skeleton" role="status" aria-label="正在加载控制器">
    <div className="controller-skeleton-monitor">
      <div className="controller-skeleton-topbar"><i className="controller-skeleton-icon" /><i className="controller-skeleton-title" /></div>
      <div className="controller-skeleton-monitor-body">
        <div className="controller-skeleton-canvas">
          <i className="controller-skeleton-status" /><i className="controller-skeleton-axis" />
          <div className="controller-skeleton-keys">{Array.from({ length: 10 }, (_, index) => <i key={index} />)}</div>
          <i className="controller-skeleton-footer" />
        </div>
        <div className="controller-skeleton-inspector"><i className="controller-skeleton-tabs" />{Array.from({ length: 6 }, (_, index) => <i key={index} className="controller-skeleton-info" />)}</div>
      </div>
    </div>
    <div className="controller-skeleton-accordions">{Array.from({ length: 2 }, (_, index) => <div key={index} className="controller-skeleton-accordion"><i className="controller-skeleton-accordion-title" /><i className="controller-skeleton-accordion-main" /><i className="controller-skeleton-accordion-line" /><i className="controller-skeleton-accordion-line short" /></div>)}</div>
  </div>;
}

export function ControllerStatusCard(): ReactElement {
  const { snapshot, moduleStatus } = useController();
  const { online, text, note } = controllerStatusView(snapshot, moduleStatus);
  return <article className={`surface status controller-status-card ${online ? "is-online" : "muted"}`}><span className="status-leading"><PencilGamepadIcon /></span><div><small>控制器</small><b>{text}</b><span>{note}</span></div><span className={`status-result ${online ? "ok" : ""}`} aria-label={online ? "已连接" : text}>{online ? <PencilCheckIcon /> : <PencilCloseIcon />}</span></article>;
}

export function ControllerPage(props: ControllerPageProps): ReactElement {
  const controller = useController();
  return <ControllerWorkspace key={controllerConnectionKey(controller.snapshot)} {...props} controller={controller} />;
}

function ControllerWorkspace({ gameRoot = "", onConfigurationChanged, controller }: ControllerPageProps & {
  controller: ReturnType<typeof useController>;
}): ReactElement {
  const { snapshot, moduleStatus, invoke } = controller;
  const workspaceActive = useRef(true);
  const connection = controllerConnectionKey(snapshot);
  const resolvedGameRoot = gameRoot || window.localStorage.getItem("ogk-toolbox.game-root.v1") || "";
  const [gameProcesses, setGameProcesses] = useState<string[]>([]);
  const [inspectorTab, setInspectorTab] = useState<"info" | "magnetic">("info");
  const [keyboardInputEnabled, setKeyboardInputEnabled] = useState(false);
  const [keyboardInputBusy, setKeyboardInputBusy] = useState(false);
  const [keyboardInputError, setKeyboardInputError] = useState("");
  const [keyboardInputNotice, setKeyboardInputNotice] = useState("");
  const [controllerConfigurationReady, setControllerConfigurationReady] = useState(false);
  const [controllerIoConfigured, setControllerIoConfigured] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [initialConnectionLoading, setInitialConnectionLoading] = useState(false);
  const [controllerRevealLoading, setControllerRevealLoading] = useState(false);
  const [controllerPromptOpen, setControllerPromptOpen] = useState(false);
  const [controllerPromptBusy, setControllerPromptBusy] = useState(false);
  const [controllerPromptError, setControllerPromptError] = useState("");
  const [keyboardHeldKeys, setKeyboardHeldKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [keyboardBindings, setKeyboardBindings] = useState<Readonly<Record<string, KeyboardBinding>>>({});
  const [keyboardConfigRevision, setKeyboardConfigRevision] = useState(0);
  const refreshStartedAt = useRef<number | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const keyboardNoticeTimer = useRef<number | null>(null);
  const controllerRevealTimer = useRef<number | null>(null);
  const controllerRevealPending = useRef(false);
  const promptedControllerKind = useRef<ControllerSnapshot["identity"]["kind"]>("Unknown");
  const connectedKind = useRef<ControllerSnapshot["identity"]["kind"]>("Unknown");
  const command: ControllerCommandInvoker = (task, options) => {
    if (!workspaceActive.current || connection !== controllerConnectionKey(cachedControllerSnapshot)) return Promise.resolve(undefined);
    return invoke(task, options);
  };
  const releaseAll = useCallback(() => { void window.ogk.controllerReleaseAll().catch(() => {}); }, []);
  const connected = moduleStatus.state === "ready" && isOnline(snapshot);
  const keyboardOnly = !connected && keyboardInputEnabled;
  const connectedDeviceName = snapshot.identity.kind === "Leonardo" ? "NYAGEKI" : snapshot.identity.kind === "Pico" ? "LUXIS" :
    snapshot.identity.kind === "SimGEKI" ? "SimGEKI" : snapshot.identity.kind === "IO4Compatible" ? "IO4" : null;

  useEffect(() => {
    workspaceActive.current = true;
    return () => {
      workspaceActive.current = false;
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      if (keyboardNoticeTimer.current !== null) window.clearTimeout(keyboardNoticeTimer.current);
      if (controllerRevealTimer.current !== null) window.clearTimeout(controllerRevealTimer.current);
    };
  }, []);
  useEffect(() => {
    let active = true;
    setControllerConfigurationReady(false);
    setControllerIoConfigured(false);
    setKeyboardInputError("");
    if (!resolvedGameRoot) {
      setKeyboardInputEnabled(false);
      setKeyboardBindings({});
      setControllerConfigurationReady(true);
      return () => { active = false; };
    }
    void window.ogk.inspectConfiguration(resolvedGameRoot).then(configuration => {
      if (!active) return;
      const file = (configuration.files ?? []).find((item: any) => item.kind === "SegaTools");
      const keyboard = findSegatoolsEntry(file, "io4", "keyboard");
      const mu3io = findSegatoolsEntry(file, "mu3io", "path");
      const nextBindings: Record<string, KeyboardBinding> = {};
      for (const definition of keyboardBindingDefinitions) {
        const entry = findSegatoolsEntry(file, "io4", definition.configKey);
        nextBindings[definition.command] = keyboardBindingFromValue(entry?.value, definition.fallback, definition.fallbackEventKey, definition.side);
      }
      setKeyboardInputEnabled(String(keyboard?.value ?? "") === "1");
      setKeyboardBindings(nextBindings);
      const mu3ioPath = String(mu3io?.value ?? "").trim().replace(/^['"]|['"]$/g, "").toLowerCase();
      setControllerIoConfigured(mu3ioPath.endsWith("nyageki_io.dll"));
      setControllerConfigurationReady(true);
    }).catch(() => {
      if (active) {
        setKeyboardInputEnabled(false);
        setKeyboardBindings({});
        setControllerIoConfigured(false);
        setControllerConfigurationReady(false);
      }
    });
    return () => { active = false; };
  }, [keyboardConfigRevision, resolvedGameRoot]);
  useEffect(() => {
    const refresh = () => setKeyboardConfigRevision(current => current + 1);
    window.addEventListener("ogk:configuration-changed", refresh);
    return () => window.removeEventListener("ogk:configuration-changed", refresh);
  }, []);
  useEffect(() => {
    const keyMap = new Map<string, string[]>();
    const mouseMap = new Map<number, string[]>();
    for (const [command, binding] of Object.entries(keyboardBindings)) {
      if (binding.eventKey !== null) {
        const eventKey = binding.eventKey.toLowerCase();
        const commands = keyMap.get(eventKey) ?? [];
        commands.push(command);
        keyMap.set(eventKey, commands);
      }
      if (binding.mouseButton !== null) {
        const commands = mouseMap.get(binding.mouseButton) ?? [];
        commands.push(command);
        mouseMap.set(binding.mouseButton, commands);
      }
    }
    if (!keyboardOnly) {
      setKeyboardHeldKeys(current => current.size === 0 ? current : new Set());
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      const mapped = keyMap.get(event.key.toLowerCase());
      if (!mapped?.length) return;
      setKeyboardHeldKeys(current => {
        if (mapped.every(command => current.has(command))) return current;
        const next = new Set(current);
        mapped.forEach(command => next.add(command));
        return next;
      });
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const mapped = keyMap.get(event.key.toLowerCase());
      if (!mapped?.length) return;
      setKeyboardHeldKeys(current => {
        if (!mapped.some(command => current.has(command))) return current;
        const next = new Set(current);
        mapped.forEach(command => next.delete(command));
        return next;
      });
    };
    const onMouseDown = (event: MouseEvent) => {
      const mapped = mouseMap.get(event.button);
      if (!mapped?.length) return;
      setKeyboardHeldKeys(current => {
        if (mapped.every(command => current.has(command))) return current;
        const next = new Set(current);
        mapped.forEach(command => next.add(command));
        return next;
      });
    };
    const onMouseUp = (event: MouseEvent) => {
      const mapped = mouseMap.get(event.button);
      if (!mapped?.length) return;
      setKeyboardHeldKeys(current => {
        if (!mapped.some(command => current.has(command))) return current;
        const next = new Set(current);
        mapped.forEach(command => next.delete(command));
        return next;
      });
    };
    const onContextMenu = (event: MouseEvent) => {
      if (mouseMap.has(2)) event.preventDefault();
    };
    const clear = () => setKeyboardHeldKeys(current => current.size === 0 ? current : new Set());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("blur", clear);
    window.addEventListener("pagehide", clear);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("blur", clear);
      window.removeEventListener("pagehide", clear);
    };
  }, [keyboardBindings, keyboardOnly]);
  useEffect(() => {
    if (snapshot.identity.kind === "Unknown") {
      connectedKind.current = "Unknown";
      setInitialConnectionLoading(false);
      setControllerRevealLoading(false);
      setControllerPromptOpen(false);
      setControllerPromptError("");
      controllerRevealPending.current = false;
      promptedControllerKind.current = "Unknown";
      if (controllerRevealTimer.current !== null) {
        window.clearTimeout(controllerRevealTimer.current);
        controllerRevealTimer.current = null;
      }
      return;
    }
    if (connectedKind.current !== snapshot.identity.kind) {
      connectedKind.current = snapshot.identity.kind;
      setInitialConnectionLoading(isControllerSyncing(snapshot));
      promptedControllerKind.current = "Unknown";
      if (snapshot.identity.kind === "Leonardo" || snapshot.identity.kind === "Pico") {
        controllerRevealPending.current = true;
        setControllerRevealLoading(true);
        if (controllerRevealTimer.current !== null) window.clearTimeout(controllerRevealTimer.current);
        controllerRevealTimer.current = window.setTimeout(() => {
          controllerRevealTimer.current = null;
          controllerRevealPending.current = false;
          setControllerRevealLoading(false);
        }, 500);
      }
    }
    if (snapshot.state === "ConnectedWaitingForData") setInitialConnectionLoading(true);
    else if (snapshot.state === "Ready") setInitialConnectionLoading(false);
  }, [snapshot.identity.kind, snapshot.state]);
  useEffect(() => {
    const kind = snapshot.identity.kind;
    if (!connected || !controllerConfigurationReady || controllerRevealLoading || controllerRevealPending.current || (kind !== "Leonardo" && kind !== "Pico")) return;
    if (controllerIoConfigured && !keyboardInputEnabled) return;
    if (promptedControllerKind.current === kind) return;
    promptedControllerKind.current = kind;
    setControllerPromptError("");
    setControllerPromptOpen(true);
  }, [connected, controllerConfigurationReady, controllerIoConfigured, controllerRevealLoading, keyboardInputEnabled, snapshot.identity.kind]);
  useEffect(() => {
    if (!refreshing) return;
    const finished = snapshot.state === "Ready" || snapshot.identity.kind === "Unknown" ||
      snapshot.state === "SyncFailed" || snapshot.state === "Faulted" || snapshot.state === "Unsupported" || snapshot.state === "BootloaderPending";
    if (!finished) return;
    const elapsed = Date.now() - (refreshStartedAt.current ?? Date.now());
    const complete = () => {
      refreshTimer.current = null;
      refreshStartedAt.current = null;
      setRefreshing(false);
    };
    if (elapsed >= 1000) complete();
    else {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(complete, 1000 - elapsed);
    }
    return () => {
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [refreshing, snapshot.identity.kind, snapshot.state]);
  useEffect(() => {
    let active = true;
    const refresh = () => void window.ogk.gameRunningProcesses().then(value => { if (active) setGameProcesses(value); }).catch(() => {});
    refresh();
    const timer = window.setInterval(refresh, 3000);
    const release = () => releaseAll();
    window.addEventListener("blur", release); window.addEventListener("pagehide", release);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("blur", release); window.removeEventListener("pagehide", release); release(); };
  }, [releaseAll]);

  const virtualButtons = useMemo(() => {
    const keyboardMouse = snapshot.deviceConfig.isKmMode || (!connected && keyboardInputEnabled);
    const keyboardLabel = (command: string, fallback: string) => keyboardOnly ? keyboardBindings[command]?.label ?? fallback : fallback;
    // Keep KM labels and shortcuts aligned with the firmware KEY_MAP:
    // L-A/S/D, L-Menu/U, R-A/J/K/L, R-Menu/O, and mouse clicks for Side.
    return [
       ["L_Side", keyboardMouse ? keyboardLabel("L_Side", "L-CLK") : "SIDE", snapshot.input.leftSide || (keyboardOnly && keyboardHeldKeys.has("L_Side")), "left-side", keyboardMouse ? null : "a"],
       ["L_Menu", keyboardMouse ? keyboardLabel("L_Menu", "U") : "MENU", snapshot.input.leftMenu || (keyboardOnly && keyboardHeldKeys.has("L_Menu")), "left-menu", keyboardMouse ? "u" : "s"],
       ["L_A", keyboardMouse ? keyboardLabel("L_A", "A") : "A", snapshot.input.leftA || (keyboardOnly && keyboardHeldKeys.has("L_A")), "left-a", keyboardMouse ? "a" : "q"],
       ["L_B", keyboardMouse ? keyboardLabel("L_B", "S") : "B", snapshot.input.leftB || (keyboardOnly && keyboardHeldKeys.has("L_B")), "left-b", keyboardMouse ? "s" : "w"],
       ["L_C", keyboardMouse ? keyboardLabel("L_C", "D") : "C", snapshot.input.leftC || (keyboardOnly && keyboardHeldKeys.has("L_C")), "left-c", keyboardMouse ? "d" : "e"],
       ["R_A", keyboardMouse ? keyboardLabel("R_A", "J") : "A", snapshot.input.rightA || (keyboardOnly && keyboardHeldKeys.has("R_A")), "right-a", keyboardMouse ? "j" : "u"],
       ["R_B", keyboardMouse ? keyboardLabel("R_B", "K") : "B", snapshot.input.rightB || (keyboardOnly && keyboardHeldKeys.has("R_B")), "right-b", keyboardMouse ? "k" : "i"],
       ["R_C", keyboardMouse ? keyboardLabel("R_C", "L") : "C", snapshot.input.rightC || (keyboardOnly && keyboardHeldKeys.has("R_C")), "right-c", keyboardMouse ? "l" : "o"],
       ["R_Menu", keyboardMouse ? keyboardLabel("R_Menu", "O") : "MENU", snapshot.input.rightMenu || (keyboardOnly && keyboardHeldKeys.has("R_Menu")), "right-menu", keyboardMouse ? "o" : "k"],
       ["R_Side", keyboardMouse ? keyboardLabel("R_Side", "R-CLK") : "SIDE", snapshot.input.rightSide || (keyboardOnly && keyboardHeldKeys.has("R_Side")), "right-side", keyboardMouse ? null : "j"]
    ] as const;
  }, [connected, keyboardInputEnabled, keyboardOnly, keyboardHeldKeys, keyboardBindings, snapshot.deviceConfig.isKmMode, snapshot.input]);
  const press = (key: string, event: React.PointerEvent<HTMLButtonElement>) => { if (!snapshot.capabilities.virtualKeys) return; event.currentTarget.setPointerCapture(event.pointerId); void command(() => window.ogk.controllerVirtualKey(key, true)); };
  const release = (key: string) => { if (snapshot.capabilities.virtualKeys) void command(() => window.ogk.controllerVirtualKey(key, false)); };
  const pressFromKeyboard = (key: string, event: React.KeyboardEvent<HTMLButtonElement>) => { if (event.repeat || !snapshot.capabilities.virtualKeys) return; event.preventDefault(); void command(() => window.ogk.controllerVirtualKey(key, true)); };
  const releaseFromKeyboard = (key: string, event: React.KeyboardEvent<HTMLButtonElement>) => { if (!snapshot.capabilities.virtualKeys) return; event.preventDefault(); void command(() => window.ogk.controllerVirtualKey(key, false)); };
  const rescan = () => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshStartedAt.current = Date.now();
    setRefreshing(true);
    void command(() => window.ogk.controllerRescan());
  };
  const restart = () => { void window.ogk.controllerRestart().catch(() => {}); };
  const pageLoading = moduleStatus.state !== "ready" || refreshing;
  const controllerConnectionChanging = snapshot.identity.kind === "Leonardo" || snapshot.identity.kind === "Pico"
    ? connectedKind.current !== snapshot.identity.kind
    : false;
  const transitionLoading = refreshing || initialConnectionLoading || controllerRevealLoading || controllerConnectionChanging;
  const configurationReadbackPending = snapshot.state === "SyncingDevice" || snapshot.state === "SyncingHall";
  const keyboardMonitorSnapshot = keyboardOnly ? {
    ...snapshot,
    state: "Ready" as const,
    identity: { ...snapshot.identity, kind: "Pico" as const, displayName: "LUXIS" },
    capabilities: {
      ...snapshot.capabilities, inputMonitor: true, virtualKeys: true, mode: true, basicLighting: true,
      picoLighting: true, hallConfiguration: true, hallCalibration: true, leverConfiguration: true,
      leverCalibration: true, cardReader: true, bootloader: false
    },
    deviceConfig: { ...snapshot.deviceConfig, valid: true, isKmMode: true, protocolSupported: true }
  } : snapshot;
  const showKeyboardInputNotice = (message: string) => {
    if (keyboardNoticeTimer.current !== null) window.clearTimeout(keyboardNoticeTimer.current);
    setKeyboardInputNotice(message);
    keyboardNoticeTimer.current = window.setTimeout(() => {
      keyboardNoticeTimer.current = null;
      setKeyboardInputNotice("");
    }, 2600);
  };
  const setKeyboardInput = async (enabled: boolean) => {
    if (keyboardInputBusy || !resolvedGameRoot) return;
    setKeyboardInputBusy(true);
    setKeyboardInputError("");
    try {
      const configuration = await window.ogk.inspectConfiguration(resolvedGameRoot);
      const file = (configuration.files ?? []).find((item: any) => item.kind === "SegaTools");
      const keyboard = findSegatoolsEntry(file, "io4", "keyboard");
      const mouse = findSegatoolsEntry(file, "io4", "mouse");
      const mu3io = findSegatoolsEntry(file, "mu3io", "path");
      if (!file?.exists || !keyboard || !mouse || !mu3io) throw new Error("未找到 Segatools 的键盘输入、鼠标摇杆或 MU3IO 配置项。");
      const edits: any[] = [];
      if (String(keyboard.value ?? "") !== (enabled ? "1" : "0")) edits.push(segatoolsEdit(keyboard, enabled ? "1" : "0"));
      if (String(mouse.value ?? "") !== (enabled ? "1" : "0")) edits.push(segatoolsEdit(mouse, enabled ? "1" : "0"));
      if (enabled && String(mu3io.value ?? "").trim() !== "") edits.push(segatoolsEdit(mu3io, ""));
      if (edits.length > 0) {
        const preview = await window.ogk.previewConfiguration({ gameRoot: resolvedGameRoot, kind: file.kind, baselineHash: file.contentHash, edits });
        if (!preview?.canSave) throw new Error(preview?.validationErrors?.join(" ") || "Segatools 配置未通过校验。");
        await window.ogk.saveConfiguration({ gameRoot: resolvedGameRoot, preview });
      }
      setKeyboardInputEnabled(enabled);
      window.dispatchEvent(new Event("ogk:configuration-changed"));
      showKeyboardInputNotice("已自动修改segatools配置");
      await onConfigurationChanged?.();
    } catch (error) {
      setKeyboardInputError(error instanceof Error ? error.message : "修改 Segatools 配置失败。");
    } finally {
      setKeyboardInputBusy(false);
    }
  };
  const useControllerForGame = async () => {
    if (controllerPromptBusy || !resolvedGameRoot) {
      if (!resolvedGameRoot) setControllerPromptError("请先选择并扫描游戏目录。");
      return;
    }
    setControllerPromptBusy(true);
    setControllerPromptError("");
    try {
      const configuration = await window.ogk.inspectConfiguration(resolvedGameRoot);
      const file = (configuration.files ?? []).find((item: any) => item.kind === "SegaTools");
      const keyboard = findSegatoolsEntry(file, "io4", "keyboard");
      const mouse = findSegatoolsEntry(file, "io4", "mouse");
      const mu3io = findSegatoolsEntry(file, "mu3io", "path");
      const aimeio = findSegatoolsEntry(file, "aimeio", "path");
      if (!file?.exists || !keyboard || !mouse || !mu3io || (snapshot.identity.kind === "Pico" && !aimeio))
        throw new Error("未找到 Segatools 的控制器输入配置项。");
      const edits: any[] = [];
      if (String(keyboard.value ?? "") !== "0") edits.push(segatoolsEdit(keyboard, "0"));
      if (String(mouse.value ?? "") !== "0") edits.push(segatoolsEdit(mouse, "0"));
      if (String(mu3io.value ?? "").trim() !== "NYAGEKI_IO.dll") edits.push(segatoolsEdit(mu3io, "NYAGEKI_IO.dll"));
      if (snapshot.identity.kind === "Pico" && String(aimeio?.value ?? "").trim() !== "NYAGEKI_IO.dll") edits.push(segatoolsEdit(aimeio, "NYAGEKI_IO.dll"));
      let preview: any = null;
      if (edits.length > 0) {
        preview = await window.ogk.previewConfiguration({ gameRoot: resolvedGameRoot, kind: file.kind, baselineHash: file.contentHash, edits });
        if (!preview?.canSave) throw new Error(preview?.validationErrors?.join(" ") || "Segatools 配置未通过校验。");
      }
      await window.ogk.installControllerIo(resolvedGameRoot);
      if (preview) await window.ogk.saveConfiguration({ gameRoot: resolvedGameRoot, preview });
      setKeyboardInputEnabled(false);
      window.dispatchEvent(new Event("ogk:configuration-changed"));
      await onConfigurationChanged?.();
      showKeyboardInputNotice("已自动修改segatools配置");
      setControllerPromptOpen(false);
    } catch (error) {
      setControllerPromptError(error instanceof Error ? error.message : "自动修改 Segatools 配置失败。");
    } finally {
      setControllerPromptBusy(false);
    }
  };

  return <div className={`controller-page ${connected ? "is-connected" : "is-disconnected"} ${keyboardOnly ? "is-keyboard-input" : ""} ${configurationReadbackPending ? "is-config-readback" : ""}`}>
     <div className="controller-page-header">
       <div><h1 key={connected ? "connected" : keyboardOnly ? "keyboard-input" : "disconnected"}>控制器</h1><p>{connected ? "Signal-first tuning console · 1440 × 900" : keyboardOnly ? "已启用 Segatools 键盘输入 · 未连接硬件控制器" : "未检测到兼容控制器 · 请连接设备后重新扫描"}</p></div>
       <div className="controller-page-actions"><ControllerDeviceSelector status={moduleStatus} command={command} />{connected ? <button type="button" className="controller-refresh" disabled={refreshing} onClick={rescan}>刷新设备</button> : <span className={`connection-chip ${keyboardOnly ? "is-keyboard-input" : ""}`}><i />{keyboardOnly ? "键盘输入" : "未连接"}</span>}</div>
     </div>
     {keyboardInputNotice && <div className="controller-config-toast" role="status" aria-live="polite">{keyboardInputNotice}</div>}
     {connected || keyboardOnly ? <>
       <div className={`controller-transition-shell ${transitionLoading ? "is-loading" : "is-ready"}`} aria-busy={transitionLoading}>
        <div className="controller-transition-content"><InputMonitor snapshot={keyboardMonitorSnapshot} virtualButtons={virtualButtons} keyboardHeldKeys={keyboardHeldKeys} keyboardBindings={keyboardBindings} keyboardInputOnly={keyboardOnly} onPress={press} onRelease={release} onPressKeyboard={pressFromKeyboard} onReleaseKeyboard={release} onReleaseAll={releaseAll} inspectorTab={inspectorTab} onInspectorTab={setInspectorTab} command={command} /><ControllerAccordionsV2 snapshot={keyboardMonitorSnapshot} command={command} disabled={keyboardOnly} keyboardInputOnly={keyboardOnly} /></div>
      <div className="controller-transition-skeleton"><ControllerSkeleton /></div>
      </div>
    </> : pageLoading ? <ControllerSkeleton /> : <DisconnectedWorkspace snapshot={snapshot} moduleStatus={moduleStatus} onRescan={rescan} onRestart={restart} keyboardInputEnabled={keyboardInputEnabled} keyboardInputBusy={keyboardInputBusy} keyboardInputError={keyboardInputError} gameRootAvailable={Boolean(resolvedGameRoot)} onKeyboardInputChange={setKeyboardInput} />}
     <span className="controller-live-status" role="status" aria-live="polite">{gameProcesses.length > 0 ? `游戏正在运行：${gameProcesses.join("、")}。控制器功能仍保持可用。` : ""}</span>
     {controllerPromptOpen && <div className="confirm-backdrop"><section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="controller-prompt-title"><h2 id="controller-prompt-title">使用控制器进行游戏？</h2><p>已连接 {connectedDeviceName ?? controllerDisplayName(snapshot)}。确认后会关闭键盘输入，并自动配置控制器 IO。</p>{controllerPromptError && <p className="controller-prompt-error" role="alert">{controllerPromptError}</p>}<div><button type="button" disabled={controllerPromptBusy} onClick={() => setControllerPromptOpen(false)}>否</button><button type="button" className="primary-action" disabled={controllerPromptBusy} onClick={() => void useControllerForGame()}>{controllerPromptBusy ? "正在修改…" : "是"}</button></div></section></div>}
   </div>;
}

type VirtualButton = readonly [string, string, boolean, string, string | null];

export function ControllerDeviceSelector({ status, command }: {
  status: ControllerModuleStatus; command: ControllerCommandInvoker;
}): ReactElement | null {
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState("");
  const selectionPending = useRef(false);
  const devices = status.backends?.filter(backend => backend.connected).map(backend => ({ ...backend,
    displayLabel: controllerDisplayName({ identity: { kind: backend.kind ?? "Unknown", displayName: backend.label } })
  })) ?? [];
  if (!devices.length) return <span className="controller-supported-devices is-offline">
    <span>已支持设备：</span>
    {["NYAGEKI", "LUXIS", "SimGEKI", "IO4"].map(label => <b key={label} className="controller-supported-device">{label}</b>)}
  </span>;
  if (devices.length === 1) return <span className="controller-supported-devices">
    <b className="controller-supported-device is-connected" title={devices[0].displayLabel}>
      <span className="controller-device-label">{devices[0].displayLabel}</span>
    </b>
  </span>;
  const select = async (backendId: string, fromKeyboard: boolean) => {
    if (selecting || selectionPending.current) return;
    selectionPending.current = true;
    setSelecting(true); setError("");
    try {
      const result = await command(() => window.ogk.controllerSelectBackend(backendId), { allowConnectionChange: true });
      if (!result) setError("设备切换未完成，请重试。");
      else if (result.status === "Failed" || result.status === "Rejected") setError(result.message || "设备切换失败，请重试。");
      else if (fromKeyboard) window.requestAnimationFrame(() => {
        // Switching connections remounts the workspace; keep keyboard focus on its selected tag.
        const selected = Array.from(document.querySelectorAll<HTMLButtonElement>(".controller-device-selector button"))
          .find(button => button.dataset.backendId === backendId && button.getAttribute("aria-pressed") === "true");
        selected?.focus({ preventScroll: true });
      });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { selectionPending.current = false; setSelecting(false); }
  };
  return <div className="controller-device-choice">
    <div className="controller-supported-devices controller-device-selector" role="group" aria-label="切换控制器" aria-busy={selecting}>
      {devices.map(backend => <button type="button" key={backend.id} title={backend.displayLabel} data-backend-id={backend.id}
        className={`controller-supported-device${backend.selected ? " is-connected" : ""}`} aria-pressed={backend.selected}
        disabled={selecting} onClick={event => { if (!backend.selected) void select(backend.id, event?.detail === 0); }}>
        <span className="controller-device-label">{backend.displayLabel}</span>
      </button>)}
    </div>
    {error && <p className="controller-prompt-error" role="alert">{error}</p>}
  </div>;
}

export function ControllerModeControl({ snapshot, command, readOnly = false }: {
  snapshot: ControllerSnapshot; command: ControllerCommandInvoker; readOnly?: boolean;
}): ReactElement {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const modes = snapshot.inputModes;
  const current = modes?.options.find(option => option.id === modes.current)?.label ?? "未提供";
  const writable = !readOnly && snapshot.capabilities.mode && snapshot.canWrite && !!modes?.options.length;
  const setMode = async (id: string) => {
    setPending(true);
    setError("");
    try {
      const result = await command(() => window.ogk.controllerSetInputMode(id));
      if (!result) setError("输入模式切换未完成，请重试。");
      else if (result.status === "Failed" || result.status === "Rejected")
        setError(result.message || "输入模式切换失败，请重试。");
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  return <div className="controller-mode-control">
    {writable && modes ? <div className="input-mode-segmented controller-input-modes" role="group" aria-label="输入模式" aria-busy={pending}>
      {modes.options.map(option => <button type="button" key={option.id}
        className={modes.current === option.id ? "selected" : ""} aria-pressed={modes.current === option.id}
        disabled={pending} onClick={() => { if (modes.current !== option.id) void setMode(option.id); }}>{option.label}</button>)}
    </div> : <span>{current}</span>}
    {error && <span className="controller-prompt-error" role="alert">{error}</span>}
  </div>;
}

function InputMonitor({ snapshot, virtualButtons, keyboardHeldKeys, keyboardBindings, keyboardInputOnly = false, onPress, onRelease, onPressKeyboard, onReleaseKeyboard, onReleaseAll, inspectorTab, onInspectorTab, command }: { snapshot: ControllerSnapshot; virtualButtons: readonly VirtualButton[]; keyboardHeldKeys: ReadonlySet<string>; keyboardBindings: Readonly<Record<string, KeyboardBinding>>; keyboardInputOnly?: boolean; onPress(key: string, event: React.PointerEvent<HTMLButtonElement>): void; onRelease(key: string): void; onPressKeyboard(key: string, event: React.KeyboardEvent<HTMLButtonElement>): void; onReleaseKeyboard(key: string, event: React.KeyboardEvent<HTMLButtonElement>): void; onReleaseAll(): void; inspectorTab: "info" | "magnetic"; onInspectorTab(tab: "info" | "magnetic"): void; command: ControllerCommandInvoker }): ReactElement {
  const input = snapshot.input;
  const virtualInput = !keyboardInputOnly && snapshot.capabilities.virtualKeys;
  const special = [["Test", keyboardInputOnly ? keyboardBindings.Test?.label ?? "TEST" : "TEST", input.test || (keyboardInputOnly && keyboardHeldKeys.has("Test")), " "], ["Service", keyboardInputOnly ? keyboardBindings.Service?.label ?? "SERVICE" : "SERVICE", input.service || (keyboardInputOnly && keyboardHeldKeys.has("Service")), "Enter"], ["Both", "BOTH", (input.test || (keyboardInputOnly && keyboardHeldKeys.has("Test"))) && (input.service || (keyboardInputOnly && keyboardHeldKeys.has("Service"))), ""]] as const;
  const magneticAvailable = snapshot.identity.kind === "Pico" && (snapshot.capabilities.hallConfiguration || isPicoConfigSyncing(snapshot));
  const activeInspectorTab = inspectorTab === "magnetic" && magneticAvailable ? "magnetic" : "info";
  return <section className="controller-monitor-surface">
    <div className="monitor-topbar"><span className="monitor-pin"><ControllerGlyph name="push_pin" /></span><h2>主监视器</h2><span className="monitor-topbar-spacer" /></div>
    <div className="monitor-body">
      <div className="signal-canvas">
        <div className="monitor-hardware-header"><span className={`monitor-online-badge ${keyboardInputOnly ? "is-keyboard-input" : ""}`} title={keyboardInputOnly ? "Segatools 键盘输入已启用" : snapshot.capabilities.bootloader ? "双击进入 Bootloader" : undefined} onDoubleClick={() => { if (!keyboardInputOnly && snapshot.capabilities.bootloader) void command(() => window.ogk.controllerBootloader()); }}><i />{keyboardInputOnly ? "KEYBOARD INPUT" : `${controllerDisplayName(snapshot)} ONLINE`}</span><span className="monitor-header-spacer" /></div>
        <div className="analog-lever-monitor"><span className="lever-end left">L</span><span className="lever-end right">R</span><b>{snapshot.deviceConfig.isKmMode ? "MOUSE X-AXIS" : "ANALOG LEVER"}</b><div className="analog-track" style={sliderPositionStyle(leverPercent(snapshot.input.mappedLever))}><i /></div></div>
        <div className="controller-button-layout">
           {virtualButtons.map(([key, label, active, placement, shortcut]) => <button type="button" key={key} disabled={!keyboardInputOnly && !virtualInput} className={`controller-key ${placement} ${active ? "is-held" : ""}`} style={keyboardInputOnly ? undefined : monitorKeyStyle(snapshot, placement)} aria-pressed={active} aria-keyshortcuts={virtualInput ? shortcut ?? undefined : undefined} onPointerDown={!virtualInput ? undefined : event => onPress(key, event)} onPointerUp={!virtualInput ? undefined : () => onRelease(key)} onPointerCancel={!virtualInput ? undefined : () => onRelease(key)} onLostPointerCapture={!virtualInput ? undefined : () => onRelease(key)} onKeyDown={!virtualInput ? undefined : event => { if (shortcut && event.key.toLowerCase() === shortcut) onPressKeyboard(key, event); }} onKeyUp={!virtualInput ? undefined : event => { if (shortcut && event.key.toLowerCase() === shortcut) onReleaseKeyboard(key, event); }} onBlur={!virtualInput ? undefined : () => onRelease(key)}>{label}</button>)}
        </div>
        <div className="monitor-hardware-footer"><div className="monitor-footer-actions">{special.map(([key, label, active, shortcut]) => <button type="button" key={key} disabled={!keyboardInputOnly && !virtualInput} className={`monitor-action ${active ? "is-held" : ""}`} aria-pressed={active} aria-keyshortcuts={virtualInput ? shortcut || undefined : undefined} onPointerDown={!virtualInput ? undefined : event => onPress(key, event)} onPointerUp={!virtualInput ? undefined : () => onRelease(key)} onPointerCancel={!virtualInput ? undefined : () => onRelease(key)} onLostPointerCapture={!virtualInput ? undefined : () => onRelease(key)} onKeyDown={!virtualInput ? undefined : event => { if (shortcut && event.key === shortcut) onPressKeyboard(key, event); }} onKeyUp={!virtualInput ? undefined : event => { if (shortcut && event.key === shortcut) onReleaseKeyboard(key, event); }} onBlur={!virtualInput ? undefined : () => onRelease(key)}>{label}</button>)}</div></div>
      </div>
      <aside className="monitor-inspector">
         <div className="inspector-tabs"><button type="button" disabled={keyboardInputOnly} className={activeInspectorTab === "info" ? "active" : "inactive"} onClick={() => onInspectorTab("info")}><span><ControllerGlyph name="memory" /></span>控制器信息</button>{magneticAvailable && <button type="button" disabled={keyboardInputOnly} className={activeInspectorTab === "magnetic" ? "active" : "inactive"} onClick={() => onInspectorTab("magnetic")}><span><ControllerGlyph name="tune" /></span>磁轴设置</button>}</div>
         {activeInspectorTab === "info" ? <InformationPanel snapshot={snapshot} command={command} keyboardInputOnly={keyboardInputOnly} /> : <MagneticPanelV2 snapshot={snapshot} command={command} />}
      </aside>
    </div>
  </section>;
}

function InformationPanel({ snapshot, command, keyboardInputOnly = false }: { snapshot: ControllerSnapshot; command: ControllerCommandInvoker; keyboardInputOnly?: boolean }): ReactElement {
  const picoInformationAvailable = snapshot.identity.kind === "Pico" && !keyboardInputOnly;
  const kmMode = snapshot.deviceConfig.isKmMode;
  const currentMode = snapshot.identity.kind === "Pico"
    ? snapshot.deviceConfig.inputMode === 1 ? "微动模式" : "磁轴模式"
    : kmMode ? "模拟键鼠" : "MU3IO";
  return <div className="information-content">
    <div className="identity-box"><span>当前连接的控制器</span><b>{keyboardInputOnly ? "键盘" : controllerDisplayName(snapshot)}</b></div>
    <InfoRow label="控制器名称" value={keyboardInputOnly ? "—" : controllerDisplayName(snapshot)} />
    <InfoRow label="固件版本" value={snapshot.identity.firmware === "—" ? "—" : `v${snapshot.identity.firmware}`} />
    <InfoRow className="controller-mode-row" label="输入模式" value={<ControllerModeControl snapshot={snapshot} command={command} readOnly={keyboardInputOnly} />} />
    {(picoInformationAvailable || keyboardInputOnly) && <InfoRow label="读卡器卡号" value={keyboardInputOnly ? "—" : snapshot.card.present ? `${snapshot.card.type} · ${snapshot.card.identifier}` : "未检测到"} />}
    {(picoInformationAvailable || keyboardInputOnly) && <InfoRow label="供电线" value={keyboardInputOnly ? "—" : "未提供遥测"} />}
    {(picoInformationAvailable || keyboardInputOnly) && <InfoRow label="当前模式" value={keyboardInputOnly ? "—" : currentMode} accent />}
  </div>;
}

function InfoRow({ label, value, success, accent, className = "" }: { label: string; value: ReactNode; success?: boolean; accent?: boolean; className?: string }): ReactElement { return <div className={`info-row ${className}`}><span>{label}</span><b className={success ? "success" : accent ? "accent" : ""}>{value}</b></div>; }

type HallFieldKey = "abcTravel" | "abcRtTrigger" | "abcRtRelease" | "abcDead" | "sideTravel" | "sideRtTrigger" | "sideRtRelease" | "sideDead";
const hallTravelMm = 3.5;
const hallDefaultMaxDelta = 700;
const hallFieldMaximumMm: Record<HallFieldKey, number> = { abcTravel: 3.4, abcRtTrigger: 1.5, abcRtRelease: 1.5, abcDead: 1, sideTravel: 3.4, sideRtTrigger: 1.5, sideRtRelease: 1.5, sideDead: 1 };
const hallAbcChannels = [0, 1, 2, 4, 6, 7];
const hallSideChannels = [3, 5];
const hallMmPerRaw = (snapshot: ControllerSnapshot, key: HallFieldKey) => {
  const channels = key.startsWith("side") ? hallSideChannels : hallAbcChannels;
  const maxDelta = Math.max(0, ...channels.map(channel => Number(snapshot.hall.maxDelta[channel]) || 0));
  return hallTravelMm / (maxDelta || hallDefaultMaxDelta);
};
const hallMmValue = (snapshot: ControllerSnapshot, key: HallFieldKey, raw: number) => Math.max(0, raw) * hallMmPerRaw(snapshot, key);
const hallRawValue = (snapshot: ControllerSnapshot, key: HallFieldKey, mm: number) => Math.max(0, Math.min(4095, Math.round(Math.max(0, Math.min(hallFieldMaximumMm[key], mm)) / hallMmPerRaw(snapshot, key))));

function MagneticPanelV2({ snapshot, command }: { snapshot: ControllerSnapshot; command: ControllerCommandInvoker }): ReactElement {
  const defaults: HallRequest = { abcTravel: 20, abcRtTrigger: 0, abcRtRelease: 0, abcDead: 6, sideTravel: 20, sideRtTrigger: 0, sideRtRelease: 0, sideDead: 6, save: true, rtEnabledAbc: 0, rtEnabledSide: 0 };
  const [draft, setDraft] = useState<HallRequest>(() => ({ ...defaults }));
  const previewTimer = useRef<number | null>(null);
  const hallCalibrationTimer = useRef<number | null>(null);
  const calibrationStartedAt = useRef<number | null>(null);
  const calibrationPeaksRef = useRef<number[]>([]);
  const [calibrationPeaks, setCalibrationPeaks] = useState<number[]>([]);
  const hallDraftDirty = useRef(false);
  const hydratedRevision = useRef(0);
  const hallReadbackFresh = snapshot.identity.kind === "Pico" && snapshot.readbackComplete && snapshot.hall.configurationValid && snapshot.hallConfigRevision > 0;
  const hallWritable = snapshot.canWrite && snapshot.capabilities.hallConfiguration;
  const hallRequestFromSnapshot = (): HallRequest => ({
    abcTravel: snapshot.hall.abcTravel, abcRtTrigger: snapshot.hall.abcRtTrigger, abcRtRelease: snapshot.hall.abcRtRelease, abcDead: snapshot.hall.abcDead,
    sideTravel: snapshot.hall.sideTravel, sideRtTrigger: snapshot.hall.sideRtTrigger, sideRtRelease: snapshot.hall.sideRtRelease, sideDead: snapshot.hall.sideDead,
    save: true, rtEnabledAbc: snapshot.hall.rtEnabledAbc, rtEnabledSide: snapshot.hall.rtEnabledSide
  });
  useEffect(() => () => { if (previewTimer.current !== null) window.clearTimeout(previewTimer.current); if (hallCalibrationTimer.current !== null) window.clearTimeout(hallCalibrationTimer.current); }, []);
  useEffect(() => {
    if (hallReadbackFresh && snapshot.operation?.name === "hall-save" && snapshot.operation.status === "Verified") hallDraftDirty.current = false;
    if (!hallReadbackFresh) {
      if (!hallDraftDirty.current) hydratedRevision.current = 0;
      return;
    }
    if (!hallDraftDirty.current && hydratedRevision.current !== snapshot.hallConfigRevision) {
      setDraft(hallRequestFromSnapshot());
      hydratedRevision.current = snapshot.hallConfigRevision;
    }
  }, [hallReadbackFresh, snapshot.hallConfigRevision, snapshot.hall.abcTravel, snapshot.hall.abcRtTrigger, snapshot.hall.abcRtRelease, snapshot.hall.abcDead, snapshot.hall.sideTravel, snapshot.hall.sideRtTrigger, snapshot.hall.sideRtRelease, snapshot.hall.sideDead, snapshot.hall.rtEnabledAbc, snapshot.hall.rtEnabledSide, snapshot.operation?.name, snapshot.operation?.status]);
  useEffect(() => {
    if (snapshot.state === "CalibratingHall") {
      if (calibrationStartedAt.current === null) calibrationStartedAt.current = Date.now();
      if (hallCalibrationTimer.current === null) {
      hallCalibrationTimer.current = window.setTimeout(() => { hallCalibrationTimer.current = null; void command(() => window.ogk.controllerHallCalibration("stop")); }, 60000);
      }
      const nextPeaks = snapshot.hall.delta.map((value, index) => Math.max(calibrationPeaksRef.current[index] ?? 0, Number(value) || 0));
      calibrationPeaksRef.current = nextPeaks;
      setCalibrationPeaks(nextPeaks);
    } else {
      calibrationStartedAt.current = null;
      calibrationPeaksRef.current = [];
      setCalibrationPeaks([]);
    }
    if (snapshot.state !== "CalibratingHall" && hallCalibrationTimer.current !== null) {
      window.clearTimeout(hallCalibrationTimer.current);
      hallCalibrationTimer.current = null;
    }
  }, [snapshot.state, command]);
  const queuePreview = (next: HallRequest) => {
    hallDraftDirty.current = true;
    setDraft(next);
    if (previewTimer.current !== null) window.clearTimeout(previewTimer.current);
    if (!hallWritable) return;
    previewTimer.current = window.setTimeout(() => { void command(() => window.ogk.controllerSetHall({ ...next, save: false })); }, 50);
  };
  const setField = (key: HallFieldKey, value: number) => queuePreview({ ...draft, [key]: hallRawValue(snapshot, key, value) });
  const toggle = (key: "rtEnabledSide" | "rtEnabledAbc", tone: "violet" | "orange") => <button type="button" className={`rt-pill ${tone}`} aria-pressed={draft[key] > 0} disabled={!hallWritable || snapshot.state === "CalibratingHall"} onClick={() => queuePreview({ ...draft, [key]: draft[key] > 0 ? 0 : 1 })}>RT {draft[key] > 0 ? "已启用" : "已停用"}</button>;
  const field = (key: HallFieldKey, label: string, color: "violet" | "orange") => {
    const raw = Number(draft[key]) || 0;
    const mm = hallMmValue(snapshot, key, raw);
    const maximumMm = hallFieldMaximumMm[key];
    const position = Math.max(0, Math.min(100, (mm / maximumMm) * 100));
    const rtEnabled = key.startsWith("side") ? draft.rtEnabledSide > 0 : draft.rtEnabledAbc > 0;
    const enabled = key.endsWith("Travel") || rtEnabled;
    const setTrackValue = (event: React.PointerEvent<HTMLDivElement>) => {
      if (!enabled || !hallWritable) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      setField(key, ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * maximumMm);
    };
    return <div className={`magnetic-field magnetic-field-${key}`}>
      <div className="magnetic-field-meta"><span>{label}</span><label className="magnetic-value-wrap"><input className="magnetic-value" type="number" min="0" max={maximumMm} step="0.01" value={mm.toFixed(2)} aria-label={`${label} ${color === "violet" ? "侧键" : "地键"}`} disabled={!enabled || !hallWritable} onChange={event => setField(key, Number(event.currentTarget.value) || 0)} onBlur={event => setField(key, Number(event.currentTarget.value) || 0)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /><small>mm</small></label></div>
      <div className={`magnetic-track ${color}`} style={sliderPositionStyle(position)} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); setTrackValue(event); }} onPointerMove={event => { if (event.buttons > 0) setTrackValue(event); }}>
        <i style={{ width: `${position}%` }} />
        <em />
        <input type="range" min="0" max={maximumMm} step="0.01" value={Math.min(maximumMm, Number(mm.toFixed(2)))} aria-label={`${label} ${color === "violet" ? "侧键" : "地键"}`} disabled={!enabled || !hallWritable} onChange={event => setField(key, Number(event.currentTarget.value))} />
      </div>
    </div>;
  };
  const delta = snapshot.hall.delta;
  const liveMaximum = Math.max(1, ...snapshot.hall.maxDelta, ...delta);
  const microswitchMode = snapshot.deviceConfig.inputMode === 1;
  type HallLiveRow = readonly [string, number, "violet" | "orange"];
  const liveRows = {
    left: (microswitchMode ? [["SIDE", 3, "violet"]] : [["SIDE", 3, "violet"], ["LA", 0, "violet"], ["LB", 2, "violet"], ["LC", 1, "violet"]]) as readonly HallLiveRow[],
    right: (microswitchMode ? [["SIDE", 5, "orange"]] : [["RA", 7, "orange"], ["RB", 6, "orange"], ["RC", 4, "orange"], ["SIDE", 5, "orange"]]) as readonly HallLiveRow[]
  };
  const liveColumn = (rows: readonly (readonly [string, number, "violet" | "orange"])[]) => rows.map(([label, channel, color]) => { const channelMaximum = Math.max(1, snapshot.hall.maxDelta[channel] || liveMaximum); const width = Math.max(0, Math.min(100, ((delta[channel] ?? 0) / channelMaximum) * 100)); return <div key={label} className={color}><span>{label}</span><i><em style={{ width: `${width}%` }} /></i></div>; });
  const reset = () => queuePreview({ abcTravel: hallRawValue(snapshot, "abcTravel", 0.1), abcRtTrigger: 0, abcRtRelease: 0, abcDead: hallRawValue(snapshot, "abcDead", 0.03), sideTravel: hallRawValue(snapshot, "sideTravel", 0.1), sideRtTrigger: 0, sideRtRelease: 0, sideDead: hallRawValue(snapshot, "sideDead", 0.03), save: true, rtEnabledAbc: 0, rtEnabledSide: 0 });
  const save = () => { if (previewTimer.current !== null) window.clearTimeout(previewTimer.current); if (!hallWritable) return; void command(() => window.ogk.controllerSetHall({ ...draft, save: true })); };
  const calibrationCoverage = calibrationPeaks.filter(value => value > 0).length;
  const calibrationMaximum = Math.max(0, ...calibrationPeaks);
  const calibrationRemaining = Math.max(0, 60 - Math.floor((Date.now() - (calibrationStartedAt.current ?? Date.now())) / 1000));
  if (!hallReadbackFresh) return <div className="magnetic-content"><div className="magnetic-content-header"><ControllerGlyph name="tune" /><b>磁轴设置</b><span className="magnetic-header-spacer" /><ControllerGlyph name="sensors" /></div><div className="hall-sync-state" role="status">正在等待新鲜的 Hall Config 回读，完成后显示当前设备值。</div></div>;
  return <div className="magnetic-content">
    <div className="magnetic-content-header"><ControllerGlyph name="tune" /><b>磁轴设置</b><span className="magnetic-header-spacer" /><span className="magnetic-mode">{snapshot.state === "CalibratingHall" ? `校准中 · ${snapshot.hall.calibrationSamples} samples` : microswitchMode ? "微动模式" : "磁轴模式"}</span><ControllerGlyph name="sensors" /></div>
    <div className={`magnetic-columns ${microswitchMode ? "is-microswitch" : ""}`}>
      <div><strong>侧键 {toggle("rtEnabledSide", "violet")}</strong>{field("sideTravel", "触发行程", "violet")}{field("sideRtTrigger", "快速触发阈值", "violet")}{field("sideRtRelease", "快速释放阈值", "violet")}{field("sideDead", "触底死区", "violet")}</div>
      {!microswitchMode && <div><strong>地键 {toggle("rtEnabledAbc", "orange")}</strong>{field("abcTravel", "触发行程", "orange")}{field("abcRtTrigger", "快速触发阈值", "orange")}{field("abcRtRelease", "快速释放阈值", "orange")}{field("abcDead", "触底死区", "orange")}</div>}
    </div>
    <div className="live-travel"><div className="live-travel-heading"><span><ControllerGlyph name="monitoring" />{snapshot.state === "CalibratingHall" ? "Hall 校准反馈" : "实时按下行程"}</span><b>{snapshot.state === "CalibratingHall" ? `${calibrationCoverage}/8 通道` : "输入监视"}</b></div>{snapshot.state === "CalibratingHall" ? <div className="hall-calibration-summary" role="status"><div><b>峰值</b><span>{calibrationMaximum} · {snapshot.hall.calibrationSamples} samples · 剩余约 {calibrationRemaining}s</span></div><div className="hall-calibration-channels">{Array.from({ length: 8 }, (_, index) => <span key={index} className={calibrationPeaks[index] > 0 ? "sampled" : ""}>CH{index + 1}<b>{calibrationPeaks[index] ?? 0}</b></span>)}</div></div> : <div className="live-travel-grid"><div className="live-travel-column">{liveColumn(liveRows.left)}</div><div className="live-travel-column">{liveColumn(liveRows.right)}</div></div>}</div>
    <div className="magnetic-actions"><button type="button" disabled={!hallWritable || snapshot.state === "CalibratingHall"} onClick={() => void command(() => window.ogk.controllerHallCalibration("baseline"))}>归零</button><button type="button" disabled={!hallWritable && snapshot.state !== "CalibratingHall"} onClick={() => void command(() => window.ogk.controllerHallCalibration(snapshot.state === "CalibratingHall" ? "stop" : "start"))}>{snapshot.state === "CalibratingHall" ? "完成" : "校准"}</button><button type="button" className="primary-action" disabled={!hallWritable || snapshot.state === "CalibratingHall"} onClick={save}>保存</button><button type="button" disabled={!hallWritable || snapshot.state === "CalibratingHall"} onClick={reset}>默认</button></div>
  </div>;
}

type LeverCalibrationStage = "idle" | "await-left" | "capturing" | "capturing-left" | "await-right" | "capturing-right" | "verifying" | "saving";

function ControllerAccordionsV2({ snapshot, command, disabled = false, keyboardInputOnly = false }: { snapshot: ControllerSnapshot; command: ControllerCommandInvoker; disabled?: boolean; keyboardInputOnly?: boolean }): ReactElement {
  const [draft, setDraft] = useState<LeverRequest>(() => ({ calibrationMin: snapshot.lever.calibrationMin, calibrationMax: snapshot.lever.calibrationMax, inverted: snapshot.lever.inverted, sensitivity: snapshot.lever.sensitivity, save: true }));
  const [lighting, setLighting] = useState<PicoLightingRequest>(() => lightingFromDeviceConfig(snapshot));
  const [lightingMode, setLightingMode] = useState<"ground" | "side" | "frame">("ground");
  const [leverCalibrationStage, setLeverCalibrationStage] = useState<LeverCalibrationStage>("idle");
  const [leverCalibrationMessage, setLeverCalibrationMessage] = useState("点击校准后，将摇杆左右推到最大行程。");
  const leverTimer = useRef<number | null>(null);
  const leverCalibrationTimer = useRef<number | null>(null);
  const leverPending = useRef<LeverRequest | null>(null);
  const leverSendInFlight = useRef<LeverRequest | null>(null);
  const leverDebounceUntil = useRef(0);
  const brightnessTimer = useRef<number | null>(null);
  const brightnessDebounceUntil = useRef(0);
  const pendingBrightness = useRef<number | null>(null);
  const brightnessSendInFlight = useRef<number | null>(null);
  const lightingDebounceUntil = useRef(0);
  const pendingLighting = useRef<PicoLightingRequest | null>(null);
  const lightingSendInFlight = useRef<PicoLightingRequest | null>(null);
  const lightingHydratedRevision = useRef<number | null>(null);
  const leverHydratedRevision = useRef<number | null>(null);
  const deviceConfigFresh = snapshot.deviceConfig.valid;
  const brightnessWritable = deviceConfigFresh && snapshot.capabilities.basicLighting &&
    snapshot.state !== "Disabled" && snapshot.state !== "Searching" && snapshot.state !== "ConnectedWaitingForData" &&
    snapshot.state !== "CalibratingHall" && snapshot.state !== "CalibratingLever" && snapshot.state !== "SyncFailed" &&
    snapshot.state !== "Faulted" && snapshot.state !== "Unsupported" && snapshot.state !== "BootloaderPending";
  const picoLightingWritable = isConfigurationUiWritable(snapshot) && snapshot.capabilities.picoLighting && snapshot.deviceConfig.valid;
  const picoLightingAvailable = snapshot.identity.kind === "Pico" && (snapshot.capabilities.picoLighting || isPicoConfigSyncing(snapshot));
  const showPicoColors = picoLightingAvailable && deviceConfigFresh && snapshot.deviceConfig.isKmMode;
  const showFrameLighting = picoLightingAvailable && deviceConfigFresh;
  const showCabGameMapping = picoLightingAvailable;
  const showLegacyColor = snapshot.identity.kind === "Leonardo" && deviceConfigFresh && snapshot.deviceConfig.isKmMode &&
    snapshot.capabilities.basicLighting;
  const legacyColorWritable = showLegacyColor && snapshot.canWrite;
  const leverAvailable = snapshot.capabilities.leverConfiguration || snapshot.capabilities.leverCalibration;
  // The actual write is still serialized by ControllerSession. Keep this
  // control interactive while a previous value is waiting for readback so a
  // drag can update the local draft and collapse into the newest command.
  const leverSettingsUiWritable = deviceConfigFresh && isDeviceConfigUiAvailable(snapshot) && snapshot.capabilities.leverConfiguration;
  const leverCalibrationAvailable = isConfigurationUiWritable(snapshot) && snapshot.capabilities.leverCalibration;
  const inputOnly = !snapshot.capabilities.basicLighting && !snapshot.capabilities.picoLighting &&
    !snapshot.capabilities.hallConfiguration && !snapshot.capabilities.hallCalibration &&
    !snapshot.capabilities.leverConfiguration && !snapshot.capabilities.leverCalibration;
  const lightingRef = useRef(lighting);
  useEffect(() => () => {
    if (leverTimer.current !== null) window.clearTimeout(leverTimer.current);
    if (brightnessTimer.current !== null) window.clearTimeout(brightnessTimer.current);
    if (leverCalibrationTimer.current !== null) window.clearTimeout(leverCalibrationTimer.current);
  }, []);
  useEffect(() => {
    if (!snapshot.deviceConfig.valid) {
      lightingHydratedRevision.current = null;
      return;
    }
    if (lightingHydratedRevision.current === snapshot.deviceConfigRevision) return;
    const next = lightingFromDeviceConfig(snapshot);
    lightingRef.current = next;
    setLighting(current => sameLighting(current, next) ? current : next);
    lightingHydratedRevision.current = snapshot.deviceConfigRevision;
  }, [snapshot.deviceConfig.valid, snapshot.deviceConfig.brightness,
    snapshot.deviceConfig.groundColor[0], snapshot.deviceConfig.groundColor[1], snapshot.deviceConfig.groundColor[2],
    snapshot.deviceConfig.sideColor[0], snapshot.deviceConfig.sideColor[1], snapshot.deviceConfig.sideColor[2],
    snapshot.deviceConfig.cabPreset, snapshot.deviceConfig.cabGameMapping, snapshot.deviceConfigRevision]);
  useEffect(() => {
    if (!snapshot.deviceConfig.valid) {
      leverHydratedRevision.current = null;
      return;
    }
    if (leverPending.current !== null || leverHydratedRevision.current === snapshot.deviceConfigRevision) return;
    setDraft(current => {
      const next = { calibrationMin: snapshot.lever.calibrationMin, calibrationMax: snapshot.lever.calibrationMax, inverted: snapshot.lever.inverted, sensitivity: snapshot.lever.sensitivity, save: true };
      return current.calibrationMin === next.calibrationMin && current.calibrationMax === next.calibrationMax && current.inverted === next.inverted && current.sensitivity === next.sensitivity ? current : next;
    });
    leverHydratedRevision.current = snapshot.deviceConfigRevision;
  }, [snapshot.deviceConfig.valid, snapshot.deviceConfigRevision, snapshot.lever.calibrationMin, snapshot.lever.calibrationMax, snapshot.lever.inverted, snapshot.lever.sensitivity]);
  useEffect(() => {
    if (leverCalibrationStage === "capturing-left" && snapshot.lever.calibrationState === 2) {
      if (leverCalibrationTimer.current !== null) window.clearTimeout(leverCalibrationTimer.current);
      setLeverCalibrationStage("await-right");
      setLeverCalibrationMessage("左端已记录，请将摇杆移动到最右端。");
    } else if (leverCalibrationStage === "capturing-right" && snapshot.lever.calibrationState === 4) {
      if (leverCalibrationTimer.current !== null) window.clearTimeout(leverCalibrationTimer.current);
      setLeverCalibrationStage("verifying");
      setLeverCalibrationMessage("右端已记录，正在回读并验证行程。");
      leverCalibrationTimer.current = window.setTimeout(() => {
        leverCalibrationTimer.current = null;
        setLeverCalibrationStage("idle");
        setLeverCalibrationMessage("校准回读超时，请重新执行左右端点采样。");
      }, 5000);
      void command(() => window.ogk.controllerLeverCalibration("stop"));
    } else if (leverCalibrationStage === "verifying" && snapshot.state === "Ready" && snapshot.deviceConfig.valid) {
      if (leverCalibrationTimer.current !== null) window.clearTimeout(leverCalibrationTimer.current);
      const valid = snapshot.lever.calibrationMax > snapshot.lever.calibrationMin && snapshot.lever.calibrationMax - snapshot.lever.calibrationMin >= 16;
      setLeverCalibrationStage("idle");
      setLeverCalibrationMessage(valid ? "校准完成，已验证摇杆左右端点。" : "校准回读失败，请重新执行左右端点采样。");
    } else if ((leverCalibrationStage === "capturing-left" || leverCalibrationStage === "capturing-right" || leverCalibrationStage === "verifying") && snapshot.lever.calibrationState === 5) {
      if (leverCalibrationTimer.current !== null) window.clearTimeout(leverCalibrationTimer.current);
      setLeverCalibrationStage("idle");
      setLeverCalibrationMessage("设备报告摇杆校准无效，请重新执行。");
    }
  }, [snapshot, leverCalibrationStage, command]);
  const flushPendingLighting = (force = false) => {
    if (!force && Date.now() < lightingDebounceUntil.current) return;
    if (!snapshot.canWrite || !brightnessWritable || pendingLighting.current === null || lightingSendInFlight.current !== null || brightnessSendInFlight.current !== null) return;
    const next = pendingLighting.current;
    pendingLighting.current = null;
    lightingSendInFlight.current = next;
    const task = snapshot.identity.kind === "Pico" && picoLightingWritable
      ? () => window.ogk.controllerSetPicoLighting(next)
      : () => window.ogk.controllerSetBrightness(next.brightness);
    void command(task).then(result => {
      if (lightingSendInFlight.current === next) lightingSendInFlight.current = null;
      // A drag may have produced a newer value while the previous command was
      // in flight. The snapshot event will flush it after the command queue is
      // writable again; request one immediate retry for quiet transports.
      if (pendingLighting.current !== null && result?.snapshot.canWrite) flushPendingLighting();
      if (pendingBrightness.current !== null && result?.snapshot.canWrite) flushPendingBrightness(true);
    });
  };
  const flushPendingBrightness = (force = false) => {
    if (!force && Date.now() < brightnessDebounceUntil.current) return;
    if (!snapshot.canWrite || !brightnessWritable || pendingBrightness.current === null || brightnessSendInFlight.current !== null || lightingSendInFlight.current !== null) return;
    const next = pendingBrightness.current;
    pendingBrightness.current = null;
    brightnessSendInFlight.current = next;
    // Updating brightness must preserve the other device configuration fields. Keep
    // it on its own latest-wins lane so a drag does not resend RGB/cab state
    // or wait behind a full lighting edit.
    void command(() => window.ogk.controllerSetBrightness(next)).then(result => {
      if (brightnessSendInFlight.current === next) brightnessSendInFlight.current = null;
      if (pendingBrightness.current !== null && result?.snapshot.canWrite) flushPendingBrightness(true);
      if (pendingLighting.current !== null && result?.snapshot.canWrite) flushPendingLighting(true);
    });
  };
  useEffect(() => {
    if (snapshot.identity.kind === "Unknown") {
      pendingLighting.current = null;
      pendingBrightness.current = null;
      return;
    }
    flushPendingLighting();
    flushPendingBrightness();
  }, [snapshot.sequence, snapshot.canWrite, snapshot.identity.kind, deviceConfigFresh, brightnessWritable, picoLightingWritable]);
  const stageLighting = (next: PicoLightingRequest) => {
    lightingRef.current = next;
    setLighting(next);
  };
  const applyLighting = (next: PicoLightingRequest) => {
    stageLighting(next);
    if (brightnessWritable) pendingLighting.current = next;
    lightingDebounceUntil.current = 0;
    flushPendingLighting(true);
  };
  const queueBrightness = (brightness: number) => {
    const next = { ...lightingRef.current, brightness: Math.max(0, Math.min(255, Math.round(brightness))) };
    stageLighting(next);
    if (!brightnessWritable) return;
    pendingBrightness.current = next.brightness;
    // Match the session poll cadence: one latest value per rendered frame is
    // enough for a smooth drag without flooding the local HTTP/IPC boundary.
    brightnessDebounceUntil.current = Date.now() + 16;
    if (brightnessTimer.current !== null) window.clearTimeout(brightnessTimer.current);
    brightnessTimer.current = window.setTimeout(() => {
      brightnessTimer.current = null;
      flushPendingBrightness();
    }, 16);
  };
  const flushPendingLever = () => {
    if (Date.now() < leverDebounceUntil.current) return;
    if (!snapshot.canWrite || leverSendInFlight.current !== null) return;
    const next = leverPending.current;
    if (next === null) return;
    leverSendInFlight.current = next;
    void command(() => window.ogk.controllerSetLever(next)).then(result => {
      if (leverSendInFlight.current === next) leverSendInFlight.current = null;
      if (result?.status === "Accepted" || result?.status === "Verified") {
        if (leverPending.current === next) leverPending.current = null;
      } else if (result?.status === "Rejected" && leverPending.current !== null && result.snapshot.canWrite && leverTimer.current === null) {
        leverTimer.current = window.setTimeout(() => { leverTimer.current = null; flushPendingLever(); }, 100);
      }
    });
  };
  useEffect(() => { flushPendingLever(); }, [snapshot.sequence, snapshot.canWrite]);
  const queueLever = (next: LeverRequest) => {
    setDraft(next);
    leverPending.current = next;
    leverDebounceUntil.current = Date.now() + 160;
    if (leverTimer.current !== null) window.clearTimeout(leverTimer.current);
    // Do not start a Device Config write for every pointer event. The draft
    // stays responsive while the latest value is sent after the drag settles.
    leverTimer.current = window.setTimeout(() => { leverTimer.current = null; flushPendingLever(); }, 160);
  };
  const sensitivityValue = Math.max(0, Math.min(10, Math.round(Number(draft.sensitivity) || 0)));
  const brightnessPercent = deviceConfigFresh ? Math.max(0, Math.min(100, Math.round((lighting.brightness / 255) * 100))) : 0;
  const cabPresetOptions = [
    { value: 0, label: "冰蓝电弧", color: [88, 194, 255] },
    { value: 1, label: "紫蓝霓虹", color: [109, 93, 251] },
    { value: 2, label: "琥珀热能", color: [255, 122, 69] }
  ] as const;
  const selectedCabPreset = cabPresetOptions.find(item => item.value === lighting.cabPreset) ?? cabPresetOptions[0];
  const lightOptions = [
    { key: "ground", label: "地键灯光", color: [lighting.groundR, lighting.groundG, lighting.groundB] },
    { key: "side", label: "侧键灯光", color: [lighting.sideR, lighting.sideG, lighting.sideB] },
    { key: "frame", label: "框体灯", color: selectedCabPreset.color }
  ] as const;
  const effectiveLightingMode = showPicoColors ? lightingMode : "frame";
  const selectedLighting = lightOptions.find(item => item.key === effectiveLightingMode) ?? lightOptions[0];
  const updateSelectedColor = (index: number, value: number) => {
    const next = { ...lightingRef.current };
    const colorValue = Math.max(0, Math.min(255, Math.round(value)));
    if (effectiveLightingMode === "side") {
      if (index === 0) next.sideR = colorValue; else if (index === 1) next.sideG = colorValue; else next.sideB = colorValue;
    } else {
      if (index === 0) next.groundR = colorValue; else if (index === 1) next.groundG = colorValue; else next.groundB = colorValue;
    }
    applyLighting(next);
  };
  const updateLegacyColor = (index: number, value: number) => {
    const color = [lightingRef.current.groundR, lightingRef.current.groundG, lightingRef.current.groundB];
    color[index] = Math.max(0, Math.min(255, Math.round(value)));
    const next = { ...lightingRef.current, groundR: color[0], groundG: color[1], groundB: color[2], sideR: color[0], sideG: color[1], sideB: color[2] };
    lightingRef.current = next;
    setLighting(next);
    if (legacyColorWritable) {
      void command(() => window.ogk.controllerSetCustomColor(color[0], color[1], color[2]));
    }
  };
  const colorFromPointer = (index: number, event: React.PointerEvent<HTMLElement>) => {
    if (!picoLightingWritable) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    updateSelectedColor(index, ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 255);
  };
  const legacyColorFromPointer = (index: number, event: React.PointerEvent<HTMLElement>) => {
    if (!legacyColorWritable) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    updateLegacyColor(index, ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 255);
  };
  const onSensitivityChange = (value: number) => queueLever({ ...draft, sensitivity: value, save: true });
  const onInvert = () => queueLever({ ...draft, inverted: !draft.inverted, sensitivity: sensitivityValue, save: true });
  const sensitivityFromPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!leverSettingsUiWritable || leverCalibrationStage !== "idle") return;
    const track = event.currentTarget.querySelector<HTMLElement>(".sensitivity-track");
    const bounds = track?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect();
    onSensitivityChange(Math.round(((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 10));
  };
  const onLeverCalibration = () => {
    const calibrationCommandAvailable = leverCalibrationAvailable || snapshot.state === "CalibratingLever";
    if (!calibrationCommandAvailable) return;
    if (snapshot.identity.kind === "SimGEKI") {
      setLeverCalibrationStage("saving");
      setLeverCalibrationMessage("请保持摇杆居中，正在校准并保存。");
      void command(() => window.ogk.controllerLeverCalibration("center")).then(result => {
        setLeverCalibrationStage("idle");
        setLeverCalibrationMessage(result?.status === "Accepted" || result?.status === "Verified"
          ? result.message : result?.message ?? "摇杆校准失败，请重试。");
      });
      return;
    }
    if (snapshot.identity.kind === "Leonardo") {
      if (leverCalibrationStage === "idle") {
        setLeverCalibrationStage("capturing");
        setLeverCalibrationMessage("请将摇杆左右推到最大行程，完成后点击“校准完成”。软件会记录端点并映射到完整行程。");
        void command(() => window.ogk.controllerLeverCalibration("start")).then(result => {
          if (result?.status !== "Accepted" && result?.status !== "Verified") {
            setLeverCalibrationStage("idle");
            setLeverCalibrationMessage("校准未开始，请确认设备在线且配置同步已完成。");
          }
        });
      } else if (leverCalibrationStage === "capturing") {
        setLeverCalibrationStage("verifying");
        setLeverCalibrationMessage("端点已记录，正在写入并验证摇杆完整行程。");
        void command(() => window.ogk.controllerLeverCalibration("complete")).then(result => {
          if (result?.status !== "Accepted" && result?.status !== "Verified") {
            setLeverCalibrationStage("idle");
            setLeverCalibrationMessage(result?.message ?? "校准完成失败，请重新执行。");
          }
        });
      }
      return;
    }
    if (leverCalibrationStage === "idle") {
      setLeverCalibrationStage("await-left");
      setLeverCalibrationMessage("将摇杆移动到最左端，然后点击“记录左端”。");
    } else if (leverCalibrationStage === "await-left") {
      setLeverCalibrationStage("capturing-left");
      setLeverCalibrationMessage("正在采样左端，请保持摇杆不动。");
      leverCalibrationTimer.current = window.setTimeout(() => { leverCalibrationTimer.current = null; setLeverCalibrationStage("idle"); setLeverCalibrationMessage("左端采样超时，请重试。"); void command(() => window.ogk.controllerLeverCalibration("stop")); }, 2200);
      void command(() => window.ogk.controllerLeverCalibration("left"));
    } else if (leverCalibrationStage === "await-right") {
      setLeverCalibrationStage("capturing-right");
      setLeverCalibrationMessage("正在采样右端，请保持摇杆不动。");
      leverCalibrationTimer.current = window.setTimeout(() => { leverCalibrationTimer.current = null; setLeverCalibrationStage("idle"); setLeverCalibrationMessage("右端采样超时，请重试。"); void command(() => window.ogk.controllerLeverCalibration("stop")); }, 2200);
      void command(() => window.ogk.controllerLeverCalibration("right"));
    }
  };
  const setCabPreset = (value: number) => applyLighting({ ...lightingRef.current, cabPreset: value });
  const toggleCabGameMapping = () => applyLighting({ ...lightingRef.current, cabGameMapping: !lightingRef.current.cabGameMapping });
  if (inputOnly) return <div className="controller-accordions"><section className="controller-accordion input-only-accordion"><div className="accordion-heading"><h3>设备功能</h3><span>ⓘ</span></div><div className="joystick-unavailable">当前控制器未提供灯光、磁轴或摇杆设置。可用的输入状态会显示在上方。</div></section></div>;
  return <div className={`controller-accordions ${disabled ? "is-keyboard-disabled" : ""}`} aria-disabled={disabled || undefined}>
    <fieldset className="controller-configuration-fieldset" disabled={disabled}>
    {(snapshot.capabilities.basicLighting || snapshot.capabilities.picoLighting) && <section className="controller-accordion lighting-accordion">
       <div className="accordion-heading"><h3>灯光控制</h3><span>ⓘ</span></div>
      <div className={`lighting-brightness-card ${showPicoColors ? "has-color-modes" : "is-single-control"}`}>
        <div className="lighting-brightness"><span>亮度 <b>{deviceConfigFresh ? `${brightnessPercent}%` : "—"}</b></span><i style={sliderPositionStyle(brightnessPercent)}><em style={{ width: `${brightnessPercent}%` }} /><input type="range" min="0" max="255" value={deviceConfigFresh ? lighting.brightness : 0} aria-label="灯光亮度" disabled={!brightnessWritable || !deviceConfigFresh} onChange={event => queueBrightness(Number(event.currentTarget.value))} /></i></div>
      </div>
      <div className="lighting-controls">
        {showFrameLighting ? <>
          {showPicoColors && <div className="lighting-mode-list">{lightOptions.map(item => <button key={item.key} type="button" className={effectiveLightingMode === item.key ? "selected" : ""} disabled={!picoLightingWritable} onClick={() => setLightingMode(item.key)}><i style={{ background: hexColor(item.color) }} />{item.label}</button>)}</div>}
          {effectiveLightingMode === "frame" ? <div className={`lighting-color-editor cab-lighting-editor ${showPicoColors ? "" : "frame-only"}`}>
            <div className="color-editor-head"><i style={{ background: hexColor(selectedCabPreset.color) }} /><span>框体灯 · 预设</span></div>
            <div className="cab-preset-list" role="radiogroup" aria-label="框体灯预设">{cabPresetOptions.map(item => <button key={item.value} type="button" className={lighting.cabPreset === item.value ? "selected" : ""} role="radio" aria-checked={lighting.cabPreset === item.value} disabled={!picoLightingWritable} onClick={() => setCabPreset(item.value)}><i style={{ background: hexColor(item.color) }} /><span>{item.label}</span></button>)}</div>
            {showCabGameMapping && <button type="button" className={`cab-mapping-toggle ${lighting.cabGameMapping ? "selected" : ""}`} aria-pressed={lighting.cabGameMapping} disabled={!picoLightingWritable} onClick={toggleCabGameMapping}><i />游戏映射框体灯<span>{lighting.cabGameMapping ? "已启用" : "已停用"}</span></button>}
          </div> : <div className="lighting-color-editor">
            <div className="color-editor-head"><i style={{ background: hexColor(selectedLighting.color) }} /><span>{selectedLighting.label} · RGB</span></div>
            <div className="rgb-lines">{(["R", "G", "B"] as const).map((channel, index) => { const position = (selectedLighting.color[index] / 255) * 100; return <div key={channel}><span>{channel}</span><i style={sliderPositionStyle(position)} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); colorFromPointer(index, event); }} onPointerMove={event => { if (event.buttons > 0) colorFromPointer(index, event); }}><em style={{ width: `${position}%` }} /><input type="range" min="0" max="255" value={selectedLighting.color[index]} aria-label={`${selectedLighting.label} ${channel}`} disabled={!picoLightingWritable} onChange={event => updateSelectedColor(index, Number(event.currentTarget.value))} /></i><b>{selectedLighting.color[index]}</b></div>; })}</div>
          </div>}
        </> : showLegacyColor ? <div className="lighting-color-editor legacy-color-editor">
          <div className="color-editor-head"><i style={{ background: hexColor([lighting.groundR, lighting.groundG, lighting.groundB]) }} /><span>按键灯 · 单色 RGB</span></div>
          <div className="rgb-lines">{(["R", "G", "B"] as const).map((channel, index) => { const color = [lighting.groundR, lighting.groundG, lighting.groundB]; const position = (color[index] / 255) * 100; return <div key={channel}><span>{channel}</span><i style={sliderPositionStyle(position)} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); legacyColorFromPointer(index, event); }} onPointerMove={event => { if (event.buttons > 0) legacyColorFromPointer(index, event); }}><em style={{ width: `${position}%` }} /><input type="range" min="0" max="255" value={color[index]} aria-label={`按键灯 ${channel}`} disabled={!legacyColorWritable} onChange={event => updateLegacyColor(index, Number(event.currentTarget.value))} /></i><b>{color[index]}</b></div>; })}</div>
        </div> : <div className="lighting-mode-unavailable">MU3IO下仅支持亮度控制</div>}
      </div>
    </section>}
    <section className={`controller-accordion joystick-accordion ${snapshot.state === "SyncingDevice" || snapshot.state === "SyncingHall" ? "is-config-syncing" : ""}`}>
      <div className="accordion-heading"><h3>摇杆设置</h3><span>ⓘ</span></div>
      {!deviceConfigFresh ? <div className="joystick-unavailable">正在等待 Device Config 回读，完成后显示摇杆配置。</div> : leverAvailable ? <div className="joystick-controls">
        <div className="joystick-actions"><button type="button" className="selected-control" disabled={(!leverCalibrationAvailable && snapshot.state !== "CalibratingLever") || leverCalibrationStage === "capturing-left" || leverCalibrationStage === "capturing-right" || leverCalibrationStage === "verifying" || leverCalibrationStage === "saving"} onClick={onLeverCalibration}>{leverCalibrationStage === "idle" ? snapshot.identity.kind === "SimGEKI" ? "校准中心" : "校准" : leverCalibrationStage === "saving" ? "保存中" : snapshot.identity.kind === "Leonardo" && leverCalibrationStage === "capturing" ? "校准完成" : leverCalibrationStage === "await-left" ? "记录左端" : leverCalibrationStage === "await-right" ? "记录右端" : leverCalibrationStage === "verifying" ? "验证中" : "采样中"}</button>{snapshot.capabilities.leverConfiguration && <button type="button" className={draft.inverted ? "selected-control" : ""} disabled={!leverSettingsUiWritable || leverCalibrationStage !== "idle"} aria-pressed={draft.inverted} onClick={onInvert}>反转</button>}</div>
        {snapshot.capabilities.leverConfiguration && <label className="sensitivity-field"><span>灵敏度 <b>{sensitivityValue === 0 ? "默认" : "当前"}</b></span><input type="range" min="0" max="10" value={sensitivityValue} aria-label="摇杆灵敏度" disabled={!leverSettingsUiWritable || leverCalibrationStage !== "idle"} onChange={event => onSensitivityChange(Number(event.currentTarget.value))} /><div className="sensitivity-scale" aria-hidden="true" onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); sensitivityFromPointer(event); }} onPointerMove={event => { if (event.buttons > 0) sensitivityFromPointer(event); }}><i className="sensitivity-track" style={sliderPositionStyle(sensitivityValue * 10)} />{Array.from({ length: 11 }, (_, index) => <i key={index} className={index === sensitivityValue ? "tick active" : "tick"} />)}<small><span>默认</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span><span>7</span><span>8</span><span>9</span><span>10</span></small></div></label>}
      </div> : <div className="joystick-unavailable">当前控制器不支持摇杆高级配置。</div>}
      {(snapshot.identity.kind === "SimGEKI" || leverCalibrationStage !== "idle" || leverCalibrationMessage !== "点击校准后，将摇杆左右推到最大行程。") && <p className="joystick-calibration-status" role="status">{snapshot.identity.kind === "SimGEKI" && leverCalibrationStage === "idle" && leverCalibrationMessage === "点击校准后，将摇杆左右推到最大行程。" ? "将摇杆置于中心，然后点击“校准中心”。" : leverCalibrationMessage}</p>}
    </section>
    </fieldset>
  </div>;
}

function DisconnectedWorkspace({ snapshot, moduleStatus, onRescan, onRestart, keyboardInputEnabled, keyboardInputBusy, keyboardInputError, gameRootAvailable, onKeyboardInputChange }: { snapshot: ControllerSnapshot; moduleStatus: ControllerModuleStatus; onRescan(): void; onRestart(): void; keyboardInputEnabled: boolean; keyboardInputBusy: boolean; keyboardInputError: string; gameRootAvailable: boolean; onKeyboardInputChange(enabled: boolean): void }): ReactElement {
  const message = moduleStatus.error || snapshot.error;
  const needsRestart = moduleStatus.state === "fault" || moduleStatus.state === "restarting";
  return <><section className="disconnected-state-surface"><div className="disconnected-empty"><div className="disconnected-icon"><ControllerGlyph name="usb_off" /></div><h2>{needsRestart ? "控制器服务不可用" : "未连接到控制器"}</h2><p>{needsRestart ? "ControllerHost 已停止响应。可先重启控制器服务，再重新扫描设备。" : "请用USB数据线连接控制器，连接成功后设备信息与调试面板将自动显示"}</p>{message && <small className="disconnected-error">{message}</small>}<div className="disconnected-actions"><button type="button" className="primary-action" onClick={onRescan}>重新扫描设备</button>{needsRestart && <button type="button" onClick={onRestart} disabled={moduleStatus.state === "restarting"}>重启控制器服务</button>}</div><div className={`keyboard-input-option ${keyboardInputEnabled ? "is-enabled" : ""}`}><span className="keyboard-input-icon" aria-hidden="true">⌨</span><span className="keyboard-input-copy"><b>使用键盘输入进行游戏</b><small>{gameRootAvailable ? "自动开启 Segatools 键盘输入和鼠标模拟摇杆，并将 MU3IO 恢复为默认选项。" : "请先选择并扫描游戏目录。"}</small>{keyboardInputError && <em role="alert">{keyboardInputError}</em>}</span><button type="button" className="primary-action keyboard-input-action" disabled={!gameRootAvailable || keyboardInputBusy} onClick={() => onKeyboardInputChange(!keyboardInputEnabled)}>{keyboardInputBusy ? "正在修改…" : keyboardInputEnabled ? "关闭键盘输入" : "使用键盘输入进行游戏"}</button></div></div></section><section className="connection-check"><div className="connection-check-header"><h3>连接检查</h3><span>完成以下步骤后再重试</span></div><div className="connection-divider" /><div className="connection-steps"><ConnectionStep icon="usb" title="连接数据线" body="确认 USB 数据线已插入控制器与电脑。" tone="orange" /><ConnectionStep icon="power" title="确认供电" body="检查指示灯与外接电源状态是否正常。" tone="neutral" /><ConnectionStep icon="refresh" title="重新检测" body="连接完成后点击“重新扫描设备”。" tone="green" /></div></section></>;
}

function ConnectionStep({ icon, title, body, tone }: { icon: ControllerGlyphName; title: string; body: string; tone: "orange" | "neutral" | "green" }): ReactElement { return <div className="connection-step"><span className={`connection-step-icon ${tone}`}><ControllerGlyph name={icon} /></span><div><b>{title}</b><p>{body}</p></div></div>; }
