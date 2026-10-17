import { describe, expect, it } from "vitest";
import {
  coreName, counterparts, domainMatches, isIgnored, isJobRelated, matchMessage, pickJob, suggestCompany, websiteDomain,
  type CompanyInfo, type HeaderInfo,
} from "../src/match.js";
import { addr, ALEX, TALENT } from "../src/testing.js";

const job = (id: string, title: string, status = "Found", last_activity = "2026-01-12T09:00:00.000Z") => ({ id, title, status, last_activity });
const ACME: CompanyInfo = {
  slug: "acme-corp", name: "Acme Corp", aliases: [], website: "https://www.acme.example.com/careers", recruiter_email: TALENT, email_match: [],
  jobs: [job("2026-01-12-ai-engineer", "AI Engineer", "Applied")],
};
const LABS: CompanyInfo = {
  slug: "example-labs", name: "Example Labs Pty Ltd", aliases: [], website: "examplelabs.example.net", recruiter_email: "",
  email_match: [addr("hiring", "partners.example.com"), "labs-talent.example.com", "LLM"],
  jobs: [job("2026-01-12-backend-engineer-llm", "Backend Engineer (LLM)"), job("2026-01-13-ml-engineer", "ML Engineer", "Interview", "2026-01-14T09:00:00.000Z"), job("2026-01-10-data-engineer", "Data Engineer", "Applying", "2026-01-11T09:00:00.000Z")],
};
const RECRUITING: CompanyInfo = { slug: "acme-recruiting", name: "Acme Recruiting", aliases: ["AR Talent"], website: "", recruiter_email: "", email_match: [], jobs: [] };
const FREE: CompanyInfo = { slug: "free-co", name: "Free Co", aliases: [], website: "https://gmail.com", recruiter_email: "", email_match: [], jobs: [] };
const ALL = [ACME, LABS, RECRUITING, FREE];
const h = (from: string, subject = "Hello", over: Partial<HeaderInfo> = {}): HeaderInfo => ({ direction: "in", from: { name: "", address: from }, to: [{ name: "", address: ALEX }], cc: [], subject, ...over });

describe("matchMessage", () => {
  it("matches the recruiter first, even when the subject names another company", () => {
    expect(matchMessage(h(TALENT, "Example Labs role"), ALL, ALEX)).toEqual({ company_slug: "acme-corp", job_id: "2026-01-12-ai-engineer", matched_by: "recruiter" });
  });
  it("matches addresses, then website domains with subdomains, then domains and words in email_match", () => {
    expect(matchMessage(h(addr("hiring", "partners.example.com")), ALL, ALEX)?.matched_by).toBe("email_match");
    expect(matchMessage(h(addr("people", "careers.acme.example.com")), ALL, ALEX)).toMatchObject({ company_slug: "acme-corp", matched_by: "domain" });
    expect(matchMessage(h(addr("people", "notacme.example.com")), ALL, ALEX)).toBeNull();
    expect(matchMessage(h(addr("x", "eu.labs-talent.example.com")), ALL, ALEX)).toMatchObject({ company_slug: "example-labs", matched_by: "email_match" });
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Your LLM work"), ALL, ALEX)).toMatchObject({ company_slug: "example-labs", matched_by: "email_match" });
  });
  it("never matches on a free-mail or job-board domain, or on a display name", () => {
    expect(matchMessage(h(addr("someone", "gmail.com")), ALL, ALEX)).toBeNull();
    expect(matchMessage({ ...h(addr("x", "elsewhere.example.org")), from: { name: "Acme Corp Talent", address: addr("x", "elsewhere.example.org") } }, ALL, ALEX)).toBeNull();
  });
  it("matches the company name in the subject as whole words, preferring the longest name", () => {
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Your Acme Corp application"), ALL, ALEX)).toMatchObject({ company_slug: "acme-corp", matched_by: "subject" });
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Acme Recruiting update"), ALL, ALEX)?.company_slug).toBe("acme-recruiting");
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "News from AR Talent"), ALL, ALEX)?.company_slug).toBe("acme-recruiting");
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Acmeville newsletter"), ALL, ALEX)).toBeNull();
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Example Labs: next steps"), ALL, ALEX)?.company_slug).toBe("example-labs");
  });
  it("matches sent mail on its recipients", () => {
    const out = h(ALEX, "Re: Interview", { direction: "out", to: [{ name: "", address: TALENT }] });
    expect(counterparts(out, ALEX)).toEqual([{ name: "", address: TALENT }]);
    expect(matchMessage(out, ALL, ALEX)?.company_slug).toBe("acme-corp");
  });
  it("never counts the user's own address as a counterpart, even if a company's recruiter_email is that address", () => {
    const selfAsRecruiter: CompanyInfo = { ...ACME, recruiter_email: ALEX };
    expect(matchMessage(h(ALEX, "Hello"), [selfAsRecruiter], ALEX)).toBeNull();
    // The incoming "from" is the user's own address with nobody else on the message: no counterpart at all.
    expect(counterparts(h(ALEX), ALEX)).toEqual([]);
  });
});

