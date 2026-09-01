import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Account, Usage, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import "./switcher.css";

function useAccounts() {
  const rpc = useRpc<typeof rpcContract>(); const [accounts, setAccounts] = useState<Account[] | null>(null); const [currentAuthPresent, setCurrentAuthPresent] = useState(false); const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => { rpc.call("accounts_list").then(({ accounts, currentAuthPresent }) => { setAccounts(accounts); setCurrentAuthPresent(currentAuthPresent); setError(null); }, (cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [rpc]);
  useEffect(() => { refresh(); }, [refresh]); useRealtime("accounts-changed", refresh); return { rpc, accounts, currentAuthPresent, error, refresh };
}

function CapacityPage() {
  const { rpc, accounts, currentAuthPresent, error, refresh } = useAccounts(); const [label, setLabel] = useState(""); const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<unknown>) => { setBusy(key); try { await action(); refresh(); } finally { setBusy(null); } };
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-2xl space-y-5 p-4 md:p-5">
    <div><h2 className="text-lg font-semibold">Codex switcher</h2><p className="mt-1 text-sm text-muted-foreground">Save signed-in accounts as local slots, then select the login for new Codex sessions.</p></div>
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><strong>Switch safely.</strong> Existing sessions are unchanged. Start a new Codex thread after switching; account limits remain separate.</div>
    <div className="rounded-lg border p-4"><p className="text-sm font-medium">Save another login</p><p className="mt-1 text-sm text-muted-foreground">{currentAuthPresent ? "A Codex login was found on this machine." : "No Codex login found. Run codex login first."}</p><div className="mt-3 flex gap-2"><Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Temporary account" disabled={!currentAuthPresent || busy !== null} /><Button onClick={() => run("save", async () => { await rpc.call("accounts_save_current", { label: label.trim() }); setLabel(""); })} disabled={!currentAuthPresent || !label.trim() || busy !== null}>{busy === "save" ? "Saving…" : "Save account"}</Button></div></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="space-y-2">{accounts === null ? <p className="text-sm text-muted-foreground">Loading accounts…</p> : accounts.map((account) => <div key={account.id} className="flex items-center gap-3 rounded-lg border p-3"><Icon name={account.active ? "CircleCheck" : "Circle"} className={account.active ? "size-5 text-emerald-600" : "size-5 text-muted-foreground"}/><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{account.label}</p><p className="text-xs text-muted-foreground">{account.active ? "Active login" : account.id === "personal" || account.id === "work" ? "Configured Codex profile" : `Saved ${new Date(account.savedAt).toLocaleDateString()}`}</p></div><Button size="sm" variant={account.active ? "secondary" : "default"} disabled={account.active || busy !== null} onClick={() => run(account.id, () => rpc.call("accounts_activate", { id: account.id }))}>{busy === account.id ? "Switching…" : account.active ? "Active" : "Switch"}</Button>{account.id !== "personal" && account.id !== "work" && <Button size="icon" variant="ghost" disabled={busy !== null} onClick={() => run(account.id, () => rpc.call("accounts_remove", { id: account.id }))} aria-label={`Remove ${account.label}`}><Icon name="Trash2" className="size-4"/></Button>}</div>)}</div>
  </div></div>;
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "footer-account-picker",
    mount({ signal }) {
      const label = "Switch Codex account";
      const endpoint = "/api/v1/plugins/codex-capacity/rpc/";
      let menu: HTMLDivElement | null = null;
      let trigger: HTMLElement | null = null;

      const close = () => { menu?.remove(); menu = null; trigger = null; };
      const call = async <T,>(method: string, input: unknown): Promise<T> => {
        const response = await fetch(`${endpoint}${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
        const body = await response.json() as { ok: boolean; result?: T; error?: { message?: string } };
        if (!body.ok || body.result === undefined) throw new Error(body.error?.message ?? "Account switch failed.");
        return body.result;
      };
      const show = async (button: HTMLElement) => {
        close(); trigger = button;
        const box = document.createElement("div"); menu = box;
        box.setAttribute("role", "menu"); box.setAttribute("aria-label", "Codex switcher");
        box.className = "capacity-switcher"; box.style.cssText = "position:fixed;z-index:9999";
        document.body.append(box);
        const rect = button.getBoundingClientRect();
        const footer = button.closest<HTMLElement>("[data-sidebar=footer]")?.getBoundingClientRect();
        box.style.left = `${Math.max(8, footer?.left ?? rect.left)}px`; box.style.width = `${Math.min(window.innerWidth - 16, Math.max(0, (footer?.width ?? 320) - 16) * 1.35)}px`; box.style.bottom = `${window.innerHeight - rect.top + 8}px`;
        try {
          const [{ accounts }, usage] = await Promise.all([call<{ accounts: Account[] }>("accounts_list", null), call<Usage>("usage_get", null)]);
          if (menu !== box) return;
          const card = document.createElement("div"); card.className = "capacity-card";
          const title = document.createElement("div"); title.className = "capacity-header"; title.innerHTML = "<strong>Codex</strong><span>Subscription usage</span>"; card.append(title);
          const windows = document.createElement("div"); windows.className = "capacity-grid";
          for (const window of usage.windows.slice(0, 2)) { const item = document.createElement("div"); item.className = "capacity-cell"; const reset = window.resetsAt === null ? "Reset unavailable" : `Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(window.resetsAt))}`; item.innerHTML = `<div class="capacity-heading"><span>${window.label}</span><strong>${window.usedPercent.toFixed(0)}%</strong></div><span class="capacity-rail"><span style="width:${Math.max(0, Math.min(100, window.usedPercent))}%"></span></span><span class="capacity-reset">${reset}</span>`; windows.append(item); }
          if (usage.windows.length === 0) { const message = document.createElement("p"); message.className = "capacity-message"; message.textContent = usage.message ?? "No Codex limits reported."; windows.append(message); }
          card.append(windows); const chooser = document.createElement("div"); chooser.className = "capacity-grid capacity-accounts";
          for (const account of accounts) {
            const choice = document.createElement("button"); choice.type = "button"; choice.setAttribute("role", "menuitem"); choice.disabled = account.active;
            choice.className = "capacity-account capacity-cell";
            const heading = document.createElement("div"); heading.className = "capacity-heading";
            const name = document.createElement("span"); name.textContent = account.label;
            const state = document.createElement("strong"); state.textContent = account.active ? "Active" : "Switch";
            heading.append(name, state); choice.append(heading);
            choice.addEventListener("click", async () => { if (account.active) return; state.textContent = "Switching…"; choice.disabled = true; try { await call("accounts_activate", { id: account.id }); await call<Usage>("usage_get", null); close(); } catch (cause) { state.textContent = cause instanceof Error ? cause.message : "Failed"; choice.disabled = false; } });
            chooser.append(choice);
          }
          card.append(chooser); box.append(card);
        } catch (cause) { box.textContent = cause instanceof Error ? cause.message : "Could not load Codex switcher."; box.style.padding = "12px"; }
      };
      const onClick = (event: MouseEvent) => {
        const button = (event.target as Element | null)?.closest<HTMLElement>(`button[aria-label="${label}"], button[title="${label}"]`);
        if (button === null || button === undefined) return;
        event.preventDefault(); event.stopImmediatePropagation(); void show(button);
      };
      const onPointerDown = (event: PointerEvent) => { if (menu && !menu.contains(event.target as Node) && !trigger?.contains(event.target as Node)) close(); };
      const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
      document.addEventListener("click", onClick, true); document.addEventListener("pointerdown", onPointerDown, true); document.addEventListener("keydown", onKeyDown, true);
      signal.addEventListener("abort", close, { once: true });
      return () => { close(); document.removeEventListener("click", onClick, true); document.removeEventListener("pointerdown", onPointerDown, true); document.removeEventListener("keydown", onKeyDown, true); };
    },
  });
  app.slots.navPanel({ id: "codex-accounts", title: "Codex switcher", icon: "Users", path: "accounts", component: CapacityPage });
  app.slots.settingsSection({ id: "codex-accounts", title: "Codex switcher", component: CapacityPage });
  app.slots.sidebarFooterAction({ id: "codex-accounts", title: "Switch Codex account", icon: "Users", run: ({ openSettings }) => openSettings() });
});
