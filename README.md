# 春菜的便当盒（OGKToolBox）

面向 ONGEKI（MU3）的 Windows 本地资源、谱面与配置管理工具。
Electron 提供桌面界面，.NET API 负责扫描、索引、配置、资源解析、音频解码和导出。

## 功能

- 扫描 A000 / Option，浏览音乐、卡牌、角色、谱面和 Unity 资源。
- 预览谱面与音频，导出受支持的资源。
- 修改受支持的游戏配置、恢复备份、管理 Mod 和数据包。

## 开发

要求 Windows 10/11 x64、.NET 10 SDK（项目目标为 .NET 8）和 Node.js 24。

```powershell
dotnet restore OGKToolBox.slnx
dotnet build OGKToolBox.slnx -c Debug
dotnet test OGKToolBox.slnx -c Release
cd src/OGKToolBox.Electron
npm ci
npm run verify:controller
npm test
npm run typecheck
npm run dev
```

也可运行根目录 `Start-Dev.cmd` / `启动测试.cmd`。启动器会编译 API 与 Electron Main，
验证并启动内置控制器 EXE。初次使用音频解码或打包前，运行 `tools/Get-Vgmstream.ps1`。

`resources/controller/artifact.json` 锁定预编译模块校验值。模块缺失、被修改或版本不匹配
时构建检查会失败；请使用维护者提供的匹配模块，不要仅修改版本清单来绕过校验。

## 项目边界

- `src/OGKToolBox.Electron`：唯一维护的桌面界面与进程管理。
- `src/OGKToolBox.Api` / `Application` / `Core` / `Infrastructure`：资源和配置服务。
- `tests/OGKToolBox.Tests`：资源与应用服务测试；Electron 项目内另有模块与启动测试。

详情见 [架构](docs/ARCHITECTURE.md)、[发布](docs/RELEASING.md)。

## 控制器支持

Electron 主进程内置 NYAGEKI、LUXIS、SimGEKI 与标准 IO4 兼容输入支持。SimGEKI / IO4 的设备标识、
输入报告和模式配置见[通信说明](docs/SIMGEKI-IO4.md)。旧的外部 provider SDK 已废弃，不再用于新增控制器。

## 用户数据

游戏目录内的 `Tools/OGKToolBox` 存放索引、缓存、备份和日志。
Electron 界面偏好存放于用户的应用数据目录。

## 发布

```powershell
./tools/Get-Vgmstream.ps1
./tools/Build-Release.ps1
```

产物位于 `artifacts/electron`。
公开安装包位于 [OGKToolBox-releases](https://github.com/lynshp/OGKToolBox-releases)。

## 许可

本项目原创应用源码按 [MIT](LICENSE) 提供。
