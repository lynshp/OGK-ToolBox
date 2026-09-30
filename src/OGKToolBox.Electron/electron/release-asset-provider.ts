import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider";
import type { CustomPublishOptions, GithubOptions } from "builder-util-runtime";
import type { AppUpdater } from "electron-updater";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider";

import { proxyReleaseAsset } from "./github-assets";
export { proxyReleaseAsset } from "./github-assets";

// Only resolveFiles is rewritten. Version discovery, release feeds and channel metadata
// remain on the original GitHub provider; hashes/sizes are kept unchanged.
export function createReleaseAssetProvider(onAssets: (urls: string[]) => void, useProxy: () => string | undefined) {
  return class ReleaseAssetProvider extends GitHubProvider {
    constructor(options: CustomPublishOptions, updater: AppUpdater, runtime: ProviderRuntimeOptions) {
      super({ ...options, provider: "github" } as GithubOptions, updater, runtime);
    }
    async getLatestVersion() {
      const info = await super.getLatestVersion();
      onAssets(super.resolveFiles(info).map(file => file.url.href));
      return info;
    }
    resolveFiles(info: Parameters<GitHubProvider["resolveFiles"]>[0]) {
      const files = super.resolveFiles(info);
      const node = useProxy();
      if (!node) return files;
      if (!this.options.owner || !this.options.repo) throw new Error("更新源缺少仓库所有者");
      const owner = this.options.owner, repo = this.options.repo;
      return files.map(file => ({ ...file,
        url: new URL(proxyReleaseAsset(file.url.href, owner, repo, node)) }));
    }
  };
}
