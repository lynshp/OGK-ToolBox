import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { MachineProfile, PlayerProfile } from "./machine-profile-models";
import type { PlayerCard } from "./player-save-models";
import { PlayerPopover } from "./player-popover";
import { CardVisibilityButton } from "./player-picker";
import { SaveFeedback } from "./player-score-ui";
import "./player-profile-editor.css";

type ProfileOption = { id: string; title: string; detail?: string };
function ProfilePicker({ parentId, label, value, options, placeholder, disabled, onChange, onAdd }: {
  parentId: string; label: string; value: string; options: ProfileOption[]; placeholder: string; disabled: boolean; onChange(id: string): void; onAdd?(accessCode: string): Promise<void>;
}) {
  const [open, setOpen] = useState(false), id = useId();
  const [draft, setDraft] = useState<string | null>(null), [adding, setAdding] = useState(false), [addError, setAddError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const selected = options.find(option => option.id === value);
  useEffect(() => {
    if (!open) return;
    (popup.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? popup.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [open]);
  const close = () => { setOpen(false); setDraft(null); setAddError(""); trigger.current?.focus({ preventScroll: true }); };
  const saveCard = async () => {
    if (!onAdd || draft === null || !/^\d{20}$/.test(draft.replace(/[\s-]/g, "")) || adding) return;
    setAdding(true); setAddError("");
    try { await onAdd(draft); if (mounted.current) close(); }
    catch (error) { if (mounted.current) setAddError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setAdding(false); }
  };
  return <div className="player-profile-picker">
    <button ref={trigger} type="button" className={`filter-trigger${open ? " open" : ""}`} data-player-profile-picker={label} aria-label={label}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} aria-disabled={disabled || adding} disabled={disabled} onClick={() => { if (!adding) setOpen(value => !value); }}>
      <span className="player-picker-copy"><b>{selected?.title ?? placeholder}</b>{selected?.detail && <small>{selected.detail}</small>}</span><span className="filter-caret" aria-hidden="true"/>
    </button>
    {open && <PlayerPopover id={id} parentId={parentId} title={label} anchor={trigger} width={350} fitContent onClose={() => { if (!adding) close(); }} bodyClassName="player-profile-picker-menu"><div ref={popup} role="menu" aria-label={label} onKeyDown={event => {
      if (event.target instanceof HTMLInputElement) return;
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...popup.current!.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}><div className="filter-options">{options.map(option => <button key={option.id} type="button" role="menuitemradio" aria-checked={value === option.id}
      data-profile-option-id={option.id} disabled={adding} className={value === option.id ? "selected-option" : ""} onClick={() => { close(); onChange(option.id); }}>
      <span className="player-picker-copy"><b>{option.title}</b>{option.detail && <small>{option.detail}</small>}</span>
    </button>)}{onAdd && <button type="button" className="player-add-option" data-player-profile-add-card role="menuitem" disabled={adding} onClick={() => { setDraft(""); setAddError(""); }}>＋ 添加新卡号</button>}</div></div>
      {draft !== null && <div className="player-profile-inline-card">
        {addError && <SaveFeedback error>{addError}</SaveFeedback>}
        <label className="player-profile-field">新卡号<input autoFocus name="player-access-code" type="password" inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={28} value={draft} disabled={adding} onChange={event => setDraft(event.target.value)} placeholder="20 位 Aime 卡号" onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void saveCard(); } }}/></label>
        <div className="player-profile-inline-card-actions"><button type="button" disabled={adding} data-player-profile-card-cancel onClick={() => { popup.current?.querySelector<HTMLButtonElement>("[data-player-profile-add-card]")?.focus({ preventScroll: true }); setDraft(null); setAddError(""); }}>取消</button><button type="button" className="primary" disabled={adding || !/^\d{20}$/.test(draft.replace(/[\s-]/g, ""))} data-player-profile-card-save onClick={() => void saveCard()}>{adding ? "保存中…" : "保存卡号"}</button></div>
      </div>}
    </PlayerPopover>}
  </div>;
}

