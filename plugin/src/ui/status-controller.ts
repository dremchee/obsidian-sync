import { Menu, setIcon } from "obsidian";

export type SyncStatusState = "ok" | "pending" | "syncing" | "error" | "revoked" | "disabled";

export type StatusSnapshot = {
  syncEnabled: boolean;
  isDeviceRevoked: boolean;
  syncInProgress: boolean;
  hasPendingWork: boolean;
  hasError: boolean;
};

export class StatusBarController {
  private readonly statusBarEl: HTMLElement;
  private state: SyncStatusState = "ok";
  private t: (key: string, params?: Record<string, string | number>) => string = (k) => k;
  private lastRenderAt = 0;
  private readonly minRenderIntervalMs = 700;
  private pendingTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pendingText: string | null = null;
  private pendingLastSyncAt = 0;

  constructor(statusBarEl: HTMLElement) {
    this.statusBarEl = statusBarEl;
  }

  update(snapshot: StatusSnapshot, lastSyncAt: number, t: (key: string, params?: Record<string, string | number>) => string) {
    this.t = t;
    const renderState = (state: SyncStatusState, text: string) => {
      this.state = state;
      this.renderThrottled(text, lastSyncAt);
    };
    if (!snapshot.syncEnabled) {
      renderState("disabled", t("status.sync_disabled"));
      return;
    }

    if (snapshot.isDeviceRevoked) {
      renderState("revoked", t("status.sync_revoked"));
      return;
    }

    if (snapshot.syncInProgress) {
      renderState("syncing", t("status.syncing"));
      return;
    }

    if (snapshot.hasPendingWork) {
      renderState("pending", t("status.pending"));
      return;
    }

    if (snapshot.hasError) {
      renderState("error", t("status.sync_error"));
      return;
    }

    renderState("ok", t("status.sync_ok"));
  }

  openMenu(
    evt: MouseEvent,
    lastSyncAt: number,
    onOpenSettings: () => void
  ) {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(this.t("status.menu_status", { value: this.state })).setDisabled(true));
    menu.addItem((item) => item.setTitle(this.t("status.menu_last_sync", { value: this.formatLastSyncValue(lastSyncAt) })).setDisabled(true));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle(this.t("status.menu_open_settings")).onClick(onOpenSettings));
    menu.showAtMouseEvent(evt);
  }

  private render(text: string, lastSyncAt: number) {
    this.statusBarEl.empty();

    const iconEl = this.statusBarEl.createSpan({ cls: "custom-sync-status-icon" });
    const textEl = this.statusBarEl.createSpan({ cls: "custom-sync-status-text", text });
    textEl.style.marginLeft = "6px";

    const iconName =
      this.state === "ok"
        ? "check-circle"
        : this.state === "pending"
          ? "clock-3"
          : this.state === "syncing"
            ? "refresh-cw"
            : this.state === "revoked"
              ? "ban"
              : this.state === "disabled"
                ? "pause-circle"
                : "alert-triangle";

    setIcon(iconEl, iconName);
    this.statusBarEl.title = `${text}\n${this.t("status.title_last_sync", { value: this.formatLastSyncValue(lastSyncAt) })}`;
  }

  private renderThrottled(text: string, lastSyncAt: number) {
    const now = Date.now();
    const elapsed = now - this.lastRenderAt;
    if (elapsed >= this.minRenderIntervalMs) {
      this.flushPending();
      this.render(text, lastSyncAt);
      this.lastRenderAt = now;
      return;
    }

    this.pendingText = text;
    this.pendingLastSyncAt = lastSyncAt;
    if (this.pendingTimer) return;
    this.pendingTimer = globalThis.setTimeout(() => {
      this.pendingTimer = null;
      this.flushPending();
    }, this.minRenderIntervalMs - elapsed);
  }

  private flushPending() {
    if (!this.pendingText) return;
    this.render(this.pendingText, this.pendingLastSyncAt);
    this.lastRenderAt = Date.now();
    this.pendingText = null;
  }

  private formatLastSyncValue(lastSyncAt: number) {
    return lastSyncAt ? new Date(lastSyncAt).toLocaleString() : this.t("status.last_sync_never");
  }
}
