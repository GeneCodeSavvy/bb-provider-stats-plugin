import { access, copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { accountHostContract } from "./host-contract.js";

const authPath = () => join(homedir(), ".codex", "auth.json");
const slotPath = (dataDir: string, id: string) => join(dataDir, "accounts", id, "auth.json");
const configuredProfilePath = (id: "personal" | "work") => join(homedir(), `.codex-${id}`, "auth.json");
async function exists(path: string) { try { await access(path, constants.R_OK); return true; } catch { return false; } }


export default experimental_defineHostEntry({
  contract: accountHostContract,
  handlers: {
    currentAuthStatus: async () => {
      if (!(await exists(authPath()))) return { present: false, activeProfile: null };
      const current = await readFile(authPath());
      for (const id of ["personal", "work"] as const) {
        const profile = configuredProfilePath(id);
        if ((await exists(profile)) && current.equals(await readFile(profile))) return { present: true, activeProfile: id };
      }
      return { present: true, activeProfile: null };
    },
    saveCurrent: async ({ id }, context) => {
      if (!(await exists(authPath()))) throw new Error("No Codex login was found at ~/.codex/auth.json.");
      const target = slotPath(context.experimental_paths.dataDir, id);
      await mkdir(join(context.experimental_paths.dataDir, "accounts", id), { recursive: true, mode: 0o700 });
      await copyFile(authPath(), target);
      return { saved: true };
    },
    activate: async ({ id }, context) => {
      const source = id === "personal" || id === "work" ? configuredProfilePath(id) : slotPath(context.experimental_paths.dataDir, id);
      if (!(await exists(source))) throw new Error("The saved credential for this account slot is missing.");
      const target = authPath();
      await mkdir(join(homedir(), ".codex"), { recursive: true, mode: 0o700 });
      const temporary = `${target}.bb-codex-capacity-new`;
      await copyFile(source, temporary);
      await rename(temporary, target);
      return { activated: true };
    },
    remove: async ({ id }, context) => {
      const directory = join(context.experimental_paths.dataDir, "accounts", id);
      if (!(await exists(directory))) return { removed: false };
      if (!(await stat(directory)).isDirectory()) throw new Error("Account slot path is invalid.");
      await rm(directory, { recursive: true, force: true });
      return { removed: true };
    },
  },
});
