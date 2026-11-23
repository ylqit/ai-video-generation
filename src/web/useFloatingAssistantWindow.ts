import { ref, onMounted, onBeforeUnmount } from 'vue';

// Window lifetime and persisted geometry are independent from message/run state.
export function useFloatingAssistantWindow() {
  const panel = ref<HTMLElement>(),
    minimal = ref(false),
    docked = ref(false);
  const position = ref({ x: Math.max(8, innerWidth - 530), y: 110 }),
    size = ref({ width: 470, height: 610 });
  let drag: any = null,
    observer: ResizeObserver | undefined;
  function constrain() {
    const box = panel.value?.getBoundingClientRect();
    position.value = {
      x: Math.max(8, Math.min(innerWidth - (box?.width || 470) - 8, position.value.x)),
      y: Math.max(62, Math.min(innerHeight - (box?.height || 610) - 12, position.value.y)),
    };
  }
  function rememberWindow() {
    localStorage.setItem(
      'studio:agent-window',
      JSON.stringify({
        position: position.value,
        docked: docked.value,
        minimal: minimal.value,
        size: size.value,
      }),
    );
  }
  function start(e: PointerEvent) {
    if ((e.target as HTMLElement).closest('button') || docked.value) return;
    drag = { x: e.clientX, y: e.clientY, px: position.value.x, py: position.value.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (drag) {
      position.value = { x: drag.px + e.clientX - drag.x, y: drag.py + e.clientY - drag.y };
      constrain();
    }
  }
  function stop() {
    drag = null;
    rememberWindow();
  }
  onMounted(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('studio:agent-window') || 'null');
      if (saved) {
        position.value = saved.position;
        docked.value = saved.docked;
        minimal.value = saved.minimal;
        if (saved.size) size.value = saved.size;
      }
    } catch {
      localStorage.removeItem('studio:agent-window');
    }
    observer = new ResizeObserver(() => {
      if (!minimal.value && !docked.value && panel.value)
        size.value = { width: panel.value.offsetWidth, height: panel.value.offsetHeight };
      constrain();
      rememberWindow();
    });
    if (panel.value) observer.observe(panel.value);
    window.addEventListener('resize', constrain);
    constrain();
  });
  onBeforeUnmount(() => {
    rememberWindow();
    observer?.disconnect();
    window.removeEventListener('resize', constrain);
  });
  return { panel, minimal, docked, position, size, start, move, stop, rememberWindow };
}
