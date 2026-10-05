import { useEffect, useId, useRef, useState } from "react";
import { CardVisibilityButton, PlayerPicker } from "./player-picker";
import type { ProfilesController } from "./segatools-machine-panel";
import "./segatools-virtual-card.css";

const maskedCard = (code: string) => code ? `${code.slice(0, 4)} •••• •••• •••• ••••` : "未设置";
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export function VirtualAimeCard({ root, profiles, enabled, onApplied }: { root: string; profiles: ProfilesController; enabled: boolean; onApplied(): Promise<void> }) {
  const [editing, setEditing] = useState<"add" | "edit" | null>(null), [code, setCode] = useState(""), [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pending = useRef(false), live = useRef({ root, mounted: true }), input = useRef<HTMLInputElement>(null);
  // Invalidate the old directory during render; a promise can finish before
  // passive effect cleanup runs after a directory switch.
  if (live.current.root !== root) live.current = { root, mounted: true };
  const id = useId(), errorId = `${id}-error`, inputId = `${id}-code`;
  useEffect(() => {
    const scope = live.current; scope.mounted = true;
    setEditing(null); setCode(""); setVisible(false); setBusy(false); setError(""); pending.current = false;
    const hide = () => setVisible(false); window.addEventListener("blur", hide);
    return () => { scope.mounted = false; window.removeEventListener("blur", hide); };
  }, [root]);
  useEffect(() => { if (editing) input.current?.focus(); }, [editing]);
  const current = profiles.state?.virtualCard;
  const isLive = (scope: typeof live.current) => scope.mounted && live.current === scope && scope.root === root;
  const begin = (mode: "add" | "edit") => {
    if (pending.current) return;
    setCode(mode === "edit" ? current?.accessCode ?? "" : ""); setError(""); setVisible(false); setEditing(mode);
  };
  const finish = async (scope: typeof live.current, close?: () => void) => {
    await profiles.reload();
    if (!isLive(scope)) return;
    await onApplied();
    if (isLive(scope)) { setEditing(null); setCode(""); close?.(); }
  };
  const applyCard = async (cardId: string) => {
    if (pending.current || !enabled) return;
    const scope = live.current;
    pending.current = true; setBusy(true); setError(""); setVisible(false);
    try {
      await window.ogk.setVirtualPlayerCard(root, cardId);
      if (isLive(scope)) await finish(scope);
    } catch (cause) { if (isLive(scope)) setError(message(cause, "写入虚拟卡号失败。")); }
    finally { if (isLive(scope)) { pending.current = false; setBusy(false); } }
  };
  const saveCode = async (close: () => void) => {
    if (pending.current || !enabled) return;
    const normalized = code.replace(/[\s-]/g, "");
    if (!/^\d{20}$/.test(normalized)) { setError("请输入完整的 20 位卡号。"); input.current?.focus(); return; }
    const scope = live.current;
    pending.current = true; setBusy(true); setError(""); setVisible(false);
    try {
      const cardId = await window.ogk.addPlayerCard(root, normalized);
      // Leaving or changing directories during card creation must not start a
      // second disk write into the previous game installation.
      if (!isLive(scope)) return;
      await window.ogk.setVirtualPlayerCard(root, cardId);
      if (isLive(scope)) await finish(scope, close);
    } catch (cause) { if (isLive(scope)) setError(message(cause, "保存虚拟卡号失败。")); }
    finally { if (isLive(scope)) { pending.current = false; setBusy(false); } }
  };
  return <div className={`virtual-aime-card${enabled ? "" : " is-disabled"}`}>
    <div className="config-entry"><span><b>虚拟卡号</b><small>{current?.path || "DEVICE/aime.txt"}</small></span><div className="config-value virtual-card-controls">
      <PlayerPicker label="虚拟卡号" value={current?.cardId} placeholder={current?.accessCode ? maskedCard(current.accessCode) : "选择卡号"}
        options={(profiles.state?.cards ?? []).map((card, index) => ({ id: card.id, title: `卡号 ${index + 1}`, detail: visible ? card.accessCode : maskedCard(card.accessCode) }))}
        disabled={!enabled || !profiles.state} pending={busy} onChange={id => void applyCard(id)} onAdd={() => begin("add")} keepOpenOnAdd
        menuClassName="virtual-card-menu" onClose={() => setVisible(false)}
        menuFooter={<button type="button" role="menuitem" data-virtual-card-edit disabled={!current?.accessCode || busy} onClick={() => begin("edit")}>编辑当前卡号</button>}
        menuContent={editing ? ({ close }) => <form className="virtual-card-editor" data-virtual-card-editor onSubmit={event => { event.preventDefault(); void saveCode(close); }}>
          <b className="virtual-card-editor-title">{editing === "add" ? "添加新卡号" : "编辑当前卡号"}</b>
          <label htmlFor={inputId}>20 位卡号</label>
          <div className="virtual-card-input"><input ref={input} id={inputId} aria-label="20 位卡号" aria-describedby={error ? errorId : undefined} aria-invalid={!!error || undefined}
            type={visible ? "text" : "password"} inputMode="numeric" autoComplete="off" value={code} disabled={busy || !enabled} onChange={event => setCode(event.currentTarget.value)}/>
            <CardVisibilityButton visible={visible} disabled={busy || !enabled} onToggle={() => setVisible(current => !current)}/>
          </div>
          {error && <p id={errorId} className="config-error virtual-card-error" role="alert">{error}</p>}
          {busy && <p className="virtual-card-operation" role="status">正在写入虚拟卡号…</p>}
          <div className="virtual-card-editor-actions"><button type="button" data-virtual-card-cancel disabled={busy} onClick={() => { setEditing(null); setVisible(false); setError(""); }}>取消</button>
            <button type="submit" data-virtual-card-save className="primary" disabled={busy || !enabled}>保存并使用</button></div>
        </form> : undefined}/>
      <CardVisibilityButton visible={visible} disabled={!enabled || busy} onToggle={() => setVisible(current => !current)}/>
    </div></div>
    {busy && !editing && <p className="virtual-card-operation" role="status">正在写入虚拟卡号…</p>}
    {error && !editing && <p className="config-error virtual-card-error" role="alert">{error}</p>}
  </div>;
}
