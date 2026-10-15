// Which rendered elements are "paragraphs" for read aloud. Reading from the DOM keeps the spoken paragraph
// and the highlighted element exactly in step, whatever the markdown renderer does.
const BLOCK = "h1,h2,h3,h4,h5,h6,p,li,blockquote,dt,dd,th,td,figcaption";

/** The innermost block elements in reading order, skipping code. */
export function listenElements(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(BLOCK)].filter((el) =>
    !el.closest("pre") && !el.querySelector(BLOCK) && (el.textContent ?? "").trim() !== "");
}

/** A link whose visible text is just an address (the renderer shortens autolinks to "example.com"). */
const ADDRESS_TEXT = /^(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?$/i;

/** The words of each block. A link shown as a bare address is read as "link", like a URL in plain text. */
export function blocksFromElement(container: Element): string[] {
  return listenElements(container).map((el) => {
    if (!el.querySelector("a")) return el.textContent ?? "";
    const copy = el.cloneNode(true) as Element;
    for (const a of copy.querySelectorAll("a")) {
      const t = (a.textContent ?? "").trim();
      const href = a.getAttribute("href") ?? "";
      // Only when the text is the address itself (so a link called "Node.js" is still read as written).
      if (ADDRESS_TEXT.test(t) && (/^https?:\/\//i.test(t) || href.includes(t.replace(/\/$/, "")))) a.textContent = "link";
    }
    return copy.textContent ?? "";
  });
}

/**
 * The blocks as spoken parts, with each one's element index for the highlight. A key-fact label (`dt`) ends with
 * a colon, so a row reads as a phrase ("Source: LinkedIn.") once the chunks are joined.
 */
export function listenParts(container: Element): { text: string; block: number }[] {
  const els = listenElements(container);
  return blocksFromElement(container).map((text, block) => {
    const t = text.trim();
    return { text: els[block]?.tagName === "DT" && t && !/[.!?:;,]$/.test(t) ? `${t}:` : t, block };
  });
}
