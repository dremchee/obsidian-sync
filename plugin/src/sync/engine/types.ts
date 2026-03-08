import type { BootstrapPolicy } from "../../settings";

export type SyncOperation = "upsert" | "delete" | "rename";

export type PullEvent = {
  eventId: number;
  fileId: string;
  revisionId: string;
  deviceId: string;
  path: string;
  prevPath?: string | null;
  op: SyncOperation;
  blobHash: string | null;
  size: number | null;
  revisionTs: number;
};

export type BatchBlobResponse = {
  items: Array<{ hash: string; dataBase64: string }>;
  missing: string[];
};

export type MissingBlobResponse = {
  missing: string[];
};

export type PushResult = {
  operationId: string;
  status: "applied" | "duplicate" | "ignored" | "conflict";
  revisionId?: string;
  headRevisionId?: string;
  conflictPath?: string;
};

export type PendingLocalOperation = {
  operationId: string;
  op: SyncOperation;
  path: string;
  prevPath?: string;
  clientTs: number;
  source?: "event" | "scan" | "bootstrap";
};

export type PushRequestOperation = {
  operationId: string;
  op: SyncOperation;
  path: string;
  prevPath?: string;
  blobHash?: string;
  size?: number;
  clientTs: number;
  baseRevisionId?: string;
};

export type PullMetrics = {
  skipped: boolean;
  events: number;
  applied: number;
  conflicts: number;
  durationMs: number;
};

export type PushMetrics = {
  candidates: number;
  prepared: number;
  uploads: number;
  operations: number;
  batches: number;
  conflicts: number;
  encryptMs: number;
  uploadMs: number;
  pushMs: number;
  durationMs: number;
};

export type RunProfile = {
  maxFilesPerCycle?: number;
  fallbackScanChunkSize?: number;
  opBatchSize?: number;
  yieldEvery?: number;
  maxBlobUploadConcurrency?: number;
  pullLimit?: number;
};

export type EngineStateSnapshot = {
  lastEventId: number;
  pendingOperations?: PendingLocalOperation[];
  dirtyPaths?: string[];
  uploadedBlobHashes: string[];
  headRevisionByPath: Record<string, string>;
  pushedMtimeByPath?: Record<string, number>;
  initialSyncDone?: boolean;
  isNewVault?: boolean;
  bootstrapPending?: boolean;
  bootstrapPolicy?: BootstrapPolicy;
  bootstrapLocalPaths?: string[];
};
