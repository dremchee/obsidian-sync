export type StartupSyncMode = "off" | "lazy" | "smooth";

export interface SyncSettings {
  syncEnabled: boolean;
  syncOnStartup: boolean;
  startupMode: StartupSyncMode;
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  vaultName: string;
  passphrase: string;
  intervalSec: number;
}