describe("pickJob", () => {
  it("uses the only job, then title words, then the most recent active job, else the company", () => {
    expect(pickJob(ACME, "anything")).toBe("2026-01-12-ai-engineer");
    expect(pickJob(LABS, "Backend Engineer LLM interview")).toBe("2026-01-12-backend-engineer-llm");
    expect(pickJob(LABS, "Data Engineer: next steps")).toBe("2026-01-10-data-engineer");
    expect(pickJob(LABS, "Quick question")).toBe("2026-01-13-ml-engineer");
    expect(pickJob({ ...LABS, jobs: LABS.jobs.map((j) => ({ ...j, status: "Found" })) }, "Quick question")).toBe("");
    expect(pickJob(RECRUITING, "x")).toBe("");
  });
});

describe("job-related rule and helpers", () => {
  it("knows job boards, ATS senders and job words, and leaves personal mail alone", () => {
    expect(isJobRelated(h(addr("noreply", "s.seek.com.au"), "New jobs for you"))).toBe(true);
    expect(isJobRelated(h(addr("no-reply", "greenhouse.io"), "Thanks"))).toBe(true);
    expect(isJobRelated(h(addr("x", "elsewhere.example.org"), "Your application to Contoso"))).toBe(true);
    expect(isJobRelated(h(addr("x", "elsewhere.example.org"), "Interviews this week"))).toBe(true);
    expect(isJobRelated(h(addr("mum", "example.net"), "Dinner on Sunday?"))).toBe(false);
    expect(isJobRelated(h(addr("x", "elsewhere.example.org"), "Controller update: control rolex"))).toBe(false);
  });
  it("suggests a company for mail to sort", () => {
    expect(suggestCompany(h(addr("people", "examplelabs-mail.example.org"), "Hi"), ALL)).toEqual({ company_slug: "example-labs", company_name: "Example Labs Pty Ltd", reason: "The sender's domain looks like Example Labs Pty Ltd." });
    expect(suggestCompany(h(addr("x", "elsewhere.example.org"), "Hi"), ALL)).toBeNull();
  });
  it("handles domains, websites, names and the ignore list", () => {
    expect(websiteDomain("https://www.acme.example.com/careers")).toBe("acme.example.com");
    expect(websiteDomain("not a site")).toBe("");
    expect(domainMatches("eu.jobs.example.com", "jobs.example.com")).toBe(true);
    expect(domainMatches("badjobs.example.com", "jobs.example.com")).toBe(false);
    expect(coreName("Example Labs Pty Ltd")).toBe("Example Labs");
    expect(coreName("Acme Corp")).toBe("Acme");
    const ignore = { senders: [addr("news", "example.net")], domains: ["spam.example.com"] };
    expect(isIgnored(addr("NEWS", "example.net"), ignore)).toBe(true);
    expect(isIgnored(addr("a", "eu.spam.example.com"), ignore)).toBe(true);
    expect(isIgnored(TALENT, ignore)).toBe(false);
  });
});

// --- security expectations (hardening beyond the brief's own fixture) -----------------------------

