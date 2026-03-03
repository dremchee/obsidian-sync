import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { SyncEngine } from "../sync/engine";
import type { StartupSyncMode, SyncSettings } from "../settings";

export type ServerConnectionState = "unknown" | "ok" | "error";

export interface SyncSettingsTabContext {
  settings: SyncSettings;
  isDeviceRevoked: boolean;
  revokedNoticeShown: boolean;
  engine: SyncEngine | null;
  serverConnectionState: ServerConnectionState;
  serverConnectionMessage: string;
  saveSettings: () => Promise<void>;
  setStartupMode: (mode: StartupSyncMode) => void;
  testServerConnection: () => Promise<void>;
  deleteConflictFiles: () => Promise<void>;
}

type SyncSettingsTabPlugin = Plugin & SyncSettingsTabContext;

export class SyncSettingsTab extends PluginSettingTab {
  plugin: SyncSettingsTabPlugin;

  constructor(app: App, plugin: SyncSettingsTabPlugin) {
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
      .setName("Startup sync mode")
      .setDesc("Off: no startup sync. Lazy: delayed normal sync. Smooth: delayed warm-up sync.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", "Off")
          .addOption("lazy", "Lazy")
          .addOption("smooth", "Smooth")
          .setValue(this.plugin.settings.startupMode)
          .onChange(async (value) => {
            this.plugin.setStartupMode(value as StartupSyncMode);
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
      .setDesc("Delete conflict files from hidden sync folder and legacy *.conflict.* files.")
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
