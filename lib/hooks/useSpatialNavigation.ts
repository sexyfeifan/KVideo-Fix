/**
 * useSpatialNavigation
 * Provides D-pad/arrow key based 2D spatial navigation for TV mode.
 * Navigates between [data-focusable] elements and standard interactive
 * elements (inputs, buttons, links) based on directional arrow key presses.
 *
 * Inside the Android TV shell (window.KVideoAndroid present) text fields
 * use a confirm-step edit mode so the cursor can never trap the D-pad:
 *   - focus only "selects" a field (readonly, no keyboard)
 *   - OK / Enter enters edit mode (keyboard + cursor)
 *   - Up / Down leaves edit mode and keeps navigating
 *   - Escape (or the shell's Back key) leaves edit mode and stays put
 */

import { useEffect, useCallback, useRef } from 'react';

function getRect(el: Element): DOMRect {
  return el.getBoundingClientRect();
}

function getCenter(rect: DOMRect): { x: number; y: number } {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

type Direction = 'up' | 'down' | 'left' | 'right';

function findBestCandidate(
  current: Element,
  candidates: Element[],
  direction: Direction
): Element | null {
  const currentRect = getRect(current);
  const currentCenter = getCenter(currentRect);

  let bestElement: Element | null = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    if (candidate === current) continue;

    const candidateRect = getRect(candidate);
    const candidateCenter = getCenter(candidateRect);

    const dx = candidateCenter.x - currentCenter.x;
    const dy = candidateCenter.y - currentCenter.y;

    // Filter by direction
    let isInDirection = false;
    switch (direction) {
      case 'up':
        isInDirection = dy < -10;
        break;
      case 'down':
        isInDirection = dy > 10;
        break;
      case 'left':
        isInDirection = dx < -10;
        break;
      case 'right':
        isInDirection = dx > 10;
        break;
    }

    if (!isInDirection) continue;

    // Weighted distance: favor elements along the primary axis
    let score: number;
    if (direction === 'up' || direction === 'down') {
      score = Math.abs(dy) + Math.abs(dx) * 3;
    } else {
      score = Math.abs(dx) + Math.abs(dy) * 3;
    }

    if (score < bestScore) {
      bestScore = score;
      bestElement = candidate;
    }
  }

  return bestElement;
}

/** Anything the D-pad should be able to reach. */
const INTERACTIVE_SELECTOR = [
  '[data-focusable]',
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Text-entry fields that participate in the confirm-step edit mode. */
const TEXT_EDIT_SELECTOR =
  'textarea, input:not([type="checkbox"]):not([type="radio"])' +
  ':not([type="button"]):not([type="submit"]):not([type="reset"])' +
  ':not([type="file"]):not([type="range"]):not([type="color"])' +
  ':not([type="image"]):not([type="hidden"])';

type TextField = HTMLInputElement | HTMLTextAreaElement;

/** OK/Enter, including remotes that report a non-standard key name. */
function isConfirmKey(e: KeyboardEvent): boolean {
  return e.key === 'Enter' || e.key === 'NumpadEnter' || e.keyCode === 13;
}

function isAndroidShell(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as Record<string, unknown>).KVideoAndroid;
}

function isEditableText(el: Element | null): el is TextField {
  return !!el && el.matches(TEXT_EDIT_SELECTOR);
}

/** Selected but not editing: readonly, waiting for the OK confirm step. */
function isArmed(el: TextField): boolean {
  return el.hasAttribute('data-tv-editable') && el.hasAttribute('readonly');
}

/** Actively editing: caret + keyboard belong to this field. */
function isEditing(el: TextField): boolean {
  return el.hasAttribute('data-tv-editable') && !el.hasAttribute('readonly');
}

/**
 * Whether Left/Right should move the caret instead of the focus ring.
 * True outside the confirm-step shell (normal typing UX) and while editing.
 */
function wantsCaretKeys(el: TextField): boolean {
  return !el.hasAttribute('data-tv-editable') || isEditing(el);
}

function notifyEditing(editing: boolean) {
  try {
    const bridge = (window as unknown as Record<string, unknown>).KVideoAndroid as
      | { setWebEditing?: (editing: boolean) => void }
      | undefined;
    bridge?.setWebEditing?.(editing);
  } catch {
    // Bridge is optional (only present inside the Android TV shell).
  }
}

function enterEditMode(el: TextField) {
  if (!isArmed(el)) return;
  const originalMode = el.getAttribute('data-tv-inputmode');
  if (originalMode) {
    el.setAttribute('inputmode', originalMode);
  } else {
    el.removeAttribute('inputmode');
  }
  el.removeAttribute('readonly');
  // Re-focus so the WebView/IME opens the keyboard for the now-editable field.
  el.blur();
  el.focus();
  try {
    const len = el.value?.length ?? 0;
    el.setSelectionRange(len, len);
  } catch {
    // Some input types do not support selection ranges.
  }
  notifyEditing(true);
}

function exitEditMode(el: TextField) {
  if (!isEditing(el)) return;
  el.setAttribute('readonly', '');
  el.setAttribute('inputmode', 'none');
  el.blur();
  el.focus();
  notifyEditing(false);
}

/** Put a text field into the "selected, confirm to type" state. */
function armTextField(el: Element) {
  if (!isEditableText(el)) return;
  if (el.hasAttribute('data-tv-editable') || el.hasAttribute('disabled')) return;
  el.setAttribute('data-tv-editable', '');
  const originalMode = el.getAttribute('inputmode');
  el.setAttribute('data-tv-inputmode', originalMode ?? '');
  el.setAttribute('inputmode', 'none');
  el.setAttribute('readonly', '');
}