describe("domainMatches: true suffix match on a label boundary only", () => {
  it("matches the domain itself and any subdomain under it", () => {
    expect(domainMatches("acme.com", "acme.com")).toBe(true);
    expect(domainMatches("mail.acme.com", "acme.com")).toBe(true);
    expect(domainMatches("a.b.mail.acme.com", "acme.com")).toBe(true);
  });
  it("never matches a domain that merely contains the base as a substring without a label boundary", () => {
    expect(domainMatches("evilacme.com", "acme.com")).toBe(false);
    expect(domainMatches("acme.com.evil.net", "acme.com")).toBe(false);
    expect(domainMatches("acme.co", "acme.com")).toBe(false);
  });
  it("compares case-insensitively", () => {
    expect(domainMatches("MAIL.ACME.COM", "acme.com")).toBe(true);
    expect(domainMatches("mail.acme.com", "ACME.COM")).toBe(true);
  });
  it("tolerates a trailing dot on either side (an absolute FQDN is the same domain)", () => {
    expect(domainMatches("acme.com.", "acme.com")).toBe(true);
    expect(domainMatches("mail.acme.com.", "acme.com.")).toBe(true);
    expect(domainMatches("acme.com", "acme.com.")).toBe(true);
  });
  it("treats a Unicode domain and its punycode form as the same domain (IDN/punycode consistency)", () => {
    // "café.example.com" ToASCII-encodes to "xn--caf-dma.example.com": the chosen normalization
    // form (documented on `toAsciiDomain`) is ASCII/punycode via the WHATWG URL host parser, so
    // either spelling of the same domain compares equal, in either position.
    expect(domainMatches("café.example.com", "xn--caf-dma.example.com")).toBe(true);
    expect(domainMatches("mail.xn--caf-dma.example.com", "café.example.com")).toBe(true);
  });
  it("never matches on an empty base, however the domain is spelled", () => {
    expect(domainMatches("acme.com", "")).toBe(false);
    expect(domainMatches("acme.com", "   ")).toBe(false);
    expect(domainMatches("acme.com", ".")).toBe(false);
  });
});

describe("matchCompany never treats a public mail host as a company domain", () => {
  it("does not match on a free-mail domain even when it is literally the configured website", () => {
    // FREE's website is "https://gmail.com" in the fixture above; no message from any
    // gmail.com address should ever be attributed to it via the domain rule.
    expect(matchMessage(h(addr("someone.else", "gmail.com"), "Totally unrelated"), ALL, ALEX)).toBeNull();
  });
  it("does not match on a job-board domain even when it is configured as a website", () => {
    const board: CompanyInfo = { slug: "board-co", name: "Board Co", aliases: [], website: "https://www.linkedin.com", recruiter_email: "", email_match: [], jobs: [] };
    expect(matchMessage(h(addr("jobs-noreply", "linkedin.com"), "Hello"), [board], ALEX)).toBeNull();
  });
});

describe("word/name matching never matches inside an unrelated word", () => {
  it("does not match a company's core name as a substring of a longer word in the subject", () => {
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "AcmeCorporation newsletter"), [ACME], ALEX)).toBeNull();
  });
  it("does not match a multi-word alias unless both words appear contiguously", () => {
    const scattered = h(addr("x", "elsewhere.example.org"), "AR representative also likes Talent shows");
    expect(matchMessage(scattered, [RECRUITING], ALEX)).toBeNull();
  });
});

describe("timing guard: subject and company-name matching stay fast on hostile-sized input", () => {
  it("matches in well under a generous budget for a 100,000-character subject and 10,000 companies", () => {
    // Build every input before starting the timer (only the call under test should be measured).
    // Two adversarial shapes in one subject: a single 100,000-character "word" with no internal
    // separators (defeats any approach that re-scans the whole subject once per company), plus a
    // long run of a short, common token ("company", which is also literally the first word of
    // every one of the 10,000 synthetic company names below, to make the trie's root node as
    // "busy" as possible at every position).
    const hostileSubject = `${"a".repeat(50_000)}! ${"company ".repeat(6_250)}zzz`;
    const manyCompanies: CompanyInfo[] = Array.from({ length: 10_000 }, (_, i) => ({
      slug: `company-${i}`, name: `Company Number ${i} Pty Ltd`, aliases: [`Alias ${i}`], website: "",
      recruiter_email: "", email_match: [`word${i}`], jobs: [],
    }));
    const header = h(addr("stranger", "elsewhere.example.org"), hostileSubject);

    const start = performance.now();
    const result = matchMessage(header, manyCompanies, ALEX);
    const elapsed = performance.now() - start;

    expect(result).toBeNull();
    // 500ms, not 200ms: measured well under 150ms in isolation, but running the whole repo's test
    // suite in parallel (many workers competing for CPU) pushed this one to ~250ms, flaking against
    // a 200ms budget. A generous-but-still-meaningful budget avoids that: a real quadratic
    // regression here would cost seconds, not a couple of hundred milliseconds either way.
    expect(elapsed).toBeLessThan(500);
  });
});

