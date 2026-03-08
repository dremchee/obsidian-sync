import type { RunProfile } from "./engine/types";

export const SYNC_DEFAULT_RUN_PROFILE: Required<RunProfile> = {
  maxFilesPerCycle: 20,
  fallbackScanChunkSize: 8,
  opBatchSize: 10,
  yieldEvery: 3,
  maxBlobUploadConcurrency: 2,
  pullLimit: 500
};

export const SYNC_LIMITS = {
  minPullIntervalSec: 10,
  maxPullBatchSize: 1000,
  maxPullPagesPerRun: 20,
  defaultBlobBatchSize: 20,
  maxBlobBatchSize: 100,
  minRetryBaseMs: 100,
  defaultRetryBaseMs: 500
} as const;

export const SYNC_TIMERS = {
  uiYieldMs: 0,
  remoteEventSuppressionTtlMs: 30_000,
  wsPingIntervalMs: 25_000,
  wsReconnectBaseDelayMs: 1_000,
  wsReconnectMaxDelayMs: 60_000
} as const;
