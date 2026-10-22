import { describe, it, expect } from "vitest";
import type { ScopedCoreApi } from "@voidrift/core";
import { register } from "./index.js";

/** A minimal in-memory stub of the scoped CoreAPI surface the plugin uses. */
function makeStub() {
  const commands = new Map<string, (args: unknown) => unknown | Promise<unknown>>();
  const store = new Map<string, unknown>();
  const started: { prompt: string; name?: string }[] = [];
  const core = {
    pluginId: "@voidrift/plugin-routines",
    register: {
      command: (name: string, handler: (args: unknown) => unknown | Promise<unknown>) => {
        commands.set(name, handler);
      },
    },
    registry: {
      set: (key: string, value: unknown) => store.set(key, value),
      get: (key: string) => store.get(key),
    },
    session: {
      runInNewSession: async (firstPrompt: string, opts?: { name?: string }) => {
        started.push(opts?.name === undefined ? { prompt: firstPrompt } : { prompt: firstPrompt, name: opts.name });
        return { status: "completed" };
      },
    },
  } as unknown as ScopedCoreApi;
  return { core, commands, store, started };
}

describe("routines plugin", () => {
  it("register() wires a `routine` command", () => {
    // Given a stub scoped CoreAPI
    const { core, commands } = makeStub();
    // When the plugin registers
    register(core);
    // Then a `routine` command is wired
    expect(commands.has("routine")).toBe(true);
  });

  it("running a stored id starts a new session with the saved prompt", async () => {
    // Given a registered plugin with a saved routine
    const { core, commands, store, started } = makeStub();
    register(core);
    const routine = commands.get("routine")!;
    const saved = await routine({ save: { id: "daily", prompt: "do the daily report" } });
    expect(saved).toEqual({ saved: "daily" });
    const rec = store.get("routine:daily") as { id: string; prompt: string; savedAt: string };
    expect(rec.id).toBe("daily");
    expect(rec.prompt).toBe("do the daily report");
    expect(typeof rec.savedAt).toBe("string");

    // When the routine runs by bare id
    await routine("daily");

    // Then a new session started with the saved prompt
    expect(started).toEqual([{ prompt: "do the daily report", name: "routine:daily" }]);
  });

  it("throws for a missing id or an unknown routine", async () => {
    const { core, commands } = makeStub();
    register(core);
    const routine = commands.get("routine")!;
    await expect(routine({})).rejects.toThrow(/requires an id/);
    await expect(routine("nope")).rejects.toThrow(/not found/);
  });

  it("validates the id slug rule and the prompt length bound on save", async () => {
    const { core, commands } = makeStub();
    register(core);
    const routine = commands.get("routine")!;
    await expect(routine({ save: { id: "Bad Id", prompt: "x" } })).rejects.toThrow(/slug/);
    await expect(routine({ save: { id: "-bad", prompt: "x" } })).rejects.toThrow(/slug/);
    await expect(routine({ save: { id: "ok", prompt: "" } })).rejects.toThrow(/1–8192/);
    await expect(routine({ save: { id: "ok", prompt: "x".repeat(8193) } })).rejects.toThrow(/1–8192/);
  });

  it("list returns id + 80-char preview + savedAt; show returns the full record", async () => {
    const { core, commands, store } = makeStub();
    // The stub registry needs query + remove for list/delete.
    (core as unknown as { registry: Record<string, unknown> }).registry = {
      set: (key: string, value: unknown) => store.set(key, value),
      get: (key: string) => store.get(key) ?? null,
      query: (prefix: string) =>
        [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, value]) => ({ key: k.slice("routine:".length), value })),
      remove: (key: string) => void store.delete(key),
    };
    register(core);
    const routine = commands.get("routine")!;
    await routine({ save: { id: "long", prompt: "p".repeat(200) } });
    const listed = (await routine({ list: true })) as { routines: { id: string; preview: string; savedAt: string }[] };
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]!.id).toBe("long");
    expect(listed.routines[0]!.preview).toHaveLength(80);
    expect(typeof listed.routines[0]!.savedAt).toBe("string");

    const shown = (await routine({ show: "long" })) as { routine: { id: string } };
    expect(shown.routine.id).toBe("long");
    await expect(routine({ show: "missing" })).rejects.toThrow(/not found/);
  });

  it("delete is idempotent", async () => {
    const { core, commands, store } = makeStub();
    (core as unknown as { registry: Record<string, unknown> }).registry = {
      set: (key: string, value: unknown) => store.set(key, value),
      get: (key: string) => store.get(key) ?? null,
      query: (prefix: string) =>
        [...store.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, value]) => ({ key: k.slice("routine:".length), value })),
      remove: (key: string) => void store.delete(key),
    };
    register(core);
    const routine = commands.get("routine")!;
    await routine({ save: { id: "gone", prompt: "x" } });
    expect(await routine({ delete: "gone" })).toEqual({ deleted: "gone" });
    // Deleting again succeeds with the same shape (§4 idempotent).
    expect(await routine({ delete: "gone" })).toEqual({ deleted: "gone" });
  });
});