// --- fix round 1 -----------------------------------------------------------------------------------

describe("item 1: phrase matching for email_match entries", () => {
  it("matches a two-word email_match entry as a contiguous phrase", () => {
    const co: CompanyInfo = { slug: "phrase-co", name: "Phrase Co", aliases: [], website: "", recruiter_email: "", email_match: ["Example Labs"], jobs: [] };
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Your Example Labs interview"), [co], ALEX)).toMatchObject({ company_slug: "phrase-co", matched_by: "email_match" });
  });
  it("matches a hyphenated email_match entry against a space-separated subject", () => {
    const co: CompanyInfo = { slug: "hyphen-co", name: "Hyphen Co", aliases: [], website: "", recruiter_email: "", email_match: ["acme-labs"], jobs: [] };
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Acme Labs update"), [co], ALEX)).toMatchObject({ company_slug: "hyphen-co", matched_by: "email_match" });
  });
  it("matches a punctuation-heavy email_match entry like 'C++', the same as the brief's wholeWord would", () => {
    const co: CompanyInfo = { slug: "cpp-co", name: "Cpp Co", aliases: [], website: "", recruiter_email: "", email_match: ["C++"], jobs: [] };
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Our C++ team is hiring"), [co], ALEX)).toMatchObject({ company_slug: "cpp-co", matched_by: "email_match" });
  });
});

describe("item 1: phrase matching for isJobRelated words", () => {
  const list = { domains: [], words: ["job offer", "follow-up"] };
  it("matches a two-word job phrase", () => {
    expect(isJobRelated(h(addr("x", "elsewhere.example.org"), "Your job offer is ready"), list)).toBe(true);
  });
  it("matches a hyphenated job phrase", () => {
    expect(isJobRelated(h(addr("x", "elsewhere.example.org"), "Quick follow-up on your application"), list)).toBe(true);
  });
  it("still leaves unrelated mail alone", () => {
    expect(isJobRelated(h(addr("mum", "example.net"), "Dinner on Sunday?"), list)).toBe(false);
  });
});

