const owner = process.env.OGK_GITHUB_OWNER || "lynshp";
const repo = process.env.OGK_GITHUB_REPO || "OGKToolBox-releases";

const config = {
  appId: "com.ogk.toolbox",
  productName: "OGK ToolBox",
  npmRebuild: false,
  asarUnpack: [
    "dist-electron/electron/providers/**/*",
    "dist-electron/electron/simgeki-io4-controller.js",
    "dist-electron/sdk/**/*",
    "node_modules/node-hid/**/*",
    "node_modules/pkg-prebuilds/**/*"
  ],
  icon: "build/toolbox-icon.ico",
  win: { icon: "build/toolbox-icon.ico", target: ["nsis"] },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    installerIcon: "build/toolbox-icon.ico",
    uninstallerIcon: "build/toolbox-icon.ico",
    installerHeaderIcon: "build/toolbox-icon.ico"
  },
  directories: { output: "../../artifacts/electron" },
  files: [
    "dist/**/*",
    "dist-electron/**/*",
    "package.json",
    "!**/*.map",
    "!**/.restart-user-data/**",
    "!**/*scan-cache*",
    "!**/github-update-token"
  ],
  extraResources: [
    { from: "resources/player-capture", to: "player-capture" },
    { from: "../OGKToolBox.Api/bin/Release/net8.0/publish", to: "api" },
    { from: "resources/controller", to: "controller", filter: ["OGKToolBox.ControllerHost.exe", "module.json", "artifact.json", "LICENSE.txt", "README.md"] },
    { from: "assets/chart", to: "chart" },
    { from: "assets/fastgithub", to: "fastgithub" },
    { from: "resources/NYAGEKI_IO.dll", to: "NYAGEKI_IO.dll" },
    { from: "resources/NYAGEKI_IO.LICENSE.txt", to: "NYAGEKI_IO.LICENSE.txt" },
    { from: "resources/hdd-setup", to: "hdd-setup" }
  ],
  publish: [{
    provider: "github",
    owner,
    repo,
    private: false,
    releaseType: "release"
  }]
};

module.exports = config;
