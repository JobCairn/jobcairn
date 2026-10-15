# JobCairn

JobCairn is a local-first job search app for macOS, built around Claude. It finds jobs, scores your fit, flags visa sponsorship wording and tailors your resume and cover letter, and it keeps your whole search in one folder on your computer.

[![Platform: macOS 13+](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey)](https://jobcairn.github.io/install.html)
[![Works with your Claude plan](https://img.shields.io/badge/works%20with-your%20Claude%20plan-d97757)](https://jobcairn.github.io/#faq)

If JobCairn helps, please ⭐ star this repo. It helps others find it.

https://github.com/user-attachments/assets/2e3ae9be-a18c-4288-9b03-7cdf4d6b6984

*JobCairn in 90 seconds, recorded in an example workspace and narrated with an AI voice. With captions on the [website](https://jobcairn.github.io).*

## What it does

- **Find jobs** in your own Chrome on SEEK, LinkedIn, Indeed and company career pages. It reads ads only, and never applies or messages anyone.
- **Score your fit** for each job, with interview odds, each must-have marked met, partial or not met, and a plain recommendation: apply, tailor first, or skip.
- **Flag visa sponsorship** wording in each ad (sponsorship offered, open to visa holders, silent, or citizens and PR only) and set aside ads that need work rights you don't have. Built for people who need sponsorship in Australia. It isn't migration advice.
- **Tailor your resume and cover letter** using only what's already in your resume and profile. 17 templates, ATS-safe one-column options, PDF or Word export.
- **Track applications** from preparing to sent. Connect Gmail and job email is filed under the right job. Nothing goes out without your OK.
- **Prepare for interviews** with skill gaps across your saved jobs, study guides, interview prep and short narrated videos marked "AI voice".
- **Keep it private.** Your workspace is a folder on your computer, and identity and employment documents are locked from Claude unless you allow access.

## Get it

This repository holds the app's **source code**, its **releases** and **questions**.

- **Download:** [latest release](https://github.com/JobCairn/jobcairn/releases/latest). Pick `-arm64.dmg` for Apple silicon or `-x64.dmg` for Intel.
- **Install guide:** https://jobcairn.github.io/install.html. Builds are signed with an Apple Developer ID and notarised by Apple.
- **Check your download:** each release has a `SHA256SUMS.txt` file. Run `shasum -a 256 -c SHA256SUMS.txt --ignore-missing` in the folder with the dmg.
- **Questions and help:** [Discussions](https://github.com/JobCairn/jobcairn/discussions)
- **Terms of use:** https://jobcairn.github.io/terms.html · **Privacy:** https://jobcairn.github.io/privacy.html

## Build from source

You need macOS 13 or later and Node.js 22.13 or later.

```sh
npm ci
npm run typecheck && npm test
npm run package:mac   # unsigned build in packages/app-electron/dist-release
```

[docs/development.md](docs/development.md) explains how the app is put together. Coding agents (and people) should read [AGENTS.md](AGENTS.md) first: it has the repo rules and how to follow the implementation plans in `docs/superpowers/plans/`.

## Licence

[GNU AGPL-3.0](LICENSE). Third-party credits are in [NOTICE.md](NOTICE.md) and `licenses/`.

You need your own Claude plan that includes Claude Code. JobCairn is an independent product and isn't affiliated with Anthropic.

If JobCairn helps, please ⭐ star this repo. It helps others find it.
