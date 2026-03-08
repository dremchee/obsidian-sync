import { Notice, Plugin, TAbstractFile, TFile, TFolder, requestUrl } from "obsidian";
import { SyncEngine, type EngineStateSnapshot } from "./src/sync/engine";
import { migrateEngineStateSnapshot } from "./src/sync/engine/snapshot";
import { SyncWebSocketClient, type WsConnectionState } from "./src/sync/ws-client";
import type { StartupSyncMode, SyncSettings } from "./src/settings";
import { SyncSettingsTab } from "./src/ui/sync-settings-tab";
import { StatusBarController } from "./src/ui/status-controller";
import { createTranslator } from "./src/i18n";

const DEFAULT_SETTINGS: SyncSettings = {
  syncEnabled: true,
  syncOnStartup: true,
  startupMode: "smooth",
  bootstrapPolicy: "merge",
  serverUrl: "http://127.0.0.1:3243",
  authToken: "",
  apiKey: "",
  deviceId: "",
  vaultName: "",
  passphrase: "",
  intervalSec: 30,
  maxConcurrentUploads: 2,
  pullBatchSize: 100,
  blobBatchSize: 20,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
  lwwPolicy: "hard",
  enableWebSocket: true,
  debugPerfLogs: false
};

export default class CustomSyncPlugin extends Plugin {
  settings: SyncSettings = DEFAULT_SETTINGS;
  engine: SyncEngine | null = null;
  syncTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  syncInProgress = false;
  pendingSync = false;
  lastSyncAt = 0;
  revokedNoticeShown = false;
  isDeviceRevoked = false;
  settingTab: SyncSettingsTab | null = null;
  statusBarController: StatusBarController | null = null;
  wsClient: SyncWebSocketClient | null = null;
  wsConnectionState: WsConnectionState = "disconnected";
  lastSyncError: string | null = null;
  serverConnectionState: "unknown" | "ok" | "error" = "unknown";
  serverConnectionMessage = "Not checked yet";
  startupSmoothActive = false;
  startupWarmupCyclesLeft = 0;
  persistTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  registerInProgress = false;
  private readonly translator = createTranslator();

  t = (key: string, params?: Record<string, string | number>) => this.translator(key, params);

