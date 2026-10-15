import type { ProgressMap } from "@careeros/contract";
import type { Fixture } from "./fixture-types";

/**
 * Fictional learning data for the dev preview (MockBridge `learnDemo`): skills in the three sample ads,
 * a resume for Alex Example, one scored job with gaps, and a few guides with progress. Tests use the
 * plain fixture unless they ask for this.
 */
const SKILLS: Record<string, string> = {
  "companies/acme-corp/jobs/2026-01-12-ai-engineer":
    "## What you'll do\n\nShip Python and TypeScript services for LLM agents. Run them on Kubernetes in AWS with Terraform. Own evals and observability for RAG features.\n",
  "companies/acme-recruiting/jobs/2026-01-12-ai-developer":
    "## Skills\n\nPython, prompt engineering, vector databases, Docker and CI/CD. System design for high-traffic LLM apps.\n",
  "companies/example-labs/jobs/2026-01-12-backend-engineer-llm":
    "## Must have\n\nTypeScript, PostgreSQL, Kafka and Kubernetes. Experience with system design and AWS is a plus.\n",
};

/** A sample guide that uses every visual the reader draws: TL;DR, callouts, Mermaid (and a broken one), tables. */
export const VISUAL_GUIDE = `# Prompt engineering basics

A fictional sample guide for Alex Example. It shows every visual a study guide can use.

> **TL;DR**
> - A prompt is a short brief: role, task, context, format.
> - Show one good example instead of describing it.
> - Test prompts like code, with a small set of fixed inputs.

## What it is

Prompt engineering is writing the instructions a language model follows. Good prompts are clear, short and testable.

\`\`\`mermaid
flowchart LR
  A[Goal] --> B[Draft prompt]
  B --> C{Test on examples}
  C -- fails --> B
  C -- passes --> D[Ship it]
\`\`\`

## Why employers ask

- Most LLM features live or die on the prompt.
- It is cheap to change, so teams iterate on it daily.
- It shows you can think about failure cases.

> **Interview tip:** Describe one prompt you improved and how you measured the change.

## How it works

The app sends the prompt with the user's message. The model replies, and the app checks the reply before showing it.

\`\`\`mermaid
sequenceDiagram
  participant U as User
  participant A as App
  participant M as Model
  U->>A: Question
  A->>M: System prompt + question
  M-->>A: Draft answer
  A->>A: Check format
  A-->>U: Answer
\`\`\`

## Core ideas

\`\`\`mermaid
mindmap
  root((Prompt))
    Role
      Who the model is
    Task
      One clear job
    Context
      Facts it needs
    Format
      Shape of the answer
\`\`\`

## Zero-shot vs few-shot

| Approach | What you give | Good for | Watch for |
|---|---|---|---|
| Zero-shot | Instructions only | Simple, common tasks | Vague output |
| Few-shot | Instructions plus 2 to 3 examples | A set format or tone | Copying the examples too closely |
| Chain of steps | One task split into calls | Long, multi-part work | More cost and latency |

> **Tip:** Start zero-shot. Add examples only when the output drifts.

## Worked example

A prompt that asks for a fixed format:

\`\`\`text
You are a support assistant for Acme Corp.
Answer in at most 3 sentences.
If the answer is not in the context, say "I don't know".

Context: {documents}
Question: {question}
\`\`\`

> **Watch out:** Long prompts hide the one rule that matters. Put the key rule near the end, close to the question.

## Practice this week

1. Write a prompt for a summary task.
2. Make 5 test inputs, including one tricky case.
3. Change one thing at a time and note the result.

## This diagram has a typo

The block below is broken on purpose, to show the fallback.

\`\`\`mermaid
flowchart LR
  A[Start] --> 
  B[[[Oops
\`\`\`

## Key terms

| Term | Meaning |
|---|---|
| System prompt | Standing instructions sent with every request |
| Few-shot | Giving a few worked examples in the prompt |
| Eval set | Fixed inputs used to test a prompt change |

## Self-check

- [ ] I can name the four parts of a prompt.
- [ ] I can explain zero-shot vs few-shot.
- [ ] I have tested one prompt on 5 inputs.

Source: [Example prompt guide](https://example.com/prompt-guide)
`;

