import type { SyncStatusSnapshot, UiTranslator, SyncSettingsTabPlugin } from "./types";
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
  panel.style.gap = "14px";

  const topEl = panel.createDiv();
  topEl.style.display = "flex";
  topEl.style.justifyContent = "space-between";
  topEl.style.alignItems = "flex-start";
  topEl.style.gap = "12px";
  topEl.style.flexWrap = "wrap";

  const headingEl = topEl.createDiv();
  headingEl.style.display = "grid";
  headingEl.style.gap = "8px";
  headingEl.style.flex = "1 1 280px";

  const badgeRowEl = headingEl.createDiv();
  badgeRowEl.style.display = "flex";
  badgeRowEl.style.gap = "8px";
  badgeRowEl.style.flexWrap = "wrap";

  const stateBadgeEl = createBadge(badgeRowEl);
  const phaseBadgeEl = createBadge(badgeRowEl);

  const summaryEl = headingEl.createDiv();
  summaryEl.style.fontSize = "13px";
  summaryEl.style.lineHeight = "1.45";
  summaryEl.style.color = "var(--text-normal)";

  const actionsEl = topEl.createDiv();
  actionsEl.style.display = "flex";
  actionsEl.style.justifyContent = "flex-end";

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

  const statsGridEl = panel.createDiv();
  statsGridEl.style.display = "grid";
  statsGridEl.style.gridTemplateColumns = "repeat(auto-fit, minmax(150px, 1fr))";
  statsGridEl.style.gap = "10px";

  const pendingCard = createStatCard(statsGridEl, t("settings.sync_status.pending_ops"));
  const pullCard = createStatCard(statsGridEl, t("settings.sync_status.last_pull"));
  const pushCard = createStatCard(statsGridEl, t("settings.sync_status.last_push"));
  const blobCard = createStatCard(statsGridEl, t("settings.sync_status.last_blob_batch"));

  const detailsWrap = panel.createDiv();
  detailsWrap.style.borderTop = "1px solid var(--background-modifier-border)";
  detailsWrap.style.paddingTop = "12px";
  detailsWrap.style.display = "grid";
  detailsWrap.style.gap = "8px";

  const detailsTitle = detailsWrap.createDiv({ text: t("settings.sync_status.details") });
  detailsTitle.style.fontSize = "12px";
  detailsTitle.style.fontWeight = "600";
  detailsTitle.style.letterSpacing = "0.02em";
  detailsTitle.style.textTransform = "uppercase";
  detailsTitle.style.color = "var(--text-muted)";

  const detailsGrid = detailsWrap.createDiv();
  detailsGrid.style.display = "grid";
  detailsGrid.style.gap = "8px";

  const detailRows = [
    t("settings.sync_status.last_sync"),
    t("settings.sync_status.next_sync"),
    t("settings.sync_status.sync_queued"),
    t("settings.sync_status.websocket"),
    t("settings.sync_status.vault"),
    t("settings.sync_status.device_id"),
    t("settings.sync_status.last_error")
  ].map((label) => createKeyValueRow(detailsGrid, label).valueEl);

  const activityWrap = panel.createDiv();
  activityWrap.style.borderTop = "1px solid var(--background-modifier-border)";
  activityWrap.style.paddingTop = "12px";
  activityWrap.style.display = "grid";
  activityWrap.style.gap = "8px";

  const activityTitle = activityWrap.createDiv({ text: t("settings.sync_status.recent_activity") });
  activityTitle.style.fontSize = "12px";
  activityTitle.style.fontWeight = "600";
  activityTitle.style.letterSpacing = "0.02em";
  activityTitle.style.textTransform = "uppercase";
  activityTitle.style.color = "var(--text-muted)";

  const activityList = activityWrap.createDiv();
  activityList.style.display = "grid";
  activityList.style.gap = "6px";

  const render = () => {
    const snapshot = plugin.getSyncStatusSnapshot();
    const stateLabel = t(`settings.sync_status.state.${snapshot.overallState}`);
    const phaseLabel = t(`settings.sync_status.phase.${snapshot.currentPhase}`);

    setBadgeState(stateBadgeEl, snapshot.overallState);
    stateBadgeEl.setText(stateLabel);

    setBadgePhase(phaseBadgeEl, snapshot.currentPhase);
    phaseBadgeEl.setText(phaseLabel);

    summaryEl.setText(buildSummary(snapshot, t));

    pendingCard.valueEl.setText(String(snapshot.pendingOperationCount));
    pendingCard.metaEl.setText(snapshot.syncQueued ? t("settings.sync_status.summary.queued") : t("settings.sync_status.summary.waiting"));

    pullCard.valueEl.setText(String(snapshot.lastPullApplied));
    pullCard.metaEl.setText(
      t("settings.sync_status.summary.pull_meta", {
        applied: snapshot.lastPullApplied,
        total: snapshot.lastPullEvents
      })
    );

    pushCard.valueEl.setText(String(snapshot.lastPushOperations));
    pushCard.metaEl.setText(
      snapshot.currentPhase === "push"
        ? t("settings.sync_status.summary.in_progress")
        : t("settings.sync_status.summary.last_run")
    );

    blobCard.valueEl.setText(formatBytes(snapshot.lastBlobBatchBytes));
    blobCard.metaEl.setText(
      t("settings.sync_status.summary.blob_meta", {
        items: snapshot.lastBlobBatchItems,
        deferred: snapshot.lastBlobBatchDeferred
      })
    );

    detailRows[0].setText(formatStatusTimestamp(snapshot.lastSyncAt, t));
    detailRows[1].setText(snapshot.nextSyncAt ? formatStatusTimestamp(snapshot.nextSyncAt, t) : t("settings.sync_status.none"));
    detailRows[2].setText(snapshot.syncQueued ? t("settings.sync_status.yes") : t("settings.sync_status.no"));
    detailRows[3].setText(t(`settings.sync_status.websocket_state.${snapshot.wsConnectionState}`));
    detailRows[4].setText(snapshot.vaultName || t("settings.sync_status.none"));
    detailRows[5].setText(snapshot.deviceId || t("settings.sync_status.none"));
    detailRows[6].setText(snapshot.lastError || t("settings.sync_status.none"));
    detailRows[6].style.color = snapshot.lastError ? "var(--color-red)" : "var(--text-normal)";

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
      rowEl.style.gridTemplateColumns = "8px 68px 1fr";
      rowEl.style.gap = "10px";
      rowEl.style.alignItems = "start";
      rowEl.style.padding = "6px 0";

      const dotEl = rowEl.createSpan();
      dotEl.style.width = "8px";
      dotEl.style.height = "8px";
      dotEl.style.borderRadius = "999px";
      dotEl.style.marginTop = "5px";
      dotEl.style.background = getActivityColor(item.kind);

      const timeEl = rowEl.createSpan({ text: new Date(item.ts).toLocaleTimeString() });
      timeEl.style.fontSize = "12px";
      timeEl.style.color = "var(--text-muted)";

      const messageEl = rowEl.createSpan({ text: item.message });
      messageEl.style.fontSize = "12px";
      messageEl.style.lineHeight = "1.45";
      if (item.kind === "error") {
        messageEl.style.color = "var(--color-red)";
      }
    }
  };

  render();
  return globalThis.setInterval(render, 1000);
}

