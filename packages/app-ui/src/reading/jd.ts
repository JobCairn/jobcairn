// The JD reader lives in contract (jd-text.ts) so main-process services can read an ad's facts too (closing dates).
export { parseJd, promoteHeadings, splitDate, splitQuote, splitUrls, type JdFact, type ParsedJd } from "@careeros/contract";
