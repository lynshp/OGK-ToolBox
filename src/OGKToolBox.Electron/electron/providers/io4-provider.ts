import { SimGekiIo4Controller } from "../simgeki-io4-controller";
import type { ControllerAdapter } from "../../../../sdk/controller-provider";

// The build copies the transport SDK beside dist-electron/electron. No HID code is loaded by Electron Main.
const { startProvider } = require("../../sdk/controller-provider/server.cjs") as {
  startProvider(adapter: ControllerAdapter, argv?: string[]): Promise<{ stop(): Promise<void> }>;
};

export function createIo4Adapter(controller = new SimGekiIo4Controller()): ControllerAdapter {
  return {
    snapshot: () => controller.getSnapshot(),
    async command(name, body) {
      switch (name) {
        case "rescan": return controller.rescan();
        case "retry-sync": return controller.retrySync();
        case "input-mode":
          if (typeof body.modeId === "string" && /^[123]$/.test(body.modeId))
            return controller.setInputMode(Number(body.modeId));
          return { status: "Rejected", message: "输入模式必须是 1、2 或 3。" };
        case "mode":
          if (typeof body.keyboardMouse === "boolean") return controller.setMode(body.keyboardMouse);
          return { status: "Rejected", message: "keyboardMouse 必须是布尔值。" };
        case "lever-calibration":
          if (body.action === "center") return controller.leverCalibration(body.action);
          return { status: "Rejected", message: "SimGEKI 仅支持摇杆中心校准。" };
        default: return { status: "Rejected", message: "当前 IO4 控制器不支持该命令。" };
      }
    },
    releaseAll: () => controller.releaseAllIfRunning(),
    close: () => controller.stop()
  };
}

export async function startIo4Provider(argv = process.argv.slice(2), controller = new SimGekiIo4Controller(),
  serve = startProvider): Promise<{ stop(): Promise<void> }> {
  try {
    // No attached controller is a normal ready state; the reader continues discovery in the background.
    await controller.start();
    return await serve(createIo4Adapter(controller), argv);
  } catch (error) {
    await controller.stop();
    throw error;
  }
}

if (require.main === module) {
  void startIo4Provider().catch(() => {
    console.error("IO4 controller provider failed to start.");
    process.exitCode = 1;
  });
}
