// jsdom ships no type declarations and this package's tsconfig has no DOM lib (video.src runs
// server-side, never in a browser). This covers only the handful of members scenes.test.ts
// actually touches, typed loosely on purpose - it's a full module declaration (not an
// augmentation), which is why it lives in its own .d.ts file rather than inline in a .ts file.
declare module "jsdom" {
  export class JSDOM {
    constructor(html: string);
    window: { document: { body: { querySelectorAll(selector: string): ArrayLike<{ tagName: string; attributes: ArrayLike<{ name: string; value: string }> }> } } };
  }
}
