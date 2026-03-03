export type StartupSyncMode = "off" | "lazy" | "smooth";
export type PluginLanguage = "auto" | "en" | "ru";

export interface SyncSettings {
  syncEnabled: boolean;
  syncOnStartup: boolean;
  startupMode: StartupSyncMode;
  language: PluginLanguage;
  serverUrl: string;
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
  debugPerfLogs: boolean;
}
