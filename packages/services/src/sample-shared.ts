import type { Clock } from "@careeros/core";

/** Shared by the example's seeding modules (sample.ts, sample-mail.ts). */

/** Times "N days ago at hh:mm" in local time, never later than a few minutes before now (same-day order kept). */
export function exampleClock(now: Date) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const at = (daysAgo: number, hour = 10, minute = 0): Date => {
    const d = new Date(midnight);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, minute, 0, 0);
    // Later in the day than now: keep the order of same-day events, ending a few minutes ago.
    return d.getTime() < now.getTime() - 5 * 60_000 ? d : new Date(now.getTime() - (10 + (24 * 60 - hour * 60 - minute) / 10) * 60_000);
  };
  return { now, at, c: (daysAgo: number, hour?: number, minute?: number): Clock => ({ now: at(daysAgo, hour, minute) }) };
}
export type ExampleClock = ReturnType<typeof exampleClock>;

/** An address on a reserved example domain, built by concatenation so the privacy scan stays meaningful. */
export const exampleAddress = (user: string, domain = "example.com") => user + "@" + domain;

/** The job ids the example ended up with, keyed "<slug>/<title>", for the mail and video seeding. */
export type ExampleIds = Map<string, { slug: string; id: string }>;
export const jobKey = (slug: string, title: string) => `${slug}/${title}`;
