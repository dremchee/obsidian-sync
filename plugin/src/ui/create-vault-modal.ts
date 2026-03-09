import { App, Modal, Setting } from "obsidian";
import type { BootstrapPolicy } from "../settings";

type ModalMode = "join" | "create" | "delete";

const MODAL_TEXT_KEYS: Record<ModalMode, { title: string; desc: string; confirm: string }> = {
  create: {
    title: "vault_modal.title_create",
    desc: "vault_modal.desc_create",
    confirm: "vault_modal.confirm_create"
  },
  join: {
    title: "vault_modal.title_join",
    desc: "vault_modal.desc_join",
    confirm: "vault_modal.confirm_join"
  },
  delete: {
    title: "vault_modal.title_delete",
    desc: "vault_modal.desc_delete",
    confirm: "vault_modal.confirm_delete"
  }
};

export interface VaultModalResult {
  vaultName: string;
  passphrase: string;
  bootstrapPolicy: BootstrapPolicy;
}

export class VaultConnectModal extends Modal {
  private vaultName: string;
  private passphrase = "";
  private passphraseVisible = false;
  private bootstrapPolicy: BootstrapPolicy;
  private readonly mode: ModalMode;
  private readonly onSubmit: (result: VaultModalResult) => void;
  private readonly t: (key: string, params?: Record<string, string | number>) => string;

  constructor(
    app: App,
    opts: {
      mode: ModalMode;
      vaultName?: string;
      bootstrapPolicy?: BootstrapPolicy;
      t: (key: string, params?: Record<string, string | number>) => string;
      onSubmit: (result: VaultModalResult) => void;
    }
  ) {
    super(app);
    this.mode = opts.mode;
    this.vaultName = opts.vaultName || "";
    this.bootstrapPolicy = opts.bootstrapPolicy || "merge";
    this.t = opts.t;
    this.onSubmit = opts.onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const textKeys = MODAL_TEXT_KEYS[this.mode];
    contentEl.createEl("h3", { text: this.t(textKeys.title, { vault: this.vaultName }) });
    contentEl.createEl("p", { text: this.t(textKeys.desc), cls: "setting-item-description" });

    let firstInput: HTMLInputElement | null = null;

    if (this.mode === "create") {
      new Setting(contentEl)
        .setName(this.t("vault_modal.vault_name"))
        .addText((text) => {
          firstInput = text.inputEl;
          text.setPlaceholder(this.t("settings.vault_picker.create_placeholder"));
          text.onChange((value) => { this.vaultName = value.trim(); });
          text.inputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              this.submit();
            }
          });
          return text;
      });
    }

    if (this.mode === "join") {
      new Setting(contentEl)
        .setName(this.t("settings.bootstrap_policy.name"))
        .setDesc(this.t("settings.bootstrap_policy.desc"))
        .addDropdown((dropdown) =>
          dropdown
            .addOption("merge", this.t("settings.bootstrap_policy.merge"))
            .addOption("remote_wins", this.t("settings.bootstrap_policy.remote_wins"))
            .addOption("local_wins", this.t("settings.bootstrap_policy.local_wins"))
            .setValue(this.bootstrapPolicy)
            .onChange((value) => {
              this.bootstrapPolicy = value as BootstrapPolicy;
            })
        );
    }

    let passphraseInputEl: HTMLInputElement | null = null;

    new Setting(contentEl)
      .setName(this.t("settings.passphrase.name"))
      .addText((text) => {
        passphraseInputEl = text.inputEl;
        if (!firstInput) firstInput = text.inputEl;
        text.inputEl.type = "password";
        text.setPlaceholder(this.t("settings.passphrase.placeholder"));
        text.onChange((value) => { this.passphrase = value; });
        text.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.submit();
          }
        });
        return text;
      })
      .addExtraButton((button) => {
        const applyIcon = () => {
          button.setIcon(this.passphraseVisible ? "eye-off" : "eye");
          button.setTooltip(this.passphraseVisible ? this.t("settings.passphrase.hide") : this.t("settings.passphrase.show"));
        };
        applyIcon();
        button.onClick(() => {
          this.passphraseVisible = !this.passphraseVisible;
          if (passphraseInputEl) {
            passphraseInputEl.type = this.passphraseVisible ? "text" : "password";
          }
          applyIcon();
        });
      });

    const confirmText = this.t(textKeys.confirm);

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText(confirmText)
          .setCta()
          .onClick(() => this.submit())
      );

    setTimeout(() => firstInput?.focus(), 50);
  }

  private submit() {
    if (!this.vaultName || !this.passphrase.trim()) return;
    this.close();
    this.onSubmit({ vaultName: this.vaultName, passphrase: this.passphrase, bootstrapPolicy: this.bootstrapPolicy });
  }

  onClose() {
    this.contentEl.empty();
  }
}
