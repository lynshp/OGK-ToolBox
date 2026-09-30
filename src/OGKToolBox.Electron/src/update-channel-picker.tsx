import React, { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredMenu } from "./use-anchored-menu";
import { channelName, type ChannelStatus, type UpdateSource, type UpdateStatus } from "./update-models";

type Route = UpdateSource;
function connectivity(status?: ChannelStatus) {
  switch (status?.state) {
    case "checking": return "检测中…";
    case "reachable": return `可连通 · ${status.latencyMs ?? 0} ms`;
    case "failed": return "检测失败";
    default: return "未检测";
  }
}

export function UpdateChannelPicker({ value, onChange, status, disabled }: {
  value: Route; onChange(value: Route): void; status: UpdateStatus; disabled: boolean;
}) {
  const choices: Route[] = ["auto", "fastgithub", "ghproxy", "github"];
  const name = "GitHub 来源";
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreAfterSave = useRef(false);
  const id = useId();
  const { menu, position } = useAnchoredMenu(host, open, () => setOpen(false));
  const label = (source: Route) => source === "auto" ? "自动选择 · 检测可用线路"
    : source === "ghproxy" ? `GH-Proxy · ${!status.ghproxy || status.ghproxy.state === "unknown" ? "自动检测 5 个节点" : connectivity(status.ghproxy)}`
    : `${channelName(source)} · ${connectivity(status.channels?.[source])}`;
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    popup.current?.querySelector<HTMLButtonElement>(`[data-source="${value}"]`)?.focus();
    const outside = (event: MouseEvent) => {
      if (!host.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!disabled && restoreAfterSave.current) {
      restoreAfterSave.current = false;
      if (document.activeElement === document.body) trigger.current?.focus();
    }
  }, [disabled]);
  return <>
    <div className="mu3io-picker update-channel-picker" ref={host}>
      <button ref={trigger} type="button" className={`filter-trigger${open ? " open" : ""}`}
        aria-label={`${name}：${label(value)}`} aria-haspopup="menu" aria-controls={open ? id : undefined}
        aria-expanded={open} disabled={disabled} onClick={() => { position(); setOpen(!open); }}>
        <span>{label(value)}</span><span className="filter-caret" aria-hidden="true"/>
      </button>
    </div>
    {open && createPortal(<div ref={popup} id={id} className="filter-popover mu3io-menu" style={menu}
      role="menu" aria-label={name} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (event.key === "Tab") { event.preventDefault(); close(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = [...popup.current!.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]")];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      <div className="filter-options">{choices.map(source => <button key={source} type="button"
        data-source={source} role="menuitemradio" aria-checked={value === source}
        className={value === source ? "selected-option" : ""}
        onClick={() => { restoreAfterSave.current = true; close(); onChange(source); }}>{label(source)}</button>)}</div>
    </div>, document.body)}
  </>;
}
