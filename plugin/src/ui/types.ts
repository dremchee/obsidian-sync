import type { Plugin } from "obsidian";
import type { StartupSyncMode, SyncSettings } from "@/settings";
import type { SyncEngine } from "@/sync/engine";
import type { WsConnectionState } from "@/sync/ws-client";

export type ServerConnectionState = "unknown" | "ok" | "error";

export type SyncStatusSnapshot = {
  overallState: "disabled" | "revoked" | "syncing" | "pending" | "error" | "ok";
  currentPhase: "idle" | "pull" | "push";
  lastSyncAt: number;
  nextSyncAt: number | null;
  pendingOperationCount: number;
  syncQueued: boolean;
  wsConnectionState: WsConnectionState;
  lastError: string | null;
  vaultName: string | null;
  deviceId: string | null;
  lastPullEvents: number;
  lastPullApplied: number;
  lastPushOperations: number;
  lastBlobBatchHashes: number;
  lastBlobBatchItems: number;
  lastBlobBatchDeferred: number;
  lastBlobBatchBytes: number;
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
