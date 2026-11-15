import { useCallback, useState } from "react";

function read(key: string): boolean | null {
  try {
    const stored = localStorage.getItem(key);
    return stored === "on" ? true : stored === "off" ? false : null;
  } catch {
    return null;
  }
}

/** A yes/no choice that follows `fallback` until the visitor makes it; the pick is remembered per browser. */
export function useRememberedChoice(key: string, fallback: boolean): [value: boolean, choose: (value: boolean) => void] {
  const [pick, setPick] = useState<boolean | null>(() => read(key));
  const choose = useCallback(
    (next: boolean) => {
      setPick(next);
      try {
        localStorage.setItem(key, next ? "on" : "off");
      } catch {
        // Storage can be blocked; the choice still applies for this visit.
      }
    },
    [key],
  );
  return [pick ?? fallback, choose];
}
