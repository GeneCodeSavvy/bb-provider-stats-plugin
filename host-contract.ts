import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const providerIdSchema = z.enum(["codex", "claude", "grok"]);

const legacyProfileSchema = z.object({
  id: z.enum(["legacy-personal", "legacy-work"]),
  label: z.string(),
}).strict();

const usageWindowSchema = z.object({
  label: z.string(),
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
}).strict();

export const accountHostContract = defineRpcContract({
  providerState: {
    input: z.object({ provider: providerIdSchema }).strict(),
    output: z.object({
      present: z.boolean(),
      activeSlotId: z.string().nullable(),
      legacyProfiles: z.array(legacyProfileSchema),
    }).strict(),
  },
  saveCurrent: {
    input: z.object({ provider: providerIdSchema, id: z.string().regex(/^[a-f0-9-]{8}$/) }).strict(),
    output: z.object({ saved: z.boolean() }).strict(),
  },
  activate: {
    input: z.object({ provider: providerIdSchema, id: z.string().regex(/^(legacy-personal|legacy-work|[a-f0-9-]{8})$/) }).strict(),
    output: z.object({ activated: z.boolean() }).strict(),
  },
  remove: {
    input: z.object({ provider: providerIdSchema, id: z.string().regex(/^[a-f0-9-]{8}$/) }).strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  grokUsage: {
    input: z.object({}).strict(),
    output: z.object({
      status: z.enum(["ok", "error", "unconfigured"]),
      planLabel: z.string().nullable(),
      message: z.string().nullable(),
      windows: z.array(usageWindowSchema),
    }).strict(),
  },
});
