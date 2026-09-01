import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { accountHostContract } from "./host-contract.js";

const accountSchema = z.object({ id: z.string(), label: z.string(), savedAt: z.string(), active: z.boolean() });
const usageSchema = z.object({ status: z.string(), planLabel: z.string().nullable(), message: z.string().nullable(), windows: z.array(z.object({ label: z.string(), usedPercent: z.number(), resetsAt: z.string().nullable() })) });
export type Account = z.infer<typeof accountSchema>;
export type Usage = z.infer<typeof usageSchema>;
export const rpcContract = defineRpcContract({
  accounts_list: { input: z.null(), output: z.object({ accounts: z.array(accountSchema), currentAuthPresent: z.boolean() }) },
  accounts_save_current: { input: z.object({ label: z.string().trim().min(1).max(80) }), output: accountSchema },
  accounts_activate: { input: z.object({ id: z.string() }), output: accountSchema },
  accounts_remove: { input: z.object({ id: z.string() }), output: z.object({ removed: z.boolean() }) },
  usage_get: { input: z.null(), output: usageSchema },
});
const ACCOUNTS_CHANGED = "accounts-changed";

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: accountHostContract });
  const readAccounts = async (): Promise<Account[]> => (await bb.storage.kv.get<Account[]>("accounts")) ?? [];
  const publish = async (accounts: Account[]) => { await bb.storage.kv.set("accounts", accounts); bb.realtime.publish(ACCOUNTS_CHANGED, { count: accounts.length }); };
  const localHostId = async () => {
    const candidate = (await bb.sdk.hosts.list()).find((item) => item.status === "connected");
    if (candidate === undefined) throw new Error("No connected BB machine is available for Codex.");
    return candidate.id;
  };
  bb.rpc.register(rpcContract, {
    accounts_list: async () => {
      const current = await host.call("currentAuthStatus", {}, { hostId: await localHostId() });
      const configured: Account[] = [
        { id: "personal", label: "codex-personal", savedAt: "", active: current.activeProfile === "personal" },
        { id: "work", label: "codex-work", savedAt: "", active: current.activeProfile === "work" },
      ];
      return { accounts: [...configured, ...(await readAccounts())], currentAuthPresent: current.present };
    },
    accounts_save_current: async ({ label }) => {
      const id = randomUUID().slice(0, 8); await host.call("saveCurrent", { id }, { hostId: await localHostId() });
      const account = { id, label, savedAt: new Date().toISOString(), active: true };
      await publish([...(await readAccounts()).map((item) => ({ ...item, active: false })), account]); return account;
    },
    accounts_activate: async ({ id }) => {
      const accounts = await readAccounts(); if (!["personal", "work"].includes(id) && !accounts.some((item) => item.id === id)) throw new Error("Account slot was not found.");
      await host.call("activate", { id }, { hostId: await localHostId() });
      if (id === "personal" || id === "work") return { id, label: `codex-${id}`, savedAt: "", active: true };
      const updated = accounts.map((item) => ({ ...item, active: item.id === id })); await publish(updated); return updated.find((item) => item.id === id)!;
    },
    accounts_remove: async ({ id }) => { const accounts = await readAccounts(); if (!accounts.some((item) => item.id === id)) return { removed: false }; await host.call("remove", { id }, { hostId: await localHostId() }); await publish(accounts.filter((item) => item.id !== id)); return { removed: true }; },
    usage_get: async () => {
      const codex = (await bb.sdk.system.usageLimits({ hostId: await localHostId() })).codex;
      if (codex?.status !== "ok") return { status: codex?.status ?? "error", planLabel: null, message: codex?.status === "error" ? codex.message : "Codex usage is unavailable.", windows: [] };
      return { status: "ok", planLabel: codex.planLabel, message: null, windows: codex.windows };
    },
  });
}
