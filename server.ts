import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accountHostContract, providerIdSchema } from "./host-contract.js";

const switchableProviderIds = ["codex", "claude", "grok"] as const;
const usageOnlyProviderIds = ["opencode-go", "openrouter"] as const;
export type SwitchableProviderId = (typeof switchableProviderIds)[number];
export type ProviderId = SwitchableProviderId | (typeof usageOnlyProviderIds)[number];

const windowSchema = z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable() });
const usageSchema = z.object({
  status: z.enum(["ok", "error", "unconfigured"]),
  planLabel: z.string().nullable(),
  message: z.string().nullable(),
  windows: z.array(windowSchema),
});
const accountSchema = z.object({
  id: z.string(), provider: providerIdSchema, label: z.string(), savedAt: z.string(), active: z.boolean(), managed: z.boolean(),
});
const providerSchema = z.object({
  id: z.enum([...switchableProviderIds, ...usageOnlyProviderIds]),
  label: z.string(),
  switchable: z.boolean(),
  currentCredentialPresent: z.boolean(),
  accounts: z.array(accountSchema),
  usage: usageSchema,
});
const dashboardSchema = z.object({ fetchedAt: z.string(), providers: z.array(providerSchema) });

export type Account = z.infer<typeof accountSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type ProviderView = z.infer<typeof providerSchema>;
export type Dashboard = z.infer<typeof dashboardSchema>;

export const rpcContract = defineRpcContract({
  dashboard_get: { input: z.null(), output: dashboardSchema },
  accounts_save_current: { input: z.object({ provider: providerIdSchema, label: z.string().trim().min(1).max(80) }), output: accountSchema },
  accounts_activate: { input: z.object({ provider: providerIdSchema, id: z.string() }), output: accountSchema },
  accounts_remove: { input: z.object({ provider: providerIdSchema, id: z.string() }), output: z.object({ removed: z.boolean() }) },
});

const ACCOUNTS_CHANGED = "provider-accounts-changed";
const ACCOUNT_KEY = "provider-accounts-v2";
const providerLabels: Record<ProviderId, string> = {
  codex: "Codex",
  claude: "Claude Code",
  grok: "Grok Build",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
};

