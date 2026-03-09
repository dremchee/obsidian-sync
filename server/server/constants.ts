export const SERVER_SYNC_LIMITS = {
  wsAuthTimeoutMs: 5_000,
  deviceRegisterMaxRequests: 10,
  deviceRegisterWindowMs: 10 * 60 * 1000,
  syncPushMaxRequests: 120,
  syncPushWindowMs: 60 * 1000,
  blobBatchGetMaxHashes: 100,
  blobBatchGetMaxBytes: 2 * 1024 * 1024,
  blobBatchMissingMaxHashes: 1000,
  syncPullDefaultLimit: 200,
  syncPullMaxLimit: 1000
} as const;