describe("item 2: linear even with duplicate names, long aliases, and many email_match domains", () => {
  it("stays fast and picks the list-order winner when 10,000 companies share one name, over a 50,000-token subject", () => {
    const hostileSubject = "acme ".repeat(50_000).trim();
    const manyAcme: CompanyInfo[] = Array.from({ length: 10_000 }, (_, i) => ({
      slug: `acme-${i}`, name: "Acme", aliases: [], website: "", recruiter_email: "", email_match: [], jobs: [],
    }));
    const header = h(addr("stranger", "elsewhere.example.org"), hostileSubject);

    const start = performance.now();
    const result = matchMessage(header, manyAcme, ALEX);
    const elapsed = performance.now() - start;

    expect(result?.company_slug).toBe("acme-0");
    // 500ms for the same full-suite-parallel-CPU-contention reason as the timing guard above.
    expect(elapsed).toBeLessThan(500);
  });

  it("stays fast when 10,000 companies each carry a 10,000-character, 2,000-word alias", () => {
    // Many short words (not one giant unseparated run) so tokenize() itself would have real work to
    // do if it ran at all -- this is what makes the MAX_PHRASE_CHARS pre-filter (checked before
    // tokenize(), not after) actually matter: tokenizing this exact alias 10,000 times measured at
    // ~800ms locally without the pre-filter, comfortably over budget.
    const hugeAlias = "word ".repeat(2_000).trim();
    const companies: CompanyInfo[] = Array.from({ length: 10_000 }, (_, i) => ({
      slug: `co-${i}`, name: `Company ${i}`, aliases: [hugeAlias], website: "", recruiter_email: "", email_match: [], jobs: [],
    }));
    const header = h(addr("stranger", "elsewhere.example.org"), "Hello there, nothing relevant here");

    const start = performance.now();
    const result = matchMessage(header, companies, ALEX);
    const elapsed = performance.now() - start;

    expect(result).toBeNull();
    // 500ms for the same full-suite-parallel-CPU-contention reason as the timing guard above.
    expect(elapsed).toBeLessThan(500);
  });

  it("stays fast for 10,000 companies x 100 email_match domains, across several counterparts", () => {
    // A generous (not razor-thin) budget: normalizing 1,000,000 raw domain-like strings is an
    // inherent JS-string-processing cost, not a sign of quadratic behaviour -- the bug this guards
    // against is re-normalizing per counterpart too. Task 9 widened the budget from 3000ms, which
    // flaked under full-suite load. Measured 2026-10-10 (Task 9): 0.66-0.80s standalone and
    // 1.6-2.0s inside the full `npm test` run. 8000ms is ~10x the standalone time and ~4x the
    // worst full-suite time, and still ~4x tighter than the ~33s this exact scenario measured
    // against the pre-fix-round-1 match.ts (9cb3dc8), so a real regression still fails hard. The
    // explicit 60s test timeout keeps vitest's 5s default from becoming the real budget.
    const companies: CompanyInfo[] = Array.from({ length: 10_000 }, (_, i) => ({
      slug: `dom-co-${i}`, name: `Dom Co ${i}`, aliases: [], website: "", recruiter_email: "",
      email_match: Array.from({ length: 100 }, (_, j) => `sub${j}.dom-co-${i}.example.com`), jobs: [],
    }));
    // Fix round 2: this guard previously didn't actually catch the "normalizes per counterpart"
    // regression it's meant to prevent, for two reasons -- both fixed here: only 8 recipients
    // (raised to ~40), and every recipient shared the *same* domain ("elsewhere.example.org"),
    // which `new Set(...)` collapsed down to a single normalized counterpart domain regardless of
    // recipient count, so the old per-counterpart cost was never actually paid more than once.
    // Each recipient now has its own distinct domain, so normDomains genuinely holds ~40 entries.
    // Verified against 9cb3dc8 (the pre-fix-round-1 match.ts): with both fixes, the old
    // per-counterpart-renormalization cost blows well past this 1500ms budget, while the current
    // code stays flat.
    const manyRecipients = Array.from({ length: 40 }, (_, i) => ({ name: "", address: addr(`person${i}`, `dom${i}.elsewhere.example.org`) }));
    const header: HeaderInfo = { direction: "out", from: { name: "", address: ALEX }, to: manyRecipients, cc: [], subject: "Hello" };

    const start = performance.now();
    const result = matchMessage(header, companies, ALEX);
    const elapsed = performance.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(8000);
  }, 60_000);
});

describe("item 3: domain normalization rejects URL syntax, IP tricks and fullwidth homographs", () => {
  it("rejects every URL-syntax or percent-escape variant that could otherwise smuggle a path past the real host", () => {
    expect(domainMatches("acme.com/.evil.net", "acme.com")).toBe(false);
    expect(domainMatches("acme.com\\.evil.net", "acme.com")).toBe(false);
    expect(domainMatches("acme.com#.evil.net", "acme.com")).toBe(false);
    expect(domainMatches("acme.com?.evil.net", "acme.com")).toBe(false);
    expect(domainMatches("evil%2eacme.com", "acme.com")).toBe(false);
    expect(domainMatches("acme.com:80", "acme.com")).toBe(false);
  });
  it("rejects a fullwidth homograph and a CJK ideographic-dot look-alike", () => {
    expect(domainMatches("ａｃｍｅ.com", "acme.com")).toBe(false);
    expect(domainMatches("ACME。com", "acme.com")).toBe(false);
  });
  it("never normalizes an IP-literal trick into a real IP address", () => {
    expect(domainMatches("0x7f.1", "127.0.0.1")).toBe(false);
  });
  it("rejects a base containing URL syntax too", () => {
    expect(domainMatches("acme.com", "acme.com/x")).toBe(false);
  });
  it("end-to-end: a forged address domain with a path suffix never matches the real company", () => {
    expect(matchMessage(h(addr("x", "acme.example.com/.evil.net")), [ACME], ALEX)).toBeNull();
  });
});

