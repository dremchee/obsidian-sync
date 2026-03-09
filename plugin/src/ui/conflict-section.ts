import { Notice, Setting, TFile, type App } from "obsidian";
import type { UiTranslator } from "./types";

const CONFLICT_RE = / \(conflict [a-f0-9]+ \d{4}-\d{2}-\d{2}\)/;
const CONFLICT_RE_GLOBAL = / \(conflict [a-f0-9]+ \d{4}-\d{2}-\d{2}\)/g;

function findConflictFiles(app: App): TFile[] {
  return app.vault.getFiles().filter((file) => CONFLICT_RE.test(file.path));
}

function getOriginalPath(conflictPath: string): string {
  return conflictPath.replace(CONFLICT_RE_GLOBAL, "");
}

async function resolveConflicts(app: App, conflicts: TFile[], t: UiTranslator) {
  let renamed = 0;
  let deleted = 0;

  for (const file of conflicts) {
    const originalPath = getOriginalPath(file.path);
    const originalExists = app.vault.getAbstractFileByPath(originalPath) instanceof TFile;

    try {
      if (originalExists) {
        await app.vault.delete(file);
        deleted += 1;
        continue;
      }

      const parentDir = originalPath.substring(0, originalPath.lastIndexOf("/"));
      if (parentDir && !(await app.vault.adapter.exists(parentDir))) {
        await app.vault.adapter.mkdir(parentDir);
      }
      await app.vault.rename(file, originalPath);
      renamed += 1;
    } catch (err) {
      console.error(`[custom-sync] failed to resolve conflict ${file.path}: ${err}`);
    }
  }

  const resolved = renamed + deleted;
  if (resolved > 0) {
    new Notice(t("notices.conflicts_resolved", { resolved, renamed, deleted }));
    return;
  }

  new Notice(t("notices.conflicts_none"));
}

export function renderConflictSection(
  app: App,
  containerEl: HTMLElement,
  t: UiTranslator,
  onResolved: () => void
) {
  const conflicts = findConflictFiles(app);
  if (!conflicts.length) {
    return;
  }

  const setting = new Setting(containerEl)
    .setName(t("settings.conflicts.name"))
    .setDesc(t("settings.conflicts.desc", { count: conflicts.length }))
    .addButton((button) =>
      button
        .setButtonText(t("settings.conflicts.resolve"))
        .setWarning()
        .onClick(async () => {
          button.setDisabled(true);
          await resolveConflicts(app, conflicts, t);
          button.setDisabled(false);
          onResolved();
        })
    );

  setting.settingEl.style.borderLeft = "3px solid var(--color-orange)";
  setting.settingEl.style.paddingLeft = "12px";
}
