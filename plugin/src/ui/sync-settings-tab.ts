import { App, Notice, Plugin, PluginSettingTab, Setting, setIcon } from "obsidian";
import type { SyncEngine } from "../sync/engine";
import type { PluginLanguage, StartupSyncMode, SyncSettings } from "../settings";

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
  t: (key: string, params?: Record<string, string | number>) => string;
}

type SyncSettingsTabPlugin = Plugin & SyncSettingsTabContext;

export class SyncSettingsTab extends PluginSettingTab {
  plugin: SyncSettingsTabPlugin;
  private passphraseVisible = false;

  constructor(app: App, plugin: SyncSettingsTabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const t = this.plugin.t;
    const maskSecret = (value: string) => {
      if (!value) return "";
      if (value.length <= 4) return "*".repeat(value.length);
      return `${"*".repeat(Math.max(8, value.length - 4))}${value.slice(-4)}`;
    };
    const copyValue = async (value: string, valueLabel: string) => {
      if (!value) {
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        new Notice(t("notices.copied", { value: valueLabel }));
      } catch (error) {
        new Notice(t("notices.copy_failed", { error: String(error) }));
      }
    };
    const addSection = (title: string, desc?: string) => {
      containerEl.createEl("h3", { text: title });
      if (desc) {
        containerEl.createEl("p", { text: desc, cls: "setting-item-description" });
      }
    };

    addSection(t("settings.section_connection"));

    new Setting(containerEl)
      .setName(t("settings.language.name"))
      .setDesc(t("settings.language.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", t("settings.language.auto"))
          .addOption("en", t("settings.language.en"))
          .addOption("ru", t("settings.language.ru"))
          .setValue(this.plugin.settings.language)
          .onChange(async (value) => {
            this.plugin.settings.language = value as PluginLanguage;
            await this.plugin.saveSettings();
            this.display();
          })
      );

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

    addSection(t("settings.section_server"));

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

      const message = (this.plugin.serverConnectionMessage || t("settings.server.not_checked")).trim();
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
          });
      });

    addSection(t("settings.section_performance"));

    new Setting(containerEl)
      .setName(t("settings.api_key.name"))
      .setDesc(t("settings.api_key.desc"))
      .addText((text) => {
        text.inputEl.type = "password";
        return text
          .setValue(maskSecret(this.plugin.settings.apiKey))
          .setDisabled(true);
      })
      .addExtraButton((button) => {
        button
          .setIcon("copy")
          .setTooltip(t("settings.api_key.copy"))
          .setDisabled(!this.plugin.settings.apiKey);

        button.onClick(async () => {
          await copyValue(this.plugin.settings.apiKey, t("settings.api_key.name"));
          button.setIcon("check");
          setTimeout(() => {
            button.setIcon("copy");
          }, 2000);
        });
      });

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

    addSection(t("settings.section_security"));

    new Setting(containerEl)
      .setName(t("settings.lww_policy.name"))
      .setDesc(t("settings.lww_policy.desc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.lwwPolicy)
          .setDisabled(true)
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

    addSection(t("settings.section_device"));

    new Setting(containerEl)
      .setName(t("settings.device_id.name"))
      .setDesc(t("settings.device_id.desc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.deviceId)
          .setDisabled(true)
      )
      .addExtraButton((button) => {
        button
          .setIcon("copy")
          .setTooltip(t("settings.device_id.copy"))
          .setDisabled(!this.plugin.settings.deviceId);

        button.onClick(async () => {
          await copyValue(this.plugin.settings.deviceId, t("settings.device_id.name"));
          button.setIcon("check");
          setTimeout(() => {
            button.setIcon("copy");
          }, 2000);
        });
      });

    new Setting(containerEl)
      .setName(t("settings.vault_name.name"))
      .setDesc(t("settings.vault_name.desc"))
      .addText((text) =>
        text
          .setValue(this.plugin.settings.vaultName)
          .onChange(async (value) => {
            this.plugin.settings.vaultName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName(t("settings.register_device.name"))
      .setDesc(
        this.plugin.isDeviceRevoked
          ? t("settings.register_device.revoked_desc")
          : t("settings.register_device.desc")
      )
      .addButton((button) => {
        const isRegistered = this.plugin.settings.apiKey && !this.plugin.isDeviceRevoked;

        button.setDisabled(isRegistered);
        button.setButtonText(
          isRegistered
            ? "Зарегистрировано"
            : this.plugin.isDeviceRevoked
              ? t("settings.register_device.button_reregister")
              : t("settings.register_device.button")
        );

        if (!isRegistered) {
          button.onClick(async () => {
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
          });
        }
      });

  }
}
