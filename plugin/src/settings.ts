export interface SyncSettings {
  syncEnabled: boolean;
  syncOnStartup: boolean;
  serverUrl: string;
  apiKey: string;
  deviceId: string;
  vaultName: string;
  passphrase: string;
  intervalSec: number;
}
