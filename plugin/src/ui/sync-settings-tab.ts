import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { SyncEngine } from "../sync/engine";
import type { StartupSyncMode, SyncSettings } from "../settings";

export type ServerConnectionState = "unknown" | "ok" | "error";

type VaultInfo = { id: string; name: string; createdAt: number; deviceCount: number };

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
  t: (key: string, params?: Record<string, string | number>) => string;
}

type SyncSettingsTabPlugin = Plugin & SyncSettingsTabContext;

export class SyncSettingsTab extends PluginSettingTab {
  plugin: SyncSettingsTabPlugin;
  private passphraseVisible = false;
  private vaults: VaultInfo[] = [];
  private vaultsLoaded = false;
  private vaultsLoading = false;

  constructor(app: App, plugin: SyncSettingsTabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const t = this.plugin.t;
    const isRegistered = Boolean(this.plugin.settings.apiKey && !this.plugin.isDeviceRevoked);

    const addSection = (title: string, desc?: string) => {
      containerEl.createEl("h3", { text: title });
      if (desc) {
        containerEl.createEl("p", { text: desc, cls: "setting-item-description" });
      }
    };

    // --- Connection ---
    addSection(t("settings.section_connection"));

    const serverUrlSetting = new Setting(containerEl)
      .setName(t("settings.server_url.name"))
      .setDesc(t("settings.server_url.desc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim();
            await this.plugin.saveSettings();
          })
      )
      .addButton((button) =>
        button.setButtonText(t("settings.server_url.test")).onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.testServerConnection();
          } finally {
            button.setDisabled(false);
          }
        })
      );

    const statusState = this.plugin.serverConnectionState;
    const statusLabel =
      statusState === "ok"
        ? t("settings.server_status.ok")
        : statusState === "error"
          ? t("settings.server_status.error")
          : t("settings.server_status.unknown");
    const statusColor =
      statusState === "ok"
        ? "var(--color-green)"
        : statusState === "error"
          ? "var(--color-red)"
          : "var(--text-muted)";
    const serverUrlDesc = serverUrlSetting.settingEl.querySelector(".setting-item-description");
    if (serverUrlDesc instanceof HTMLElement) {
      const statusRow = serverUrlDesc.createDiv({ cls: "custom-sync-server-status" });
      statusRow.style.display = "flex";
      statusRow.style.alignItems = "center";
      statusRow.style.gap = "6px";
      statusRow.style.marginTop = "4px";

      const statusEl = statusRow.createSpan({
        text: t("settings.server_status.inline", { value: statusLabel })
      });
      statusEl.style.color = statusColor;
      statusEl.style.fontWeight = "600";
      statusEl.style.fontSize = "12px";
    }

    new Setting(containerEl)
      .setName(t("settings.auth_token.name"))
      .setDesc(t("settings.auth_token.desc"))
      .addText((text) => {
        text.inputEl.type = "password";
        return text
          .setPlaceholder(t("settings.auth_token.placeholder"))
          .setValue(this.plugin.settings.authToken)
          .onChange(async (value) => {
            this.plugin.settings.authToken = value.trim();
            await this.plugin.saveSettings();
            this.vaultsLoaded = false;
          });
      });

    // --- Passphrase ---
    let passphraseInput: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName(t("settings.passphrase.name"))
      .setDesc(t("settings.passphrase.desc"))
      .addText((text) => {
        passphraseInput = text.inputEl;
        text.inputEl.type = this.passphraseVisible ? "text" : "password";
        return text
          .setPlaceholder(t("settings.passphrase.placeholder"))
          .setValue(this.plugin.settings.passphrase)
          .onChange(async (value) => {
            this.plugin.settings.passphrase = value;
            await this.plugin.saveSettings();
          });
      })
      .addExtraButton((button) => {
        const applyIconAndTooltip = () => {
          button.setIcon(this.passphraseVisible ? "eye-off" : "eye");
          button.setTooltip(this.passphraseVisible ? t("settings.passphrase.hide") : t("settings.passphrase.show"));
        };
        applyIconAndTooltip();
        button.onClick(() => {
          this.passphraseVisible = !this.passphraseVisible;
          if (passphraseInput) {
            passphraseInput.type = this.passphraseVisible ? "text" : "password";
          }
          applyIconAndTooltip();
        });
      });

    // --- Vault ---
    addSection(t("settings.section_vault"));

    if (isRegistered) {
      this.renderRegisteredVault(containerEl, t);
    } else {
      this.renderVaultPicker(containerEl, t);
    }

    if (!isRegistered) return;

    // --- Plugin settings (only when registered) ---
    addSection("Plugin");

    new Setting(containerEl)
      .setName(t("settings.enable_sync.name"))
      .setDesc(t("settings.enable_sync.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncEnabled)
          .onChange(async (value) => {
            this.plugin.settings.syncEnabled = value;
            await this.plugin.saveSettings();
          })
      );

    addSection(t("settings.section_startup"));

    new Setting(containerEl)
      .setName(t("settings.startup_mode.name"))
      .setDesc(t("settings.startup_mode.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("off", t("settings.startup_mode.off"))
          .addOption("immediate", t("settings.startup_mode.immediate"))
          .addOption("smooth", t("settings.startup_mode.smooth"))
          .setValue(this.plugin.settings.startupMode)
          .onChange(async (value) => {
            this.plugin.setStartupMode(value as StartupSyncMode);
            await this.plugin.saveSettings();
          })
      );

    addSection(t("settings.section_performance"));

    new Setting(containerEl)
      .setName(t("settings.interval_sec.name"))
      .setDesc(t("settings.interval_sec.desc"))
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
      .setName(t("settings.enable_websocket.name"))
      .setDesc(t("settings.enable_websocket.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableWebSocket)
          .onChange(async (value) => {
            this.plugin.settings.enableWebSocket = value;
            await this.plugin.saveSettings();
          })
      );

    addSection(t("settings.section_reliability"));

    new Setting(containerEl)
      .setName(t("settings.pull_batch.name"))
      .setDesc(t("settings.pull_batch.desc"))
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pullBatchSize))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.pullBatchSize = Number.isFinite(parsed) ? Math.max(10, Math.min(1000, parsed)) : 100;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.blob_batch.name"))
      .setDesc(t("settings.blob_batch.desc"))
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.blobBatchSize))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.blobBatchSize = Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 20;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.concurrent_uploads.name"))
      .setDesc(t("settings.concurrent_uploads.desc"))
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxConcurrentUploads))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.maxConcurrentUploads = Number.isFinite(parsed) ? Math.max(1, Math.min(8, parsed)) : 2;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.retry_window.name"))
      .setDesc(t("settings.retry_window.desc"))
      .addText((text) =>
        text
          .setPlaceholder(t("settings.retry_window.base"))
          .setValue(String(this.plugin.settings.retryBaseMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.retryBaseMs = Number.isFinite(parsed) ? Math.max(100, parsed) : 500;
            await this.plugin.saveSettings();
          })
      )
      .addText((text) =>
        text
          .setPlaceholder(t("settings.retry_window.max"))
          .setValue(String(this.plugin.settings.retryMaxMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.retryMaxMs = Number.isFinite(parsed) ? Math.max(this.plugin.settings.retryBaseMs, parsed) : 30_000;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.debug_perf.name"))
      .setDesc(t("settings.debug_perf.desc"))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugPerfLogs)
          .onChange(async (value) => {
            this.plugin.settings.debugPerfLogs = value;
            await this.plugin.saveSettings();
          })
      );
  }

  private renderRegisteredVault(containerEl: HTMLElement, t: (key: string, params?: Record<string, string | number>) => string) {
    new Setting(containerEl)
      .setName(t("settings.vault_current.name"))
      .setDesc(t("settings.vault_current.desc", { name: this.plugin.settings.vaultName }))
      .addButton((button) =>
        button
          .setButtonText(t("settings.vault_disconnect.button"))
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.apiKey = "";
            this.plugin.settings.deviceId = "";
            this.plugin.settings.vaultName = "";
            await this.plugin.saveSettings();
            this.plugin.isDeviceRevoked = false;
            this.plugin.revokedNoticeShown = false;
            new Notice(t("notices.vault_disconnected"));
            this.vaultsLoaded = false;
            this.display();
          })
      );

    if (this.plugin.isDeviceRevoked) {
      new Setting(containerEl)
        .setName(t("settings.register_device.name"))
        .setDesc(t("settings.register_device.revoked_desc"))
        .addButton((button) =>
          button
            .setButtonText(t("settings.register_device.button_reregister"))
            .onClick(async () => {
              button.setDisabled(true);
              try {
                const reg = await this.plugin.engine?.registerDevice();
                if (reg) {
                  this.plugin.settings.apiKey = reg.apiKey;
                  this.plugin.settings.deviceId = reg.deviceId;
                  await this.plugin.saveSettings();
                  this.plugin.isDeviceRevoked = false;
                  this.plugin.revokedNoticeShown = false;
                  new Notice(t("notices.device_registered"));
                  this.display();
                }
              } catch (err) {
                new Notice(t("notices.register_failed", { error: String(err) }));
              } finally {
                button.setDisabled(false);
              }
            })
        );
    }
  }

  private renderVaultPicker(containerEl: HTMLElement, t: (key: string, params?: Record<string, string | number>) => string) {
    if (!this.plugin.settings.authToken || !this.plugin.settings.serverUrl) {
      containerEl.createEl("p", {
        text: t("settings.vault_picker.configure_first"),
        cls: "setting-item-description"
      });
      return;
    }

    // Load vaults button / auto-load
    if (!this.vaultsLoaded && !this.vaultsLoading) {
      new Setting(containerEl)
        .setName(t("settings.vault_picker.load"))
        .addButton((button) =>
          button.setButtonText(t("settings.vault_picker.load_button")).onClick(() => {
            this.loadVaults();
          })
        );
      return;
    }

    if (this.vaultsLoading) {
      containerEl.createEl("p", {
        text: t("settings.vault_picker.loading"),
        cls: "setting-item-description"
      });
      return;
    }

    // Vault list
    if (this.vaults.length > 0) {
      for (const vault of this.vaults) {
        const date = new Date(vault.createdAt).toLocaleDateString();
        new Setting(containerEl)
          .setName(vault.name)
          .setDesc(t("settings.vault_picker.vault_info", { devices: vault.deviceCount, date }))
          .addButton((button) =>
            button.setButtonText(t("settings.vault_picker.join")).onClick(async () => {
              await this.joinVault(vault.name, t);
            })
          )
          .addButton((button) =>
            button
              .setButtonText(t("settings.vault_picker.delete"))
              .setWarning()
              .onClick(async () => {
                if (!confirm(t("settings.vault_picker.delete_confirm", { name: vault.name }))) return;
                try {
                  await this.plugin.engine?.deleteVault(vault.id);
                  new Notice(t("notices.vault_deleted", { name: vault.name }));
                  this.vaultsLoaded = false;
                  this.loadVaults();
                } catch (err) {
                  new Notice(t("notices.vault_delete_failed", { error: String(err) }));
                }
              })
          );
      }
    } else {
      containerEl.createEl("p", {
        text: t("settings.vault_picker.empty"),
        cls: "setting-item-description"
      });
    }

    // Create new vault
    let newVaultName = "";
    new Setting(containerEl)
      .setName(t("settings.vault_picker.create_name"))
      .addText((text) =>
        text
          .setPlaceholder(t("settings.vault_picker.create_placeholder"))
          .onChange((value) => { newVaultName = value.trim(); })
      )
      .addButton((button) =>
        button.setButtonText(t("settings.vault_picker.create_button")).onClick(async () => {
          if (!newVaultName) return;
          if (!this.plugin.settings.passphrase) {
            new Notice(t("notices.passphrase_required"));
            return;
          }
          button.setDisabled(true);
          try {
            await this.plugin.engine?.createVault(newVaultName);
            await this.joinVault(newVaultName, t);
          } catch (err) {
            new Notice(t("notices.vault_create_failed", { error: String(err) }));
          } finally {
            button.setDisabled(false);
          }
        })
      );
  }

  private async joinVault(vaultName: string, t: (key: string, params?: Record<string, string | number>) => string) {
    if (!this.plugin.settings.passphrase) {
      new Notice(t("notices.passphrase_required"));
      return;
    }
    this.plugin.settings.vaultName = vaultName;
    try {
      const reg = await this.plugin.engine?.registerDevice();
      if (reg) {
        this.plugin.settings.apiKey = reg.apiKey;
        this.plugin.settings.deviceId = reg.deviceId;
        await this.plugin.saveSettings();
        this.plugin.isDeviceRevoked = false;
        this.plugin.revokedNoticeShown = false;
        new Notice(t("notices.device_registered"));
        this.display();
      }
    } catch (err) {
      new Notice(t("notices.register_failed", { error: String(err) }));
    }
  }

  private async loadVaults() {
    this.vaultsLoading = true;
    this.display();
    try {
      const res = await this.plugin.engine?.listVaults();
      this.vaults = res?.vaults || [];
      this.vaultsLoaded = true;
    } catch (err) {
      new Notice(this.plugin.t("notices.vault_load_failed", { error: String(err) }));
      this.vaults = [];
    } finally {
      this.vaultsLoading = false;
      this.display();
    }
  }
}
