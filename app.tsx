import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Dashboard, ProviderView, SwitchableProviderId, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import "./switcher.css";

function resetLabel(value: string | null) {
  if (!value) return "No reset time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `Resets ${new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(date)}`;
}

function UsageWindows({ provider }: { provider: ProviderView }) {
  if (provider.usage.status !== "ok") return <p className="text-xs text-muted-foreground">{provider.usage.message ?? "Usage unavailable."}</p>;
  if (!provider.usage.windows.length) return <p className="text-xs text-muted-foreground">No quota windows reported.</p>;
  return <div className="capacity-grid">{provider.usage.windows.map((window) => <div key={`${window.label}-${window.resetsAt}`} className="capacity-cell">
    <div className="capacity-heading"><span>{window.label}</span><strong>{window.usedPercent.toFixed(0)}%</strong></div>
    <span className="capacity-rail"><span style={{ width: `${Math.max(0, Math.min(100, window.usedPercent))}%` }}/></span>
    <span className="capacity-reset">{resetLabel(window.resetsAt)}</span>
  </div>)}</div>;
}

function ProviderCard({ provider, busy, run }: { provider: ProviderView; busy: string | null; run: (key: string, action: () => Promise<unknown>) => Promise<void> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [label, setLabel] = useState("");
  const active = provider.accounts.find((account) => account.active);
  return <section className="provider-card">
    <div className="provider-title"><div><h3>{provider.label}</h3><p>{provider.usage.planLabel ?? (provider.switchable ? "Account login" : "Usage lane")}</p></div><span className={`provider-status provider-status-${provider.usage.status}`}>{provider.usage.status}</span></div>
    <UsageWindows provider={provider}/>
    {provider.switchable && <div className="provider-accounts">
      <div className="provider-account-summary"><span>{active ? `Active: ${active.label}` : "Current login is not saved"}</span><span>{provider.currentCredentialPresent ? "credential detected" : "no credential file"}</span></div>
      <div className="provider-account-list">{provider.accounts.map((account) => <div key={account.id} className="provider-account-row">
        <div className="provider-account-name"><Icon name={account.active ? "CircleCheck" : "Circle"} className={account.active ? "size-4 text-emerald-600" : "size-4 text-muted-foreground"}/><span>{account.label}</span>{!account.managed && <em>legacy</em>}</div>
        <Button size="sm" variant={account.active ? "secondary" : "default"} disabled={account.active || busy !== null} onClick={() => run(`${provider.id}:${account.id}`, () => rpc.call("accounts_activate", { provider: provider.id as SwitchableProviderId, id: account.id }))}>{busy === `${provider.id}:${account.id}` ? "Switching…" : account.active ? "Active" : "Switch"}</Button>
        {account.managed && <Button size="icon" variant="ghost" disabled={busy !== null} onClick={() => run(`remove:${provider.id}:${account.id}`, () => rpc.call("accounts_remove", { provider: provider.id as SwitchableProviderId, id: account.id }))} aria-label={`Remove ${account.label}`}><Icon name="Trash2" className="size-4"/></Button>}
      </div>)}</div>
      <div className="provider-save-row"><Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Save current login as…" disabled={!provider.currentCredentialPresent || busy !== null}/><Button disabled={!provider.currentCredentialPresent || !label.trim() || busy !== null} onClick={() => run(`save:${provider.id}`, async () => { await rpc.call("accounts_save_current", { provider: provider.id as SwitchableProviderId, label: label.trim() }); setLabel(""); })}>{busy === `save:${provider.id}` ? "Saving…" : "Save"}</Button></div>
      {provider.id === "claude" && !provider.currentCredentialPresent && <p className="provider-note">Claude usage can still come from BB/Keychain, but switching needs Claude Code's <code>~/.claude/.credentials.json</code> file.</p>}
    </div>}
  </section>;
}

function ProviderPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => { rpc.call("dashboard_get").then((value) => { setDashboard(value); setError(null); }, (cause) => setError(cause instanceof Error ? cause.message : String(cause))); }, [rpc]);
  useEffect(() => { refresh(); }, [refresh]);
  useRealtime("provider-accounts-changed", refresh);
  const run = async (key: string, action: () => Promise<unknown>) => { setBusy(key); try { await action(); refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(null); } };
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-4xl space-y-5 p-4 md:p-5">
    <div className="provider-page-heading"><div><h2 className="text-lg font-semibold">Provider accounts & usage</h2><p className="mt-1 text-sm text-muted-foreground">Switch local logins for Codex, Claude Code, and Grok; see quota headroom across native and API-key providers.</p></div><Button variant="outline" size="sm" onClick={refresh} disabled={busy !== null}>Refresh</Button></div>
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"><strong>Switching changes future sessions only.</strong> Existing agent threads keep their current provider session. Credentials stay local on the connected BB host.</div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {!dashboard ? <p className="text-sm text-muted-foreground">Loading providers…</p> : <div className="provider-stack">{dashboard.providers.map((provider) => <ProviderCard key={provider.id} provider={provider} busy={busy} run={run}/>)}</div>}
  </div></div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "provider-accounts", title: "Provider usage", icon: "Users", path: "providers", component: ProviderPage });
  app.slots.settingsSection({ id: "provider-accounts", title: "Provider accounts & usage", component: ProviderPage });
  app.slots.sidebarFooterAction({ id: "provider-accounts", title: "Provider accounts & usage", icon: "Users", run: ({ openSettings }) => openSettings() });
});
