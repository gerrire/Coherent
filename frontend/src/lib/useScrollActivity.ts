import { useCallback, useEffect, useRef } from "react";

/** Reveal on actual scrolling too: touch, keyboard and touchpad need no hover. */
export function useScrollActivity() {
  const target = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    clearTimeout(timer.current);
    target.current?.removeAttribute("data-scrolling");
  }, []);
  return useCallback((element: HTMLElement) => {
    if (target.current !== element) target.current?.removeAttribute("data-scrolling");
    target.current = element;
    element.setAttribute("data-scrolling", "");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => element.removeAttribute("data-scrolling"), 900);
  }, []);
}
