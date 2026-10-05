import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { MachineProfile, MachineProfilesState, MachineValues } from "./machine-profile-models";
import "./segatools-machine-panel.css";

export type ProfilesController = {
  state: MachineProfilesState | null; loading: boolean; error: string;
  reload(): Promise<MachineProfilesState | undefined>;
  acceptMachine(machine: MachineProfile): void;
  removeMachine(id: string): void;
};
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const copyValues = (values: MachineValues): MachineValues => ({ dns: { ...values.dns }, netenv: { ...values.netenv }, keychip: { ...values.keychip } });
const readValue = (values: Record<string, string>, key: string) => Object.entries(values).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? "";
function setValue(values: Record<string, string>, key: string, value: string) {
  const existing = Object.keys(values).find(name => name.toLowerCase() === key.toLowerCase());
  values[existing ?? key] = value;
}

// Both sections share one snapshot. A late read from a previous directory cannot
// replace the current directory, including the first render before effect cleanup.
export function useSegatoolsProfiles(root: string, configurationRevision?: string): ProfilesController {
  const [state, setState] = useState<MachineProfilesState | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const scope = useRef({ root, revision: 0, mounted: true });
  if (scope.current.root !== root) scope.current = { root, revision: scope.current.revision + 1, mounted: true };
  const stateRoot = useRef(root);
  const reload = useCallback(async () => {
    if (!root || scope.current.root !== root) return;
    const current = scope.current, request = ++current.revision;
    setLoading(true); setError("");
    try {
      const result = await window.ogk.machineProfiles(root);
      if (current !== scope.current || !current.mounted || request !== current.revision) return;
      stateRoot.current = root; setState(result); return result;
    } catch (cause) {
      if (current === scope.current && current.mounted && request === current.revision) setError(message(cause, "读取机台配置失败。"));
      throw cause;
    } finally {
      if (current === scope.current && current.mounted && request === current.revision) setLoading(false);
    }
  }, [root]);
  useEffect(() => {
    const current = scope.current; current.mounted = true;
    if (stateRoot.current !== root || !root) { setState(null); setError(""); setLoading(false); }
    if (root) void reload().catch(() => {});
    return () => { current.mounted = false; current.revision++; };
  }, [root, configurationRevision, reload]);
  return { state: stateRoot.current === root ? state : null, loading, error, reload,
    acceptMachine(machine) {
      if (scope.current.root !== root || !scope.current.mounted) return;
      scope.current.revision++;
      setLoading(false);
      setState(current => current ? { ...current, machines: current.machines.some(item => item.id === machine.id)
        ? current.machines.map(item => item.id === machine.id ? machine : item) : [...current.machines, machine] } : current);
    },
    removeMachine(id) {
      if (scope.current.root !== root || !scope.current.mounted) return;
      scope.current.revision++; setLoading(false);
      setState(current => current ? { ...current, machines: current.machines.filter(machine => machine.id !== id) } : current);
    }
  };
}

type MachineDraft = { name: string; values: MachineValues };
type EntryRenderer = (props: { entry: any; onPersist(value: string): Promise<void>; disabled: boolean }) => ReactNode;
const machineFields = { dns: ["default", "AimeDB", "replaceHost"], netenv: ["enable"], keychip: ["id", "subnet"] } as const;
const machinePresentation: Record<string, { title: string; detail?: string }> = {
  "dns.default": { title: "游戏服务器" },
  "dns.aimedb": { title: "读卡服务器", detail: "留空时不额外指定读卡服务器；选择 Mumur 时会自动填写对应地址。" },
  "keychip.id": { title: "Keychip", detail: "点击查看并编辑；留空保存后会注释此项。" },
  "keychip.subnet": { title: "LAN 子网", detail: "模拟游戏使用的 /24 局域网子网；关闭模拟网络环境时须填写以 192.168 开头的子网。" },
  "dns.replacehost": { title: "服务器地址替换", detail: "切换到 EA 服务器时会自动启用地址替换。" },
  "netenv.enable": { title: "模拟网络环境", detail: "模拟游戏使用的网卡与局域网环境，不会切换电脑的实体网络连接。" }
};
function machineEntries(values: MachineValues, file: any, persisted: MachineValues) {
  return (Object.keys(machineFields) as (keyof MachineValues)[]).flatMap(section => {
    const keys = [...machineFields[section], ...Object.keys(values[section])].filter((key, index, all) => all.findIndex(item => item.toLowerCase() === key.toLowerCase()) === index);
    return keys.map(key => {
      const original = file.entries?.find((entry: any) => String(entry.section).toLowerCase() === section && String(entry.key).toLowerCase() === key.toLowerCase());
      const value = readValue(values[section], key);
      return { ...original, section, key, value, isKnown: true, isPresent: true, detailAsHint: true,
        presentationOverride: machinePresentation[`${section}.${key}`.toLowerCase()] ?? { title: `${section}.${key}`, detail: original?.description },
        persistedValue: readValue(persisted[section], key),
        valueKind: key.toLowerCase() === "enable" || key.toLowerCase() === "replacehost" ? "Boolean" : original?.valueKind ?? "String",
        isSensitive: section === "keychip" && key === "id", displayValue: value ? "•••• •••• ••••" : "未设置" };
    });
  });
}

