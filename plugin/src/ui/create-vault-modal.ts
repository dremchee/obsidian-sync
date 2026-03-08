import { App, Modal, Setting } from "obsidian";

type ModalMode = "join" | "create" | "delete";

export interface VaultModalResult {
  vaultName: string;
  passphrase: string;
}

export class VaultConnectModal extends Modal {
  private vaultName: string;
  private passphrase = "";
  private passphraseVisible = false;
  private readonly mode: ModalMode;
  private readonly onSubmit: (result: VaultModalResult) => void;
  private readonly t: (key: string, params?: Record<string, string | number>) => string;

  constructor(
    app: App,
    opts: {
      mode: ModalMode;
      vaultName?: string;
      t: (key: string, params?: Record<string, string | number>) => string;
      onSubmit: (result: VaultModalResult) => void;
    }
  ) {
    super(app);
    this.mode = opts.mode;
    this.vaultName = opts.vaultName || "";
    this.t = opts.t;
    this.onSubmit = opts.onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    const titleKey = this.mode === "create"
      ? "vault_modal.title_create"
      : this.mode === "delete"
        ? "vault_modal.title_delete"
        : "vault_modal.title_join";
    contentEl.createEl("h3", { text: this.t(titleKey, { vault: this.vaultName }) });

    const descKey = this.mode === "create"
      ? "vault_modal.desc_create"
      : this.mode === "delete"
        ? "vault_modal.desc_delete"
        : "vault_modal.desc_join";
    contentEl.createEl("p", { text: this.t(descKey), cls: "setting-item-description" });

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

    const confirmKey = this.mode === "create"
      ? "vault_modal.confirm_create"
      : this.mode === "delete"
        ? "vault_modal.confirm_delete"
        : "vault_modal.confirm_join";
    const confirmText = this.t(confirmKey);

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
    this.onSubmit({ vaultName: this.vaultName, passphrase: this.passphrase });
  }

  onClose() {
    this.contentEl.empty();
  }
}
