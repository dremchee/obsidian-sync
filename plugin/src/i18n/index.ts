import type { PluginLanguage } from "../settings";
import en from "./en";
import ru from "./ru";

type Params = Record<string, string | number>;

const dictionaries = { en, ru } as const;

type Locale = keyof typeof dictionaries;

function detectLocale(): Locale {
  const lang = String(globalThis.navigator?.language || "en").toLowerCase();
  if (lang.startsWith("ru")) return "ru";
  return "en";
}

function resolveLocale(language: PluginLanguage): Locale {
  if (language === "auto") return detectLocale();
  return language === "ru" ? "ru" : "en";
}

function interpolate(template: string, params?: Params) {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? ""));
}

export function createTranslator(getLanguage: () => PluginLanguage) {
  return (key: string, params?: Params) => {
    const locale = resolveLocale(getLanguage());
    const dict = dictionaries[locale] as Record<string, string>;
    const fallback = dictionaries.en as Record<string, string>;
    const value = dict[key] || fallback[key] || key;
    return interpolate(value, params);
  };
}
