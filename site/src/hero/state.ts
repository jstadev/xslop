// The one xslop switch of the page. The hero and the thread both show it; the flood and the headline follow it.

type Listener = (on: boolean) => void;

export interface XslopSwitch {
  readonly on: boolean;
  set(on: boolean): void;
  subscribe(listener: Listener): void;
}

function createSwitch(): XslopSwitch {
  const listeners = new Set<Listener>();
  let current = false;
  return {
    get on() {
      return current;
    },
    set(on) {
      if (on === current) return;
      current = on;
      for (const listener of listeners) listener(on);
    },
    subscribe(listener) {
      listeners.add(listener);
    },
  };
}

export const xslop = createSwitch();
