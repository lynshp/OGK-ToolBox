import { useLayoutEffect, useRef, useState } from "react";

const revealDistance = 180;

// Read scroll geometry before writes. Non-inheriting motion properties are applied
// only to the handful of moving containers, never to the 110 card descendants.
export function usePlayerRecordFocus(identity: string, enabled: boolean) {
  const page = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLElement>(null);
  const playerCollapse = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLElement>(null);
  const summary = useRef<HTMLDivElement>(null);
  const resources = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const toggle = useRef<() => void>(() => {});
  const [expanded, setExpanded] = useState(false);
  const [fullyExpanded, setFullyExpanded] = useState(false);

  useLayoutEffect(() => {
    setExpanded(false); setFullyExpanded(false);
    const host = surface.current, list = scroller.current;
    const focusNodes = [host, playerCollapse.current, player.current, summary.current?.parentElement,
      summary.current, host?.querySelector<HTMLElement>(".player-results-body"), resources.current?.parentElement]
      .filter((node): node is HTMLElement => !!node);
    const content = list?.querySelector<HTMLElement>(".player-best-content");
    const reset = () => {
      for (const node of focusNodes) node.style.setProperty("--player-focus", "0");
      content?.style.setProperty("--player-reveal-offset", "0px");
    };
    reset();
    const sizes = new Map<string, string>();
    const measure = () => {
      // Batch every geometry read before updating any property.
      const values = [
        [host, "--player-summary-height", `${summary.current?.offsetHeight ?? 0}px`],
        [host, "--player-aside-height", `${(resources.current?.offsetHeight ?? 0) + 13}px`],
        [playerCollapse.current, "--player-direct-height", `${player.current?.offsetHeight ?? 0}px`],
        [playerCollapse.current, "--player-page-gap", page.current ? getComputedStyle(page.current).rowGap : "14px"]
      ] as const;
      for (const [node, name, value] of values) {
        if (!node || sizes.get(name) === value) continue;
        sizes.set(name, value); node.style.setProperty(name, value);
      }
    };
    const observer = new ResizeObserver(measure);
    for (const node of [page.current, player.current, summary.current, resources.current]) if (node) observer.observe(node);
    measure();
    if (!host || !enabled || !list) { toggle.current = () => {}; return () => { observer.disconnect(); reset(); }; }
    list.scrollTop = 0;
    let scrollFrame = 0, animationFrame = 0, progress = 0, offset = 0, forced = false, previousTop = 0;
    let scrollbarPointer: number | null = null, settlingScrollbar = false;
    let wasExpanded = false, wasFullyExpanded = false;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = (value: number, top: number, revealOffset = Math.min(top, revealDistance)) => {
      const next = Math.max(0, Math.min(1, value)), nextOffset = revealOffset;
      if (next === progress && nextOffset === offset) return;
      if (next !== progress) {
        progress = next;
        for (const node of focusNodes) node.style.setProperty("--player-focus", String(progress));
      }
      if (nextOffset !== offset) {
        offset = nextOffset; content?.style.setProperty("--player-reveal-offset", `${offset}px`);
      }
      const nextExpanded = progress > .001, nextFullyExpanded = progress >= .999;
      if (nextExpanded !== wasExpanded) { wasExpanded = nextExpanded; setExpanded(nextExpanded); }
      if (nextFullyExpanded !== wasFullyExpanded) { wasFullyExpanded = nextFullyExpanded; setFullyExpanded(nextFullyExpanded); }
    };
    const onScroll = () => {
      // Chromium holds the thumb against its original track during a native drag.
      // Changing that track's position/size here makes scrolling repeatedly snap back.
      if (scrollbarPointer !== null || settlingScrollbar || scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        if (scrollbarPointer !== null || settlingScrollbar) return;
        const top = list.scrollTop;
        if (forced && previousTop > 0 && top === 0) forced = false;
        previousTop = top;
        apply(forced ? 1 : top / revealDistance, top);
      });
    };
    const animate = (target: number, settleScrollbar = false) => {
      cancelAnimationFrame(animationFrame);
      settlingScrollbar = settleScrollbar;
      const initial = progress, initialOffset = offset, start = performance.now();
      const tick = (now: number) => {
        animationFrame = 0;
        const top = list.scrollTop;
        const time = reduced.matches ? 1 : Math.min(1, (now - start) / 220);
        const eased = 1 - (1 - time) ** 3;
        apply(initial + (target - initial) * eased, top, settleScrollbar
          ? initialOffset + (Math.min(top, revealDistance) - initialOffset) * eased : Math.min(top, revealDistance));
        if (time < 1) animationFrame = requestAnimationFrame(tick);
        else if (settleScrollbar) {
          // Read the final native clamp on the next frame, after the layout
          // writes above have painted, rather than forcing a synchronous layout.
          animationFrame = requestAnimationFrame(() => {
            animationFrame = 0; settlingScrollbar = false;
            // A sparse list can lose overflow as the viewport opens. Keep its
            // explicit reveal usable until Home/the return button restores it.
            if (target > 0 && list.scrollTop === 0) { forced = true; previousTop = 0; }
            onScroll();
          });
        }
      };
      animationFrame = requestAnimationFrame(tick);
    };
    const onScrollbarDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType === "touch" || list.scrollHeight <= list.clientHeight) return;
      const rect = list.getBoundingClientRect();
      const scrollbarLeft = rect.left + list.clientLeft + list.clientWidth;
      if (event.clientX < scrollbarLeft || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.top + list.clientHeight) return;
      scrollbarPointer = event.pointerId;
      cancelAnimationFrame(scrollFrame); scrollFrame = 0;
      cancelAnimationFrame(animationFrame); animationFrame = 0; settlingScrollbar = false;
    };
    const finishScrollbar = () => {
      if (scrollbarPointer === null) return;
      scrollbarPointer = null;
      const top = list.scrollTop;
      if (top === 0) forced = false;
      previousTop = top;
      animate(forced ? 1 : Math.min(1, top / revealDistance), true);
    };
    const onScrollbarUp = (event: PointerEvent) => {
      if (event.pointerId === scrollbarPointer) finishScrollbar();
    };
    const interruptSettle = () => {
      if (!settlingScrollbar) return;
      cancelAnimationFrame(animationFrame); animationFrame = 0; settlingScrollbar = false;
    };
    const restore = () => {
      cancelAnimationFrame(animationFrame); animationFrame = 0;
      settlingScrollbar = false;
      forced = false;
      const top = list.scrollTop;
      if (top > 0) list.scrollTo({ top: 0, behavior: reduced.matches ? "instant" : "smooth" });
      else animate(0);
    };
    toggle.current = () => {
      if (progress > .001) { restore(); return; }
      if (list.scrollHeight - list.clientHeight >= revealDistance) {
        list.scrollTo({ top: revealDistance, behavior: reduced.matches ? "instant" : "smooth" });
      } else { forced = true; animate(1); }
    };
    const onKey = (event: KeyboardEvent) => {
      interruptSettle();
      if (event.key === "Home" && forced) { event.preventDefault(); restore(); }
    };
    list.addEventListener("scroll", onScroll, { passive: true });
    list.addEventListener("wheel", interruptSettle, { passive: true });
    // A native scrollbar may retarget its pointer event to the document root.
    // Capture there, then use the list's actual gutter bounds instead of target.
    document.addEventListener("pointerdown", onScrollbarDown, { capture: true, passive: true });
    list.addEventListener("keydown", onKey);
    document.addEventListener("pointerup", onScrollbarUp, true);
    document.addEventListener("pointercancel", onScrollbarUp, true);
    window.addEventListener("blur", finishScrollbar);
    return () => {
      cancelAnimationFrame(scrollFrame); cancelAnimationFrame(animationFrame); observer.disconnect();
      list.removeEventListener("scroll", onScroll); list.removeEventListener("keydown", onKey);
      list.removeEventListener("wheel", interruptSettle); document.removeEventListener("pointerdown", onScrollbarDown, true);
      document.removeEventListener("pointerup", onScrollbarUp, true); document.removeEventListener("pointercancel", onScrollbarUp, true);
      window.removeEventListener("blur", finishScrollbar);
      toggle.current = () => {}; reset();
    };
  }, [identity, enabled]);

  return { page, surface, playerCollapse, player, summary, resources, scroller, expanded, fullyExpanded, toggle: () => toggle.current() };
}
