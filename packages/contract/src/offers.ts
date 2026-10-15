import { SUPER_RATE } from "./analytics.js";

// Offer comparison: what each offer is worth side by side, and the short, numbers-only note "Draft negotiation
// email" hands Claude. Pure: the job record stores the details (job.offer, written through core's store).

/** Superannuation added on top of base pay when the person hasn't set a rate for an offer: the guarantee (12% from 1 July 2025), editable per offer. */
export const OFFER_SUPER_DEFAULT = SUPER_RATE;

export interface OfferDetails {
  /** Yearly base pay, without super. */
  base: number | null;
  /** Super as a fraction of base (0.115 is 11.5%); null means OFFER_SUPER_DEFAULT. */
  super_rate: number | null;
  /** Yearly bonus, as expected. */
  bonus: number | null;
  equity: string; work_mode: string; commute: string;
  /** "YYYY-MM-DD", or "". */
  start_date: string;
}

export const EMPTY_OFFER: OfferDetails = { base: null, super_rate: null, bonus: null, equity: "", work_mode: "", commute: "", start_date: "" };
/** Text fields' longest length (also the IPC check's). */
export const OFFER_TEXT_MAX = 200;

/** A stored offer with every field present (older or hand-edited records may miss some). */
export function offerOf(raw: Partial<OfferDetails> | undefined | null): OfferDetails {
  const o = raw ?? {};
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const s = (v: unknown) => (typeof v === "string" ? v.slice(0, OFFER_TEXT_MAX) : "");
  return {
    base: n(o.base), super_rate: n(o.super_rate), bonus: n(o.bonus), equity: s(o.equity), work_mode: s(o.work_mode), commute: s(o.commute),
    start_date: typeof o.start_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.start_date) ? o.start_date : "",
  };
}

export const superRate = (o: OfferDetails) => o.super_rate ?? OFFER_SUPER_DEFAULT;
/** Super in dollars a year, or null without a base. */
export const offerSuper = (o: OfferDetails) => (o.base === null ? null : Math.round(o.base * superRate(o)));
/** Base + super + bonus a year, or null without a base. Equity isn't counted: its value is a guess. */
export function offerTotal(o: OfferDetails): number | null {
  if (o.base === null) return null;
  return Math.round(o.base + (offerSuper(o) ?? 0) + (o.bonus ?? 0));
}

const aud = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;

/**
 * The note for "Draft negotiation email": this offer's numbers, and the best other offer's total as a number only.
 * Other employers are never named, so Claude can't put them in the email. Equity, commute and start date stay out
 * (free text the person typed; the email asks about pay).
 */
export function negotiationNote(mine: OfferDetails, others: OfferDetails[]): string {
  const parts: string[] = [];
  if (mine.base !== null) parts.push(`The offer is ${aud(mine.base)} base plus ${+(superRate(mine) * 100).toFixed(2)}% super${mine.bonus ? ` and a ${aud(mine.bonus)} bonus` : ""}, ${aud(offerTotal(mine)!)} a year in total.`);
  const best = others.map(offerTotal).filter((t): t is number => t !== null).sort((a, b) => b - a)[0];
  if (best !== undefined && mine.base !== null && best > offerTotal(mine)!) parts.push(`I hold another offer worth ${aud(best)} a year in total; mention it only as "another offer", never by name.`);
  parts.push("Ask politely whether they can improve the base pay. Keep it warm and keen.");
  return parts.join(" ");
}

/** The higher-is-better position of each total among the offers (1 is the best), null without a total. */
export function offerRanks(offers: OfferDetails[]): (number | null)[] {
  const totals = offers.map(offerTotal);
  return totals.map((t) => (t === null ? null : 1 + totals.filter((x) => x !== null && x > t).length));
}
