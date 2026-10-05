import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CaptureState } from "./player-save-models";
import { SaveFeedback } from "./player-score-ui";

export const playerDataNoticeStorageKey = "ogk-player-data-notice-dismissed:v1";

export function PlayerDataIntro({ capture, status, busy, feedback, onToggle, onUpdate, onClose }: {
  capture?: CaptureState; status: string; busy: boolean; feedback: ReactNode;
  onToggle(): void; onUpdate(): void; onClose(permanent: boolean): void;
}) {
  const titleId = useId(), warningId = useId(), descriptionId = useId();
  const dialog = useRef<HTMLElement>(null), continueButton = useRef<HTMLButtonElement>(null);
  const callbacks = useRef({ busy, onClose }); callbacks.current = { busy, onClose };
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const nodes = () => Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),[tabindex='0']") ?? []).filter(node => node.getClientRects().length > 0);
    continueButton.current?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!callbacks.current.busy) callbacks.current.onClose(false); }
      if (event.key !== "Tab") return;
      const items = nodes(), first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); dialog.current?.focus(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const contain = (event: FocusEvent) => { if (!dialog.current?.contains(event.target as Node)) (nodes()[0] ?? dialog.current)?.focus({ preventScroll: true }); };
    document.addEventListener("keydown", keyboard, true); document.addEventListener("focusin", contain);
    return () => {
      document.removeEventListener("keydown", keyboard, true); document.removeEventListener("focusin", contain);
      const target = previous?.isConnected ? previous : document.querySelector<HTMLElement>('[data-nav-page="player-saves"]');
      target?.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div className="confirm-backdrop player-data-intro-backdrop">
    <section ref={dialog} className="confirm-dialog player-data-intro" data-player-data-intro role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={warningId} tabIndex={-1}>
      <header><h2 id={titleId}>游玩数据使用提示</h2></header>
      <div className="player-data-intro-body">
        <SaveFeedback error><span id={warningId}>修改存档可能产生异常数据，也存在封禁风险。工具箱无法保证修改后的数据不会出现异常，请合理使用，并在修改前备份存档。</span></SaveFeedback>
        <section className="player-data-intro-upload"><h3>各服务器的修改方式</h3>
          <p>为降低封禁风险，<b>RinNET 和 NagekiNET（NA 服）</b>仅支持通过游戏上传资源修改。谱面成绩修改请使用「仅保存存档」，再到对应 NET 前端手动上传。</p>
          <p>MuNET 支持保存资源和谱面成绩改动，下次游玩时由游戏上传。</p>
        </section>
        <section className="player-capture-panel player-data-intro-mod">
          <div className="player-capture-row"><div><h3>自动读取 Mod<span className="player-data-intro-recommend">推荐启用</span></h3></div><button type="button" className={`switch-control${capture?.enabled ? " is-on" : ""}`} role="switch" aria-label="自动读取 Mod" aria-checked={!!capture?.enabled} aria-describedby={descriptionId} disabled={busy || !capture} onClick={onToggle}><i/></button></div>
          <p id={descriptionId}>自动读取登录和结算后的存档，归入对应玩家。通过「保存改动」提交的修改，会在下次登录游戏时自动应用，并随正常结算保存；仅保存存档不会自动修改游戏。</p>
          <p className="player-data-intro-install-note">首次开启会安装模块，请先退出游戏；需要已安装 BepInEx。</p>
          <div className="player-data-intro-mod-status"><span className="player-status-badge" data-intro-capture-status role="status">{busy ? "正在应用…" : status}</span>{capture?.enabled && capture.updateAvailable && <button type="button" data-intro-capture-update disabled={busy} onClick={onUpdate}>更新模块</button>}</div>
        </section>
        {feedback}
      </div>
      <footer><button type="button" data-player-data-intro-dismiss disabled={busy} onClick={() => onClose(true)}>不再提示</button><button ref={continueButton} type="button" className="primary" data-player-data-intro-continue disabled={busy} onClick={() => onClose(false)}>我已了解</button></footer>
    </section>
  </div>, document.querySelector(".app") ?? document.body);
}