async function readBbEnv(name: string) {
  try {
    const raw = await readFile(join(homedir(), ".bb", "env.json"), "utf8");
    const value = (JSON.parse(raw)?.env ?? {})[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  } catch {}
  return process.env[name]?.trim() ?? "";
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { headers: { "User-Agent": "bb-provider-stats/0.2", ...headers }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as any;
  } finally { clearTimeout(timer); }
}

function unavailable(message: string, status: Usage["status"] = "error"): Usage {
  return { status, planLabel: null, message, windows: [] };
}

async function extraUsage(provider: "opencode-go" | "openrouter"): Promise<Usage> {
  if (provider === "opencode-go") {
    const key = await readBbEnv("OPENCODE_API_KEY");
    if (!key) return unavailable("Set OPENCODE_API_KEY in BB's environment to show Go usage.", "unconfigured");
    try {
      const data = await fetchJson("https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${key}` });
      const usage = data?.usage ?? {};
      const names: Record<string, string> = { rolling: "Rolling (5h)", weekly: "Weekly", monthly: "Monthly" };
      const windows = ["rolling", "weekly", "monthly"].filter((key) => usage[key]).map((key) => ({
        label: names[key], usedPercent: Number(usage[key].percent ?? 0), resetsAt: usage[key].resetsAt ?? null,
      }));
      return { status: "ok", planLabel: "Go", message: null, windows };
    } catch (cause) { return unavailable(cause instanceof Error ? cause.message : String(cause)); }
  }

  const key = await readBbEnv("OPENROUTER_API_KEY");
  if (!key) return unavailable("Set OPENROUTER_API_KEY in BB's environment to show credit usage.", "unconfigured");
  try {
    const data = await fetchJson("https://openrouter.ai/api/v1/credits", { Authorization: `Bearer ${key}` });
    const total = Number(data?.data?.total_credits ?? 0);
    const used = Number(data?.data?.total_usage ?? 0);
    const left = Math.max(0, total - used);
    return {
      status: "ok", planLabel: "pay-as-you-go", message: `$${left.toFixed(2)} of $${total.toFixed(2)} left`,
      windows: [{ label: "Balance consumed", usedPercent: total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : 0, resetsAt: null }],
    };
  } catch (cause) { return unavailable(cause instanceof Error ? cause.message : String(cause)); }
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: accountHostContract });
  const localHostId = async () => {
    const candidate = (await bb.sdk.hosts.list()).find((item) => item.status === "connected");
    if (!candidate) throw new Error("No connected BB machine is available for provider credentials.");
    return candidate.id;
  };

  const readAccounts = async (): Promise<Account[]> => {
    const current = await bb.storage.kv.get<Account[]>(ACCOUNT_KEY);
    if (current) return current;
    const legacy = (await bb.storage.kv.get<Array<{ id: string; label: string; savedAt: string; active: boolean }>>("accounts")) ?? [];
    if (!legacy.length) return [];
    const migrated = legacy.map((item) => ({ ...item, provider: "codex" as const, active: false, managed: true }));
    await bb.storage.kv.set(ACCOUNT_KEY, migrated);
    return migrated;
  };
  const publish = async (accounts: Account[]) => {
    await bb.storage.kv.set(ACCOUNT_KEY, accounts);
    bb.realtime.publish(ACCOUNTS_CHANGED, { count: accounts.length });
  };

  async function usageFor(provider: SwitchableProviderId, hostId: string): Promise<Usage> {
    if (provider === "grok") return host.call("grokUsage", {}, { hostId });
    try {
      const limits = await bb.sdk.system.usageLimits({ hostId }) as Record<string, any>;
      const native = limits[provider === "codex" ? "codex" : "claudeCode"];
      if (!native || native.status === "not_installed") return unavailable(`${providerLabels[provider]} is not installed.`, "unconfigured");
      if (native.status !== "ok") return unavailable(native.message ?? `${providerLabels[provider]} usage is unavailable.`);
      return { status: "ok", planLabel: native.planLabel ?? null, message: null, windows: native.windows ?? [] };
    } catch (cause) { return unavailable(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function dashboard(): Promise<Dashboard> {
    const hostId = await localHostId();
    const stored = await readAccounts();
    const states = await Promise.all(switchableProviderIds.map(async (provider) => ({
      provider,
      state: await host.call("providerState", { provider }, { hostId }),
    })));
    const accountViews = new Map<SwitchableProviderId, Account[]>();
    for (const provider of switchableProviderIds) accountViews.set(provider, []);
    for (const { provider, state } of states) {
      const own = stored.filter((item) => item.provider === provider).map((item) => ({ ...item, active: state.activeSlotId === item.id }));
      if (provider === "codex") {
        for (const profile of state.legacyProfiles) own.unshift({
          id: profile.id, provider: "codex", label: profile.label, savedAt: "", active: state.activeSlotId === profile.id, managed: false,
        });
      }
      accountViews.set(provider, own);
    }
    const [codex, claude, grok, openCode, openRouter] = await Promise.all([
      usageFor("codex", hostId), usageFor("claude", hostId), usageFor("grok", hostId), extraUsage("opencode-go"), extraUsage("openrouter"),
    ]);
    const usageMap: Record<ProviderId, Usage> = { codex, claude, grok, "opencode-go": openCode, openrouter: openRouter };
    const stateMap = Object.fromEntries(states.map(({ provider, state }) => [provider, state])) as Record<SwitchableProviderId, (typeof states)[number]["state"]>;
    return {
      fetchedAt: new Date().toISOString(),
      providers: [...switchableProviderIds, ...usageOnlyProviderIds].map((id) => ({
        id, label: providerLabels[id], switchable: switchableProviderIds.includes(id as SwitchableProviderId),
        currentCredentialPresent: id in stateMap ? stateMap[id as SwitchableProviderId].present : false,
        accounts: id in stateMap ? accountViews.get(id as SwitchableProviderId) ?? [] : [], usage: usageMap[id],
      })),
    };
  }

  bb.rpc.register(rpcContract, {
    dashboard_get: async () => dashboard(),
    accounts_save_current: async ({ provider, label }) => {
      const hostId = await localHostId();
      const id = randomUUID().slice(0, 8);
      await host.call("saveCurrent", { provider, id }, { hostId });
      const account: Account = { id, provider, label, savedAt: new Date().toISOString(), active: true, managed: true };
      const accounts = (await readAccounts()).map((item) => item.provider === provider ? { ...item, active: false } : item);
      await publish([...accounts, account]);
      return account;
    },
    accounts_activate: async ({ provider, id }) => {
      const hostId = await localHostId();
      const accounts = await readAccounts();
      const stored = accounts.find((item) => item.provider === provider && item.id === id);
      const legacy = provider === "codex" && (id === "legacy-personal" || id === "legacy-work");
      if (!stored && !legacy) throw new Error("Account slot was not found.");
      await host.call("activate", { provider, id }, { hostId });
      if (legacy) return { id, provider, label: id === "legacy-personal" ? "codex-personal" : "codex-work", savedAt: "", active: true, managed: false };
      const updated = accounts.map((item) => item.provider === provider ? { ...item, active: item.id === id } : item);
      await publish(updated);
      return updated.find((item) => item.provider === provider && item.id === id)!;
    },
    accounts_remove: async ({ provider, id }) => {
      const accounts = await readAccounts();
      if (!accounts.some((item) => item.provider === provider && item.id === id)) return { removed: false };
      await host.call("remove", { provider, id }, { hostId: await localHostId() });
      await publish(accounts.filter((item) => !(item.provider === provider && item.id === id)));
      return { removed: true };
    },
  });
}
