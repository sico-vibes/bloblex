/**
 * Tauri v2 starts a window drag only when the mousedown target itself
 * carries `data-tauri-drag-region`. A parent mark does not cover children.
 * After each companion render we mark every non-interactive element that can
 * be that target, and we strip the mark from controls, the chat composer,
 * and the scrollable message list.
 */
export const COMPANION_DRAG_ATTR = 'data-tauri-drag-region'

/** Subtrees that must keep the press for scrolling or composing. */
export const COMPANION_NO_DRAG_ATTR = 'data-companion-no-drag'

const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [role="switch"], [role="link"]'

function shouldDrag(el: Element): boolean {
  if (el.closest(`[${COMPANION_NO_DRAG_ATTR}]`)) return false
  const control = el.closest(INTERACTIVE)
  if (!control) return true
  // The compact face is a canvas inside the open button, and that canvas is
  // the mousedown target. Other control descendants must not start a drag.
  return el.classList.contains('blob-canvas') && control.classList.contains('compact-bot')
}

export function stampCompanionDragRegions(root: HTMLElement) {
  const nodes: Element[] = [root, ...root.querySelectorAll('*')]
  for (const node of nodes) {
    if (shouldDrag(node)) node.setAttribute(COMPANION_DRAG_ATTR, '')
    else node.removeAttribute(COMPANION_DRAG_ATTR)
  }
}