function createBadge(containerEl: HTMLElement) {
  const badgeEl = containerEl.createSpan();
  badgeEl.style.display = "inline-flex";
  badgeEl.style.alignItems = "center";
  badgeEl.style.padding = "4px 10px";
  badgeEl.style.borderRadius = "999px";
  badgeEl.style.fontSize = "12px";
  badgeEl.style.fontWeight = "600";
  badgeEl.style.border = "1px solid transparent";
  return badgeEl;
}

function createStatCard(containerEl: HTMLElement, label: string) {
  const cardEl = containerEl.createDiv();
  cardEl.style.border = "1px solid var(--background-modifier-border)";
  cardEl.style.borderRadius = "10px";
  cardEl.style.padding = "12px";
  cardEl.style.background = "var(--background-primary-alt)";
  cardEl.style.display = "grid";
  cardEl.style.gap = "6px";
  cardEl.style.minHeight = "88px";

  const labelEl = cardEl.createDiv({ text: label });
  labelEl.style.fontSize = "12px";
  labelEl.style.color = "var(--text-muted)";
  labelEl.style.fontWeight = "600";

  const valueEl = cardEl.createDiv();
  valueEl.style.fontSize = "20px";
  valueEl.style.fontWeight = "700";
  valueEl.style.lineHeight = "1.1";

  const metaEl = cardEl.createDiv();
  metaEl.style.fontSize = "12px";
  metaEl.style.lineHeight = "1.4";
  metaEl.style.color = "var(--text-muted)";

  return { cardEl, valueEl, metaEl };
}

