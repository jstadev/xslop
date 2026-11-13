// Vitest assigns `define` values as globals. The API origin stays a plain global, so a test can
// point it at its own mock server before it imports the modules.
(globalThis as { __XSLOP_API__?: string }).__XSLOP_API__ = 'http://127.0.0.1:9';

export function setApi(url: string): void {
  (globalThis as { __XSLOP_API__?: string }).__XSLOP_API__ = url;
}

// happy-dom: xslop uses closed shadow roots, so the page cannot read them. Tests keep a reference
// (dom.ts rootOf), and connected elements get a layout size, because happy-dom does no layout.
if (typeof HTMLElement !== 'undefined') {
  const roots = new WeakMap<Element, ShadowRoot>();
  (globalThis as { __xslopRoots?: WeakMap<Element, ShadowRoot> }).__xslopRoots = roots;
  const attach = HTMLElement.prototype.attachShadow;
  HTMLElement.prototype.attachShadow = function (this: HTMLElement, init: ShadowRootInit): ShadowRoot {
    const root = attach.call(this, init);
    roots.set(this, root);
    return root;
  };
  Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
    return this.isConnected ? new DOMRect(0, 0, 34, 34) : new DOMRect(0, 0, 0, 0);
  };
}
