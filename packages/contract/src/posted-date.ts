/** "This week" as a number of days. Pure: the caller passes the clock. */

/**
 * Days since Monday, counting today: Monday 1, Tuesday 2 ... Sunday 7 (local time). "This week" means ads posted
 * in this many days, so on a Monday it's the last 24 hours and by Sunday the whole week.
 */
export function daysSinceMonday(now: Date): number {
  const d = now.getDay();
  return d === 0 ? 7 : d;
}