function getFocusableElements(): HTMLElement[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)
  );

  return nodes.filter((el) => {
    if ((el as HTMLInputElement).disabled) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    if (el.closest('[data-no-spatial]')) return false;
    const rect = getRect(el);
    return rect.width > 0 && rect.height > 0;
  });
}

export function useSpatialNavigation(enabled: boolean) {
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  // Confirm-step edit mode for text fields (Android TV shell only).
  useEffect(() => {
    if (!enabled || !isAndroidShell()) return;

    document.querySelectorAll(TEXT_EDIT_SELECTOR).forEach(armTextField);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node as HTMLElement;
          armTextField(el);
          el.querySelectorAll?.(TEXT_EDIT_SELECTOR).forEach(armTextField);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const handlePointerDown = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (isEditableText(target) && isArmed(target)) {
        enterEditMode(target);
      }
    };
    document.addEventListener('click', handlePointerDown, true);

    return () => {
      observer.disconnect();
      document.removeEventListener('click', handlePointerDown, true);
    };
  }, [enabled]);

  // Capture-phase: decide edit-mode toggles before React handlers run.
  const handleCaptureKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled || !isAndroidShell()) return;

    const target = e.target as HTMLElement | null;
    if (!isEditableText(target)) return;
    const el = target;

    if (e.key === 'Escape' && isEditing(el)) {
      e.preventDefault();
      exitEditMode(el);
      return;
    }

    if (!isConfirmKey(e)) return;

    if (isEditing(el)) {
      // Leave edit mode first.
      const form = el.form;
      const textFields = form
        ? Array.from(form.querySelectorAll<HTMLElement>(TEXT_EDIT_SELECTOR)).filter(
            (field) => !(field as HTMLInputElement).disabled
          ).length
        : 1;
      exitEditMode(el);
      if (textFields > 1) {
        // Multi-field forms confirm via their buttons: swallow Enter so a
        // half-filled form is never submitted by accident.
        e.preventDefault();
        e.stopPropagation();
      }
      // Single-field forms (search) let the event run on so submit happens.
    } else {
      e.preventDefault();
      e.stopPropagation();
      enterEditMode(el);
    }
  }, [enabled]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;

    const directionMap: Record<string, Direction> = {
      ArrowUp: 'up',
      ArrowDown: 'down',
      ArrowLeft: 'left',
      ArrowRight: 'right',
    };

    const direction = directionMap[e.key];

    // For input/textarea: allow Left/Right for cursor movement while typing,
    // but let Up/Down navigate spatially so the user can escape the input on TV.
    // Skip if the event was already handled (e.g., by search history dropdown).
    const target = e.target as HTMLElement;

    if (isEditableText(target)) {
      if (wantsCaretKeys(target) && (!direction || direction === 'left' || direction === 'right')) {
        return;
      }
      // If a React handler already called preventDefault (e.g., dropdown navigation), skip
      if (e.defaultPrevented) {
        return;
      }
      if (direction && isEditing(target)) {
        // Confirmed exit: leave edit mode and keep navigating.
        exitEditMode(target);
      }
      if (!direction && !isConfirmKey(e)) {
        return;
      }
    }

    if (direction) {
      // Check if the focused element is inside a [data-no-spatial] container
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest('[data-no-spatial]')) return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) return;

      let currentFocused = focused && focusableElements.includes(focused)
        ? focused
        : null;

      if (!currentFocused) {
        // Resume from wherever the user last was instead of jumping to the top.
        const last = lastFocusedRef.current;
        if (last && focusableElements.includes(last)) {
          currentFocused = last;
        }
      }

      if (!currentFocused) {
        (focusableElements[0] as HTMLElement).focus();
        e.preventDefault();
        return;
      }

      const best = findBestCandidate(currentFocused, focusableElements, direction);
      if (best) {
        (best as HTMLElement).focus();
        best.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        e.preventDefault();
      }
    } else if (isConfirmKey(e)) {
      // Trigger click on focused element (text fields are handled in capture).
      const focused = document.activeElement as HTMLElement;
      if (focused && focused.hasAttribute('data-focusable') && !isEditableText(focused)) {
        focused.click();
        e.preventDefault();
      }
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const trackFocus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && el !== document.body) {
        lastFocusedRef.current = el;
      }
    };

    // Entry points the Android shell calls when the soft keyboard swallows
    // D-pad/Back keys so the cursor can always escape an input.
    const shellApi = window as unknown as Record<string, unknown>;
    shellApi.__kvideoTvNav = (dir: 'up' | 'down') => {
      const active = document.activeElement as HTMLElement | null;
      const target = active && active !== document.body ? active : document.body;
      target.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: dir === 'down' ? 'ArrowDown' : 'ArrowUp',
          bubbles: true,
          cancelable: true,
        })
      );
    };
    shellApi.__kvideoExitEdit = () => {
      const active = document.activeElement;
      if (isEditableText(active) && isEditing(active)) {
        exitEditMode(active);
      }
    };

    document.addEventListener('keydown', handleCaptureKeyDown, true);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('focusin', trackFocus);
    return () => {
      document.removeEventListener('keydown', handleCaptureKeyDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('focusin', trackFocus);
      delete shellApi.__kvideoTvNav;
      delete shellApi.__kvideoExitEdit;
    };
  }, [enabled, handleCaptureKeyDown, handleKeyDown]);
}
