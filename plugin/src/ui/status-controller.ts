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
  private lastRenderAt = 0;
  private readonly minRenderIntervalMs = 700;
  private pendingTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pendingText: string | null = null;
  private pendingLastSyncAt = 0;

  constructor(statusBarEl: HTMLElement) {
    this.statusBarEl = statusBarEl;
  }

  update(snapshot: StatusSnapshot, lastSyncAt: number) {
    const renderState = (state: SyncStatusState, text: string) => {
      this.state = state;
      this.renderThrottled(text, lastSyncAt);
    };
    if (!snapshot.syncEnabled) {
      renderState("disabled", "Sync disabled");
      return;
    }

    if (snapshot.isDeviceRevoked) {
      renderState("revoked", "Sync revoked");
      return;
    }

    if (snapshot.syncInProgress) {
      renderState("syncing", "Syncing");
      return;
    }

    if (snapshot.hasPendingWork) {
      renderState("pending", "Pending");
      return;
    }

    if (snapshot.hasError) {
      renderState("error", "Sync error");
      return;
    }

    renderState("ok", "Sync ok");
  }

  openMenu(evt: MouseEvent, lastSyncAt: number, onOpenSettings: () => void) {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle(`Status: ${this.state}`).setDisabled(true));
    menu.addItem((item) => item.setTitle(`Last sync: ${this.formatLastSyncAt(lastSyncAt)}`).setDisabled(true));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Open Sync Settings").onClick(onOpenSettings));
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
    this.statusBarEl.title = `${text}\nLast sync: ${this.formatLastSyncAt(lastSyncAt)}`;
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

  private formatLastSyncAt(lastSyncAt: number) {
    if (!lastSyncAt) return "never";
    return new Date(lastSyncAt).toLocaleString();
  }
}
