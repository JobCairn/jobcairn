// The Windows icon (.ico) from the brand's rendered PNG, in plain JavaScript (node:zlib only), the way
// mac-bundle.mjs makes the .icns. Only the 512 and 1024 px PNGs are rendered, and an .ico wants the small sizes
// too (taskbar, title bar, Explorer lists), so the 1024 px image is decoded, area-averaged down to each size
// (alpha-premultiplied, so transparent edges don't darken) and stored as PNG entries, which Windows Vista and
// later read for every size.
import zlib from "node:zlib";

/** The sizes Windows asks an .ico for: small icons (16, 24, 32), Explorer (48, 64), large and jumbo (128, 256). */
export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what the icon renderer writes) to RGBA pixels. */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("png: not a PNG");
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("ascii", at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const depth = data[8]; colorType = data[9];
      if (depth !== 8 || (colorType !== 6 && colorType !== 2) || data[12] !== 0) {
        throw new Error(`png: only 8-bit, non-interlaced RGB(A) is supported (depth ${depth}, colour type ${colorType}, interlace ${data[12]})`);
      }
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    at += 12 + len;
  }
  if (!width || !height || !idat.length) throw new Error("png: no image data");
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error(`png: unknown filter ${filter}`);
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = line[x * channels]; out[o + 1] = line[x * channels + 1]; out[o + 2] = line[x * channels + 2];
      out[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** Encodes RGBA pixels as a PNG (no filtering; zlib does the work). */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) data.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA, deflate, no filter method, no interlace
  return Buffer.concat([PNG_SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Area-averaged downscale to size x size (alpha-premultiplied). The source should be square and at least as big. */
export function resizeRgba(img, size) {
  const { width, height, data } = img;
  const out = Buffer.alloc(size * size * 4);
  const sx = width / size, sy = height / size;
  for (let ty = 0; ty < size; ty++) {
    const y0 = ty * sy, y1 = y0 + sy;
    for (let tx = 0; tx < size; tx++) {
      const x0 = tx * sx, x1 = x0 + sx;
      let r = 0, g = 0, b = 0, a = 0, w = 0;
      for (let y = Math.floor(y0); y < Math.min(height, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(width, Math.ceil(x1)); x++) {
          const wt = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const o = (y * width + x) * 4;
          const al = data[o + 3] * wt;
          r += data[o] * al; g += data[o + 1] * al; b += data[o + 2] * al; a += al; w += wt;
        }
      }
      const o = (ty * size + tx) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = w > 0 ? Math.round(a / w) : 0;
    }
  }
  return { width: size, height: size, data: out };
}

/** An .ico holding the given PNGs (keys are the pixel sizes, 1 to 256), each stored as a PNG entry. */
export function icoFromPngs(pngs) {
  const entries = Object.entries(pngs).map(([size, data]) => {
    const s = Number(size);
    if (!Number.isInteger(s) || s < 1 || s > 256) throw new Error(`ico: unsupported size ${size}`);
    if (!Buffer.isBuffer(data) || !data.subarray(0, 8).equals(PNG_SIG)) throw new Error(`ico: ${size} is not a PNG`);
    return { s, data };
  }).sort((a, b) => a.s - b.s);
  if (!entries.length) throw new Error("ico: no images");
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = entries.map(({ s, data }) => {
    const e = Buffer.alloc(16);
    e[0] = s === 256 ? 0 : s; e[1] = s === 256 ? 0 : s; // 0 means 256
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...entries.map((e) => e.data)]);
}

/** The app's .ico from one large square PNG (the 1024 px render), at every size in ICO_SIZES. */
export function icoFromPng(png, sizes = ICO_SIZES) {
  const img = decodePng(png);
  if (img.width !== img.height) throw new Error(`ico: the source must be square (${img.width}x${img.height})`);
  if (Math.max(...sizes) > img.width) throw new Error(`ico: the source (${img.width}px) is smaller than ${Math.max(...sizes)}px`);
  return icoFromPngs(Object.fromEntries(sizes.map((s) => [s, encodePng(resizeRgba(img, s))])));
}

/** Reads an .ico's directory: each entry's size and its embedded image (tests and verification). */
export function readIco(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("ico: not an icon file");
  const n = buf.readUInt16LE(4);
  return Array.from({ length: n }, (_, i) => {
    const e = 6 + i * 16;
    const size = buf[e] || 256;
    const len = buf.readUInt32LE(e + 8), off = buf.readUInt32LE(e + 12);
    return { size, height: buf[e + 1] || 256, bitCount: buf.readUInt16LE(e + 6), data: buf.subarray(off, off + len) };
  });
}
