import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Portalled menus follow every scrolling ancestor, including nested config lists. */
export function useAnchoredMenu(host: RefObject<HTMLElement | null>, open: boolean, close: () => void, options: { width?: number; maxHeight?: number; align?: "start" | "end"; gap?: number } = {}) {
  const { width: preferredWidth, maxHeight: heightLimit = 300, align = "start", gap = 6 } = options;
  const onClose = useRef(close);
  onClose.current = close;
  const [menu, setMenu] = useState({ top: 0, left: 0, width: 0, maxHeight: 300 });
  const position = useCallback(() => {
    const anchor = host.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(preferredWidth ?? rect.width, window.innerWidth - 16);
    const below = window.innerHeight - rect.bottom - gap - 8;
    const above = rect.top - gap - 8;
    const upward = below < Math.min(180, heightLimit) && above > below;
    const maxHeight = Math.max(0, Math.min(heightLimit, upward ? above : below));
    setMenu({ top: upward ? rect.top - gap : rect.bottom + gap,
      left: Math.max(8, Math.min(align === "end" ? rect.right - width : rect.left, window.innerWidth - width - 8)),
      width, maxHeight });
    anchor.dataset.menuPlacement = upward ? "top" : "bottom";
  }, [host, preferredWidth, heightLimit, align, gap]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = host.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) continue;
        const clip = parent.getBoundingClientRect();
        if (rect.bottom <= clip.top || rect.top >= clip.bottom) { onClose.current(); return; }
      }
      position();
    };
    update();
    const observer = new ResizeObserver(update);
    if (host.current) observer.observe(host.current);
    document.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, host, position]);

  return { menu: { ...menu, translate: host.current?.dataset.menuPlacement === "top" ? "0 -100%" : undefined }, position };
}
