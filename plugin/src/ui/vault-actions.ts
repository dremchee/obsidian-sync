import { Notice } from "obsidian";
import type { BootstrapPolicy } from "../settings";
import type { SyncSettingsTabPlugin, UiTranslator } from "./types";
import type { VaultInfo } from "./vault-section";

type VaultActionCallbacks = {
  onVaultsInvalidated?: () => void;
  onReload: () => void;
  loadVaults: () => Promise<void>;
};

export async function handleCreateVault(
  plugin: SyncSettingsTabPlugin,
  vaultName: string,
  passphrase: string,
  t: UiTranslator,
  callbacks: VaultActionCallbacks
) {
  plugin.settings.passphrase = passphrase;
  plugin.settings.vaultName = vaultName;
  try {
    plugin.engine?.resetState();
    plugin.engine?.setNewVault(true);
    plugin.engine?.markAllFilesDirty();
    await plugin.engine?.createVault(vaultName, passphrase);
    const reg = await plugin.engine?.registerDevice();
    if (!reg) return;
    plugin.settings.apiKey = reg.apiKey;
    plugin.settings.deviceId = reg.deviceId;
    await plugin.saveSettings();
    plugin.isDeviceRevoked = false;
    plugin.revokedNoticeShown = false;
    new Notice(t("notices.device_registered"));
    plugin.triggerImmediateSync();
    callbacks.onReload();
  } catch (err) {
    new Notice(t("notices.vault_create_failed", { error: String(err) }));
  }
}

export async function handleJoinVault(
  plugin: SyncSettingsTabPlugin,
  vault: VaultInfo,
  bootstrapPolicy: BootstrapPolicy,
  passphrase: string,
  vaultName: string,
  t: UiTranslator,
  callbacks: VaultActionCallbacks
) {
  try {
    await plugin.engine?.verifyPassphrase(vault.id, passphrase);
  } catch {
    new Notice(t("notices.passphrase_invalid"));
    return;
  }

  plugin.settings.passphrase = passphrase;
  plugin.settings.vaultName = vaultName;
  try {
    plugin.engine?.resetState();
    plugin.engine?.beginBootstrap(bootstrapPolicy);
    const reg = await plugin.engine?.registerDevice();
    if (!reg) return;
    plugin.settings.apiKey = reg.apiKey;
    plugin.settings.deviceId = reg.deviceId;
    await plugin.saveSettings();
    plugin.isDeviceRevoked = false;
    plugin.revokedNoticeShown = false;
    new Notice(t("notices.device_registered"));
    plugin.triggerImmediateSync();
    callbacks.onReload();
  } catch (err) {
    new Notice(t("notices.register_failed", { error: String(err) }));
  }
}

export async function handleDeleteVault(
  plugin: SyncSettingsTabPlugin,
  vault: VaultInfo,
  passphrase: string,
  t: UiTranslator,
  callbacks: VaultActionCallbacks
) {
  try {
    await plugin.engine?.deleteVault(vault.id, passphrase);
    new Notice(t("notices.vault_deleted", { name: vault.name }));
    callbacks.onVaultsInvalidated?.();
    await callbacks.loadVaults();
  } catch (err) {
    new Notice(t("notices.vault_delete_failed", { error: String(err) }));
  }
}
