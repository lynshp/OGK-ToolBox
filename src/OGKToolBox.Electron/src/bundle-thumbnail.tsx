import { useEffect, useRef, useState } from "react";
import type { ThumbnailCache } from "./models";

let thumbnailRequestSequence = 0;
export function useThumbnail(bundlePath?: string, cache?: ThumbnailCache, enabled = true) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    setSrc(null);
    if (!enabled || !bundlePath || !cache?.gameRoot) return;
    const requestId = `thumbnail-${++thumbnailRequestSequence}`; let active = true;
    void window.ogk.thumbnail(bundlePath, cache, "visible", requestId).then(image => { if (active) setSrc(image); }).catch(() => { if (active) setSrc(null); });
    return () => { active = false; window.ogk.cancelThumbnail(requestId); };
  }, [bundlePath, cache?.gameRoot, cache?.kind, enabled]);
  return src;
}
export function BundleThumbnail({ bundlePath, alt = "", className = "", fallback = "?", cache, enabled = true }: { bundlePath?: string; alt?: string; className?: string; fallback?: string; cache?: ThumbnailCache; enabled?: boolean }) {
  const host = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = host.current;
    if (!element || !("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { threshold: .01 });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const src = useThumbnail(bundlePath, cache, enabled && visible);
  return <span ref={host} className={className}>{src ? <img src={src} alt={alt} loading="eager" decoding="async"/> : <b aria-hidden="true">{fallback}</b>}</span>;
}
