import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Avatar, Button, Dialog, Icon, Icons, Text, useToast, cx } from "@careeros/brand";
import { isActiveRun, type RecentWorkspace } from "@careeros/contract";
import { errorText, useBridge, useLoad } from "../bridge-context";
import { hasExample, hasSwitcher, openExample, recentWorkspaces } from "../onboarding/folder";
import { useWorkspaceFlow, workspaceDetail, workspaceLabel } from "./context";
import { ManageWorkspaces } from "./ManageWorkspaces";
import "./workspaces.css";

const ITEMS = "[role='menuitem'], [role='menuitemradio']";

/**
 * The workspace switcher at the top of the sidebar. One computer can be shared: each person keeps their own
 * workspace (data, secrets, privacy locks). Shows the open workspace by the person's name (else the folder's
 * name) and never a full path. Switching stops the old workspace's Claude tasks, after asking.
 */
export function WorkspaceSwitcher() {
  const bridge = useBridge();
  const flow = useWorkspaceFlow();
  const toast = useToast();
  const canList = hasSwitcher(bridge);
  const ws = useLoad((b) => b.workspace.current(), [], ["workspace", "settings"]);
  const list = useLoad((b) => recentWorkspaces(b), [], ["workspace", "settings"]);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | (() => Promise<void>)>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  // The rail clips anything wider than itself, so the menu is placed in the window, just below the trigger.
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const rows = list.data ?? [];
  const current = rows.find((r) => r.current);
  const label = current ? workspaceLabel(current) : ws.data?.name.trim() || "Your workspace";
  const isSample = current?.isSample ?? ws.data?.isSample ?? false;

  const close = (focusTrigger = true) => { setOpen(false); if (focusTrigger) triggerRef.current?.focus(); };

  // Focus the first item on open; close on a click outside.
  useEffect(() => {
    if (!open) return undefined;
    menuRef.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onResize = () => setOpen(false);
    window.addEventListener("resize", onResize);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("resize", onResize); };
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => { e.preventDefault(); items[(n + items.length) % items.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") setOpen(false);
  };

  const perform = async (go: () => Promise<void>) => {
    setBusy(true);
    try { await go(); } catch (e) { toast({ text: errorText(e), tone: "danger" }); } finally { setBusy(false); }
  };
  /** Leaving this workspace: ask first when a Claude task is still running here (it stops on switch). */
  const leaveThen = async (go: () => Promise<void>) => {
    setOpen(false);
    let active = 0;
    try { active = (await bridge.claude.runs()).filter((r) => isActiveRun(r.status)).length; } catch { active = 0; }
    if (active) { setConfirm(() => go); return; }
    await perform(go);
  };

  const switchTo = (r: RecentWorkspace) => {
    if (r.current) { close(); return; }
    // A folder that can't be found: open the list's tools (Locate…, Remove) instead of failing.
    if (!r.available) { close(false); setRemoving(true); return; }
    void leaveThen(async () => { await bridge.workspace.switchTo(r.key); flow.switched(); });
  };
  const openAnother = () => void leaveThen(async () => {
    const dir = await bridge.workspace.pickFolder("open");
    if (!dir) return;
    await bridge.workspace.open(dir);
    flow.switched();
  });
  const startNew = () => void leaveThen(async () => { flow.startNew(); });
  const explore = () => void leaveThen(async () => { await openExample(bridge); flow.switched(); });

  return (
    <div className="ws-switch">
      <button
        ref={triggerRef} type="button" className={cx("ws-switch__trigger", open && "is-open")} data-tour="workspace-switcher"
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "ws-switch-menu" : undefined}
        aria-label={`Workspace: ${label}${isSample ? " (example)" : ""}. Switch workspace`} data-tip={`${label}${isSample ? " (example)" : ""}`} data-hint="Switch workspace"
        disabled={busy} onClick={() => {
          const r = triggerRef.current?.getBoundingClientRect();
          if (r) setAt({ top: r.bottom + 4, left: r.left });
          setOpen((o) => !o);
        }}
      >
        <Avatar name={label} size="sm" />
        <span className="ws-switch__text">
          <span className="ws-switch__name">{label}</span>
          {isSample ? <span className="ws-switch__sub"><span className="ws-switch__tag">Example</span></span>
            : current && current.name.trim() ? <span className="ws-switch__sub">{current.place}</span> : null}
        </span>
        <Icon icon={Icons.expand} size="sm" className="ws-switch__chevron" />
      </button>

      {open ? (
        <div ref={menuRef} id="ws-switch-menu" role="menu" aria-label="Workspaces" className="ws-switch__menu" onKeyDown={onMenuKey}
          style={at ? { top: at.top, left: at.left } : undefined}>
          {canList && rows.length ? (
            <div role="group" aria-label="Workspaces on this computer" className="ws-switch__group">
              <div className="ws-switch__heading" aria-hidden="true">Workspaces on this computer</div>
              {rows.map((r) => (
                <div
                  key={r.key} role="menuitemradio" aria-checked={r.current} aria-disabled={!r.available || undefined} tabIndex={-1}
                  className={cx("ws-switch__item", r.current && "is-current", !r.available && "is-missing")}
                  onClick={() => switchTo(r)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchTo(r); } }}
                >
                  <Avatar name={workspaceLabel(r)} size="sm" />
                  <span className="ws-switch__item-text">
                    <span className="ws-switch__item-name">
                      {workspaceLabel(r)}{r.isSample ? <> <span className="ws-switch__tag">Example</span></> : null}
                    </span>
                    <span className="ws-switch__item-folder" title={workspaceDetail(r)}>{workspaceDetail(r, true)}</span>
                  </span>
                  {r.current ? <Icon icon={Icons.check} size="sm" className="ws-switch__check" label="Open now" /> : null}
                </div>
              ))}
            </div>
          ) : null}
          <div role="separator" className="ws-switch__sep" />
          {canList ? (
            <div role="menuitem" tabIndex={-1} className="ws-switch__item ws-switch__action" onClick={startNew} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startNew(); } }}>
              <Icon icon={Icons.add} size="sm" /><span>New workspace</span>
            </div>
          ) : null}
          <div role="menuitem" tabIndex={-1} className="ws-switch__item ws-switch__action" onClick={openAnother} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAnother(); } }}>
            <Icon icon={Icons.folder} size="sm" /><span>Open…</span>
          </div>
          {hasExample(bridge) ? (
            <div role="menuitem" tabIndex={-1} className="ws-switch__item ws-switch__action" onClick={explore} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); explore(); } }}>
              <Icon icon={Icons.guide} size="sm" /><span>{isSample ? "Restart example" : "Example"}</span>
            </div>
          ) : null}
          {canList && rows.length ? (
            <div role="menuitem" tabIndex={-1} className="ws-switch__item ws-switch__action" onClick={() => { close(false); setRemoving(true); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); close(false); setRemoving(true); } }}>
              <Icon icon={Icons.close} size="sm" /><span>Remove…</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog open={!!confirm} onClose={() => setConfirm(null)} title="Stop the running task?"
        actions={<>
          <Button variant="ghost" onClick={() => setConfirm(null)}>Keep working</Button>
          <Button variant="danger" loading={busy} onClick={() => { const go = confirm; setConfirm(null); if (go) void perform(go); }}>Stop &amp; switch</Button>
        </>}>
        <Text role="body">A task is still running in {label}. Stop it and switch?</Text>
      </Dialog>

      <ManageWorkspaces open={removing} onClose={() => setRemoving(false)} rows={rows} onChanged={() => list.reload()} />
    </div>
  );
}
