import path from "node:path";
import { writeFileAtomic } from "@careeros/core";
import type { SceneSpec } from "../src/types.js";
import type { Files } from "./harness.js";
import { ACME_JOB, BRIEF_SCRIPT, briefSpec, JD, JD_SCRIPT, jdSpec, QUIZ_SCRIPT, quizSpec } from "./fixtures.js";

const HISTORY = { file: "me/history/roles.md" };
const RESUME = `${ACME_JOB}/application/resume.md`;
const LETTER = `${ACME_JOB}/application/cover-letter.md`;

export const PITCH_SCRIPT = [
  "Here is how I would answer, tell me about yourself, for Acme Corp.",
  "Right now I am an AI Engineer at Example Labs. Since 2024 I have built agents.",
  "Before that, my agent work handled 40 support tickets a day. That fits what Acme Corp asks for.",
  "So, next I want to build LLM agents with a team that ships. That is why I applied. Thanks for listening.",
].join("\n\n") + "\n";

export function pitchSpec(): SceneSpec {
  return {
    version: 2, title: "My answer for Acme Corp", voice_type: "interview",
    scenes: [
      { type: "title", cue: "Here is how", kicker: "Tell me about yourself", title: "My answer for Acme Corp", sources: [{ file: JD }] },
      {
        type: "bullet-build", cue: "Right now", headline: "What I do now", sources: [HISTORY],
        items: [{ text: "AI Engineer at Example Labs", cue: "AI Engineer" }, { text: "Building agents since 2024", cue: "Since" }],
      },
      {
        type: "comparison", cue: "Before that", headline: "Why I fit", left: { label: "Acme Corp asks", items: ["Build LLM agents"] },
        right: { label: "I have done", items: ["An agent for 40 tickets a day"] }, cue_left: "That fits", cue_right: "asks for",
        sources: [{ file: JD, quote: "Build LLM agents." }, HISTORY],
      },
      {
        type: "recap-card", cue: "So, next", headline: "Why this job next", sources: [{ file: JD }, HISTORY], closing: "Thanks for listening.",
        items: [{ text: "Build LLM agents", cue: "build" }, { text: "Join a team that ships", cue: "team" }, { text: "Apply where I fit", cue: "applied" }],
      },
    ],
  };
}

export const APP_SCRIPT = [
  "Here is what you are about to send to Acme Corp.",
  "You are sending a resume and a cover letter.",
  "The ad asks for LLM agents. Your resume shows agent work.",
  "So remember. It covers agents, it is short, and it is ready.",
].join("\n\n") + "\n";

export function appSpec(): SceneSpec {
  return {
    version: 2, title: "Your Acme Corp application", voice_type: "slides",
    scenes: [
      { type: "title", cue: "Here is what", kicker: "Application summary", title: "Your Acme Corp application", sources: [{ file: RESUME }] },
      { type: "bullet-build", cue: "You are sending", headline: "What you are sending", sources: [{ file: RESUME }, { file: LETTER }], items: [{ text: "Resume", cue: "resume" }, { text: "Cover letter", cue: "cover" }] },
      {
        type: "comparison", cue: "The ad asks", headline: "How it fits", left: { label: "The ad asks", items: ["LLM agents"] }, right: { label: "You show", items: ["Agent work"] },
        cue_left: "LLM agents", cue_right: "Your resume", sources: [{ file: JD, quote: "Build LLM agents." }, { file: RESUME }],
      },
      {
        type: "recap-card", cue: "So remember", headline: "Ready to send", sources: [{ file: RESUME }], closing: "Approve it when you are happy.",
        items: [{ text: "Covers agents", cue: "covers" }, { text: "Short", cue: "short" }, { text: "Ready to send", cue: "ready" }],
      },
    ],
  };
}

export function seedApplication(root: string): void {
  writeFileAtomic(path.join(root, RESUME), "# Alex Example\n\nAI Engineer. Built LLM agents at Example Labs (fictional).\n");
  writeFileAtomic(path.join(root, LETTER), "Dear Acme Corp team,\n\nI build LLM agents.\n");
}

export const LESSON_SCRIPT = [
  "Here is Kubernetes in plain words.",
  "Three ideas. Pods run your containers. Deployments keep them running. Services give them an address.",
  "Now see a pod run. Type this command and watch it finish.",
  "So remember. Pods, deployments, services. Practise by running one pod today.",
].join("\n\n") + "\n";

export function lessonSpec(): SceneSpec {
  return {
    version: 2, title: "Kubernetes in plain words", voice_type: "guide",
    scenes: [
      { type: "title", cue: "Here is", kicker: "Skill-gap lesson", title: "Kubernetes in plain words" },
      {
        type: "bullet-build", cue: "Three ideas", headline: "Three ideas to start with",
        items: [{ text: "Pods run containers", cue: "Pods" }, { text: "Deployments keep them running", cue: "Deployments" }, { text: "Services give an address", cue: "Services" }],
      },
      { type: "code-typing", cue: "Now see", lang: "sh", code: "kubectl run web --image=nginx\nkubectl get pods", label: "Your first pod", cue_done: "finish" },
      {
        type: "recap-card", cue: "So remember", headline: "Remember these three", closing: "Run one pod today.",
        items: [{ text: "Pods run containers", cue: "Pods" }, { text: "Deployments keep them up", cue: "deployments" }, { text: "Services give an address", cue: "services" }],
      },
    ],
  };
}

export function filesFor(typeId: string): Files {
  switch (typeId) {
    case "jd-walkthrough": return { script: JD_SCRIPT, spec: jdSpec(), extras: { "notes.md": "# Notes\n" } };
    case "company-briefing": return { script: BRIEF_SCRIPT, spec: briefSpec(), extras: { "notes.md": "# Notes\n" } };
    case "interview-prep": return { script: QUIZ_SCRIPT, spec: quizSpec(), extras: { "notes.md": "# Notes\n" } };
    case "pitch": return { script: PITCH_SCRIPT, spec: pitchSpec(), extras: { "pitch.md": "Right now I am an AI Engineer.\n" } };
    case "application-summary": return { script: APP_SCRIPT, spec: appSpec() };
    case "skill-gap-lesson": return { script: LESSON_SCRIPT, spec: lessonSpec() };
    default: throw new Error(`no fixture for ${typeId}`);
  }
}