export function PlayerProfileEditor({ root, profile, automaticName, machines, cards, defaultMachineId, defaultCardId, anchor, onClose, onSaved, onDeleted, onEditMachine }: {
  root: string; profile?: PlayerProfile; automaticName: string; machines: MachineProfile[]; cards: PlayerCard[]; defaultMachineId: string; defaultCardId: string;
  anchor: RefObject<HTMLButtonElement | null>; onClose(): void; onSaved(id: string, isEditorCurrent: () => boolean): Promise<void>; onDeleted(isEditorCurrent: () => boolean): Promise<void>; onEditMachine?(id: string): void;
}) {
  const [machineId, setMachineId] = useState(profile?.machineId ?? (defaultMachineId || machines[0]?.id || ""));
  const [cardId, setCardId] = useState(profile?.cardId ?? (defaultCardId || cards[0]?.id || ""));
  const [catalog, setCatalog] = useState({ machines, cards }), [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [addingCard, setAddingCard] = useState(false), [error, setError] = useState("");
  const [visible, setVisible] = useState(false), [deleteConfirm, setDeleteConfirm] = useState(false), [deleting, setDeleting] = useState(false);
  const mounted = useRef(true), id = useId(), machine = catalog.machines.find(item => item.id === machineId);
  useEffect(() => {
    mounted.current = true;
    void window.ogk.machineProfiles(root).then(next => {
      if (!mounted.current) return;
      setCatalog({ machines: next.machines, cards: next.cards });
      if (next.configurationError) setError(next.configurationError);
    }).catch(error => { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }).finally(() => { if (mounted.current) setLoading(false); });
    return () => { mounted.current = false; };
  }, [root]);
  useEffect(() => {
    const hide = () => setVisible(false);
    const visibility = () => { if (document.visibilityState !== "visible") hide(); };
    window.addEventListener("blur", hide); document.addEventListener("visibilitychange", visibility);
    return () => { window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  const canSave = !!machine && (catalog.cards.some(card => card.id === cardId) || cardId === "" && !!profile?.importedSaveIds?.length);
  const busy = saving || addingCard;
  const submit = async () => {
    if (!canSave || busy || loading || deleteConfirm) return;
    setSaving(true); setVisible(false); setError("");
    try {
      const savedId = await window.ogk.savePlayerProfile(root, { id: profile?.id, name: automaticName, machineId, cardId });
      if (mounted.current) await onSaved(savedId, () => mounted.current);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) setSaving(false); }
  };
  const remove = async () => {
    if (!profile || busy || loading) return;
    setSaving(true); setDeleting(true); setVisible(false); setError("");
    try {
      await window.ogk.deletePlayerProfile(root, profile.id);
      if (mounted.current) await onDeleted(() => mounted.current);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (mounted.current) { setSaving(false); setDeleting(false); } }
  };
  const cardText = (value: string) => visible ? value.replace(/(.{4})(?=.)/g, "$1 ") : `${value.slice(0, 4)} •••• •••• •••• ••••`;
  return <PlayerPopover id={id} title={profile ? "编辑玩家" : "新增玩家"} anchor={anchor} width={420} fitContent onClose={() => { if (!busy) onClose(); }} bodyClassName="player-profile-editor">
    {error && <SaveFeedback error>{error}</SaveFeedback>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="player-profile-field"><span>机台</span><ProfilePicker parentId={id} label="选择机台" value={machineId} options={catalog.machines.map(machine => ({ id: machine.id, title: machine.name, detail: `${machine.server?.label ?? "服务器未配置"} · Keychip ${machine.keychipHint || "未配置"}` }))}
        placeholder={loading ? "读取中…" : "选择机台"} disabled={busy || loading} onChange={setMachineId}/>
        <div className="player-profile-machine-info"><span>{machine?.server?.label ?? "服务器未配置"}</span><button type="button" data-player-profile-edit-machine disabled={busy || !machine || !onEditMachine} onClick={() => { if (!busy && machine && onEditMachine) { onClose(); onEditMachine(machine.id); } }}>编辑机台</button></div>
      </div>
      <div className="player-profile-field"><span>Aime 卡号</span><div className="player-card-controls"><ProfilePicker parentId={id} label="选择玩家卡号" value={cardId} options={catalog.cards.map((card, index) => ({ id: card.id, title: `卡号 ${index + 1}`, detail: cardText(card.accessCode) }))}
        placeholder={loading ? "读取中…" : "选择卡号"} disabled={saving || loading} onChange={id => { setCardId(id); setVisible(false); }} onAdd={async value => {
          setAddingCard(true); setVisible(false);
          try {
            const addedId = await window.ogk.addPlayerCard(root, value);
            if (!mounted.current) return;
            const next = await window.ogk.machineProfiles(root);
            if (!mounted.current) return;
            if (!next.cards.some(card => card.id === addedId)) throw new Error("新卡号尚未读取，请重试。");
            setCatalog({ machines: next.machines, cards: next.cards }); setCardId(addedId);
          } finally { if (mounted.current) setAddingCard(false); }
        }}/>
        <CardVisibilityButton visible={visible} onToggle={() => setVisible(value => !value)} disabled={busy || loading || !cardId}/></div>
      </div>
      <p className="player-profile-note">{deleteConfirm ? "仅删除玩家绑定，卡号与存档保留。" : "用于工具箱取档与成绩同步。切换玩家不会改动游戏当前机台或虚拟 Aime 卡。"}</p>
      <div className="player-profile-actions">
        {profile && <div className="player-profile-delete">{deleteConfirm ? <><button type="button" disabled={busy} data-player-profile-delete-cancel onClick={() => setDeleteConfirm(false)}>取消删除</button><button type="button" className="player-delete-confirm" disabled={busy || loading} data-player-profile-delete-confirm onClick={() => void remove()}>{deleting ? "删除中…" : "确认删除"}</button></> : <button type="button" disabled={busy || loading} data-player-profile-delete onClick={() => setDeleteConfirm(true)}>删除玩家</button>}</div>}
        <button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" type="submit" data-player-profile-save disabled={busy || loading || deleteConfirm || !canSave}>{saving && !deleting ? "保存中…" : profile ? "保存玩家" : "新增玩家"}</button>
      </div>
    </form>
  </PlayerPopover>;
}
