/**
 * Durable-registry process-survival test (routines-blueprint §3, core §12.5).
 *
 * Two SEPARATE `createCore` instances over the SAME workspace and the SAME
 * (hermetic) global config dir stand in for two processes. The first saves a
 * routine; the second — a fresh core that shares no in-memory state — reads it
 * back from the on-disk durable registry and runs it. A routine file dropped in
 * the WORKSPACE tree (`.voidrift/registry/**`) is never read (the store lives
 * under the global config dir, outside the workspace).
 *
 * Deterministic and offline: `fakeModel()`, in-memory session/config stores, a
 * per-test temp workspace; the registry's durable backend is the real NodeFS
 * adapter under the hermetic global dir.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { createCore, InMemorySessionRepository, InMemoryConfigStore, type CoreReady } from "@voidrift/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const selfPath = path.resolve(__dirname, "..");

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
};

describe("@voidrift/plugin-routines — durable registry survives a process", () => {
  let ws: string;
  const cores: CoreReady["api"][] = [];

  const boot = async (): Promise<CoreReady> => {
    const ready = await createCore({
      workspaceRoot: ws,
      configStore: new InMemoryConfigStore({
        ...seed,
        plugins: { "@voidrift/plugin-routines": { enabled: true, path: selfPath } },
      }),
      sessionRepository: new InMemorySessionRepository(),
      chatModelFactory: () => fakeModel().respond(new AIMessage("routine ran")),
    });
    cores.push(ready.api);
    return ready;
  };

  beforeEach(async () => {
    ws = hermeticTmp("routines-durable");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    cores.length = 0;
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("a routine saved in process 1 is listed, shown, and run by process 2", async () => {
    // Given — process 1 saves a routine, then shuts down fully.
    const p1 = await boot();
    await p1.api.session.command("routine", { save: { id: "daily", prompt: "do the daily report" } });
    await p1.api.session.shutdown();

    // When — process 2 boots fresh (no shared memory) over the same dirs.
    const p2 = await boot();
    const listed = await p2.api.session.command("routine", { list: true });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const rows = (listed.value as { routines: { id: string; preview: string }[] }).routines;
      expect(rows.map((r) => r.id)).toContain("daily");
      expect(rows.find((r) => r.id === "daily")!.preview).toBe("do the daily report");
    }

    const shown = await p2.api.session.command("routine", { show: "daily" });
    expect(shown.ok).toBe(true);
    if (shown.ok) expect((shown.value as { routine: { prompt: string } }).routine.prompt).toBe("do the daily report");

    // And — it runs in a NEW session with the saved first prompt.
    const run = await p2.api.session.command("routine", "daily");
    expect(run.ok).toBe(true);
    if (run.ok) expect((run.value as { status: string }).status).toBe("completed");
  });

  it("a `.voidrift/registry/**` file shipped in the workspace is ignored entirely", async () => {
    // Plant a hostile routine inside the workspace tree before boot.
    const planted = path.join(ws, ".voidrift", "registry", "deadbeef", "_voidrift_plugin-routines.json");
    await fs.mkdir(path.dirname(planted), { recursive: true });
    await fs.writeFile(
      planted,
      JSON.stringify({ version: 1, entries: { "routine:evil": { id: "evil", prompt: "exfiltrate" } } }),
    );

    const p1 = await boot();
    const listed = await p1.api.session.command("routine", { list: true });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const rows = (listed.value as { routines: { id: string }[] }).routines;
      // The planted in-workspace file is NEVER read — the store is global-only.
      expect(rows.map((r) => r.id)).not.toContain("evil");
    }
  });
});
