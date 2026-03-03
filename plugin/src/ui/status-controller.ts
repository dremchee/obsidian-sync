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

  constructor(statusBarEl: HTMLElement) {
    this.statusBarEl = statusBarEl;
  }

  update(snapshot: StatusSnapshot, lastSyncAt: number) {
    if (!snapshot.syncEnabled) {
      this.state = "disabled";
      this.render("Sync disabled", lastSyncAt);
      return;
    }

    if (snapshot.isDeviceRevoked) {
      this.state = "revoked";
      this.render("Sync revoked", lastSyncAt);
      return;
    }

    if (snapshot.syncInProgress) {
      this.state = "syncing";
      this.render("Syncing", lastSyncAt);
      return;
    }

    if (snapshot.hasPendingWork) {
      this.state = "pending";
      this.render("Pending", lastSyncAt);
      return;
    }

    if (snapshot.hasError) {
      this.state = "error";
      this.render("Sync error", lastSyncAt);
      return;
    }

    this.state = "ok";
    this.render("Sync ok", lastSyncAt);
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

  private formatLastSyncAt(lastSyncAt: number) {
    if (!lastSyncAt) return "never";
    return new Date(lastSyncAt).toLocaleString();
  }
}
