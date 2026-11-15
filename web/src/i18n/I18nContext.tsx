import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from "react";
import { en, es } from "./translations";
import type { Language, Translations } from "./types";

const STORAGE_KEY = "aeros-lang";

function getInitialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "es" || stored === "en") return stored;
    if (typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("es")) {
      return "es";
    }
  } catch {
    // Ignore localStorage access failures
  }
  return "en";
}

interface I18nContextValue {
  lang: Language;
  setLang: (lang: Language) => void;
  toggleLang: () => void;
  t: Translations;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(getInitialLanguage);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Ignore storage errors
    }
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((newLang: Language) => {
    setLangState(newLang);
  }, []);

  const toggleLang = useCallback(() => {
    setLangState((curr) => (curr === "es" ? "en" : "es"));
  }, []);

  const t = lang === "es" ? es : en;

  return <I18nContext.Provider value={{ lang, setLang, toggleLang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n must be used within an I18nProvider");
  }
  return ctx;
}
