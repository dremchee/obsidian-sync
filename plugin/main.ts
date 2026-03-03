import { Notice, Plugin, TAbstractFile, requestUrl } from "obsidian";
import { SyncEngine, type EngineStateSnapshot } from "./src/sync/engine";
import type { StartupSyncMode, SyncSettings } from "./src/settings";
import { SyncSettingsTab } from "./src/ui/sync-settings-tab";
import { StatusBarController } from "./src/ui/status-controller";

const DEFAULT_SETTINGS: SyncSettings = {
  syncEnabled: true,
  syncOnStartup: true,
  startupMode: "smooth",
  serverUrl: "http://127.0.0.1:3243",
  apiKey: "",
  deviceId: "",
  vaultName: "default",
  passphrase: "",
  intervalSec: 30,
  maxConcurrentUploads: 2,
  pullBatchSize: 100,
  blobBatchSize: 20,
  retryBaseMs: 500,
  retryMaxMs: 30_000,
  lwwPolicy: "hard",
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
  lastSyncError: string | null = null;
  serverConnectionState: "unknown" | "ok" | "error" = "unknown";
  serverConnectionMessage = "Not checked yet";
  startupSmoothActive = false;
  startupWarmupCyclesLeft = 0;
  persistTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

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

    this.registerEvent(this.app.vault.on("create", (file) => this.markDirtyAndSchedule(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.markDirtyAndSchedule(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.markDirtyAndSchedule(file)));
    this.registerEvent(this.app.vault.on("rename", (file) => this.markDirtyAndSchedule(file)));

    this.addCommand({
      id: "custom-sync-now",
      name: "Custom Sync: Sync now",
      callback: async () => {
        await this.syncNow(true, true);
      }
    });

    this.addCommand({
      id: "custom-sync-register-device",
      name: "Custom Sync: Register device",
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
            new Notice("Device registered. API key saved in plugin settings.");
          }
        } catch (err) {
          new Notice(`Register failed: ${String(err)}`);
        }
      }
    });

    this.settingTab = new SyncSettingsTab(this.app, this);
    this.addSettingTab(this.settingTab);
    this.startupSyncIfEnabled();
  }

  onunload() {
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

  private async loadPersistedData(): Promise<{ settings?: Partial<SyncSettings>; syncState?: EngineStateSnapshot } > {
    const raw = await this.loadData();
    if (raw && typeof raw === "object" && "settings" in (raw as Record<string, unknown>)) {
      const data = raw as { settings?: Partial<SyncSettings>; syncState?: EngineStateSnapshot };
      return data;
    }
    return { settings: raw as Partial<SyncSettings> };
  }

  async loadSettings(persisted?: { settings?: Partial<SyncSettings> }) {
    const loaded = Object.assign({}, DEFAULT_SETTINGS, persisted?.settings || {}) as SyncSettings;
    if (!loaded.startupMode) {
      loaded.startupMode = loaded.syncOnStartup ? "smooth" : "off";
    }
    loaded.syncOnStartup = loaded.startupMode !== "off";
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
    this.pendingSync = true;
    this.updateStatusBar();
    this.scheduleSync();
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
      settings: this.settings,
      syncState: this.engine?.getStateSnapshot()
    });
  }

  private markDirtyAndSchedule(file?: TAbstractFile) {
    if (file?.path && this.engine?.shouldSuppressLocalEvent(file.path)) {
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

  private startupSyncIfEnabled() {
    if (this.settings.startupMode === "off") {
      return;
    }

    this.pendingSync = true;
    this.startupSmoothActive = this.settings.startupMode === "smooth";
    this.startupWarmupCyclesLeft = this.startupSmoothActive ? 3 : 0;
    this.updateStatusBar();

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
    if (!this.engine || !this.settings.apiKey || !this.settings.passphrase) return;
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
    if (!this.engine || !this.settings.apiKey || !this.settings.passphrase) return;
    if (this.syncInProgress) return;
    if (!this.pendingSync && !showNotice) return;

    this.syncInProgress = true;
    this.pendingSync = false;
    this.updateStatusBar();

    try {
      await this.engine.runOnce({ forcePull: force, profile: this.getRunProfile(force) });
      this.lastSyncAt = Date.now();
      this.serverConnectionState = "ok";
      this.serverConnectionMessage = `Connected via sync at ${new Date(this.lastSyncAt).toLocaleTimeString()}`;
      this.revokedNoticeShown = false;
      this.isDeviceRevoked = false;
      this.lastSyncError = null;
      this.refreshSettingsUi();
      this.updateStatusBar();
      if (showNotice) new Notice("Sync complete");
    } catch (err) {
      if (this.isDeviceRevokedError(err)) {
        this.isDeviceRevoked = true;
        this.lastSyncError = "device revoked";
        this.serverConnectionState = "error";
        this.serverConnectionMessage = "Device key revoked";
        this.refreshSettingsUi();
        this.updateStatusBar();
        if (!this.revokedNoticeShown) {
          this.revokedNoticeShown = true;
          new Notice("Sync disabled: device API key is invalid/revoked. Re-register device in plugin settings.");
        }
      } else if (showNotice) {
        const detail = this.toSyncErrorText(err);
        this.lastSyncError = detail;
        this.serverConnectionState = "error";
        this.serverConnectionMessage = detail;
        this.updateStatusBar();
        this.refreshSettingsUi();
        new Notice(`Sync failed: ${detail}`);
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

  async deleteConflictFiles() {
    const hiddenPrefix = ".obsidian/custom-self-hosted-sync/conflicts/";
    const files = this.app.vault.getFiles().filter((f) => {
      if (f.path.startsWith(hiddenPrefix)) return true;
      return /\.conflict\.[^.]+\.\d+\.md$/i.test(f.path) || f.path.includes(".conflict.");
    });

    if (!files.length) {
      new Notice("No conflict files found.");
      return;
    }

    let deleted = 0;
    let failed = 0;
    for (const file of files) {
      try {
        await this.app.vault.delete(file);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }

    if (failed > 0) {
      new Notice(`Conflict cleanup done: deleted ${deleted}, failed ${failed}.`);
      return;
    }
    new Notice(`Conflict cleanup done: deleted ${deleted}.`);
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
      this.lastSyncAt
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

  async testServerConnection() {
    const base = this.settings.serverUrl.trim().replace(/\/+$/, "");
    if (!base) {
      this.serverConnectionState = "error";
      this.serverConnectionMessage = "Server URL is empty";
      this.refreshSettingsUi();
      new Notice("Server URL is empty.");
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
        new Notice(`Connection failed: ${res.status} ${res.text || ""}`.trim());
        return;
      }

      this.serverConnectionState = "ok";
      this.serverConnectionMessage = `Connected (HTTP ${res.status})`;
      this.refreshSettingsUi();
      new Notice(`Connection OK: ${res.status}`);
    } catch (err) {
      this.serverConnectionState = "error";
      this.serverConnectionMessage = String(err);
      this.refreshSettingsUi();
      new Notice(`Connection failed: ${String(err)}`);
    }
  }
}
