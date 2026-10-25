import { describe, expect, it } from "vitest";
import { decodePng, encodePng, ICO_SIZES, icoFromPng, icoFromPngs, readIco, resizeRgba } from "../scripts/win-icon.mjs";

/** A square RGBA test image: an opaque red disc on a transparent background. */
function disc(size: number) {
  const data = Buffer.alloc(size * size * 4);
  const c = size / 2, r = size * 0.4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 > r * r) continue;
    const o = (y * size + x) * 4;
    data[o] = 200; data[o + 1] = 30; data[o + 2] = 40; data[o + 3] = 255;
  }
  return { width: size, height: size, data };
}

describe("PNG in plain JavaScript", () => {
  it("round-trips RGBA pixels through encode and decode", () => {
    const img = disc(40);
    const back = decodePng(encodePng(img));
    expect(back.width).toBe(40);
    expect(back.height).toBe(40);
    expect(back.data.equals(img.data)).toBe(true);
  });

  it("refuses what it can't read", () => {
    expect(() => decodePng(Buffer.from("not a png"))).toThrow(/not a PNG/);
    const png = encodePng(disc(4));
    // IHDR's bit depth byte: 16-bit isn't supported.
    const deep = Buffer.from(png);
    deep[8 + 8 + 8] = 16;
    expect(() => decodePng(deep)).toThrow(/8-bit/);
  });
});

describe("downscaling", () => {
  it("keeps the colour of a solid area and the transparency around it (no dark fringe)", () => {
    const small = resizeRgba(disc(1024), 24);
    const at = (x: number, y: number) => [...small.data.subarray((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)];
    expect(at(12, 12)).toEqual([200, 30, 40, 255]);
    expect(at(0, 0)[3]).toBe(0);
    // An edge pixel is partly transparent but keeps the disc's colour (alpha-premultiplied averaging).
    const edge = [...Array(24).keys()].map((x) => at(x, 12)).find((p) => p[3]! > 0 && p[3]! < 255)!;
    expect(edge.slice(0, 3)).toEqual([200, 30, 40]);
  });
});

describe("the Windows .ico", () => {
  it("holds a PNG for every size Windows asks for, 256 written as 0", () => {
    const ico = icoFromPng(encodePng(disc(1024)));
    const entries = readIco(ico);
    expect(entries.map((e) => e.size)).toEqual(ICO_SIZES);
    expect(ICO_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256]);
    for (const e of entries) {
      expect(e.height).toBe(e.size);
      expect(e.bitCount).toBe(32);
      const img = decodePng(e.data);
      expect([img.width, img.height]).toEqual([e.size, e.size]);
    }
    // The directory entry for 256 px stores 0 in its width and height bytes.
    const last = 6 + 16 * (ICO_SIZES.length - 1);
    expect([ico[last], ico[last + 1]]).toEqual([0, 0]);
  });

  it("refuses a source that isn't square, is too small, or isn't a PNG", () => {
    expect(() => icoFromPng(encodePng({ width: 4, height: 2, data: Buffer.alloc(32) }))).toThrow(/square/);
    expect(() => icoFromPng(encodePng(disc(128)))).toThrow(/smaller than 256px/);
    expect(() => icoFromPngs({ 16: Buffer.from("nope") })).toThrow(/not a PNG/);
    expect(() => icoFromPngs({ 512: encodePng(disc(4)) })).toThrow(/unsupported size/);
  });
});
