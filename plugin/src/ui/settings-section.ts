import { Setting } from "obsidian";
import type { BootstrapPolicy, StartupSyncMode } from "../settings";
import { appendSection } from "./helpers";
import type { SyncSettingsTabPlugin, UiTranslator } from "./types";

export function renderPluginSettingsSection(
  containerEl: HTMLElement,
  plugin: SyncSettingsTabPlugin,
  t: UiTranslator
) {
  appendSection(containerEl, "Plugin");

  new Setting(containerEl)
    .setName(t("settings.enable_sync.name"))
    .setDesc(t("settings.enable_sync.desc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.syncEnabled)
        .onChange(async (value) => {
          plugin.settings.syncEnabled = value;
          await plugin.saveSettings();
        })
    );

  appendSection(containerEl, t("settings.section_startup"));

  new Setting(containerEl)
    .setName(t("settings.startup_mode.name"))
    .setDesc(t("settings.startup_mode.desc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("off", t("settings.startup_mode.off"))
        .addOption("immediate", t("settings.startup_mode.immediate"))
        .addOption("smooth", t("settings.startup_mode.smooth"))
        .setValue(plugin.settings.startupMode)
        .onChange(async (value) => {
          plugin.setStartupMode(value as StartupSyncMode);
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName(t("settings.bootstrap_policy.name"))
    .setDesc(t("settings.bootstrap_policy.desc"))
    .addDropdown((dropdown) =>
      dropdown
        .addOption("merge", t("settings.bootstrap_policy.merge"))
        .addOption("remote_wins", t("settings.bootstrap_policy.remote_wins"))
        .addOption("local_wins", t("settings.bootstrap_policy.local_wins"))
        .setValue(plugin.settings.bootstrapPolicy)
        .onChange(async (value) => {
          plugin.settings.bootstrapPolicy = value as BootstrapPolicy;
          await plugin.saveSettings();
        })
    );

  appendSection(containerEl, t("settings.section_performance"));

  new Setting(containerEl)
    .setName(t("settings.interval_sec.name"))
    .setDesc(t("settings.interval_sec.desc"))
    .addText((text) =>
      text
        .setValue(String(plugin.settings.intervalSec))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          plugin.settings.intervalSec = Number.isFinite(parsed) ? parsed : 30;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName(t("settings.enable_websocket.name"))
    .setDesc(t("settings.enable_websocket.desc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.enableWebSocket)
        .onChange(async (value) => {
          plugin.settings.enableWebSocket = value;
          await plugin.saveSettings();
        })
    );

  appendSection(containerEl, t("settings.section_reliability"));

  new Setting(containerEl)
    .setName(t("settings.pull_batch.name"))
    .setDesc(t("settings.pull_batch.desc"))
    .addText((text) =>
      text
        .setValue(String(plugin.settings.pullBatchSize))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          plugin.settings.pullBatchSize = Number.isFinite(parsed) ? Math.max(10, Math.min(1000, parsed)) : 100;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName(t("settings.blob_batch.name"))
    .setDesc(t("settings.blob_batch.desc"))
    .addText((text) =>
      text
        .setValue(String(plugin.settings.blobBatchSize))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          plugin.settings.blobBatchSize = Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 20;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName(t("settings.concurrent_uploads.name"))
    .setDesc(t("settings.concurrent_uploads.desc"))
    .addText((text) =>
      text
        .setValue(String(plugin.settings.maxConcurrentUploads))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          plugin.settings.maxConcurrentUploads = Number.isFinite(parsed) ? Math.max(1, Math.min(8, parsed)) : 2;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName(t("settings.retry_window.name"))
    .setDesc(t("settings.retry_window.desc"))
    .addText((text) =>
      text
        .setPlaceholder(t("settings.retry_window.base"))
        .setValue(String(plugin.settings.retryBaseMs))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          plugin.settings.retryBaseMs = Number.isFinite(parsed) ? Math.max(100, parsed) : 500;
          await plugin.saveSettings();
        })
    )
    .addText((text) =>
      text
        .setPlaceholder(t("settings.retry_window.max"))
        .setValue(String(plugin.settings.retryMaxMs))
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          plugin.settings.retryMaxMs = Number.isFinite(parsed) ? Math.max(plugin.settings.retryBaseMs, parsed) : 30_000;
          await plugin.saveSettings();
        })
    );

  new Setting(containerEl)
    .setName(t("settings.debug_perf.name"))
    .setDesc(t("settings.debug_perf.desc"))
    .addToggle((toggle) =>
      toggle
        .setValue(plugin.settings.debugPerfLogs)
        .onChange(async (value) => {
          plugin.settings.debugPerfLogs = value;
          await plugin.saveSettings();
        })
    );
}
