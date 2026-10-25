export interface Rgba { width: number; height: number; data: Buffer }
export const ICO_SIZES: number[];
export function decodePng(buf: Buffer): Rgba;
export function encodePng(img: Rgba): Buffer;
export function resizeRgba(img: Rgba, size: number): Rgba;
export function icoFromPngs(pngs: Record<number, Buffer>): Buffer;
export function icoFromPng(png: Buffer, sizes?: number[]): Buffer;
export function readIco(buf: Buffer): { size: number; height: number; bitCount: number; data: Buffer }[];
