import { type RefObject, useEffect, useState } from "react";

interface Options {
  rootMargin?: string;
  threshold?: number;
  /** Stays true after the first time the element is seen. */
  once?: boolean;
}

/** Whether the element is on screen; without IntersectionObserver it always is. */
export function useInView(ref: RefObject<Element | null>, { rootMargin = "0px", threshold = 0, once = false }: Options = {}) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        setInView(entry.isIntersecting);
        if (entry.isIntersecting && once) observer.disconnect();
      },
      { rootMargin, threshold },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin, threshold, once]);
  return inView;
}
