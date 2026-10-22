/**
 * Routines REAL integration test (split-readiness).
 *
 * This test lives in the routines package — not in core — so the core repository
 * never reaches into this sibling. It imports the published core surface
 * (`createCore`, the in-memory repositories) from `@voidrift/core`, its declared
 * peer/dev dependency, and loads THIS package by its own path. The core plugin
 * loader reads this package's `package.json` (`main: ./dist/index.js`), so the
 * built `dist` must exist (root `npm run build` produces it before `npm test`).
 *
 * It asserts the same behavior the core self-contained fixture proves, but end to
 * end against the real plugin: a routine saved via the `routine` command, then run
 * via `session.command("routine", id)`, starts a NEW session whose first prompt is
 * the saved one; and the loaded plugin's id is `@voidrift/plugin-routines`.
 *
 * Deterministic and offline: `fakeModel()` drives the engine, in-memory session
 * and config stores, a per-test temp workspace.
 */
import { hermeticTmp } from "./test-hermetic.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fakeModel } from "@langchain/core/testing";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { createCore, InMemorySessionRepository, InMemoryConfigStore } from "@voidrift/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This package's root (src/.. ) — the loader reads its package.json main.
const selfPath = path.resolve(__dirname, "..");

const seed = {
  models: { test: { model: "test-model", protocol: "openai", contextLimit: 32_000 } },
  modelSelected: "test",
};

describe("@voidrift/plugin-routines — real integration against @voidrift/core", () => {
  let ws: string;
  const cores: { session: { shutdown: () => Promise<void> } }[] = [];

  beforeEach(async () => {
    ws = hermeticTmp("routines-it");
    await fs.mkdir(path.join(ws, ".voidrift"), { recursive: true });
    cores.length = 0;
  });
  afterEach(async () => {
    for (const c of cores) await c.session.shutdown().catch(() => undefined);
    await fs.rm(ws, { recursive: true, force: true });
  });

  it("saves then runs a routine in a NEW session with the saved first prompt; plugin id is @voidrift/plugin-routines", async () => {
    // Given — a core loading THIS plugin by its own package path.
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
    const { api } = ready;

    // Then — the plugin is loaded under its package-name id (§12.4).
    const plugins = await api.plugins.list();
    expect(plugins.ok).toBe(true);
    if (plugins.ok) {
      const self = plugins.value.find((p) => p.id === "@voidrift/plugin-routines");
      expect(self).toBeDefined();
      expect(self!.active).toBe(true);
    }

    // And — the real plugin registered the `routine` command.
    const cmds = await api.session.listCommands();
    expect(cmds.ok && cmds.value).toContain("routine");

    // When — a routine is saved then run by bare id.
    await api.session.command("routine", { save: { id: "daily", prompt: "do the daily report" } });
    const before = (await api.session.list()).length;
    const run = await api.session.command("routine", "daily");

    // Then — a NEW session started and completed.
    expect(run.ok).toBe(true);
    if (run.ok) expect((run.value as { status: string }).status).toBe("completed");
    const after = (await api.session.list()).length;
    expect(after).toBe(before + 1);

    // And — that new session's first prompt is the saved one. The routine names
    // its session `routine:<id>`, so select by name rather than list order.
    const sessions = await api.session.list();
    const newest = sessions.find((s) => s.name === "routine:daily") ?? sessions[sessions.length - 1]!;
    const detail = await api.session.loadMessages(newest.id);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      const firstUser = detail.value.find((m) => m.role === "human");
      expect(firstUser?.content).toContain("do the daily report");
    }
  });
});
