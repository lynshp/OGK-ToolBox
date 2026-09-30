import { useLayoutEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredMenu } from "./use-anchored-menu";

export function PlayerPopover({ id, title, anchor, width, onClose, children }: { id: string; title: string; anchor: RefObject<HTMLButtonElement | null>; width: number; onClose(): void; children: ReactNode }) {
  const popup = useRef<HTMLDivElement>(null), titleId = useId(), close = useRef(onClose);
  close.current = onClose;
  const { menu } = useAnchoredMenu(anchor, true, onClose, { width, maxHeight: 480, align: "end", gap: 10 });
  useLayoutEffect(() => {
    const element = popup.current!, trigger = anchor.current;
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (!element.contains(event.target as Node) && !trigger?.contains(event.target as Node)) close.current();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); trigger?.focus({ preventScroll: true }); close.current(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      if (element.contains(document.activeElement) && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [anchor]);
  const rect = anchor.current?.getBoundingClientRect();
  const arrow = Math.max(18, Math.min(menu.width - 18, (rect ? rect.left + rect.width / 2 : 0) - menu.left));
  return createPortal(<div ref={popup} id={id} className="filter-popover player-popover" role="dialog" aria-modal="false" aria-labelledby={titleId} data-placement={anchor.current?.dataset.menuPlacement} style={{ ...menu, "--player-popover-arrow": `${arrow}px` } as React.CSSProperties}>
    <div className="filter-popover-head player-popover-heading"><h2 id={titleId}>{title}</h2><button type="button" onClick={() => { anchor.current?.focus({ preventScroll: true }); onClose(); }} aria-label={`关闭${title}`}>关闭</button></div><div className="player-popover-body">{children}</div>
  </div>, document.querySelector(".app") ?? document.body);
}
