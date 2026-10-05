import manifest from "./player-resource-icon-manifest.json";

const icons = manifest as { resources: Record<string, string>; families: Record<string, string> };

export function playerResourceIconUrl(key: string) {
  const parts = key.split(":");
  const family = parts[0] === "item" ? `item:${parts[1]}` : parts[0];
  const name = icons.resources[key] ?? icons.families[family];
  return name ? `./resource-icons/${name}` : undefined;
}
