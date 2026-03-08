import type { EngineStateSnapshot } from "./types";

export const CURRENT_ENGINE_STATE_VERSION = 2;

export function migrateEngineStateSnapshot(snapshot: unknown): Partial<EngineStateSnapshot> | undefined {
  if (!snapshot || typeof snapshot !== "object") {
    return undefined;
  }

  const raw = snapshot as Record<string, unknown>;
  const version = Number.isFinite(raw.version) ? Math.max(1, Number(raw.version)) : 1;

  if (version > CURRENT_ENGINE_STATE_VERSION) {
    console.warn(
      `[custom-sync] state snapshot version ${version} is newer than supported ${CURRENT_ENGINE_STATE_VERSION}; applying best-effort migration`
    );
  }

  return {
    ...raw,
    version: CURRENT_ENGINE_STATE_VERSION
  } as Partial<EngineStateSnapshot>;
}
