import { fireEvent, render } from "@testing-library/react";
import { ToastProvider } from "@careeros/brand";
import type { ReactElement } from "react";
import { BridgeProvider } from "../src/bridge-context";
import { MockBridge } from "../src/mock/MockBridge";
import { ThemeProvider } from "../src/theme";

export function renderApp(ui: ReactElement, opts: { bridge?: MockBridge; hash?: string } = {}) {
  const bridge = opts.bridge ?? new MockBridge();
  if (opts.hash) window.location.hash = opts.hash;
  const utils = render(<BridgeProvider bridge={bridge}><ThemeProvider><ToastProvider>{ui}</ToastProvider></ThemeProvider></BridgeProvider>);
  return { bridge, ...utils };
}

/** Makes an element look cut off (wider content than box) and hovers it, so a truncation tooltip appears. */
export function cutAndHover(el: Element): void {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: 1000 });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: 50 });
  fireEvent.mouseEnter(el);
}
