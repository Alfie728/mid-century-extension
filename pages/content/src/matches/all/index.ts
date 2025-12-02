import type { ActionPayload, ActionType, DomMeta } from '@extension/shared';

const installFlag = '__cuaListenerInstalled__';
const alreadyInstalled = Boolean((window as unknown as { [installFlag]?: boolean })[installFlag]);

if (!alreadyInstalled) {
  (window as unknown as { [installFlag]?: boolean })[installFlag] = true;

  const perfBaseline = performance.now();

  const buildSelectors = (el: Element): string[] => {
    const selectors: string[] = [];
    if (el.id) selectors.push(`#${el.id}`);
    if (el.classList.length) selectors.push(`.${Array.from(el.classList).join('.')}`);
    selectors.push(el.tagName.toLowerCase());
    return selectors;
  };

  const getDomMeta = (
    target: EventTarget | null,
    sampleText: boolean,
    coordsOverride?: Partial<DomMeta['coords']>,
  ): DomMeta => {
    const element = target instanceof Element ? target : null;
    const rect = element?.getBoundingClientRect();
    const textSample = sampleText && element?.textContent ? element.textContent.trim().slice(0, 140) : undefined;
    const inputType = element instanceof HTMLInputElement ? element.type : undefined;

    return {
      tag: element?.tagName.toLowerCase() ?? 'unknown',
      id: element?.id,
      classList: element ? Array.from(element.classList).slice(0, 6) : undefined,
      name: element instanceof HTMLInputElement ? element.name : undefined,
      type: element instanceof HTMLInputElement ? element.type : undefined,
      selectors: element ? buildSelectors(element) : [],
      textSample,
      inputType,
      coords: {
        clientX: coordsOverride?.clientX ?? rect?.x,
        clientY: coordsOverride?.clientY ?? rect?.y,
        pageX: coordsOverride?.pageX ?? (rect ? rect.x + window.scrollX : undefined),
        pageY: coordsOverride?.pageY ?? (rect ? rect.y + window.scrollY : undefined),
        screenX: coordsOverride?.screenX,
        screenY: coordsOverride?.screenY,
        scrollX: coordsOverride?.scrollX ?? window.scrollX,
        scrollY: coordsOverride?.scrollY ?? window.scrollY,
      },
    };
  };

  const sendAction = (type: ActionType, payload: Omit<ActionPayload, 'actionId' | 'type'>) => {
    const action: ActionPayload = {
      ...payload,
      type,
      actionId: crypto.randomUUID(),
    };

    void chrome.runtime
      .sendMessage({ type: 'cua/action', payload: action })
      .then(() => {
        console.log('[CUA][content] action sent', type, action.actionId);
      })
      .catch(error => {
        console.warn('[CUA] send action failed', error);
      });
  };

  const handleClick = (event: MouseEvent) => {
    const domMeta = getDomMeta(event.target, true, {
      clientX: event.clientX,
      clientY: event.clientY,
      pageX: event.pageX,
      pageY: event.pageY,
      screenX: event.screenX,
      screenY: event.screenY,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    });
    sendAction('click', {
      domMeta,
      happenedAt: Date.now(),
      perfTime: performance.now() - perfBaseline,
      pointerMeta: { button: event.button, buttons: event.buttons },
    });
  };

  let lastScrollSent = 0;
  const handleScroll = () => {
    const now = Date.now();
    if (now - lastScrollSent < 400) return;
    lastScrollSent = now;
    const domMeta: DomMeta = {
      tag: 'document',
      selectors: ['document'],
      coords: {
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
    sendAction('scroll', {
      domMeta,
      happenedAt: now,
      perfTime: performance.now() - perfBaseline,
    });
  };

  const handleKeydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const isSensitiveInput =
      target instanceof HTMLInputElement && ['password', 'email', 'tel', 'number'].includes(target.type.toLowerCase());
    if (isSensitiveInput) return;

    const domMeta = getDomMeta(target, false);
    sendAction('keypress', {
      domMeta,
      happenedAt: Date.now(),
      perfTime: performance.now() - perfBaseline,
      keyMeta: {
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
    });
  };

  let isMoving = false;
  let moveTimeoutId: number | null = null;
  let lastMoveEvent: PointerEvent | null = null;

  const handlePointerMove = (event: PointerEvent) => {
    lastMoveEvent = event;

    if (!isMoving) {
      isMoving = true;
      const target = event.target as Element;
      const domMeta = getDomMeta(target, true, {
        clientX: event.clientX,
        clientY: event.clientY,
        pageX: event.pageX,
        pageY: event.pageY,
        screenX: event.screenX,
        screenY: event.screenY,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      });

      sendAction('mouseover_start', {
        domMeta,
        happenedAt: Date.now(),
        perfTime: performance.now() - perfBaseline,
      });
    }

    if (moveTimeoutId) {
      clearTimeout(moveTimeoutId);
    }

    moveTimeoutId = window.setTimeout(() => {
      isMoving = false;
      if (lastMoveEvent) {
        const target = lastMoveEvent.target as Element;
        sendAction('mouseover_end', {
          domMeta: getDomMeta(target, true, {
            clientX: lastMoveEvent.clientX,
            clientY: lastMoveEvent.clientY,
            pageX: lastMoveEvent.pageX,
            pageY: lastMoveEvent.pageY,
            screenX: lastMoveEvent.screenX,
            screenY: lastMoveEvent.screenY,
            scrollX: window.scrollX,
            scrollY: window.scrollY,
          }),
          happenedAt: Date.now(),
          perfTime: performance.now() - perfBaseline,
        });
      }
    }, 500);
  };

  const handleInteraction = (event: Event) => {
    if (event.type === 'click') handleClick(event as MouseEvent);
    if (event.type === 'keydown') handleKeydown(event as KeyboardEvent);
  };

  window.addEventListener('click', handleInteraction, { capture: true });
  window.addEventListener('scroll', handleScroll, { capture: true, passive: true });
  window.addEventListener('keydown', handleInteraction, { capture: true });
  window.addEventListener('pointermove', handlePointerMove, { capture: true });

  console.log('[CUA] interaction listener installed');
} else {
  console.debug('[CUA] interaction listener already active, skipping re-bind');
}
