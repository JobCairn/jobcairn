// File names are untrusted input: a dropped or picked file can carry Unicode bidi
// control characters (e.g. RLO, U+202E) that make an extension look different from
// what it really is ("invoice<RLO>fdp.exe" renders as "invoice...exe.pdf"). Strip the
// disguise before the name ever reaches the screen, so what's shown is what's real.
const INVISIBLE_FORMAT_CHARS = /[‎‏؜‪-‮⁦-⁩]/g;

/** Makes an untrusted file name safe to display: invisible bidi/format characters become a visible "�". */
export function displayName(name: string): string {
  return name.replace(INVISIBLE_FORMAT_CHARS, "�");
}