describe("item 4: subject-match ties are broken by company list order, not subject position", () => {
  it("picks the company earlier in the list even when its name appears later in the subject", () => {
    const NOVA: CompanyInfo = { slug: "nova", name: "Nova", aliases: [], website: "", recruiter_email: "", email_match: [], jobs: [] };
    const VEGA: CompanyInfo = { slug: "vega", name: "Vega", aliases: [], website: "", recruiter_email: "", email_match: [], jobs: [] };
    const subject = "Vega team meets Nova team";
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), subject), [NOVA, VEGA], ALEX)?.company_slug).toBe("nova");
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), subject), [VEGA, NOVA], ALEX)?.company_slug).toBe("vega");
  });
});

describe("item 5: tokenizing keeps combining marks whole and excludes near-empty names", () => {
  it("excludes 'C++' (tokenizes to a single one-letter token) from name/alias matching", () => {
    const CPP: CompanyInfo = { slug: "cpp-corp", name: "C++", aliases: [], website: "", recruiter_email: "", email_match: [], jobs: [] };
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Plan C is ready"), [CPP], ALEX)).toBeNull();
  });
  it("keeps the tolerant punctuation behaviour: a hyphenated alias matches a space-separated subject", () => {
    const HY: CompanyInfo = { slug: "hy-co", name: "Hy Co", aliases: ["Acme-Labs"], website: "", recruiter_email: "", email_match: [], jobs: [] };
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Acme Labs is hiring"), [HY], ALEX)?.company_slug).toBe("hy-co");
  });
  it("Devanagari: excludes a mark-heavy name with only one real letter, even from a bare mention of that letter", () => {
    // "किीि" is one base consonant ("क") plus three vowel-sign combining marks -- one real letter
    // once marks are excluded from the count (per item 5), so it must never match anything,
    // including a subject that contains that bare consonant as its own word. Without keeping
    // combining marks *inside* the token, this name would wrongly tokenize down to exactly that
    // bare consonant and then wrongly match it.
    const DEV: CompanyInfo = { slug: "dev-co", name: "किीि", aliases: [], website: "", recruiter_email: "", email_match: [], jobs: [] };
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "क is a letter"), [DEV], ALEX)).toBeNull();
  });
  it("Devanagari: does not split a real multi-letter word at its combining marks", () => {
    const DEV2: CompanyInfo = { slug: "namaste-co", name: "नमस्ते", aliases: [], website: "", recruiter_email: "", email_match: [], jobs: [] };
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "नमस्ते team, quick update"), [DEV2], ALEX)?.company_slug).toBe("namaste-co");
  });
});

describe("item 7: free-mail detection covers subdomains and common country-TLD variants", () => {
  it("treats a subdomain of a known free-mail host as free-mail", () => {
    const co: CompanyInfo = { slug: "sub-free", name: "Sub Free", aliases: [], website: "https://mail.yahoo.com", recruiter_email: "", email_match: [], jobs: [] };
    expect(matchMessage(h(addr("someone", "mail.yahoo.com"), "Totally unrelated"), [co], ALEX)).toBeNull();
  });
  it("treats a common country-TLD variant of a known free-mail host as free-mail", () => {
    const co: CompanyInfo = { slug: "au-free", name: "AU Free", aliases: [], website: "https://yahoo.com.au", recruiter_email: "", email_match: [], jobs: [] };
    expect(matchMessage(h(addr("someone", "yahoo.com.au"), "Totally unrelated"), [co], ALEX)).toBeNull();
    const co2: CompanyInfo = { slug: "au-free-2", name: "AU Free 2", aliases: [], website: "https://outlook.com.au", recruiter_email: "", email_match: [], jobs: [] };
    expect(matchMessage(h(addr("someone", "outlook.com.au"), "Totally unrelated"), [co2], ALEX)).toBeNull();
  });
});

