import { App, Notice, PluginSettingTab } from "obsidian";
import { appendSection } from "./helpers";
import { renderConnectionSection } from "./connection-section";
import { renderConflictSection } from "./conflict-section";
import { renderPluginSettingsSection } from "./settings-section";
import { SettingsTabController } from "./settings-tab-controller";
import { renderSyncStatusSection } from "./status-section";
import type { SyncSettingsTabPlugin } from "./types";
import { renderRegisteredVaultSection, renderVaultPickerSection, type VaultInfo } from "./vault-section";
import { handleCreateVault, handleDeleteVault, handleJoinVault } from "./vault-actions";

export class SyncSettingsTab extends PluginSettingTab {
  plugin: SyncSettingsTabPlugin;
  private readonly controller: SettingsTabController;

  constructor(app: App, plugin: SyncSettingsTabPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.controller = new SettingsTabController(plugin, () => this.display());
  }

  display() {
    const { containerEl } = this;
    this.controller.clearStatusRefreshTimer();
    containerEl.empty();
    const t = this.plugin.t;
    const isRegistered = Boolean(this.plugin.settings.apiKey && !this.plugin.isDeviceRevoked);

    if (this.plugin.serverConnectionState === "unknown" && this.plugin.settings.serverUrl) {
      this.plugin.testServerConnection({ silent: true });
    }

    renderConnectionSection(containerEl, this.plugin, t, {
      onAuthTokenChanged: () => {
        this.controller.invalidateVaults();
      }
    });

    // --- Vault ---
    appendSection(containerEl, t("settings.section_vault"));

    if (isRegistered) {
      renderRegisteredVaultSection(containerEl, this.plugin, t, {
        onDisconnected: () => {
          this.controller.invalidateVaults();
          this.display();
        },
        onReload: () => this.display()
      });
      this.controller.setStatusRefreshTimer(renderSyncStatusSection(containerEl, this.plugin, t));
    } else {
      void this.controller.ensureVaultsLoaded();
      renderVaultPickerSection(this.app, containerEl, this.plugin, t, this.controller.getVaultState(), {
        onJoinVault: async (vault, bootstrapPolicy, passphrase, vaultName) => {
          await handleJoinVault(this.plugin, vault, bootstrapPolicy, passphrase, vaultName, t, {
            onReload: () => this.display(),
            loadVaults: () => this.controller.loadVaults()
          });
        },
        onDeleteVault: async (vault, passphrase) => {
          await handleDeleteVault(this.plugin, vault, passphrase, t, {
            onVaultsInvalidated: () => {
              this.controller.invalidateVaults();
            },
            onReload: () => this.display(),
            loadVaults: () => this.controller.loadVaults()
          });
        },
        onCreateVault: async (vaultName, passphrase) => {
          await handleCreateVault(this.plugin, vaultName, passphrase, t, {
            onReload: () => this.display(),
            loadVaults: () => this.controller.loadVaults()
          });
        }
      });
    }

    if (!isRegistered) return;

    // --- Conflicts ---
    renderConflictSection(this.app, containerEl, t, () => this.display());

    renderPluginSettingsSection(containerEl, this.plugin, t);
  }

  hide() {
    this.controller.clearStatusRefreshTimer();
  }
}
