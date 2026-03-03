import { App, Menu, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, requestUrl, setIcon } from "obsidian";
import { SyncEngine } from "./src/sync/engine";
import type { SyncSettings } from "./src/settings";

const DEFAULT_SETTINGS: SyncSettings = {
  syncEnabled: true,
  syncOnStartup: true,
  serverUrl: "http://127.0.0.1:3243",
  apiKey: "",
  deviceId: "",
  vaultName: "default",
  passphrase: "",
  intervalSec: 30
};

export default class CustomSyncPlugin extends Plugin {
  settings: SyncSettings = DEFAULT_SETTINGS;
  engine: SyncEngine | null = null;
  syncTimer: number | null = null;
  syncInProgress = false;
  pendingSync = false;
  lastSyncAt = 0;
  revokedNoticeShown = false;
  isDeviceRevoked = false;
  settingTab: SyncSettingTab | null = null;
  statusBarEl: HTMLElement | null = null;
  lastSyncError: string | null = null;
  statusState: "ok" | "pending" | "syncing" | "error" | "revoked" | "disabled" = "ok";
  serverConnectionState: "unknown" | "ok" | "error" = "unknown";
  serverConnectionMessage = "Not checked yet";

  async onload() {
    await this.loadSettings();
    this.engine = new SyncEngine(this.app, this.settings);
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("custom-sync-statusbar");
    this.registerDomEvent(this.statusBarEl, "click", (evt) => this.openStatusMenu(evt));
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

    this.settingTab = new SyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    if (this.settings.syncOnStartup) {
      this.pendingSync = true;
      this.updateStatusBar();
      this.scheduleSync(true);
    }
  }

  onunload() {
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.engine = new SyncEngine(this.app, this.settings);
    if (this.syncTimer) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.pendingSync = true;
    this.updateStatusBar();
    this.scheduleSync();
  }

  private markDirtyAndSchedule(file?: TAbstractFile) {
    if (file?.path && this.engine?.shouldSuppressLocalEvent(file.path)) {
      return;
    }
    this.pendingSync = true;
    this.updateStatusBar();
    this.scheduleSync();
  }

  private scheduleSync(immediate = false) {
    if (!this.settings.syncEnabled) return;
    if (!this.engine || !this.settings.apiKey || !this.settings.passphrase) return;
    if (this.syncInProgress) return;
    if (this.syncTimer) return;

    const intervalMs = Math.max(10, this.settings.intervalSec) * 1000;
    const elapsed = Date.now() - this.lastSyncAt;
    const delay = immediate ? 0 : Math.max(0, intervalMs - elapsed);

    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      void this.syncNow();
    }, delay);
    this.updateStatusBar();
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
      await this.engine.runOnce({ forcePull: force });
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
      this.syncInProgress = false;
      this.updateStatusBar();
      if (this.pendingSync) {
        this.scheduleSync();
      }
    }
  }

  async deleteConflictFiles() {
    const files = this.app.vault
      .getFiles()
      .filter((f) => /\.conflict\.[^.]+\.\d+\.md$/i.test(f.path) || f.path.includes(".conflict."));

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
    if (!this.statusBarEl) return;

    if (!this.settings.syncEnabled) {
      this.statusState = "disabled";
      this.setStatusBarText("Sync disabled");
      return;
    }

    if (this.isDeviceRevoked) {
      this.statusState = "revoked";
      this.setStatusBarText("Sync revoked");
      return;
    }

    if (this.syncInProgress) {
      this.statusState = "syncing";
      this.setStatusBarText("Syncing");
      return;
    }

    if (this.pendingSync || this.syncTimer) {
      this.statusState = "pending";
      this.setStatusBarText("Pending");
      return;
    }

    if (this.lastSyncError) {
      this.statusState = "error";
      this.setStatusBarText("Sync error");
      return;
    }

    this.statusState = "ok";
    this.setStatusBarText("Sync ok");
  }

  private formatLastSyncAt() {
    if (!this.lastSyncAt) return "never";
    return new Date(this.lastSyncAt).toLocaleString();
  }

  private setStatusBarText(text: string) {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();

    const iconEl = this.statusBarEl.createSpan({ cls: "custom-sync-status-icon" });
    const textEl = this.statusBarEl.createSpan({ cls: "custom-sync-status-text", text });
    textEl.style.marginLeft = "6px";

    const iconName =
      this.statusState === "ok"
        ? "check-circle"
        : this.statusState === "pending"
          ? "clock-3"
          : this.statusState === "syncing"
            ? "refresh-cw"
            : this.statusState === "revoked"
              ? "ban"
              : this.statusState === "disabled"
                ? "pause-circle"
                : "alert-triangle";
    setIcon(iconEl, iconName);

    this.statusBarEl.title = `${text}\nLast sync: ${this.formatLastSyncAt()}`;
  }

  private openStatusMenu(evt: MouseEvent) {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(`Status: ${this.statusState}`).setDisabled(true));
    menu.addItem((item) => item.setTitle(`Last sync: ${this.formatLastSyncAt()}`).setDisabled(true));
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle("Open Sync Settings").onClick(() => this.openPluginSettings())
    );
    menu.showAtMouseEvent(evt);
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

