import { useLayoutEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredMenu } from "./use-anchored-menu";

export function PlayerPopover({ id, title, anchor, width, onClose, children, bodyClassName = "", parentId, fitContent = false }: { id: string; title: string; anchor: RefObject<HTMLButtonElement | null>; width: number; onClose(): void; children: ReactNode; bodyClassName?: string; parentId?: string; fitContent?: boolean }) {
  const popup = useRef<HTMLDivElement>(null), body = useRef<HTMLDivElement>(null), titleId = useId(), close = useRef(onClose);
  const [naturalHeight, setNaturalHeight] = useState(0);
  close.current = onClose;
  const { menu } = useAnchoredMenu(anchor, true, onClose, { width, maxHeight: 480, align: "end", gap: 10 });
  useLayoutEffect(() => {
    if (!fitContent) return;
    const element = popup.current!, content = body.current!;
    const measure = () => {
      const style = getComputedStyle(element), heading = element.firstElementChild!.getBoundingClientRect().height;
      setNaturalHeight(Math.ceil(heading + content.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content); observer.observe(element.firstElementChild!);
    return () => observer.disconnect();
  }, [fitContent]);
  useLayoutEffect(() => {
    const element = popup.current!, trigger = anchor.current;
    element.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const related = (node: Element | null) => {
      let child = node?.closest<HTMLElement>(".player-popover");
      const visited = new Set<string>();
      while (child?.dataset.playerPopoverParent) {
        const parent = child.dataset.playerPopoverParent;
        if (parent === id) return true;
        if (visited.has(parent)) break;
        visited.add(parent); child = document.getElementById(parent);
      }
      return false;
    };
    const outside = (event: Event) => {
      if (!element.contains(event.target as Node) && !trigger?.contains(event.target as Node) && !related(event.target instanceof Element ? event.target : null)) close.current();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || [...document.querySelectorAll(".player-popover[data-player-popover-parent]")].some(related)) return;
      event.preventDefault(); trigger?.focus({ preventScroll: true }); close.current();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      if (element.contains(document.activeElement) && trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [anchor, id]);
  const rect = anchor.current?.getBoundingClientRect();
  const heightLimit = Math.max(0, window.innerHeight - 16), constrained = fitContent && naturalHeight > heightLimit;
  let placement = anchor.current?.dataset.menuPlacement, position = menu;
  if (fitContent && rect) {
    const height = Math.min(naturalHeight || heightLimit, heightLimit), below = rect.bottom + 10, above = rect.top - 10 - height;
    const top = below + height <= window.innerHeight - 8 ? below : above >= 8 ? above : Math.max(8, Math.min(below, window.innerHeight - height - 8));
    placement = top + height <= rect.top ? "top" : "bottom";
    position = { ...menu, top, maxHeight: heightLimit, translate: undefined };
  }
  const arrow = Math.max(18, Math.min(menu.width - 18, (rect ? rect.left + rect.width / 2 : 0) - menu.left));
  return createPortal(<div ref={popup} id={id} className="filter-popover player-popover" role="dialog" aria-modal="false" aria-labelledby={titleId} data-player-popover-parent={parentId} data-fit-content={fitContent || undefined} data-placement={placement} style={{ ...position, "--player-popover-arrow": `${arrow}px` } as React.CSSProperties}>
    <div className="filter-popover-head player-popover-heading"><h2 id={titleId}>{title}</h2><button type="button" onClick={() => { anchor.current?.focus({ preventScroll: true }); onClose(); }} aria-label={`关闭${title}`}>关闭</button></div><div ref={body} className={`player-popover-body ${bodyClassName}`} style={fitContent ? { overflow: constrained ? "auto" : "visible", flexShrink: constrained ? 1 : 0 } : undefined}>{children}</div>
  </div>, document.querySelector(".app") ?? document.body);
}
