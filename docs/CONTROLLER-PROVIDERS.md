# 已废弃：外部控制器 Provider

> 本文记录的 SDK/provider 扩展方案已废弃，不再用于产品功能开发。控制器支持应直接实现于
> `src/OGKToolBox.Electron/electron`，并通过应用内的控制器聚合层接入。本文仅保留用于理解旧模块兼容层。

控制器扩展采用独立进程接口。开发者实现硬件适配器，返回统一状态并处理命令。
本文介绍模块启动、状态结构和应用层通信 API。

## 启动示例

在仓库根目录执行（先按 README 安装 Electron 项目依赖）：

```powershell
$env:OGK_CONTROLLER_MODULE_DIR = (Resolve-Path ./examples/controller-provider).Path
cd src/OGKToolBox.Electron
npm run dev
```

示例显示只读的 `Example Controller (simulation)`，没有实际硬件访问、按键注入或配置写入。
结束测试后用 `Remove-Item Env:OGK_CONTROLLER_MODULE_DIR` 清除当前终端的选择，重新启动应用即恢复默认模块。
变量也适用于从该终端启动的、包含本次源码变更的安装版；先退出已有应用进程。
已发布的旧版 v1.1.7 安装包尚不包含此扩展加载器。

一次只运行一个提供者。默认模块保留，显式指定的提供者替代它；不扫描游戏目录，不自动发现或下载插件。
要支持多个硬件型号，可在一个适配器中完成识别和路由。多个提供者并行运行及界面内选择暂未实现。

## 开发自己的模块

1. 复制 `examples/controller-provider` 并保留对 `sdk/controller-provider` 的引用，或将 SDK 随模块一起分发。
2. 修改 `module.json` 的 `moduleId`、`moduleVersion`，保留应用 API 版本 1。
3. 实现 `sdk/controller-provider/index.d.ts` 中的 `ControllerAdapter`：`snapshot()`、`command()`、`releaseAll()`，以及可选的 `close()`。
4. 将自己的 HID、串口或其他设备代码放在适配器中。后台轮询硬件，`snapshot()` 只返回完整的缓存状态。
5. 通过 `OGK_CONTROLLER_MODULE_DIR` 指定模块的绝对目录，重启应用测试。

SDK 仅使用 Node 内置模块；`runtime: "node"` 的 `.cjs` 入口由 Electron 的 Node 模式启动，
不需要终端 PATH 上另装 Node。原生 `.exe` 可使用 `runtime: "native"`，自行实现下述 HTTP 接口。
入口必须是模块目录中的普通文件名，不能是路径、命令行或目录外的链接。
发布适配器时需包含其依赖文件；不要依赖维护者本机的 SDK 路径。

```json
{
  "moduleId": "your-controller",
  "moduleVersion": "0.1.0",
  "moduleApiVersion": 1,
  "ogkToolBoxVersion": "1.1.7",
  "platform": "win-x64",
  "runtime": "node",
  "entryPoint": "provider.cjs"
}
```

`ogkToolBoxVersion` 当前要求与应用精确匹配；升级前应重测并更新清单。
第三方模块使用独立的模块标识和版本号。`Leonardo` / `Pico` 为现有硬件的保留类型；新硬件请使用自己的类型标识。

## 状态与功能声明

完整结构以 `src/OGKToolBox.Electron/src/controller-models.ts` 为准，示例包含每个必需字段。
`identity.kind` 可以使用自己的标识，`Unknown` 表示没有设备；`displayName` 为显示名称。
原硬件类型 `Leonardo`、`Pico` 是保留值。`input.mappedLever` 的 UI 范围是 0–1023。
无卡时 `card.identifier` 必须为空；不要记录真实卡号或无关设备标识。

只声明实际实现的 `capabilities`。只读模块使用 `canWrite: false`；已完成必要同步才设置
`readbackComplete: true`。写入后必须更新对应状态及配置 revision，不能用 `Verified` 表示仅已发送报文。
不支持的命令返回 `Rejected`。设备断开、异常或退出时，`releaseAll()` 必须能够反复调用并释放所有合成输入。

当前通用 UI 可显示设备名、输入监视，复用已有模式、基础亮度及摇杆能力；
磁轴与多区域灯光等部分界面仍含原硬件专用逻辑。仅设置 capability 不会自动生成新配置界面。
新硬件特有功能应在 fork 中按既有 Electron 组件样式添加页面和相应 API，不能复用不存在的硬件语义。
对游戏的输入驱动配置也由新硬件开发者自行提供；接口不会替第三方写入 NYAGEKI_IO 配置。

## 原生进程通信协议

应用启动入口并传入：`--port`、`--session-token`、`--instance-id`、`--parent-pid`、
`--software-version`、`--manifest`。令牌每次应用启动随机生成，不得硬编码、记录或发送到外部。
仅监听指定的 `127.0.0.1` 端口；准备好后 stdout 输出一行：

```text
OGK_CONTROLLER_READY {"address":"http://127.0.0.1:<指定端口>","instanceId":"<传入值>","moduleApiVersion":1}
```

每个请求都必须校验 `X-OGK-Controller-Session`。拒绝浏览器 Origin，不启用 CORS，不返回重定向。
`GET /health` 返回 `instanceId`、`moduleApiVersion: 1`、`ogkToolBoxVersion`。
`GET /api/v1/snapshot` 返回完整快照。
`GET /api/v1/stream` 使用 SSE：`data: <完整快照 JSON>\n\n`，持续推送，建议每 50–100ms 一次。
父进程退出后释放输入并停止服务。提供的 SDK 已实现上述传输、会话检查和退出处理。

所有命令使用 `POST /api/v1/commands/<名称>`，JSON body，响应为
`{ commandId, status, message, snapshot }`。应用命令超时通常为 5 秒；长任务返回 `Accepted` 并通过快照跟踪进度。
`release-all` 和 `shutdown` 必须快速响应，应用退出时仅给予较短的宽限时间，随后可能终止进程。

| 命令 | 请求体 |
| --- | --- |
| `rescan`, `retry-sync`, `release-all`, `hall-query`, `device-query`, `bootloader`, `shutdown` | 空对象或空 body |
| `virtual-key` | `{ key: string, pressed: boolean }`，键名取自界面按钮与输入字段映射 |
| `mode` | `{ keyboardMouse: boolean }` |
| `brightness` | `{ brightness: 0..255 }` |
| `custom-color` | `{ red: 0..255, green: 0..255, blue: 0..255 }` |
| `pico-lighting` | `PicoLightingRequest`，仅用于实现同等功能的适配器 |
| `hall` | `HallRequest` |
| `lever` | `LeverRequest` |
| `hall-calibration` | `{ action: "baseline" / "start" / "stop" }` |
| `lever-calibration` | `{ action: "left" / "right" / "stop" }`；保留硬件另有 `start` / `complete` 流程 |

请求类型和数值范围见 `controller-models.ts` 与 `electron/controller-module-manager.ts`。
模块必须自行验证参数、能力、设备状态和命令顺序，不能把 UI 检查当成硬件安全校验。
