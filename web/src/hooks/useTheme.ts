import { useCallback, useEffect, useState } from "react";
import { useMediaQuery } from "./useMediaQuery";

export type ThemeChoice = "system" | "light" | "dark";
const STORAGE_KEY = "aeros-theme";

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Follows the system theme until the visitor picks one; the pick is remembered per browser. */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolved: "light" | "dark" = choice === "system" ? (systemDark ? "dark" : "light") : choice;

  useEffect(() => {
    const root = document.documentElement;
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
    try {
      if (choice === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
      // Storage can be blocked; the theme still applies for this visit.
    }
  }, [choice]);

  const toggle = useCallback(() => setChoice(resolved === "dark" ? "light" : "dark"), [resolved]);
  return { resolved, toggle };
}
