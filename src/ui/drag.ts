/**
 * 卡片手势：点击开合侧栏、修饰键多选、指针拖拽跨列。
 * 用 Pointer Events 而非 HTML5 拖放，落点用真实 DOM 占位缝表示，布局不跳。
 */

export interface DragColumn {
  index: number;
  bodyEl: HTMLElement;
}

export interface DragHost {
  root: HTMLElement;
  columns(): DragColumn[];
  scroller(): HTMLElement | null;
  selected(): ReadonlySet<string>;
  onCardActivate(id: string, additive: boolean): void;
  onDrop(ids: string[], columnIndex: number, beforeKey: string | null): void;
}

interface Press {
  id: string;
  cardEl: HTMLElement;
  startX: number;
  startY: number;
}

interface Drag {
  ids: string[];
  ghost: HTMLElement;
  placeholder: HTMLElement;
  offsetX: number;
  offsetY: number;
}

const DRAG_THRESHOLD = 5;
const CARD_SELECTOR = ".sb-card";
const DRAGGING = "sb-card--dragging";

export function installGestures(host: DragHost): () => void {
  let press: Press | null = null;
  let drag: Drag | null = null;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const target = event.target as HTMLElement | null;
    const cardEl = target?.closest<HTMLElement>(CARD_SELECTOR);
    if (!target || !cardEl) return;
    if (target.closest(".sb-check, a, button, textarea, input, .sb-card-menu")) return;

    press = {
      id: cardEl.dataset.id ?? "",
      cardEl,
      startX: event.clientX,
      startY: event.clientY,
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown, true);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (drag) {
      updateDrag(host, drag, event);
      return;
    }
    if (!press) return;
    if (Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < DRAG_THRESHOLD) {
      return;
    }
    drag = beginDrag(host, press, event);
  };

  const onPointerUp = (event: PointerEvent): void => {
    const released = press;
    const active = drag;
    detach();

    if (!active) {
      if (released) {
        host.onCardActivate(released.id, event.shiftKey || event.metaKey || event.ctrlKey);
      }
      reset();
      return;
    }

    const target = readDropTarget(active.placeholder);
    finish(active);
    reset();
    if (target) host.onDrop(active.ids, target.columnIndex, target.beforeKey);
  };

  const onPointerCancel = (): void => {
    detach();
    if (drag) finish(drag);
    reset();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (drag) finish(drag);
    detach();
    reset();
  };

  const detach = (): void => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("keydown", onKeyDown, true);
  };

  const reset = (): void => {
    press = null;
    drag = null;
  };

  host.root.addEventListener("pointerdown", onPointerDown);
  return () => {
    host.root.removeEventListener("pointerdown", onPointerDown);
    detach();
    if (drag) finish(drag);
    reset();
  };
}

function beginDrag(host: DragHost, press: Press, event: PointerEvent): Drag {
  const selection = host.selected();
  const ids = selection.has(press.id) && selection.size > 1 ? [...selection] : [press.id];

  const rect = press.cardEl.getBoundingClientRect();
  const ghost = press.cardEl.cloneNode(true) as HTMLElement;
  ghost.classList.add("sb-ghost");
  ghost.removeAttribute("data-id");
  ghost.style.width = `${rect.width}px`;
  ghost.style.left = `${rect.left}px`;
  ghost.style.top = `${rect.top}px`;
  if (ids.length > 1) {
    const badge = document.createElement("div");
    badge.className = "sb-ghost-badge";
    badge.textContent = `+${ids.length - 1}`;
    ghost.appendChild(badge);
  }
  document.body.appendChild(ghost);

  for (const id of ids) {
    host.root.querySelector(`.sb-card[data-id="${CSS.escape(id)}"]`)?.classList.add(DRAGGING);
  }

  const placeholder = document.createElement("div");
  placeholder.className = "sb-placeholder";
  placeholder.style.height = `${rect.height}px`;
  press.cardEl.insertAdjacentElement("beforebegin", placeholder);

  return {
    ids,
    ghost,
    placeholder,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
  };
}

function updateDrag(host: DragHost, drag: Drag, event: PointerEvent): void {
  drag.ghost.style.left = `${event.clientX - drag.offsetX}px`;
  drag.ghost.style.top = `${event.clientY - drag.offsetY}px`;
  host.root.classList.add("sb-is-dragging");
  placePlaceholder(host, drag.placeholder, event.clientX, event.clientY);
  autoScroll(host, drag.placeholder, event.clientX, event.clientY);
}

function placePlaceholder(host: DragHost, placeholder: HTMLElement, x: number, y: number): void {
  const columns = host.columns();
  if (columns.length === 0) return;

  let chosen = columns[0];
  let best = Number.POSITIVE_INFINITY;
  for (const column of columns) {
    const rect = column.bodyEl.getBoundingClientRect();
    const distance =
      x >= rect.left && x <= rect.right ? 0 : Math.abs(x - (rect.left + rect.right) / 2);
    if (distance < best) {
      best = distance;
      chosen = column;
    }
  }

  const cards = chosen.bodyEl.querySelectorAll<HTMLElement>(`${CARD_SELECTOR}:not(.${DRAGGING})`);
  let reference: HTMLElement | null = null;
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (y < rect.top + rect.height / 2) {
      reference = card;
      break;
    }
  }
  if (reference) chosen.bodyEl.insertBefore(placeholder, reference);
  else chosen.bodyEl.appendChild(placeholder);
}

function autoScroll(host: DragHost, placeholder: HTMLElement, x: number, y: number): void {
  const edge = 56;
  const scroller = host.scroller();
  if (scroller) {
    const rect = scroller.getBoundingClientRect();
    if (x > rect.right - edge) scroller.scrollLeft += 16;
    else if (x < rect.left + edge) scroller.scrollLeft -= 16;
  }

  const body = placeholder.parentElement;
  if (!body) return;
  const rect = body.getBoundingClientRect();
  if (y > rect.bottom - edge) body.scrollTop += 12;
  else if (y < rect.top + edge) body.scrollTop -= 12;
}

function readDropTarget(placeholder: HTMLElement): { columnIndex: number; beforeKey: string | null } | null {
  const columnEl = placeholder.closest<HTMLElement>("[data-column-index]");
  if (!columnEl) return null;
  const columnIndex = Number(columnEl.dataset.columnIndex);
  if (Number.isNaN(columnIndex)) return null;

  let beforeKey: string | null = null;
  let node = placeholder.nextElementSibling as HTMLElement | null;
  while (node) {
    if (node.classList.contains("sb-card") && !node.classList.contains(DRAGGING)) {
      const id = node.dataset.id;
      if (id) {
        beforeKey = `c:${id}`;
        break;
      }
    }
    node = node.nextElementSibling as HTMLElement | null;
  }
  return { columnIndex, beforeKey };
}

function finish(drag: Drag): void {
  drag.ghost.remove();
  drag.placeholder.remove();
  for (const el of document.querySelectorAll(`.${DRAGGING}`)) el.classList.remove(DRAGGING);
  document.querySelector(".sb-root.sb-is-dragging")?.classList.remove("sb-is-dragging");
}
