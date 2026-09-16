import type { ObjectDirective } from 'vue';

// Owns the modal keyboard lifecycle; each nested dialog restores its invoking control.
const active = new WeakMap<
  HTMLElement,
  { keydown: (event: KeyboardEvent) => void; prior: HTMLElement | null; close: () => void }
>();
export const dialogFocus: ObjectDirective<HTMLElement, () => void> = {
  mounted(element, binding) {
    const state = {
      prior: document.activeElement as HTMLElement | null,
      close: binding.value,
      keydown: (_event: KeyboardEvent) => {},
    };
    const controls = () =>
      Array.from(
        element.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ),
      ).filter((e) => e.getClientRects().length > 0);
    state.keydown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        state.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = controls(),
        first = items[0],
        last = items.at(-1);
      if (!first) {
        event.preventDefault();
        element.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === element)
      ) {
        event.preventDefault();
        last!.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || document.activeElement === element)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    element.tabIndex = -1;
    element.addEventListener('keydown', state.keydown);
    active.set(element, state);
    queueMicrotask(() => {
      if (element.isConnected) (controls()[0] || element).focus();
    });
  },
  updated(element, binding) {
    const state = active.get(element);
    if (state) state.close = binding.value;
  },
  unmounted(element) {
    const state = active.get(element);
    if (!state) return;
    element.removeEventListener('keydown', state.keydown);
    active.delete(element);
    if (state.prior?.isConnected) state.prior.focus();
  },
};
