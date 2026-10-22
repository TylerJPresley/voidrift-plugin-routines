/**
 * VoidRift Routines — a first-party plugin (routines-blueprint.md, core §12.4).
 *
 * A routine is a saved prompt run on demand or from a trigger. This plugin owns
 * routine storage in its namespaced, DURABLE registry (core §12.5) — a routine
 * saved in one process is present in the next — and registers one `routine`
 * command through `register.command`. `session.command("routine", <args>)`
 * routes to the handler, which accepts `{ save }`, `{ list }`, `{ show }`,
 * `{ delete }`, or a bare id / `{ id }` (run). A headless `voidrift --routine
 * <id>` passes the id straight through; `voidrift --routine --list` routes
 * `{ list: true }`. Running a routine starts a NEW session whose first prompt is
 * the saved one (§5, core §5.7).
 *
 * A routine record carries NO permission/tool/scope grant a frontend could act
 * on: the persisted, runnable unit is `{ id, prompt }` plus declarative metadata
 * (the saved time and the optional authored skill/description/trigger of §2).
 */

import type { ScopedCoreApi } from "@voidrift/core";

// ── §2 the routine definition ────────────────────────────────────────────────

/** The slug id rule (§2): 1–64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`. */
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID_MAX = 64;
/** The prompt length bound (§2): 1–8192 chars. */
export const PROMPT_MAX = 8192;

/** Optional declarative trigger metadata the host reads (§6). */
interface TriggerMeta {
  kind: string;
  spec?: string;
}

/** The scope a run declares up front — DATA only, never a grant (§2, §5). */
interface TrustedScope {
  tools?: string[];
  paths?: string[];
  network?: boolean;
}

/** The persisted routine record (§2). `{ id, prompt }` plus metadata. */
export interface StoredRoutine {
  id: string;
  prompt: string;
  skill?: string;
  scope?: TrustedScope;
  trigger?: TriggerMeta;
  description?: string;
  /** The saved time (ISO 8601), set by the handler on save (§4 listing). */
  savedAt: string;
}

/** The `routine` command argument shapes (§4). A bare id string is a run. */
interface RoutineArgs {
  save?: SaveInput;
  list?: boolean;
  show?: string;
  delete?: string;
  id?: string;
}

/** The save input the handler validates before writing (§3 validation). */
interface SaveInput {
  id: string;
  prompt: string;
  skill?: string;
  scope?: TrustedScope;
  trigger?: TriggerMeta;
  description?: string;
}

const KEY_PREFIX = "routine:";
const keyFor = (id: string): string => `${KEY_PREFIX}${id}`;

/** Validate an id against the slug rule and length bound (§2, §3). */
function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > ID_MAX || !ID_RE.test(id)) {
    throw new Error(
      `routine id must be a slug (lowercase alphanumerics and hyphens, 1–${ID_MAX} chars): "${String(id)}"`,
    );
  }
}

/** Validate a prompt against the length bound (§2, §3). */
function assertPrompt(prompt: unknown): asserts prompt is string {
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > PROMPT_MAX) {
    throw new Error(`routine prompt must be 1–${PROMPT_MAX} characters`);
  }
}

/**
 * The plugin entry point. The scoped CoreAPI tags every registration with this
 * plugin's id and namespaces its registry access to the plugin (§12.4, §12.5).
 */
export function register(core: ScopedCoreApi): void {
  core.register.command("routine", async (args: unknown) => {
    // ── Save — validate then write; runs nothing (§4). ──────────────────────
    if (isObj(args) && isObj(args.save)) {
      const input = args.save as SaveInput;
      assertId(input.id);
      assertPrompt(input.prompt);
      const record: StoredRoutine = {
        id: input.id,
        prompt: input.prompt,
        savedAt: new Date().toISOString(),
        ...(input.skill !== undefined ? { skill: input.skill } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      };
      // Idempotent: a save under an existing id replaces it in place (§3).
      core.registry.set(keyFor(record.id), record);
      return { saved: record.id };
    }

    // ── List — id + 80-char preview + savedAt for every routine (§4). ───────
    if (isObj(args) && args.list === true) {
      const rows = core.registry.query(KEY_PREFIX).map((e) => {
        const r = e.value as StoredRoutine;
        return { id: r.id, preview: r.prompt.slice(0, 80), savedAt: r.savedAt };
      });
      return { routines: rows };
    }

    // ── Show — the full stored record, or an unknown-id error (§4). ─────────
    if (isObj(args) && typeof args.show === "string") {
      const stored = core.registry.get(keyFor(args.show)) as StoredRoutine | null;
      if (!stored) throw new Error(`routine "${args.show}" not found`);
      return { routine: stored };
    }

    // ── Delete — idempotent removal (§4). ───────────────────────────────────
    if (isObj(args) && typeof args.delete === "string") {
      core.registry.remove(keyFor(args.delete));
      return { deleted: args.delete };
    }

    // ── Run — a bare id or `{ id }`; start a fresh session (§4, §5). ────────
    const id = typeof args === "string" ? args : isObj(args) ? args.id : undefined;
    if (typeof id !== "string" || id.length === 0) throw new Error("routine requires an id");
    const stored = core.registry.get(keyFor(id)) as StoredRoutine | null;
    if (!stored) throw new Error(`routine "${id}" not found`);
    return core.session.runInNewSession(stored.prompt, { name: `routine:${id}` });
  });
}

function isObj(v: unknown): v is RoutineArgs & Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export default { register };
