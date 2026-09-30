import React from "react";
export function GithubSourceHelp() {
  return <div className="option-placeholder-notice error" role="alert">
    <span>GitHub 拉取失败，可在设置中更换来源后重试。</span>
    <button type="button" onClick={() => window.dispatchEvent(new Event("ogk:github-settings"))}>前往设置</button>
  </div>;
}