function buildSummary(snapshot: SyncStatusSnapshot, t: UiTranslator) {
  if (snapshot.overallState === "error" && snapshot.lastError) {
    return t("settings.sync_status.summary.error", {
      error: snapshot.lastError
    });
  }
  if (snapshot.overallState === "syncing") {
    return t("settings.sync_status.summary.syncing", {
      phase: t(`settings.sync_status.phase.${snapshot.currentPhase}`),
      pending: snapshot.pendingOperationCount
    });
  }
  if (snapshot.overallState === "pending") {
    return t("settings.sync_status.summary.pending", {
      pending: snapshot.pendingOperationCount
    });
  }
  if (snapshot.overallState === "disabled") {
    return t("settings.sync_status.summary.disabled");
  }
  if (snapshot.overallState === "revoked") {
    return t("settings.sync_status.summary.revoked");
  }
  return t("settings.sync_status.summary.ok", {
    lastSync: formatStatusTimestamp(snapshot.lastSyncAt, t)
  });
}

function setBadgeState(badgeEl: HTMLElement, state: SyncStatusSnapshot["overallState"]) {
  const tone = getStateTone(state);
  applyBadgeTone(badgeEl, tone.background, tone.text, tone.border);
}

function setBadgePhase(badgeEl: HTMLElement, phase: SyncStatusSnapshot["currentPhase"]) {
  const tones: Record<SyncStatusSnapshot["currentPhase"], { background: string; text: string; border: string }> = {
    idle: {
      background: "color-mix(in srgb, var(--background-secondary) 86%, var(--interactive-accent) 14%)",
      text: "var(--text-normal)",
      border: "var(--background-modifier-border)"
    },
    pull: {
      background: "color-mix(in srgb, var(--background-secondary) 78%, var(--color-cyan) 22%)",
      text: "var(--text-normal)",
      border: "color-mix(in srgb, var(--background-modifier-border) 70%, var(--color-cyan) 30%)"
    },
    push: {
      background: "color-mix(in srgb, var(--background-secondary) 78%, var(--color-orange) 22%)",
      text: "var(--text-normal)",
      border: "color-mix(in srgb, var(--background-modifier-border) 70%, var(--color-orange) 30%)"
    }
  };
  const tone = tones[phase];
  applyBadgeTone(badgeEl, tone.background, tone.text, tone.border);
}

function applyBadgeTone(badgeEl: HTMLElement, background: string, text: string, border: string) {
  badgeEl.style.background = background;
  badgeEl.style.color = text;
  badgeEl.style.borderColor = border;
}

function getStateTone(state: SyncStatusSnapshot["overallState"]) {
  const tones: Record<SyncStatusSnapshot["overallState"], { background: string; text: string; border: string }> = {
    disabled: {
      background: "var(--background-secondary)",
      text: "var(--text-muted)",
      border: "var(--background-modifier-border)"
    },
    revoked: {
      background: "color-mix(in srgb, var(--background-secondary) 76%, var(--color-red) 24%)",
      text: "var(--text-normal)",
      border: "color-mix(in srgb, var(--background-modifier-border) 65%, var(--color-red) 35%)"
    },
    syncing: {
      background: "color-mix(in srgb, var(--background-secondary) 76%, var(--interactive-accent) 24%)",
      text: "var(--text-normal)",
      border: "color-mix(in srgb, var(--background-modifier-border) 65%, var(--interactive-accent) 35%)"
    },
    pending: {
      background: "color-mix(in srgb, var(--background-secondary) 76%, var(--color-orange) 24%)",
      text: "var(--text-normal)",
      border: "color-mix(in srgb, var(--background-modifier-border) 65%, var(--color-orange) 35%)"
    },
    error: {
      background: "color-mix(in srgb, var(--background-secondary) 74%, var(--color-red) 26%)",
      text: "var(--text-normal)",
      border: "color-mix(in srgb, var(--background-modifier-border) 65%, var(--color-red) 35%)"
    },
    ok: {
      background: "color-mix(in srgb, var(--background-secondary) 78%, var(--color-green) 22%)",
      text: "var(--text-normal)",
      border: "color-mix(in srgb, var(--background-modifier-border) 65%, var(--color-green) 35%)"
    }
  };
  return tones[state];
}

function getActivityColor(kind: SyncStatusSnapshot["recentActivity"][number]["kind"]) {
  if (kind === "error") return "var(--color-red)";
  if (kind === "sync") return "var(--color-green)";
  return "var(--color-cyan)";
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
