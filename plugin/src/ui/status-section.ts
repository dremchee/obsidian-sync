import type { UiTranslator, SyncSettingsTabPlugin } from "./types";
import { createKeyValueRow, createPanel } from "./helpers";

export function formatStatusTimestamp(timestamp: number, t: UiTranslator) {
  return timestamp ? new Date(timestamp).toLocaleString() : t("status.last_sync_never");
}

export function renderSyncStatusSection(
  containerEl: HTMLElement,
  plugin: SyncSettingsTabPlugin,
  t: UiTranslator
) {
  containerEl.createEl("h3", { text: t("settings.section_status") });
  const panel = createPanel(containerEl, "custom-sync-status-panel");

  const actionsEl = panel.createDiv();
  actionsEl.style.display = "flex";
  actionsEl.style.justifyContent = "flex-end";
  actionsEl.style.marginBottom = "4px";

  const syncNowButton = actionsEl.createEl("button", {
    text: t("settings.sync_status.sync_now")
  });
  syncNowButton.addClass("mod-cta");
  syncNowButton.addEventListener("click", () => {
    syncNowButton.disabled = true;
    plugin.triggerImmediateSync();
    globalThis.setTimeout(() => {
      syncNowButton.disabled = false;
    }, 1000);
  });

  const rows = [
    t("settings.sync_status.current_state"),
    t("settings.sync_status.current_phase"),
    t("settings.sync_status.last_sync"),
    t("settings.sync_status.next_sync"),
    t("settings.sync_status.pending_ops"),
    t("settings.sync_status.sync_queued"),
    t("settings.sync_status.websocket"),
    t("settings.sync_status.vault"),
    t("settings.sync_status.device_id"),
    t("settings.sync_status.last_error"),
    t("settings.sync_status.last_pull_events"),
    t("settings.sync_status.last_pull_applied"),
    t("settings.sync_status.last_push_ops"),
    t("settings.sync_status.last_blob_batch")
  ].map((label) => createKeyValueRow(panel, label).valueEl);

  const activityWrap = panel.createDiv();
  activityWrap.style.borderTop = "1px solid var(--background-modifier-border)";
  activityWrap.style.paddingTop = "10px";
  activityWrap.style.display = "grid";
  activityWrap.style.gap = "8px";

  const activityTitle = activityWrap.createDiv({ text: t("settings.sync_status.recent_activity") });
  activityTitle.style.fontSize = "13px";
  activityTitle.style.fontWeight = "600";
  activityTitle.style.color = "var(--text-muted)";

  const activityList = activityWrap.createDiv();
  activityList.style.display = "grid";
  activityList.style.gap = "6px";

  const render = () => {
    const snapshot = plugin.getSyncStatusSnapshot();
    rows[0].setText(t(`settings.sync_status.state.${snapshot.overallState}`));
    rows[1].setText(t(`settings.sync_status.phase.${snapshot.currentPhase}`));
    rows[2].setText(formatStatusTimestamp(snapshot.lastSyncAt, t));
    rows[3].setText(snapshot.nextSyncAt ? formatStatusTimestamp(snapshot.nextSyncAt, t) : t("settings.sync_status.none"));
    rows[4].setText(String(snapshot.pendingOperationCount));
    rows[5].setText(snapshot.syncQueued ? t("settings.sync_status.yes") : t("settings.sync_status.no"));
    rows[6].setText(t(`settings.sync_status.websocket_state.${snapshot.wsConnectionState}`));
    rows[7].setText(snapshot.vaultName || t("settings.sync_status.none"));
    rows[8].setText(snapshot.deviceId || t("settings.sync_status.none"));
    rows[9].setText(snapshot.lastError || t("settings.sync_status.none"));
    rows[10].setText(String(snapshot.lastPullEvents));
    rows[11].setText(String(snapshot.lastPullApplied));
    rows[12].setText(String(snapshot.lastPushOperations));
    rows[13].setText(
      `${snapshot.lastBlobBatchHashes}/${snapshot.lastBlobBatchItems}/${snapshot.lastBlobBatchDeferred} • ${formatBytes(snapshot.lastBlobBatchBytes)}`
    );
    syncNowButton.disabled = snapshot.overallState === "syncing";

    activityList.empty();
    if (!snapshot.recentActivity.length) {
      const emptyEl = activityList.createDiv({ text: t("settings.sync_status.none") });
      emptyEl.style.fontSize = "12px";
      emptyEl.style.color = "var(--text-muted)";
      return;
    }

    for (const item of snapshot.recentActivity) {
      const rowEl = activityList.createDiv();
      rowEl.style.display = "grid";
      rowEl.style.gridTemplateColumns = "72px 1fr";
      rowEl.style.gap = "12px";
      rowEl.style.alignItems = "start";

      const timeEl = rowEl.createSpan({ text: new Date(item.ts).toLocaleTimeString() });
      timeEl.style.fontSize = "12px";
      timeEl.style.color = "var(--text-muted)";

      const messageEl = rowEl.createSpan({ text: item.message });
      messageEl.style.fontSize = "12px";
      if (item.kind === "error") {
        messageEl.style.color = "var(--color-red)";
      } else if (item.kind === "sync") {
        messageEl.style.color = "var(--color-green)";
      }
    }
  };

  render();
  return globalThis.setInterval(render, 1000);
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
