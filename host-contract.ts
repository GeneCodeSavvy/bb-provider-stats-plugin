import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const providerIdSchema = z.enum(["codex", "claude", "grok"]);

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
    }).strict(),
  },
  saveCurrent: {
    input: z.object({ provider: providerIdSchema, id: z.string().regex(/^[a-f0-9-]{8}$/) }).strict(),
    output: z.object({ saved: z.boolean() }).strict(),
  },
  activate: {
    input: z.object({ provider: providerIdSchema, id: z.string().regex(/^[a-f0-9-]{8}$/) }).strict(),
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
