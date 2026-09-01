import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { accountHostContract, type providerIdSchema } from "./host-contract.js";
import type { z } from "zod";

type ProviderId = z.infer<typeof providerIdSchema>;

const providerAuthPath = (provider: ProviderId) => {
  if (provider === "codex") {
    const codexHome = process.env.CODEX_HOME?.trim();
    return join(codexHome || join(homedir(), ".codex"), "auth.json");
  }
  if (provider === "claude") return join(homedir(), ".claude", ".credentials.json");
  const grokHome = process.env.GROK_HOME?.trim();
  return join(grokHome || join(homedir(), ".grok"), "auth.json");
};

const slotPath = (dataDir: string, provider: ProviderId, id: string) =>
  join(dataDir, "accounts", provider, id, "credentials.json");

const legacyCodexPath = (id: "legacy-personal" | "legacy-work") =>
  join(homedir(), id === "legacy-personal" ? ".codex-personal" : ".codex-work", "auth.json");

async function exists(path: string) {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

async function sameFile(a: string, b: string) {
  if (!(await exists(a)) || !(await exists(b))) return false;
  const [left, right] = await Promise.all([readFile(a), readFile(b)]);
  return left.equals(right);
}

async function activeSlotId(dataDir: string, provider: ProviderId, currentPath: string) {
  if (!(await exists(currentPath))) return null;
  const root = join(dataDir, "accounts", provider);
  let ids: string[] = [];
  try { ids = await readdir(root); } catch { return null; }
  for (const id of ids) {
    if (await sameFile(currentPath, slotPath(dataDir, provider, id))) return id;
  }
  return null;
}

async function legacyProfiles(currentPath: string) {
  const profiles: Array<{ id: "legacy-personal" | "legacy-work"; label: string }> = [];
  for (const [id, label] of [["legacy-personal", "codex-personal"], ["legacy-work", "codex-work"]] as const) {
    if (await exists(legacyCodexPath(id))) profiles.push({ id, label });
  }
  if (profiles.length && await exists(currentPath)) {
    for (const profile of profiles) {
      if (await sameFile(currentPath, legacyCodexPath(profile.id))) return { profiles, active: profile.id };
    }
  }
  return { profiles, active: null as string | null };
}

async function replaceCredential(source: string, target: string) {
  if (!(await exists(source))) throw new Error("The saved credential for this account is missing.");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.bb-provider-stats-new`;
  await copyFile(source, temporary);
  await rename(temporary, target);
}

function titleWords(raw: string) {
  return raw.replace(/^SUBSCRIPTION_TIER_/, "").replace(/^TIER_/, "").toLowerCase()
    .split(/[_-]+/).filter(Boolean).map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ");
}

function collectGrokWindows(value: unknown, output: Array<{ label: string; usedPercent: number; resetsAt: string | null }>, seen = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const item of value) collectGrokWindows(item, output, seen);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const used = Number(object.usage ?? object.used ?? object.totalUsed);
  const limit = Number(object.limit ?? object.total ?? object.monthlyLimit);
  if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
    const labelRaw = String(object.label ?? object.name ?? object.type ?? "Tasks");
    const label = titleWords(labelRaw) || "Tasks";
    const resetsAt = typeof (object.resetTime ?? object.resetsAt ?? object.resetAt) === "string"
      ? String(object.resetTime ?? object.resetsAt ?? object.resetAt)
      : null;
    const key = `${label}:${used}:${limit}:${resetsAt ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ label, usedPercent: Math.max(0, Math.min(100, used / limit * 100)), resetsAt });
    }
  }
  for (const child of Object.values(object)) collectGrokWindows(child, output, seen);
}

async function grokUsage() {
  const path = providerAuthPath("grok");
  if (!(await exists(path))) return { status: "unconfigured" as const, planLabel: null, message: "Run 'grok login' first.", windows: [] };
  try {
    const doc = JSON.parse(await readFile(path, "utf8")) as Record<string, { key?: string; email?: string }>;
    const candidates = Object.entries(doc)
      .filter(([, entry]) => typeof entry?.key === "string" && entry.key.length > 0)
      .sort(([a], [b]) => Number(!a.includes("auth.x.ai")) - Number(!b.includes("auth.x.ai")));
    const token = candidates[0]?.[1]?.key;
    if (!token) return { status: "error" as const, planLabel: null, message: "No Grok token found in auth.json.", windows: [] };
    const headers = { Authorization: `Bearer ${token}`, "X-XAI-Token-Auth": "xai-grok-cli", Accept: "application/json", "User-Agent": "Grok Build" };
    const [subscriptionsResponse, usageResponse] = await Promise.all([
      fetch("https://grok.com/rest/subscriptions", { headers }),
      fetch("https://grok.com/rest/tasks/usage", { headers }),
    ]);
    if (!usageResponse.ok) throw new Error(`Grok usage request failed (HTTP ${usageResponse.status})`);
    const usage = await usageResponse.json();
    const windows: Array<{ label: string; usedPercent: number; resetsAt: string | null }> = [];
    collectGrokWindows(usage, windows);
    let planLabel: string | null = null;
    if (subscriptionsResponse.ok) {
      const subscriptions = await subscriptionsResponse.json() as { subscriptions?: Array<{ status?: string; tier?: string }> };
      const active = subscriptions.subscriptions?.find((item) => item.status?.toLowerCase() === "active");
      if (active?.tier) planLabel = titleWords(active.tier);
    }
    return { status: "ok" as const, planLabel, message: null, windows };
  } catch (cause) {
    return { status: "error" as const, planLabel: null, message: cause instanceof Error ? cause.message : String(cause), windows: [] };
  }
}

export default experimental_defineHostEntry({
  contract: accountHostContract,
  handlers: {
    providerState: async ({ provider }, context) => {
      const currentPath = providerAuthPath(provider);
      const slot = await activeSlotId(context.experimental_paths.dataDir, provider, currentPath);
      if (provider !== "codex") return { present: await exists(currentPath), activeSlotId: slot, legacyProfiles: [] };
      const legacy = await legacyProfiles(currentPath);
      return { present: await exists(currentPath), activeSlotId: slot ?? legacy.active, legacyProfiles: legacy.profiles };
    },
    saveCurrent: async ({ provider, id }, context) => {
      const source = providerAuthPath(provider);
      if (!(await exists(source))) throw new Error(`No ${provider} credential file was found on this machine.`);
      const target = slotPath(context.experimental_paths.dataDir, provider, id);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target);
      return { saved: true };
    },
    activate: async ({ provider, id }, context) => {
      const source = id === "legacy-personal" || id === "legacy-work"
        ? provider === "codex" ? legacyCodexPath(id) : ""
        : slotPath(context.experimental_paths.dataDir, provider, id);
      if (!source) throw new Error("Legacy profiles are only supported for Codex.");
      await replaceCredential(source, providerAuthPath(provider));
      return { activated: true };
    },
    remove: async ({ provider, id }, context) => {
      const directory = join(context.experimental_paths.dataDir, "accounts", provider, id);
      if (!(await exists(directory))) return { removed: false };
      if (!(await stat(directory)).isDirectory()) throw new Error("Account slot path is invalid.");
      await rm(directory, { recursive: true, force: true });
      return { removed: true };
    },
    grokUsage: async () => grokUsage(),
  },
});
