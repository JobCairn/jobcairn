import { useEffect, useLayoutEffect } from "react";
import { toHash, type Route } from "../router";
import { goBack, rememberScroll, resetKept, resetTrail, visit } from "./trail";

/** The workspace generation the trail belongs to (the screens remount on a switch, so this lives outside them). */
let lastGeneration: number | null = null;

/** How long a restored scroll keeps trying while a list is still loading. */
const RESTORE_FOR_MS = 1500;

/** Typing places keep their own keys: Alt + Left moves the cursor by a word there. */
function typing(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/** Cmd or Ctrl + [, or Alt + Left: the browser's own Back keys. */
export function isBackKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & { code?: string }): boolean {
  if (e.shiftKey) return false;
  if ((e.key === "[" || e.code === "BracketLeft") && (e.metaKey || e.ctrlKey) && !e.altKey) return true;
  return e.key === "ArrowLeft" && e.altKey && !e.metaKey && !e.ctrlKey;
}

/**
 * Mounted once around the screens. Records each page in the trail, keeps each page's scroll (a new page starts
 * at the top; coming back to a page restores where it was), handles the Back keys, and forgets it all when the
 * workspace changes (`generation`).
 */
export function NavMemory({ route, generation }: { route: Route; generation: number }) {
  const hash = toHash(route);
  // Runs before the first visit below, so a new workspace starts with an empty trail.
  useLayoutEffect(() => {
    if (lastGeneration !== null && lastGeneration !== generation) { resetTrail(); resetKept(); }
    lastGeneration = generation;
  }, [generation]);

  useLayoutEffect(() => {
    const main = document.getElementById("main");
    const v = visit(hash);
    if (!main || v.samePage) return;
    if (v.restore === undefined) { main.scrollTop = 0; return; }
    const want = v.restore;
    const until = Date.now() + RESTORE_FOR_MS;
    let frame = 0;
    const tryRestore = () => {
      main.scrollTop = want;
      if (Math.abs(main.scrollTop - want) > 2 && Date.now() < until) frame = requestAnimationFrame(tryRestore);
    };
    tryRestore();
    // The person scrolling or clicking stops the restore at once.
    const stop = () => cancelAnimationFrame(frame);
    main.addEventListener("wheel", stop, { once: true, passive: true });
    main.addEventListener("pointerdown", stop, { once: true });
    return () => { cancelAnimationFrame(frame); main.removeEventListener("wheel", stop); main.removeEventListener("pointerdown", stop); };
  }, [hash]);

  useEffect(() => {
    const main = document.getElementById("main");
    if (!main) return;
    const on = () => rememberScroll(main.scrollTop);
    main.addEventListener("scroll", on, { passive: true });
    return () => main.removeEventListener("scroll", on);
  }, []);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      // Never navigate from under an open dialog (its own buttons have focus).
      if (e.defaultPrevented || !isBackKey(e) || typing(e.target) || document.querySelector("[role=dialog], dialog[open]")) return;
      if (goBack(route)) e.preventDefault();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [route]);
  return null;
}
