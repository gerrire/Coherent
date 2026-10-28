type Bounds = { left: number; top: number; right: number; bottom: number };

export function messageMenuPosition(bubble: Bounds, menu: { width: number; height: number }, viewport: { width: number; height: number; topInset: number }) {
  const gap = 8;
  let left = bubble.left - menu.width - gap;
  let top = (bubble.top + bubble.bottom - menu.height) / 2;
  if (left < gap) {
    left = bubble.left;
    top = bubble.bottom + gap;
    if (top + menu.height > viewport.height - gap) top = bubble.top - menu.height - gap;
  }
  return {
    left: Math.max(gap, Math.min(left, viewport.width - menu.width - gap)),
    top: Math.max(viewport.topInset + gap, Math.min(top, viewport.height - menu.height - gap)),
  };
}
