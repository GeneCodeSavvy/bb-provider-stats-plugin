import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const accountHostContract = defineRpcContract({
  currentAuthStatus: { input: z.object({}).strict(), output: z.object({ present: z.boolean(), activeProfile: z.enum(["personal", "work"]).nullable() }).strict() },
  saveCurrent: { input: z.object({ id: z.string().regex(/^[a-f0-9-]{8}$/) }).strict(), output: z.object({ saved: z.boolean() }).strict() },
  activate: { input: z.object({ id: z.string().regex(/^(personal|work|[a-f0-9-]{8})$/) }).strict(), output: z.object({ activated: z.boolean() }).strict() },
  remove: { input: z.object({ id: z.string().regex(/^[a-f0-9-]{8}$/) }).strict(), output: z.object({ removed: z.boolean() }).strict() },
});