class SyncSettingTab extends PluginSettingTab {
  plugin: CustomSyncPlugin;

  constructor(app: App, plugin: CustomSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Enable sync")
      .setDesc("Turn automatic sync on/off. Manual sync command still works.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.syncEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync on startup")
      .setDesc("Run initial sync automatically when Obsidian starts.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    const serverUrlSetting = new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Base URL of the Nitro sync API")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) =>
        button.setButtonText("Test").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.testServerConnection();
          } finally {
            button.setDisabled(false);
          }
        })
      );

    const serverStatusText =
      this.plugin.serverConnectionState === "ok"
        ? `Connected: ${this.plugin.serverConnectionMessage}`
        : this.plugin.serverConnectionState === "error"
          ? `Connection failed: ${this.plugin.serverConnectionMessage}`
          : this.plugin.serverConnectionMessage;
    const serverStatusColor =
      this.plugin.serverConnectionState === "ok"
        ? "var(--color-green)"
        : this.plugin.serverConnectionState === "error"
          ? "var(--color-red)"
          : "var(--text-muted)";

    const serverUrlDesc = serverUrlSetting.settingEl.querySelector(".setting-item-description");
    if (serverUrlDesc instanceof HTMLElement) {
      const statusEl = serverUrlDesc.createDiv({ cls: "custom-sync-server-status" });
      statusEl.textContent = serverStatusText;
      statusEl.style.color = serverStatusColor;
      statusEl.style.fontWeight = "600";
      statusEl.style.marginTop = "4px";
    }

    new Setting(containerEl)
      .setName("API key")
      .setDesc("Assigned automatically on register")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.apiKey)
          .setDisabled(true)
      );

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Assigned automatically by server on register")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.deviceId)
          .setDisabled(true)
      );

    new Setting(containerEl)
      .setName("Vault name")
      .setDesc("Vault name used for device registration")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.vaultName)
          .onChange(async (value) => {
            this.plugin.settings.vaultName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Passphrase")
      .setDesc("Passphrase used for client-side encryption")
      .addText((text) => {
        text.inputEl.type = "password";
        return text
          .setPlaceholder("Required for sync")
          .setValue(this.plugin.settings.passphrase)
          .onChange(async (value) => {
            this.plugin.settings.passphrase = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Interval (sec)")
      .setDesc("Throttle window for change-based sync")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.intervalSec))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.intervalSec = Number.isFinite(parsed) ? parsed : 30;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Register device")
      .setDesc(
        this.plugin.isDeviceRevoked
          ? "Device key is revoked. Click Register to re-register this device."
          : "Requests API key/device ID from server and saves them."
      )
      .addButton((button) =>
        button.setButtonText(this.plugin.isDeviceRevoked ? "Re-register" : "Register").onClick(async () => {
          button.setDisabled(true);
          try {
            const reg = await this.plugin.engine?.registerDevice();
            if (reg) {
              this.plugin.settings.apiKey = reg.apiKey;
              this.plugin.settings.deviceId = reg.deviceId;
              await this.plugin.saveSettings();
              this.plugin.isDeviceRevoked = false;
              this.plugin.revokedNoticeShown = false;
              new Notice("Device registered. API key saved in plugin settings.");
              this.display();
            }
          } catch (err) {
            new Notice(`Register failed: ${String(err)}`);
          } finally {
            button.setDisabled(false);
          }
        })
      );

    new Setting(containerEl)
      .setName("Delete conflicts")
      .setDesc("Delete files created as sync conflicts (*.conflict.*).")
      .addButton((button) =>
        button.setButtonText("Delete").onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.deleteConflictFiles();
          } finally {
            button.setDisabled(false);
          }
        })
      );
  }
}
