import { randomUUID } from "node:crypto";
import { ControllerModuleManager } from "./controller-module-manager";
import { SimGekiIo4Controller } from "./simgeki-io4-controller";
import type { ControllerCommandResult, ControllerModuleStatus, ControllerSnapshot, HallRequest, LeverRequest,
  PicoLightingRequest } from "../src/controller-models";

type Backend = ControllerModuleManager | SimGekiIo4Controller;
type SnapshotListener = (snapshot: ControllerSnapshot) => void;
type StatusListener = (status: ControllerModuleStatus) => void;

const online = (snapshot: ControllerSnapshot | null) => snapshot?.identity.kind !== "Unknown" &&
  snapshot?.state !== "Faulted" && snapshot?.state !== "Unsupported" && snapshot?.state !== "SyncFailed";

export class ControllerHub {
  private readonly module = new ControllerModuleManager();
  private readonly io4 = new SimGekiIo4Controller();
  private readonly backends: Backend[] = [this.module, this.io4];
  private readonly snapshotListeners = new Set<SnapshotListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor() {
    for (const backend of this.backends) {
      backend.onSnapshot(() => this.publishSnapshot());
      backend.onStatus(() => this.publishStatus());
    }
  }

  getSnapshot(): ControllerSnapshot { return this.active().getSnapshot() ?? this.io4.getSnapshot(); }
  getStatus(): ControllerModuleStatus { return this.combinedStatus(); }
  onSnapshot(listener: SnapshotListener): () => void { this.snapshotListeners.add(listener); const value = this.getSnapshot(); if (value) listener(value); return () => this.snapshotListeners.delete(listener); }
  onStatus(listener: StatusListener): () => void { this.statusListeners.add(listener); listener(this.getStatus()); return () => this.statusListeners.delete(listener); }

  async start(): Promise<void> {
    const results = await Promise.allSettled(this.backends.map(backend => backend.start()));
    if (results.every(result => result.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  }

  async restart(): Promise<void> {
    const results = await Promise.allSettled(this.backends.map(backend => backend.restart()));
    if (results.every(result => result.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  }

  async stop(): Promise<void> { await Promise.all(this.backends.map(backend => backend.stop().catch(() => undefined))); }

  async rescan(): Promise<ControllerCommandResult> { return this.all("rescan"); }
  async retrySync(): Promise<ControllerCommandResult> { return this.all("retrySync"); }
  async releaseAll(): Promise<ControllerCommandResult> { return this.all("releaseAll"); }
  async releaseAllIfRunning(): Promise<void> { await Promise.all(this.backends.map(backend => backend.releaseAllIfRunning().catch(() => undefined))); }

  setVirtualKey(key: string, pressed: boolean) { return this.active().setVirtualKey(key, pressed); }
  setMode(keyboardMouse: boolean) { return this.active().setMode(keyboardMouse); }
  setBrightness(brightness: number) { return this.active().setBrightness(brightness); }
  setCustomColor(red: number, green: number, blue: number) { return this.active().setCustomColor(red, green, blue); }
  setPicoLighting(request: PicoLightingRequest) { return this.active().setPicoLighting(request); }
  setHall(request: HallRequest) { return this.active().setHall(request); }
  hallCalibration(action: string) { return this.active().hallCalibration(action); }
  hallQuery() { return this.active().hallQuery(); }
  deviceQuery() { return this.active().deviceQuery(); }
  setLever(request: LeverRequest) { return this.active().setLever(request); }
  leverCalibration(action: string) { return this.active().leverCalibration(action); }
  bootloader() { return this.active().bootloader(); }
  setInputMode(mode: number): Promise<ControllerCommandResult> {
    return this.active() === this.io4 ? this.io4.setInputMode(mode) : Promise.resolve(this.rejected("当前控制器不支持 SimGEKI 输入模式。"));
  }

  private active(): Backend {
    // Prefer the direct reader once it has positively identified an IO4 collection.
    if (online(this.io4.getSnapshot())) return this.io4;
    return this.module;
  }

  private async all(command: "rescan" | "retrySync" | "releaseAll"): Promise<ControllerCommandResult> {
    const results = await Promise.allSettled(this.backends.map(backend => backend[command]()));
    const activeIndex = this.backends.indexOf(this.active());
    const activeResult = results[activeIndex];
    if (activeResult?.status === "fulfilled") return activeResult.value;
    const successful = results.find((result): result is PromiseFulfilledResult<ControllerCommandResult> => result.status === "fulfilled");
    if (successful) return successful.value;
    throw (results[0] as PromiseRejectedResult).reason;
  }

  private rejected(message: string): ControllerCommandResult {
    return { commandId: randomUUID(), status: "Rejected", message, snapshot: this.getSnapshot() };
  }

  private combinedStatus(): ControllerModuleStatus {
    const statuses = this.backends.map(backend => backend.getStatus());
    if (statuses.some(status => status.state === "ready")) return { state: "ready" };
    if (statuses.some(status => status.state === "starting")) return { state: "starting" };
    if (statuses.some(status => status.state === "restarting")) return { state: "restarting" };
    if (statuses.every(status => status.state === "stopped")) return { state: "stopped" };
    return { state: "fault", error: statuses.map(status => status.error).filter(Boolean).join("\n") || "控制器服务不可用。" };
  }

  private publishSnapshot(): void {
    const snapshot = this.getSnapshot();
    if (snapshot) for (const listener of this.snapshotListeners) listener(snapshot);
  }

  private publishStatus(): void {
    const status = this.getStatus();
    for (const listener of this.statusListeners) listener(status);
  }
}