  async onload() {
    const persisted = await this.loadPersistedData();
    await this.loadSettings(persisted);
    this.engine = new SyncEngine(this.app, this.settings);
    this.engine.applyStateSnapshot(persisted.syncState);
    const statusBarEl = this.addStatusBarItem();
    statusBarEl.addClass("custom-sync-statusbar");
    this.statusBarController = new StatusBarController(statusBarEl);
    this.registerDomEvent(statusBarEl, "click", (evt) =>
      this.statusBarController?.openMenu(evt, this.lastSyncAt, () => this.openPluginSettings())
    );
    this.updateStatusBar();

    this.connectWebSocket();

    this.registerEvent(this.app.vault.on("create", (file) => this.markDirtyAndSchedule(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.markDirtyAndSchedule(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.markDeleteAndSchedule(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.markRenameAndSchedule(file, oldPath)));

    this.addCommand({
      id: "custom-sync-now",
      name: this.t("commands.sync_now"),
      callback: async () => {
        await this.syncNow(true, true);
      }
    });

    this.addCommand({
      id: "custom-sync-register-device",
      name: this.t("commands.register_device"),
      callback: async () => {
        try {
          const reg = await this.engine?.registerDevice();
          if (reg) {
            this.settings.apiKey = reg.apiKey;
            this.settings.deviceId = reg.deviceId;
            await this.saveSettings();
            this.revokedNoticeShown = false;
            this.isDeviceRevoked = false;
            this.refreshSettingsUi();
            new Notice(this.t("notices.device_registered"));
          }
        } catch (err) {
          new Notice(this.t("notices.register_failed", { error: String(err) }));
        }
      }
    });

    this.settingTab = new SyncSettingsTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.startupSyncIfEnabled();
  }

  onunload() {
    this.disconnectWebSocket();
    if (this.syncTimer) {
      globalThis.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.persistTimer) {
      globalThis.clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    void this.persistPluginData();
  }

  connectWebSocket() {
    this.disconnectWebSocket();
    if (!this.settings.enableWebSocket || !this.settings.apiKey || !this.settings.serverUrl) return;

    this.wsClient = new SyncWebSocketClient({
      serverUrl: this.settings.serverUrl,
      apiKey: this.settings.apiKey,
      onNewEvents: () => {
        this.pendingSync = true;
        this.updateStatusBar();
        if (this.syncInProgress) return;
        if (this.syncTimer) {
          globalThis.clearTimeout(this.syncTimer);
          this.syncTimer = null;
        }
        void this.syncNow(false, true);
      },
      onStateChange: (state) => {
        this.wsConnectionState = state;
        this.updateStatusBar();
      },
      debugLog: this.settings.debugPerfLogs
        ? (msg) => console.debug(`[custom-sync][ws] ${msg}`)
        : undefined
    });
    this.wsClient.connect();
  }

  private disconnectWebSocket() {
    if (this.wsClient) {
      this.wsClient.disconnect();
      this.wsClient = null;
      this.wsConnectionState = "disconnected";
    }
  }

  private async loadPersistedData(): Promise<{ settings?: Partial<SyncSettings>; syncState?: EngineStateSnapshot }> {
    const raw = await this.loadData();
    const syncState = await this.loadSyncStateFile();
    if (raw && typeof raw === "object" && "settings" in (raw as Record<string, unknown>)) {
      const data = raw as { settings?: Partial<SyncSettings>; syncState?: EngineStateSnapshot };
      return {
        settings: data.settings,
        syncState
      };
    }
    return {
      settings: raw as Partial<SyncSettings>,
      syncState
    };
  }

  async loadSettings(persisted?: { settings?: Partial<SyncSettings> }) {
    const loaded = Object.assign({}, DEFAULT_SETTINGS, persisted?.settings || {}) as SyncSettings;
    if ((loaded.startupMode as string) === "lazy") {
      loaded.startupMode = "smooth";
    }
    if (!loaded.startupMode) {
      loaded.startupMode = loaded.syncOnStartup ? "smooth" : "off";
    }
    loaded.syncOnStartup = loaded.startupMode !== "off";
    if (loaded.bootstrapPolicy !== "merge" && loaded.bootstrapPolicy !== "remote_wins" && loaded.bootstrapPolicy !== "local_wins") {
      loaded.bootstrapPolicy = "merge";
    }
    loaded.lwwPolicy = "hard";
    this.settings = loaded;
  }

  async saveSettings() {
    await this.persistPluginData();
    const prevState = this.engine?.getStateSnapshot();
    this.engine = new SyncEngine(this.app, this.settings);
    if (prevState) {
      this.engine.applyStateSnapshot(prevState);
    }
    if (this.syncTimer) {
      globalThis.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    const canSync = Boolean(this.settings.apiKey || (this.settings.authToken && this.settings.vaultName));
    if (canSync) {
      this.pendingSync = true;
      this.connectWebSocket();
      this.scheduleSync();
    } else {
      this.pendingSync = false;
      this.disconnectWebSocket();
    }
    this.updateStatusBar();
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = globalThis.setTimeout(() => {
      this.persistTimer = null;
      void this.persistPluginData();
    }, 1000);
  }

  private async persistPluginData() {
    await this.saveData({
      settings: this.settings
    });
    await this.saveSyncStateFile(this.engine?.getStateSnapshot());
  }

  private getSyncStatePath() {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/state.json`;
  }

  private async loadSyncStateFile(): Promise<EngineStateSnapshot | undefined> {
    const statePath = this.getSyncStatePath();
    try {
      if (!(await this.app.vault.adapter.exists(statePath))) {
        return undefined;
      }
      const raw = await this.app.vault.adapter.read(statePath);
      if (!raw.trim()) {
        return undefined;
      }
      const parsed = migrateEngineStateSnapshot(JSON.parse(raw));
      if (!parsed) {
        return undefined;
      }
      return parsed as EngineStateSnapshot;
    } catch (err) {
      console.error(`[custom-sync] failed to load sync state from ${statePath}: ${err}`);
      return undefined;
    }
  }

  private async saveSyncStateFile(snapshot?: EngineStateSnapshot) {
    const statePath = this.getSyncStatePath();
    try {
      await this.app.vault.adapter.write(
        statePath,
        JSON.stringify(
          snapshot || { version: 2, lastEventId: 0, uploadedBlobHashes: [], headRevisionByPath: {} },
          null,
          2
        )
      );
    } catch (err) {
      console.error(`[custom-sync] failed to save sync state to ${statePath}: ${err}`);
    }
  }

  private markDirtyAndSchedule(file?: TAbstractFile) {
    if (!(file instanceof TFile)) {
      return;
    }
    if (!this.engine?.shouldQueueLocalUpsert(file)) {
      return;
    }
    if (file?.path) {
      this.engine?.markDirty(file.path);
    }
    this.pendingSync = true;
    this.updateStatusBar();
    this.scheduleSync();
    this.schedulePersist();
  }

  private markDeleteAndSchedule(file?: TAbstractFile) {
    if (!(file instanceof TFile)) {
      return;
    }
    if (file?.path && this.engine?.shouldSuppressLocalEvent(file.path)) {
      return;
    }
    if (file?.path) {
      this.engine?.markFileDeleted(file.path);
    }
    this.pendingSync = true;
    this.updateStatusBar();
    this.scheduleSync();
    this.schedulePersist();
  }

  private markRenameAndSchedule(file?: TAbstractFile, oldPath?: string) {
    if (file instanceof TFolder) {
      this.markFolderRenameAndSchedule(file, oldPath);
      return;
    }
    if (!(file instanceof TFile)) {
      return;
    }
    const nextPath = file?.path || "";
    const prevPath = oldPath || "";
    if ((prevPath && this.engine?.shouldSuppressLocalEvent(prevPath)) || (nextPath && this.engine?.shouldSuppressLocalEvent(nextPath))) {
      return;
    }
    if (prevPath && nextPath) {
      this.engine?.markFileRenamed(prevPath, nextPath);
    } else if (nextPath) {
      this.engine?.markDirty(nextPath);
    }
    this.pendingSync = true;
    this.updateStatusBar();
    this.scheduleSync();
    this.schedulePersist();
  }

  private markFolderRenameAndSchedule(folder: TFolder, oldPath?: string) {
    const prevRoot = String(oldPath || "").replace(/\/+$/, "");
    const nextRoot = folder.path.replace(/\/+$/, "");
    if (!prevRoot || !nextRoot || prevRoot === nextRoot) {
      return;
    }

    let changed = false;
    for (const file of this.app.vault.getFiles()) {
      if (!(file.path === nextRoot || file.path.startsWith(`${nextRoot}/`))) {
        continue;
      }
      const suffix = file.path.slice(nextRoot.length);
      const prevPath = `${prevRoot}${suffix}`;
      if (this.engine?.shouldSuppressLocalEvent(prevPath) || this.engine?.shouldSuppressLocalEvent(file.path)) {
        continue;
      }
      this.engine?.markFileRenamed(prevPath, file.path);
      changed = true;
    }

    if (!changed) {
      return;
    }

    this.pendingSync = true;
    this.updateStatusBar();
    this.scheduleSync();
    this.schedulePersist();
  }

  private startupSyncIfEnabled() {
    if (this.settings.startupMode === "off") {
      return;
    }

    this.pendingSync = true;
    this.startupSmoothActive = this.settings.startupMode === "smooth";
    this.startupWarmupCyclesLeft = this.startupSmoothActive ? 3 : 0;
    this.updateStatusBar();

    if (this.settings.startupMode === "immediate") {
      this.syncTimer = globalThis.setTimeout(() => {
        this.syncTimer = null;
        void this.syncNow(false, false);
      }, 0);
      return;
    }

    const baseDelayMs = Math.max(10, this.settings.intervalSec) * 1000;
    const jitterMs = Math.floor(Math.random() * (this.startupSmoothActive ? 10_000 : 3_000));
    const delayMs = baseDelayMs + jitterMs;
    this.syncTimer = globalThis.setTimeout(() => {
      this.syncTimer = null;
      if (this.startupSmoothActive) {
        this.runSyncWhenIdle();
        return;
      }
      void this.syncNow(false, false);
    }, delayMs);
  }

  private runSyncWhenIdle() {
    const run = () => {
      void this.syncNow(false, false);
    };
    const host = globalThis as typeof globalThis & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    };
    if (typeof host.requestIdleCallback === "function") {
      host.requestIdleCallback(run, { timeout: 2000 });
      return;
    }
    globalThis.setTimeout(run, 0);
  }

  private scheduleSync(immediate = false) {
    if (!this.settings.syncEnabled) return;
    if (!this.engine || !this.settings.passphrase) return;
    if (!this.settings.apiKey && !this.settings.vaultName) return;
    if (this.syncInProgress) return;
    if (this.syncTimer) return;

    const intervalMs = Math.max(10, this.settings.intervalSec) * 1000;
    const elapsed = Date.now() - this.lastSyncAt;
    const delay = immediate ? 0 : Math.max(0, intervalMs - elapsed);

    this.syncTimer = globalThis.setTimeout(() => {
      this.syncTimer = null;
      if (this.startupSmoothActive) {
        this.runSyncWhenIdle();
        return;
      }
      void this.syncNow();
    }, delay);
    this.updateStatusBar();
  }

  private getRunProfile(force: boolean) {
    if (!this.startupSmoothActive || force) return undefined;
    return {
      maxFilesPerCycle: 8,
      fallbackScanChunkSize: 4,
      opBatchSize: 4,
      yieldEvery: 2,
      maxBlobUploadConcurrency: 1,
      pullLimit: 100
    };
  }

  private consumeStartupWarmupCycle() {
    if (!this.startupSmoothActive) return;
    this.startupWarmupCyclesLeft -= 1;
    if (this.startupWarmupCyclesLeft <= 0) {
      this.startupSmoothActive = false;
    }
  }

  setStartupMode(mode: StartupSyncMode) {
    this.settings.startupMode = mode;
    this.settings.syncOnStartup = mode !== "off";
  }

  private async syncNow(showNotice = false, force = false) {
    if (!force && !this.settings.syncEnabled) return;
    if (!this.engine || !this.settings.passphrase) return;
    if (this.syncInProgress) return;
    if (!this.pendingSync && !showNotice) return;

    if (!this.settings.apiKey) {
      const registered = await this.ensureDeviceRegistered(showNotice);
      if (!registered) return;
    }

    this.syncInProgress = true;
    this.pendingSync = false;
    this.updateStatusBar();

    try {
      await this.engine.runOnce({ forcePull: force, profile: this.getRunProfile(force) });
      this.lastSyncAt = Date.now();
      this.serverConnectionState = "ok";
      this.serverConnectionMessage = new Date(this.lastSyncAt).toLocaleTimeString();
      this.revokedNoticeShown = false;
      this.isDeviceRevoked = false;
      this.lastSyncError = null;
      this.refreshSettingsUi();
      this.updateStatusBar();
      if (showNotice) new Notice(this.t("notices.sync_complete"));
    } catch (err) {
      if (this.isDeviceRevokedError(err)) {
        this.isDeviceRevoked = true;
        this.lastSyncError = "device revoked";
        this.serverConnectionState = "error";
        this.serverConnectionMessage = this.t("status.sync_revoked");
        this.refreshSettingsUi();
        this.updateStatusBar();
        if (!this.revokedNoticeShown) {
          this.revokedNoticeShown = true;
          new Notice(this.t("notices.sync_disabled_revoked"));
        }
      } else if (showNotice) {
        const detail = this.toSyncErrorText(err);
        this.lastSyncError = detail;
        this.serverConnectionState = "error";
        this.serverConnectionMessage = detail;
        this.updateStatusBar();
        this.refreshSettingsUi();
        new Notice(this.t("notices.sync_failed", { detail }));
      } else {
        this.lastSyncError = this.toSyncErrorText(err);
        this.serverConnectionState = "error";
        this.serverConnectionMessage = this.lastSyncError;
        this.updateStatusBar();
        this.refreshSettingsUi();
      }
    } finally {
      this.consumeStartupWarmupCycle();
      this.syncInProgress = false;
      this.updateStatusBar();
      this.schedulePersist();
      if (this.pendingSync) {
        this.scheduleSync();
      }
    }
  }

  private async ensureDeviceRegistered(showNotice: boolean): Promise<boolean> {
    if (!this.engine) return false;
    if (this.settings.apiKey) return true;
    if (!this.settings.authToken || !this.settings.vaultName) {
      return false;
    }
    if (this.registerInProgress) return false;

    this.registerInProgress = true;
    try {
      const reg = await this.engine.registerDevice();
      this.settings.apiKey = reg.apiKey;
      this.settings.deviceId = reg.deviceId;
      await this.persistPluginData();
      this.revokedNoticeShown = false;
      this.isDeviceRevoked = false;
      this.refreshSettingsUi();
      new Notice(this.t("notices.device_registered"));
      return true;
    } catch (err) {
      if (showNotice) {
        new Notice(this.t("notices.register_failed", { error: String(err) }));
      }
      return false;
    } finally {
      this.registerInProgress = false;
    }
  }

  private isDeviceRevokedError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /DEVICE_REVOKED/i.test(msg);
  }

  private toSyncErrorText(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    const compact = raw.replace(/\s+/g, " ").trim();
    if (!compact) return "unknown error";
    return compact.length > 80 ? `${compact.slice(0, 80)}...` : compact;
  }

  private refreshSettingsUi() {
    this.settingTab?.display();
  }

  private updateStatusBar() {
    this.statusBarController?.update(
      {
        syncEnabled: this.settings.syncEnabled,
        isDeviceRevoked: this.isDeviceRevoked,
        syncInProgress: this.syncInProgress,
        hasPendingWork: Boolean(this.pendingSync || this.syncTimer),
        hasError: Boolean(this.lastSyncError)
      },
      this.lastSyncAt,
      this.t
    );
  }

  private openPluginSettings() {
    const appWithSettings = this.app as unknown as {
      setting?: {
        open?: () => void;
        openTabById?: (id: string) => void;
      };
    };
    appWithSettings.setting?.open?.();
    appWithSettings.setting?.openTabById?.(this.manifest.id);
  }

  triggerImmediateSync() {
    if (this.syncTimer) {
      globalThis.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.startupSmoothActive = false;
    this.pendingSync = true;
    this.updateStatusBar();
    void this.syncNow(false, true);
  }

  async testServerConnection(opts?: { silent?: boolean }) {
    const silent = opts?.silent ?? false;
    const base = this.settings.serverUrl.trim().replace(/\/+$/, "");
    if (!base) {
      this.serverConnectionState = "error";
      this.serverConnectionMessage = this.t("notices.server_url_empty");
      this.refreshSettingsUi();
      if (!silent) new Notice(this.t("notices.server_url_empty"));
      return;
    }

    try {
      const res = await requestUrl({
        url: `${base}/healthz`,
        method: "GET",
        throw: false
      });

      if (res.status >= 400) {
        this.serverConnectionState = "error";
        this.serverConnectionMessage = `${res.status} ${res.text || ""}`.trim();
        this.refreshSettingsUi();
        if (!silent) new Notice(this.t("notices.connection_failed", { error: `${res.status} ${res.text || ""}`.trim() }));
        return;
      }

      this.serverConnectionState = "ok";
      this.serverConnectionMessage = `Connected (HTTP ${res.status})`;
      this.refreshSettingsUi();
      if (!silent) new Notice(this.t("notices.connection_ok", { status: res.status }));
    } catch (err) {
      this.serverConnectionState = "error";
      this.serverConnectionMessage = String(err);
      this.refreshSettingsUi();
      if (!silent) new Notice(this.t("notices.connection_failed", { error: String(err) }));
    }
  }
}
