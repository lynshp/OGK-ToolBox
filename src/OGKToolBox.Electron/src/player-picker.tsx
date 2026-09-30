import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredMenu } from "./use-anchored-menu";

type Option = { id: string; title: string; detail?: string };
export function PlayerPicker({ label, value, placeholder, options, disabled, onChange, onAdd, onReorder }: {
  label: string; value?: string; placeholder: string; options: Option[]; disabled?: boolean;
  onChange(id: string): void; onAdd?(): void; onReorder?(ids: string[]): void;
}) {
  const [open, setOpen] = useState(false), [over, setOver] = useState("");
  const host = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), drag = useRef("");
  const id = useId(), selected = options.find(option => option.id === value);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const { menu, position } = useAnchoredMenu(host, open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    (popup.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? popup.current?.querySelector<HTMLButtonElement>('button'))?.focus();
    const outside = (event: MouseEvent) => { if (!host.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const reorder = (from: string, to: string) => {
    if (!onReorder || from === to || !options.some(option => option.id === from)) return;
    const ids = options.map(option => option.id), index = ids.indexOf(to);
    if (index < 0) return;
    ids.splice(ids.indexOf(from), 1); ids.splice(index, 0, from); onReorder(ids);
  };
  return <>
    <div className="player-picker" ref={host}>
      <button ref={trigger} type="button" className={`filter-trigger${open ? " open" : ""}`} data-player-picker={label}
        aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} disabled={disabled}
        onClick={() => { position(); setOpen(value => !value); }}>
        <span className="player-picker-copy"><b>{selected?.title ?? placeholder}</b>{selected?.detail && <small>{selected.detail}</small>}</span><span className="filter-caret" aria-hidden="true"/>
      </button>
    </div>
    {open && createPortal(<div ref={popup} id={id} className="filter-popover player-picker-menu" style={menu} role="menu" aria-label={label} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
      if (event.key === "Tab") { setOpen(false); trigger.current?.focus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...popup.current!.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (event.altKey && onReorder) {
          const next = index + (event.key === "ArrowDown" ? 1 : -1);
          if (index >= 0 && next >= 0 && index < options.length && next < options.length) reorder(options[index].id, options[next].id);
          return;
        }
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
      {onReorder && options.length > 1 && <div className="filter-popover-head">拖动排序 · Alt + ↑ / ↓</div>}
      <div className="filter-options">{options.map(option => <button key={option.id} type="button" role="menuitemradio" aria-checked={value === option.id} data-option-id={option.id}
        className={`${value === option.id ? "selected-option" : ""}${over === option.id ? " is-drag-over" : ""}`} draggable={!!onReorder}
        onDragStart={event => { drag.current = option.id; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", option.id); }}
        onDragOver={event => { if (onReorder && drag.current) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(option.id); } }}
        onDrop={event => { event.preventDefault(); reorder(drag.current, option.id); drag.current = ""; setOver(""); }}
        onDragEnd={() => { drag.current = ""; setOver(""); }} onClick={() => { close(); onChange(option.id); }}>
        {onReorder && <svg className="player-grip" viewBox="0 0 16 20" aria-hidden="true"><path d="M5 4h.1M11 4h.1M5 10h.1M11 10h.1M5 16h.1M11 16h.1"/></svg>}
        <span className="player-picker-copy"><b>{option.title}</b>{option.detail && <small>{option.detail}</small>}</span>
      </button>)}{onAdd && <button type="button" role="menuitem" className="player-add-option" onClick={() => { close(); onAdd(); }}>＋ 添加新卡号</button>}</div>
    </div>, document.querySelector(".app") ?? document.body)}
  </>;
}

export function CardVisibilityButton({ visible, onToggle, disabled }: { visible: boolean; onToggle(): void; disabled?: boolean }) {
  return <button className="player-card-eye" type="button" aria-label={visible ? "隐藏卡号" : "显示卡号"} aria-pressed={visible} title={visible ? "隐藏卡号" : "显示卡号"} disabled={disabled} onClick={onToggle}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>{!visible && <path d="m3 3 18 18"/>}</svg>
  </button>;
}