export function SegatoolsMachinePanel({ root, file, profiles, focusMachineId, onApplied, renderEntry }: {
  root: string; file: any; profiles: ProfilesController; focusMachineId?: string; onApplied(): Promise<void>; renderEntry: EntryRenderer;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null), [drafts, setDrafts] = useState<Record<string, MachineDraft>>({});
  const draftsRef = useRef(drafts); draftsRef.current = drafts;
  const [pending, setPending] = useState(""), [error, setError] = useState(""), [errorAction, setErrorAction] = useState("save");
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const busy = useRef(false), live = useRef(true), addTrigger = useRef<HTMLButtonElement>(null), machineList = useRef<HTMLDivElement>(null);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, [root]);
  const machines = profiles.state?.machines ?? [];
  const selected = machines.find(machine => machine.id === selectedId);
  useEffect(() => {
    if (focusMachineId && machines.some(machine => machine.id === focusMachineId)) setSelectedId(focusMachineId);
  }, [focusMachineId, machines.some(machine => machine.id === focusMachineId)]);
  useEffect(() => {
    const reveal = () => {
      const card = Array.from(machineList.current?.querySelectorAll<HTMLElement>("[data-machine-card]") ?? []).find(item => item.dataset.machineCard === selected?.id);
      if (!card || !machineList.current) return;
      const list = machineList.current, start = card.offsetLeft - list.offsetLeft, end = start + card.offsetWidth;
      if (start < list.scrollLeft) list.scrollLeft = start;
      else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth;
    };
    // Flex widths finish after the initial layout. One final reveal keeps a
    // middle card fully visible without measuring the rail on every frame.
    reveal(); const settled = window.setTimeout(reveal, 180); window.addEventListener("resize", reveal);
    return () => { window.clearTimeout(settled); window.removeEventListener("resize", reveal); };
  }, [selected?.id]);
  const draft = selected ? drafts[selected.id] ?? selected : undefined;
  const entries = useMemo(() => draft && selected ? machineEntries(draft.values, file, selected.values) : [], [draft?.values, selected?.values, file]);
  const commonEntries = (section: string, keys: string[]) => entries.filter(entry => entry.section === section && keys.includes(String(entry.key).toLowerCase()));
  const advancedEntries = entries.filter(entry => !["dns.default", "dns.aimedb", "keychip.id", "keychip.subnet"].includes(`${entry.section}.${entry.key}`.toLowerCase()));
  const writeDraft = (id: string, next: MachineDraft) => {
    draftsRef.current = { ...draftsRef.current, [id]: next }; setDrafts(draftsRef.current);
  };
  const clearDraft = (id: string) => { const next = { ...draftsRef.current }; delete next[id]; draftsRef.current = next; setDrafts(next); };
  const save = async (machine: MachineProfile, next: MachineDraft) => {
    if (busy.current) throw new Error("正在保存机台，请稍后再试。");
    writeDraft(machine.id, next); busy.current = true; setPending(machine.id); setError(""); setErrorAction("save");
    try {
      const saved = await window.ogk.saveMachineProfile(root, { id: machine.id, name: next.name.trim(), values: next.values });
      if (!live.current) return;
      profiles.acceptMachine(saved); clearDraft(machine.id);
      if (profiles.state?.activeMachineId === machine.id) await onApplied();
    } catch (cause) {
      if (live.current) setError(message(cause, "保存机台失败。"));
      throw cause;
    } finally { if (live.current) { busy.current = false; setPending(""); } }
  };
  const persistField = async (entry: any, value: string) => {
    if (!selected) return;
    const current = draftsRef.current[selected.id] ?? selected, values = copyValues(current.values);
    setValue(values[entry.section as keyof MachineValues], entry.key, value);
    if (entry.section === "dns" && entry.key.toLowerCase() === "default") {
      if (value === "ea.naominet.live") setValue(values.dns, "replaceHost", "1");
      setValue(values.dns, "AimeDB", value === "play.mumur.net" ? "aime.mumur.net" : "");
      if (value === "nageki-net.com") setValue(values.keychip, "id", "");
    }
    if (current.name === selected.name && JSON.stringify(values) === JSON.stringify(selected.values)) return;
    await save(selected, { name: current.name, values });
  };
  const add = async () => {
    if (busy.current || !profiles.state) return;
    busy.current = true; setPending("new"); setError(""); setErrorAction("other");
    try {
      const machines = profiles.state.machines, active = machines.find(machine => machine.id === profiles.state!.activeMachineId) ?? machines[0];
      const saved = await window.ogk.saveMachineProfile(root, { name: `机台 ${machines.length + 1}`, values: active ? copyValues(active.values) : { dns: {}, netenv: {}, keychip: {} } });
      if (live.current) { profiles.acceptMachine(saved); setSelectedId(saved.id); }
    } catch (cause) { if (live.current) setError(message(cause, "添加机台失败。")); }
    finally { if (live.current) { busy.current = false; setPending(""); } }
  };
  const activate = async () => {
    if (!selected || busy.current) return;
    busy.current = true; setPending(selected.id); setError(""); setErrorAction("other");
    try {
      const current = draftsRef.current[selected.id];
      if (current && (current.name !== selected.name || JSON.stringify(current.values) !== JSON.stringify(selected.values))) {
        const saved = await window.ogk.saveMachineProfile(root, { id: selected.id, name: current.name.trim(), values: current.values });
        if (!live.current) return;
        profiles.acceptMachine(saved); clearDraft(selected.id);
      }
      await window.ogk.activateMachineProfile(root, selected.id);
      if (live.current) { await profiles.reload(); if (live.current) await onApplied(); }
    } catch (cause) { if (live.current) setError(message(cause, "应用机台失败。")); }
    finally { if (live.current) { busy.current = false; setPending(""); } }
  };
  const deleteMachine = async (machine: MachineProfile) => {
    if (busy.current) return;
    busy.current = true; setPending(machine.id); setError(""); setErrorAction("delete");
    try {
      await window.ogk.deleteMachineProfile(root, machine.id);
      if (!live.current) return;
      profiles.removeMachine(machine.id); clearDraft(machine.id); setDeleteCandidate(null); setSelectedId(null);
      void profiles.reload().catch(() => {});
      window.requestAnimationFrame(() => { if (live.current) addTrigger.current?.focus(); });
    } catch (cause) { if (live.current) setError(message(cause, "删除机台失败。")); }
    finally { if (live.current) { busy.current = false; setPending(""); } }
  };
  const selectMachine = (id: string) => { if (busy.current) return; setSelectedId(id === selected?.id ? null : id); setError(""); setDeleteCandidate(null); };
  const navigateMachines = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (busy.current || pending || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = machines.findIndex(machine => machine.id === event.currentTarget.dataset.machineId);
    const next = event.key === "Home" ? 0 : event.key === "End" ? machines.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + machines.length) % machines.length;
    const machine = machines[next];
    if (!machine) return;
    setSelectedId(machine.id); setError(""); setDeleteCandidate(null);
    Array.from(machineList.current?.querySelectorAll<HTMLButtonElement>("[data-machine-id]") ?? []).find(button => button.dataset.machineId === machine.id)?.focus();
  };
  const renderEntries = (items: typeof entries) => items.map(entry => renderEntry({ entry, disabled: !!pending, onPersist: value => persistField(entry, value) }));
  const current = selected?.id === profiles.state?.activeMachineId;
  const deleteReason = machines.length === 1 ? "至少保留一个机台。" : current ? "请先将另一机台设为当前。" : "";
  return <section className="config-section machine-section" aria-label="机台">
    <div className="machine-section-heading"><h2 className="config-section-title">机台</h2><button ref={addTrigger} type="button" data-machine-add onClick={() => void add()} disabled={!profiles.state || !!pending}>＋ 添加机台</button></div>
    {profiles.error && <div className="config-error machine-error" role="alert">{profiles.error}<button type="button" onClick={() => void profiles.reload().catch(() => {})}>重新读取</button></div>}
    {profiles.state?.configurationError && <div className="config-error machine-error" role="alert">{profiles.state.configurationError}</div>}
    {!profiles.state && !profiles.error && <p className="machine-loading" role="status">{profiles.loading ? "正在读取机台…" : "暂无机台"}</p>}
    <div ref={machineList} className={`machine-list${selected ? " has-expanded" : ""}`} aria-label="机台档案">{machines.map(machine => {
      const expanded = machine.id === selected?.id;
      return <article key={machine.id} data-machine-card={machine.id} className={`machine-card${expanded ? " is-expanded" : selected ? " is-spine" : ""}`}>
      <button type="button" className="machine-card-toggle" data-machine-id={machine.id} data-machine-collapse={expanded ? "" : undefined} aria-expanded={expanded} aria-controls={`sega-machine-panel-${machine.id}`} aria-label={`${expanded ? "收起机台" : "展开机台"} ${machine.name}${machine.id === profiles.state?.activeMachineId ? "，当前机台" : ""}`} disabled={!!pending} onClick={() => selectMachine(machine.id)} onKeyDown={navigateMachines}>
        {!expanded && <><span className="machine-spine-name">{machine.name}</span>{!selected && <span className="machine-card-summary"><span>{machine.server?.label ?? (readValue(machine.values.dns, "default") || "未设置服务器")}</span><span>Keychip {machine.keychipHint || "未设置"}</span>{machine.id === profiles.state?.activeMachineId && <em className="machine-current-badge">当前机台</em>}</span>}</>}
        {!expanded && selected && machine.id === profiles.state?.activeMachineId && <span className="machine-current-dot" title="当前机台" aria-hidden="true"/>}
        <svg className="machine-card-caret" viewBox="0 0 16 16" aria-hidden="true"><path d={expanded ? "M4 10l4-4 4 4" : "M6 4l4 4-4 4"}/></svg>
      </button>
    {expanded && selected && draft && <div key={selected.id} id={`sega-machine-panel-${selected.id}`} className="machine-editor" data-machine-panel={selected.id} role="region" aria-label={`${selected.name}配置`}>
      <div className="machine-editor-title"><input aria-label="机台名称" value={draft.name} disabled={!!pending} maxLength={40} onChange={event => writeDraft(selected.id, { ...draft, name: event.currentTarget.value })} onBlur={() => { if (draft.name !== selected.name) void save(selected, draft).catch(() => {}); }}/>{current && <em className="machine-current-badge">当前机台</em>}</div>
      <div className="machine-editor-body">
        <section className="machine-field-group" data-machine-field-group="server" aria-label="服务器"><h3>服务器</h3>{renderEntries(commonEntries("dns", ["default", "aimedb"]))}</section>
        <section className="machine-field-group" data-machine-field-group="identity" aria-label="机台身份"><h3>机台身份</h3>{renderEntries(commonEntries("keychip", ["id", "subnet"]))}</section>
      </div>
      <details className="machine-advanced" data-machine-advanced><summary data-machine-advanced-toggle>高级设置<span className="filter-caret" aria-hidden="true"/></summary><div className="machine-advanced-fields">{renderEntries(advancedEntries)}</div></details>
      <div className="machine-editor-footer"><div className="machine-save-state"><span role="status" className={pending ? "machine-operation" : undefined}>{pending ? errorAction === "delete" ? "正在删除机台…" : pending === "new" ? "正在添加机台…" : "正在保存机台…" : current ? "修改自动应用 · 自动备份" : "修改只保存此机台"}</span>{deleteReason && <small id={`machine-delete-reason-${selected.id}`}>{deleteReason}</small>}</div><div className="machine-editor-actions">
        <button type="button" className="option-delete-button machine-delete" data-machine-delete disabled={!!pending || !!deleteReason} aria-describedby={deleteReason ? `machine-delete-reason-${selected.id}` : undefined} onClick={() => { setDeleteCandidate(selected.id); setError(""); }}>删除机台</button>
        {!current && <button type="button" className="primary" data-machine-activate onClick={() => void activate()} disabled={!!pending}>设为当前机台</button>}
      </div></div>
      {deleteCandidate === selected.id && <div className="machine-delete-confirm" role="group" aria-label="确认删除机台"><p>删除此机台档案？</p><div><button type="button" data-machine-delete-cancel disabled={!!pending} onClick={() => { setDeleteCandidate(null); setError(""); }}>取消</button><button type="button" className="option-delete-button" data-machine-delete-confirm disabled={!!pending} onClick={() => void deleteMachine(selected)}>确认删除</button></div></div>}
      {error && <div className="config-error machine-error" role="alert">{error}{errorAction === "save" && <button type="button" data-machine-retry disabled={!!pending} onClick={() => void save(selected, draft).catch(() => {})}>重试保存</button>}</div>}
    </div>}
      </article>;
    })}</div>
    {error && !selected && <div className="config-error machine-error" role="alert">{error}</div>}
  </section>;
}

export { VirtualAimeCard } from "./segatools-virtual-card";
