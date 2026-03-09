import { Notice, Setting } from "obsidian";
import type { App } from "obsidian";
import { VaultConnectModal } from "./create-vault-modal";
import type { UiTranslator, SyncSettingsTabPlugin } from "./types";

export type VaultInfo = { id: string; name: string; createdAt: number; deviceCount: number };

type VaultSectionCallbacks = {
  onDisconnected: () => void;
  onReload: () => void;
  onJoinVault: (vault: VaultInfo, bootstrapPolicy: "merge" | "remote_wins" | "local_wins", passphrase: string, vaultName: string) => Promise<void>;
  onDeleteVault: (vault: VaultInfo, passphrase: string) => Promise<void>;
  onCreateVault: (vaultName: string, passphrase: string) => Promise<void>;
};

export function renderRegisteredVaultSection(
  containerEl: HTMLElement,
  plugin: SyncSettingsTabPlugin,
  t: UiTranslator,
  callbacks: Pick<VaultSectionCallbacks, "onDisconnected" | "onReload">
) {
  new Setting(containerEl)
    .setName(t("settings.vault_current.name"))
    .setDesc(t("settings.vault_current.desc", { name: plugin.settings.vaultName }))
    .addButton((button) =>
      button
        .setButtonText(t("settings.vault_disconnect.button"))
        .setWarning()
        .onClick(async () => {
          plugin.engine?.resetState();
          plugin.settings.apiKey = "";
          plugin.settings.deviceId = "";
          plugin.settings.vaultName = "";
          plugin.settings.passphrase = "";
          await plugin.saveSettings();
          plugin.isDeviceRevoked = false;
          plugin.revokedNoticeShown = false;
          new Notice(t("notices.vault_disconnected"));
          callbacks.onDisconnected();
        })
    );

  if (!plugin.isDeviceRevoked) {
    return;
  }

  new Setting(containerEl)
    .setName(t("settings.register_device.name"))
    .setDesc(t("settings.register_device.revoked_desc"))
    .addButton((button) =>
      button
        .setButtonText(t("settings.register_device.button_reregister"))
        .onClick(async () => {
          button.setDisabled(true);
          try {
            const reg = await plugin.engine?.registerDevice();
            if (reg) {
              plugin.settings.apiKey = reg.apiKey;
              plugin.settings.deviceId = reg.deviceId;
              await plugin.saveSettings();
              plugin.isDeviceRevoked = false;
              plugin.revokedNoticeShown = false;
              new Notice(t("notices.device_registered"));
              callbacks.onReload();
            }
          } catch (err) {
            new Notice(t("notices.register_failed", { error: String(err) }));
          } finally {
            button.setDisabled(false);
          }
        })
    );
}

export function renderVaultPickerSection(
  app: App,
  containerEl: HTMLElement,
  plugin: SyncSettingsTabPlugin,
  t: UiTranslator,
  state: { vaults: VaultInfo[]; vaultsLoaded: boolean; vaultsLoading: boolean },
  callbacks: Pick<VaultSectionCallbacks, "onJoinVault" | "onDeleteVault" | "onCreateVault">
) {
  if (!plugin.settings.authToken || !plugin.settings.serverUrl) {
    containerEl.createEl("p", {
      text: t("settings.vault_picker.configure_first"),
      cls: "setting-item-description"
    });
    return;
  }

  if (!state.vaultsLoaded && !state.vaultsLoading) {
    return;
  }

  if (state.vaultsLoading) {
    containerEl.createEl("p", {
      text: t("settings.vault_picker.loading"),
      cls: "setting-item-description"
    });
    return;
  }

  if (state.vaults.length > 0) {
    for (const vault of state.vaults) {
      const date = new Date(vault.createdAt).toLocaleDateString();
      new Setting(containerEl)
        .setName(vault.name)
        .setDesc(t("settings.vault_picker.vault_info", { devices: vault.deviceCount, date }))
        .addButton((button) =>
          button.setButtonText(t("settings.vault_picker.join")).onClick(() => {
            new VaultConnectModal(app, {
              mode: "join",
              vaultName: vault.name,
              bootstrapPolicy: plugin.settings.bootstrapPolicy,
              t,
              onSubmit: async (result) => {
                await callbacks.onJoinVault(vault, result.bootstrapPolicy, result.passphrase, result.vaultName);
              }
            }).open();
          })
        )
        .addButton((button) =>
          button
            .setButtonText(t("settings.vault_picker.delete"))
            .setWarning()
            .onClick(() => {
              new VaultConnectModal(app, {
                mode: "delete",
                vaultName: vault.name,
                t,
                onSubmit: async (result) => {
                  await callbacks.onDeleteVault(vault, result.passphrase);
                }
              }).open();
            })
        );
    }
  } else {
    containerEl.createEl("p", {
      text: t("settings.vault_picker.empty"),
      cls: "setting-item-description"
    });
  }

  new Setting(containerEl)
    .setName(t("settings.vault_picker.create_name"))
    .addButton((button) =>
      button.setButtonText(t("settings.vault_picker.create_button")).onClick(() => {
        new VaultConnectModal(app, {
          mode: "create",
          bootstrapPolicy: plugin.settings.bootstrapPolicy,
          t,
          onSubmit: async (result) => {
            await callbacks.onCreateVault(result.vaultName, result.passphrase);
          }
        }).open();
      })
    );
}
