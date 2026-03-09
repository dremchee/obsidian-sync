import { Notice } from "obsidian";
import type { SyncSettingsTabPlugin, VaultListState } from "./types";
import type { VaultInfo } from "./vault-section";

export class SettingsTabController {
  private readonly plugin: SyncSettingsTabPlugin;
  private readonly refresh: () => void;
  private statusRefreshTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private vaultState: VaultListState<VaultInfo> = {
    vaults: [],
    vaultsLoaded: false,
    vaultsLoading: false
  };

  constructor(plugin: SyncSettingsTabPlugin, refresh: () => void) {
    this.plugin = plugin;
    this.refresh = refresh;
  }

  getVaultState() {
    return this.vaultState;
  }

  setStatusRefreshTimer(timer: ReturnType<typeof globalThis.setInterval> | null) {
    this.clearStatusRefreshTimer();
    this.statusRefreshTimer = timer;
  }

  clearStatusRefreshTimer() {
    if (!this.statusRefreshTimer) {
      return;
    }
    globalThis.clearInterval(this.statusRefreshTimer);
    this.statusRefreshTimer = null;
  }

  invalidateVaults() {
    this.vaultState.vaultsLoaded = false;
  }

  async ensureVaultsLoaded() {
    if (this.vaultState.vaultsLoaded || this.vaultState.vaultsLoading) {
      return;
    }
    if (!this.plugin.settings.authToken || !this.plugin.settings.serverUrl) {
      return;
    }
    await this.loadVaults();
  }

  async loadVaults() {
    this.vaultState.vaultsLoading = true;
    this.refresh();
    try {
      const res = await this.plugin.engine?.listVaults();
      this.vaultState.vaults = res?.vaults || [];
      this.vaultState.vaultsLoaded = true;
    } catch (err) {
      new Notice(this.plugin.t("notices.vault_load_failed", { error: String(err) }));
      this.vaultState.vaults = [];
    } finally {
      this.vaultState.vaultsLoading = false;
      this.refresh();
    }
  }
}
