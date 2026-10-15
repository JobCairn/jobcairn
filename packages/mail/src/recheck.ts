import type { EmailAddress, EmailMatchKind } from "@careeros/core";
import { isJobRelated, matchMessage, type CompanyInfo } from "./match.js";

/**
 * Bump when the matching rules change in a way that can unfile mail filed under the old rules. The app
 * offers "Re-check filed mail" once automatically for each version it hasn't offered yet.
 * 1: system and no-reply senders no longer match by domain alone.
 */
export const RECHECK_VERSION = 1;

export type RecheckOutcome = "keep" | "sort" | "unfile";
export interface FiledEmail {
  direction: "in" | "out"; from: EmailAddress; to: EmailAddress[]; cc: EmailAddress[]; subject: string; matched_by: EmailMatchKind;
}

/**
 * What today's matching rules say about an email the sync filed under `companySlug` earlier:
 * - "keep": you filed or moved it yourself, or it still matches that company;
 * - "sort": it no longer matches that company but looks job-related (or matches another one), so it goes to Mail to sort;
 * - "unfile": it no longer matches anything and isn't job-related, so it's removed, as a sync would skip it today.
 */
export function recheckFiled(e: FiledEmail, companySlug: string, companies: CompanyInfo[], own = ""): RecheckOutcome {
  if (e.matched_by === "user") return "keep";
  const info = { direction: e.direction, from: e.from, to: e.to, cc: e.cc, subject: e.subject };
  const m = matchMessage(info, companies, own);
  if (m && m.company_slug === companySlug) return "keep";
  return m || isJobRelated(info) ? "sort" : "unfile";
}
