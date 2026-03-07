import en from "./en.json";
import ru from "./ru.json";

type Params = Record<string, string | number>;

const NAMESPACE = "vault-sync";

const resources: Record<string, Record<string, string>> = { en, ru };

let initialized = false;

interface I18next {
  t: (key: string, opts?: Record<string, unknown>) => string;
  language: string;
  addResourceBundle?: (lng: string, ns: string, resources: Record<string, string>, deep?: boolean, overwrite?: boolean) => void;
}

function getI18next(): I18next | null {
  return (globalThis as unknown as { i18next?: I18next }).i18next ?? null;
}

function ensureInit() {
  if (initialized) return;
  initialized = true;

  const i18next = getI18next();
  if (!i18next?.addResourceBundle) return;

  for (const [lang, dict] of Object.entries(resources)) {
    i18next.addResourceBundle(lang, NAMESPACE, dict, true, true);
  }
}

function interpolate(template: string, params?: Params) {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? ""));
}

function fallbackTranslate(key: string, params?: Params): string {
  const lang = getI18next()?.language?.slice(0, 2) || "en";
  const dict = (resources[lang] || resources.en) as Record<string, string>;
  const fallback = resources.en as Record<string, string>;
  const value = dict[key] || fallback[key] || key;
  return interpolate(value, params);
}

export function createTranslator() {
  return (key: string, params?: Params) => {
    ensureInit();

    const i18next = getI18next();
    if (i18next?.t) {
      const nsKey = `${NAMESPACE}:${key}`;
      const result = i18next.t(nsKey, params as Record<string, unknown>);
      if (result !== nsKey && result !== key) return result;
    }

    return fallbackTranslate(key, params);
  };
}
