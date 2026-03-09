import type { Plugin } from "obsidian";
import type { SyncEngine } from "../sync/engine";
import type { WsConnectionState } from "../sync/ws-client";
import type { StartupSyncMode, SyncSettings } from "../settings";

export type ServerConnectionState = "unknown" | "ok" | "error";

export type SyncStatusSnapshot = {
  overallState: "disabled" | "revoked" | "syncing" | "pending" | "error" | "ok";
  lastSyncAt: number;
  nextSyncAt: number | null;
  pendingOperationCount: number;
  syncQueued: boolean;
  wsConnectionState: WsConnectionState;
  lastError: string | null;
  vaultName: string | null;
  deviceId: string | null;
  recentActivity: Array<{
    ts: number;
    kind: "sync" | "error" | "websocket";
    message: string;
  }>;
};

export interface SyncSettingsTabContext {
  settings: SyncSettings;
  isDeviceRevoked: boolean;
  revokedNoticeShown: boolean;
  engine: SyncEngine | null;
  serverConnectionState: ServerConnectionState;
  serverConnectionMessage: string;
  saveSettings: () => Promise<void>;
  setStartupMode: (mode: StartupSyncMode) => void;
  testServerConnection: (opts?: { silent?: boolean }) => Promise<void>;
  triggerImmediateSync: () => void;
  getSyncStatusSnapshot: () => SyncStatusSnapshot;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export type SyncSettingsTabPlugin = Plugin & SyncSettingsTabContext;

export type UiTranslator = (key: string, params?: Record<string, string | number>) => string;

export type VaultListState<TVaultInfo> = {
  vaults: TVaultInfo[];
  vaultsLoaded: boolean;
  vaultsLoading: boolean;
};
