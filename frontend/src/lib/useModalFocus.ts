import { useEffect, useRef, type RefObject } from "react";

const dialogs: HTMLElement[] = [];
const focusable = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function useModalFocus(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const dialog = ref.current; if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const hidden = new Map<HTMLElement, boolean>();
    let ancestor: HTMLElement = dialog;
    while (ancestor.parentElement && ancestor.parentElement !== document.body) {
      for (const sibling of ancestor.parentElement.children) if (sibling !== ancestor && sibling instanceof HTMLElement) {
        hidden.set(sibling, sibling.inert); sibling.inert = true;
      }
      ancestor = ancestor.parentElement;
    }
    dialogs.push(dialog); document.body.style.overflow = "hidden"; dialog.focus();
    function trap(event: KeyboardEvent) {
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const items = Array.from(dialog!.querySelectorAll<HTMLElement>(focusable)).filter(item => !item.closest("[inert]") && item.getClientRects().length > 0);
      const first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); dialog!.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog!.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", trap, true);
    return () => {
      document.removeEventListener("keydown", trap, true);
      const index = dialogs.indexOf(dialog); if (index >= 0) dialogs.splice(index, 1);
      for (const [element, value] of hidden) element.inert = value;
      document.body.style.overflow = previousOverflow;
      if (previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true });
    };
  }, [ref]);
}
