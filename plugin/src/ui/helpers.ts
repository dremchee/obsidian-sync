export function appendSection(containerEl: HTMLElement, title: string, desc?: string) {
  containerEl.createEl("h3", { text: title });
  if (desc) {
    containerEl.createEl("p", { text: desc, cls: "setting-item-description" });
  }
}

export function createPanel(containerEl: HTMLElement, className: string) {
  const panel = containerEl.createDiv({ cls: className });
  panel.style.border = "1px solid var(--background-modifier-border)";
  panel.style.borderRadius = "10px";
  panel.style.padding = "14px";
  panel.style.background = "var(--background-secondary)";
  panel.style.display = "grid";
  panel.style.gap = "10px";
  return panel;
}

export function createKeyValueRow(containerEl: HTMLElement, label: string) {
  const rowEl = containerEl.createDiv();
  rowEl.style.display = "grid";
  rowEl.style.gridTemplateColumns = "160px 1fr";
  rowEl.style.gap = "12px";
  rowEl.style.alignItems = "start";
  rowEl.style.fontSize = "13px";

  const labelEl = rowEl.createSpan({ text: label });
  labelEl.style.color = "var(--text-muted)";
  labelEl.style.fontWeight = "600";

  const valueEl = rowEl.createSpan();
  valueEl.style.wordBreak = "break-word";
  return { rowEl, valueEl };
}