const GUIDES: Record<string, string> = {
  "learning/prompt-engineering/guide.md": VISUAL_GUIDE,
  "learning/system-design-for-llm-apps/guide.md":
    "# System design for LLM apps\n\nA fictional study guide for Alex Example.\n\n## Why employers ask\n\nLLM features fail in new ways: slow calls, cost spikes, wrong answers.\n\n## Core ideas\n\n- Put a queue in front of slow model calls\n- Cache answers you can reuse\n- Measure quality with evals before every release\n\n## Practice this week\n\n1. Sketch a support bot that answers from documents.\n2. Mark where it can fail and how you'd notice.\n\nSource: [Example docs](https://example.com/docs)\n",
  "learning/kubernetes/guide.md":
    "# Kubernetes basics\n\nA fictional study guide for Alex Example.\n\n## What it is\n\nA system that runs containers across many machines and restarts them when they fail.\n\n## Core ideas\n\n- Pods, Deployments and Services\n- Health checks and rolling updates\n- Config and secrets\n\n## How to talk about it\n\nSay what you have used (Docker) and what you are learning. Don't claim production experience you don't have.\n",
};

export function applyLearnDemo(f: Fixture): { progress: ProgressMap; dates: Record<string, string> } {
  for (const j of f.jobs) {
    const base = `companies/${j.job.company_slug}/jobs/${j.job.id}`;
    const extra = SKILLS[base];
    if (!extra) continue;
    j.description = `${j.description.trimEnd()}\n\n${extra}`;
    f.texts[`${base}/jd.md`] = j.description;
  }
  const labs = f.jobs.find((j) => j.job.company_slug === "example-labs");
  if (labs) {
    labs.job.scores.fit.must_haves = [
      { skill: "TypeScript", met: true }, { skill: "Kubernetes", met: false }, { skill: "Kafka", met: false }, { skill: "System design", met: false },
    ];
    labs.job.scores.fit.value = 72;
    labs.job.scores.career.scored_at = "2026-01-13T02:00:00.000Z";
    f.texts["companies/example-labs/jobs/2026-01-12-backend-engineer-llm/score.md"] = "# Score\n\nFit 72. Gaps: Kubernetes, Kafka, system design.\n";
  }
  f.texts["me/resumes/alex-example-resume.md"] = "# Alex Example\n\nAI Engineer. Python, TypeScript, RAG pipelines, AI agents and SQL (fictional).\n";
  Object.assign(f.texts, GUIDES);
  f.learning.topics.push(
    {
      slug: "kubernetes", title: "Kubernetes basics", items: [
        { path: "learning/kubernetes/guide.md", title: "Kubernetes basics", kind: "guide" },
        { path: "learning/kubernetes/videos/1/renders/draft.mp4", title: "Video lesson 1 (draft)", kind: "video" },
      ],
    },
    { slug: "prompt-engineering", title: "Prompt engineering basics", items: [{ path: "learning/prompt-engineering/guide.md", title: "Prompt engineering basics", kind: "guide" }] },
    { slug: "system-design-for-llm-apps", title: "System design for LLM apps", items: [{ path: "learning/system-design-for-llm-apps/guide.md", title: "System design for LLM apps", kind: "guide" }] },
  );
  f.learning.topics.sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    progress: {
      "learning/rag-pipelines/guide.md": { state: "done", at: "2026-01-11T07:30:00.000Z" },
      "companies/acme-corp/jobs/2026-01-12-ai-engineer/interview/questions.md": { state: "done", at: "2026-01-13T10:00:00.000Z" },
      "learning/kubernetes/guide.md": { state: "in_progress", at: "2026-01-14T09:00:00.000Z" },
    },
    dates: {
      "learning/rag-pipelines/guide.md": "2026-01-09T03:00:00.000Z",
      "companies/acme-corp/jobs/2026-01-12-ai-engineer/interview/questions.md": "2026-01-12T05:00:00.000Z",
      "learning/kubernetes/guide.md": "2026-01-14T02:00:00.000Z",
      "learning/kubernetes/videos/1/renders/draft.mp4": "2026-01-14T04:00:00.000Z",
      "learning/system-design-for-llm-apps/guide.md": "2026-01-13T01:00:00.000Z",
      "learning/prompt-engineering/guide.md": "2026-01-15T01:00:00.000Z",
    },
  };
}
