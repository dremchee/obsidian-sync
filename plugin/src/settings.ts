export type StartupSyncMode = "off" | "smooth" | "immediate";
export type BootstrapPolicy = "merge" | "remote_wins" | "local_wins";

export interface SyncSettings {
  syncEnabled: boolean;
  syncOnStartup: boolean;
  startupMode: StartupSyncMode;
  bootstrapPolicy: BootstrapPolicy;
  serverUrl: string;
  authToken: string;
  apiKey: string;
  deviceId: string;
  vaultName: string;
  passphrase: string;
  intervalSec: number;
  maxConcurrentUploads: number;
  pullBatchSize: number;
  blobBatchSize: number;
  retryBaseMs: number;
  retryMaxMs: number;
  lwwPolicy: "hard";
  enableWebSocket: boolean;
  debugPerfLogs: boolean;
}
