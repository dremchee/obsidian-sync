import { Setting } from "obsidian";
import { appendSection } from "./helpers";
import type { SyncSettingsTabPlugin, UiTranslator } from "./types";

export function renderConnectionSection(
  containerEl: HTMLElement,
  plugin: SyncSettingsTabPlugin,
  t: UiTranslator,
  callbacks: { onAuthTokenChanged: () => void }
) {
  appendSection(containerEl, t("settings.section_connection"));

  const serverUrlSetting = new Setting(containerEl)
    .setName(t("settings.server_url.name"))
    .setDesc(t("settings.server_url.desc"))
    .addText((text) =>
      text
        .setValue(plugin.settings.serverUrl)
        .onChange(async (value) => {
          plugin.settings.serverUrl = value.trim();
          await plugin.saveSettings();
        })
    )
    .addButton((button) =>
      button.setButtonText(t("settings.server_url.test")).onClick(async () => {
        button.setDisabled(true);
        try {
          await plugin.testServerConnection();
        } finally {
          button.setDisabled(false);
        }
      })
    );

  const statusLabel =
    plugin.serverConnectionState === "ok"
      ? t("settings.server_status.ok")
      : plugin.serverConnectionState === "error"
        ? t("settings.server_status.error")
        : t("settings.server_status.unknown");
  const statusColor =
    plugin.serverConnectionState === "ok"
      ? "var(--color-green)"
      : plugin.serverConnectionState === "error"
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
        .setValue(plugin.settings.authToken)
        .onChange(async (value) => {
          plugin.settings.authToken = value.trim();
          await plugin.saveSettings();
          callbacks.onAuthTokenChanged();
        });
    });
}