// --- fix round 2 -----------------------------------------------------------------------------------

describe("item 1 (fix round 2): isJobRelated skips MIN_NAME_LENGTH for job words, email_match keeps it", () => {
  const list = { domains: [], words: ["CV", "HR"] };
  it("matches a bare 2-letter job word", () => {
    expect(isJobRelated(h(addr("x", "elsewhere.example.org"), "Your CV"), list)).toBe(true);
    expect(isJobRelated(h(addr("x", "elsewhere.example.org"), "HR update"), list)).toBe(true);
  });
  it("the pluralized form still matches, as before", () => {
    expect(isJobRelated(h(addr("x", "elsewhere.example.org"), "New CVs received"), list)).toBe(true);
  });
  it("an email_match word still needs at least 3 characters", () => {
    const co: CompanyInfo = { slug: "cv-co", name: "CV Co", aliases: [], website: "", recruiter_email: "", email_match: ["CV"], jobs: [] };
    expect(matchMessage(h(addr("x", "elsewhere.example.org"), "Your CV status"), [co], ALEX)).toBeNull();
  });
});

describe("item 2 (fix round 2): toAsciiDomain bounds the punycode encoder and normalizes NFD to NFC", () => {
  it("rejects a label over 63 code points, before the (quadratic) encoding step", () => {
    const longLabel = `${"é".repeat(64)}.com`;
    expect(domainMatches(longLabel, longLabel)).toBe(false);
  });
  it("normalizes NFD to NFC before the character-class gate, so a decomposed and composed form of the same domain match", () => {
    const nfd = `cafe${"́"}.example.com`; // "café" written as "e" + a combining acute accent (NFD)
    expect(domainMatches(nfd, "xn--caf-dma.example.com")).toBe(true);
  });
});

