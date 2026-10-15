// jsdom (a root dev dependency) ships no types and @types/jsdom isn't installed. The print tests use only this much of it.
declare module "jsdom" {
  interface XNode { textContent: string | null; tagName: string; getAttributeNames(): string[]; getElementsByTagNameNS(ns: string, name: string): ArrayLike<XNode> & Iterable<XNode>; getElementsByTagName(name: string): ArrayLike<XNode> }
  interface XDocument extends XNode { body: XNode & { querySelectorAll(sel: string): ArrayLike<XNode> & Iterable<XNode> }; querySelectorAll(sel: string): ArrayLike<XNode> & Iterable<XNode> }
  export class JSDOM {
    constructor(html?: string);
    window: { document: XDocument; DOMParser: new () => { parseFromString(text: string, type: string): XDocument } };
  }
}
