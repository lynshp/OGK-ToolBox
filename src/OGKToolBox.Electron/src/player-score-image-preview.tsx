import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { generatePlayerScoreImage, type PlayerScoreImage } from "./player-score-image";
import type { PlayerSave } from "./player-save-models";
import type { RatingGroup } from "./player-rating";
import { SaveFeedback } from "./player-score-ui";

export type ScoreImageSnapshot = { save: PlayerSave; groups: RatingGroup[]; root: string; rating?: number; ratingSource: "stored" | "local" };

export function PlayerScoreImagePreview({ snapshot, anchor, onClose, onSaved }: {
  snapshot: ScoreImageSnapshot; anchor: RefObject<HTMLButtonElement | null>; onClose(): void; onSaved(): void;
}) {
  const [image, setImage] = useState<PlayerScoreImage | null>(null);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(true);
  const [saving, setSaving] = useState(false);
  const [originalSize, setOriginalSize] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false), callbacks = useRef({ onClose, onSaved });
  callbacks.current = { onClose, onSaved };
  const titleId = useId();

  useLayoutEffect(() => {
    mounted.current = true;
    closeButton.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); callbacks.current.onClose();
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!buttons.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const containFocus = (event: FocusEvent) => {
      if (!dialog.current?.contains(event.target as Node)) closeButton.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", containFocus);
    return () => {
      mounted.current = false;
      document.removeEventListener("keydown", keydown, true); document.removeEventListener("focusin", containFocus);
      if (anchor.current?.isConnected) anchor.current.focus({ preventScroll: true });
    };
  }, [anchor]);

  useEffect(() => {
    const controller = new AbortController();
    setGenerating(true); setImage(null); setError(""); setOriginalSize(false);
    void generatePlayerScoreImage({ ...snapshot, signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setImage(result);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (!controller.signal.aborted) setGenerating(false); });
    return () => controller.abort();
  }, [snapshot, attempt]);

  const save = async () => {
    if (!image || saving) return;
    setSaving(true); setError("");
    try {
      // The native save dialog selects the destination; no card or server identifier is exported.
      const saved = await window.ogk.savePlayerScoreImage({ dataUrl: image.dataUrl, fileName: `ONGEKI-BEST110-${snapshot.save.updatedAt.slice(0, 10)}.png` });
      if (saved && mounted.current) callbacks.current.onSaved();
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (mounted.current) setSaving(false); }
  };

  return createPortal(<div className="image-viewer-backdrop player-score-image-backdrop" role="presentation" onMouseDown={event => {
    if (event.target === event.currentTarget && !saving) onClose();
  }}><section ref={dialog} className="surface player-score-image-preview" role="dialog" aria-modal="true" aria-labelledby={titleId}>
    <header className="player-score-image-heading"><div><h2 id={titleId}>BEST 110 成绩图</h2><p>旧曲 50 · 新曲 10 · 白金 50</p></div><button ref={closeButton} data-score-image-close type="button" disabled={saving} onClick={onClose}>关闭</button></header>
    <div className={`player-score-image-stage${originalSize ? " is-original" : ""}`} tabIndex={image ? 0 : undefined} aria-label="成绩图预览">
      {image ? <img className="player-score-image-artwork" src={image.dataUrl} alt={`${snapshot.save.playerName} 的 BEST 110 成绩图`} width={image.width} height={image.height}/> : <div className="empty" role="status"><b>{generating ? "正在生成成绩图…" : "成绩图生成失败"}</b><span>{generating ? "正在读取封面和排版全部成绩" : "可以重试生成"}</span></div>}
    </div>
    {error && <SaveFeedback error>{error}</SaveFeedback>}
    <footer className="player-score-image-footer"><div className="player-score-image-note">{image ? <><span>{image.width} × {image.height} · PNG</span>{image.missingCovers > 0 && <span>{image.missingCovers} 张封面未能读取，已使用占位图</span>}</> : <span>成绩图在本地生成</span>}</div><div className="player-save-actions">
      {!generating && !image && <button data-score-image-retry type="button" onClick={() => setAttempt(value => value + 1)}>重新生成</button>}
      {image && <button data-score-image-size type="button" aria-pressed={originalSize} onClick={() => setOriginalSize(value => !value)}>{originalSize ? "适应窗口" : "查看原尺寸"}</button>}
      <button data-score-image-save type="button" className="primary" disabled={!image || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存 PNG"}</button>
    </div></footer>
  </section></div>, document.querySelector(".app") ?? document.body);
}
