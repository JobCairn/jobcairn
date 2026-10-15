/**
 * Dev preview only (`npm run dev` with `?maildemo`): answers /__mock-mail/<token>[/text] with a fictional email,
 * run through the app's real sanitizer and frame document, so the Mail reader can be checked in a browser.
 * The desktop app never uses this: it serves careeros-mail: from the services.
 */
import type { Plugin } from "vite";
import { mailTokenToRef } from "../../contract/src/mail.ts";
import { renderMailDocument, sanitizeEmailHtml, textToHtml } from "../../mail/src/sanitize.ts";

const BODIES: { match: RegExp; html: string; text: string }[] = [
  {
    // A typical ATS template: a fixed 600px table, a logo row, a button-style link and a footer.
    match: /your-application-at-example-labs/,
    html: `<table width="600" cellpadding="0" cellspacing="0" align="center" style="font-family:Arial,sans-serif;border:1px solid #e5e5e5">
<tr><td style="background:#1f2a44;color:#fff;padding:20px 24px;font-size:20px;font-weight:bold">Example Labs</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:22px;color:#222">
<p>Hi Alex,</p>
<p>Thanks for applying for <b>Backend Engineer (LLM)</b>. We read every application, and you'll hear from us within two weeks.</p>
<p>Here's what happens next:</p>
<ol><li>A 30 minute call with our recruiter.</li><li>A technical conversation with two engineers.</li><li>A short take-home task, if both of us want to keep going.</li></ol>
<table width="560" cellpadding="0" cellspacing="0"><tr><td width="280" style="padding:8px;background:#f4f6fa">Role<br><b>Backend Engineer (LLM)</b></td><td width="280" style="padding:8px;background:#f4f6fa">Location<br><b>Brisbane or remote</b></td></tr></table>
<p style="margin:24px 0"><a href="https://jobs.example.com/status/4821" style="background:#2f6fed;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">Check your application status</a></p>
<p>If you have questions, reply to this email and a person on our team will answer.</p>
<p>Regards,<br>Example Labs Talent</p>
<img src="https://images.example.com/track.gif" width="1" height="1" alt="">
</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#777;border-top:1px solid #eee">Example Labs Pty Ltd · 1 Example Street, Brisbane QLD 4000 · <a href="https://examplelabs.example.net/privacy">Privacy</a></td></tr>
</table>`,
    text: "Hi Alex,\n\nThanks for applying for Backend Engineer (LLM). We read every application, and you'll hear from us within two weeks.\n\nHere's what happens next:\n1. A 30 minute call with our recruiter.\n2. A technical conversation with two engineers.\n3. A short take-home task, if both of us want to keep going.\n\nCheck your application status: https://jobs.example.com/status/4821\n\nRegards,\nExample Labs Talent",
  },
];
const PLAIN = "Hi Alex,\n\nThanks for your note. Could you talk on Friday at 10 am Brisbane time? I've put the details below.\n\nWe'll meet on a video call: https://meet.example.com/acme-ai\n\nIf Friday doesn't suit, reply with two times that work next week.\n\nRegards,\nAcme Talent";

export function mockMailFrames(): Plugin {
  return {
    name: "mock-mail-frames",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__mock-mail/", (req, res) => {
        const [token = "", view = ""] = (req.url ?? "").replace(/^\//, "").split("?")[0]!.split("/");
        const ref = mailTokenToRef(token);
        if (!ref || (view && view !== "text")) { res.statusCode = 404; res.end(); return; }
        const body = BODIES.find((b) => b.match.test(ref));
        const html = view === "text" ? textToHtml(body?.text ?? PLAIN) : body?.html ?? textToHtml(PLAIN);
        const clean = sanitizeEmailHtml(html, { token, imagesAllowed: false });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(renderMailDocument(clean.html));
      });
    },
  };
}