describe("system and no-reply mail from a platform is never filed by domain alone", () => {
  // Acme stands in for a big platform that is also a tracked employer (its own accounts mail, its own careers).
  const PLATFORM: CompanyInfo = {
    slug: "acme-corp", name: "Acme Corp", aliases: [], website: "https://acme.example.com", recruiter_email: "", email_match: [],
    jobs: [job("2026-01-12-ai-engineer", "AI Engineer", "Applied")],
  };
  const BOARD: CompanyInfo = { slug: "seek", name: "SEEK", aliases: [], website: "https://www.seek.com.au", recruiter_email: "", email_match: [], jobs: [job("2026-01-02-x", "X")] };
  const LIST = [PLATFORM, BOARD];

  it("does not file an account notice from the platform's no-reply sender under the platform's job", () => {
    expect(matchMessage(h(addr("noreply-accounts", "acme.example.com"), "You shared some Acme Account data with Example Labs"), LIST, ALEX)).toBeNull();
    expect(matchMessage(h(addr("no-reply", "accounts.acme.example.com"), "Review your Acme Account settings"), LIST, ALEX)).toBeNull();
    expect(matchMessage(h(addr("notifications", "acme.example.com"), "Security alert"), LIST, ALEX)).toBeNull();
    expect(matchMessage(h(addr("donotreply", "mail.acme.example.com"), "Welcome to Acme"), LIST, ALEX)).toBeNull();
  });
  it("still files mail from a person at the platform's domain", () => {
    expect(matchMessage(h(addr("jordan.lee", "acme.example.com"), "Next steps"), LIST, ALEX)).toMatchObject({ company_slug: "acme-corp", matched_by: "domain" });
    // Real recruiting mailboxes are people-run, not system senders.
    for (const user of ["careers", "talent", "jobs", "hr", "recruiting", "info"]) {
      expect(matchMessage(h(addr(user, "acme.example.com"), "Hello"), LIST, ALEX)?.company_slug, user).toBe("acme-corp");
    }
  });
  it("still files a no-reply message from elsewhere when the subject names another company", () => {
    expect(matchMessage(h(addr("noreply", "seek.com.au"), "Your application to Acme Corp"), LIST, ALEX)).toMatchObject({ company_slug: "acme-corp", matched_by: "subject" });
    // An ATS notice from the employer's own no-reply sender that names the job's company is not a self-mention of a platform.
    expect(matchMessage(h(addr("no-reply", "acme.example.com"), "Your application to Acme Corp: AI Engineer"), LIST, ALEX)).toMatchObject({ company_slug: "acme-corp", matched_by: "subject" });
  });
  it("leaves a board's own welcome mail unmatched, so it goes to Mail to sort", () => {
    const welcome = h(addr("noreply", "seek.com.au"), "Welcome to SEEK");
    expect(matchMessage(welcome, LIST, ALEX)).toBeNull();
    expect(isJobRelated(welcome)).toBe(true);
  });
  it("leaves a platform account notice unmatched and not job-related, so it is skipped", () => {
    const notice = h(addr("noreply-accounts", "acme.example.com"), "Review your Acme Account settings");
    expect(matchMessage(notice, LIST, ALEX)).toBeNull();
    expect(isJobRelated(notice)).toBe(false);
  });
  it("keeps the addresses the user set up by hand", () => {
    const pinned = { ...PLATFORM, email_match: [addr("noreply", "acme.example.com")] };
    expect(matchMessage(h(addr("noreply", "acme.example.com"), "Your Acme Account"), [pinned], ALEX)).toMatchObject({ company_slug: "acme-corp", matched_by: "email_match" });
    const recruiter = { ...PLATFORM, recruiter_email: addr("no-reply", "acme.example.com") };
    expect(matchMessage(h(addr("no-reply", "acme.example.com"), "Welcome to Acme"), [recruiter], ALEX)?.matched_by).toBe("recruiter");
  });
  it("does not match a system sender by an email_match domain either", () => {
    const byDomain = { ...PLATFORM, website: "", email_match: ["acme.example.com"] };
    expect(matchMessage(h(addr("noreply", "acme.example.com"), "Your Acme Account"), [byDomain], ALEX)).toBeNull();
    expect(matchMessage(h(addr("sam", "acme.example.com"), "Coffee"), [byDomain], ALEX)?.matched_by).toBe("email_match");
  });
});

describe("applicant tracking system mail (rule 6)", () => {
  const ats = addr("no-reply", "us.greenhouse.io");
  it("files an ATS email under the one company with an active job of that title, even from a no-reply address", () => {
    expect(matchMessage(h(ats, "Your application for Data Engineer"), ALL, ALEX)).toEqual({ company_slug: "example-labs", job_id: "2026-01-10-data-engineer", matched_by: "subject" });
    expect(matchMessage(h(addr("notifications", "myworkday.com"), "ML Engineer: next steps"), ALL, ALEX)).toMatchObject({ company_slug: "example-labs", job_id: "2026-01-13-ml-engineer" });
  });
  it("still prefers the company named in the subject", () => {
    expect(matchMessage(h(ats, "Thank you for applying to Acme Corp"), ALL, ALEX)).toMatchObject({ company_slug: "acme-corp", matched_by: "subject" });
  });
  it("never matches a one-word title, a job that isn't active, a job board, or a title two companies share", () => {
    expect(matchMessage(h(ats, "Your application for Backend Engineer (LLM)"), [{ ...LABS, email_match: [] }], ALEX)).toBeNull(); // Found, not active
    const two: CompanyInfo = { ...ACME, slug: "acme-two", name: "Acme Two", website: "", recruiter_email: "", jobs: [job("x", "Data Engineer", "Applied")] };
    expect(matchMessage(h(ats, "Your application for Data Engineer"), [LABS, two], ALEX)).toBeNull();
    expect(matchMessage(h(addr("noreply", "s.seek.com.au"), "Your application for Data Engineer"), ALL, ALEX)).toBeNull();
    const oneWord: CompanyInfo = { ...ACME, jobs: [job("y", "Engineer", "Applied")] };
    expect(matchMessage(h(ats, "Engineer update"), [oneWord], ALEX)).toBeNull();
  });
});
