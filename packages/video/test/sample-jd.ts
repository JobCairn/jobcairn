import type { SceneSpec } from "../src/types.js";

/**
 * A fictional JD walkthrough (Alex Example, Example Labs) used to render before/after stills of the visual
 * vocabulary. `BEFORE_*` is the old text-led look; the "after" spec lives beside it once the new scenes exist.
 */
export const BEFORE_SCRIPT = [
  "Example Labs wants a builder for decentralised training. Here is what the role asks for.",
  "More must-haves go deep on systems. Checkpointing and data sharding. P2P and NAT traversal. Async Python. Prometheus and Grafana.",
  "Compare the asks with your evidence. The role asks for distributed training, and you have shipped agents in production.",
  "The ad lists 5 years of experience as the bar.",
  "So the plan. Learn sharding, show your agents, and ask about the team.",
].join("\n\n") + "\n";

export function beforeSpec(): SceneSpec {
  return {
    version: 2, title: "Example Labs: what the role asks", voice_type: "slides", captions: "rail",
    scenes: [
      { type: "title", cue: "Example Labs wants", kicker: "JD walkthrough", title: "Example Labs wants a builder for decentralised training", underline: "builder" },
      {
        type: "bullet-build", cue: "More must-haves", headline: "More must-haves go deep on systems",
        items: [
          { text: "Checkpointing and data sharding", cue: "Checkpointing" }, { text: "P2P and NAT traversal", cue: "P2P" },
          { text: "Async Python", cue: "Async" }, { text: "Prometheus and Grafana", cue: "Prometheus" },
        ],
      },
      {
        type: "comparison", cue: "Compare the asks", headline: "The asks against your evidence",
        left: { label: "The role asks", items: ["Distributed training", "Async Python"] }, right: { label: "Your evidence", items: ["Agents in production", "Async Python services"] },
        cue_left: "role asks", cue_right: "you have",
      },
      { type: "stat", cue: "The ad", value: 5, suffix: "+", label: "Years of experience asked for", source: "Example Labs job ad" },
      {
        type: "recap-card", cue: "So the plan", headline: "Before you apply",
        items: [{ text: "Learn sharding", cue: "Learn sharding" }, { text: "Show your agents", cue: "show" }, { text: "Ask about the team", cue: "ask" }], closing: "Good luck.",
      },
    ],
  } as SceneSpec;
}

/** The same walkthrough in the visual vocabulary (spec version 3): pictures first, at most 12 words a scene. */
export const AFTER_SCRIPT = [
  "Example Labs wants a builder for decentralised training. Here is what the role asks for.",
  "The role is based in Brisbane, with two days a week in the office.",
  "More must-haves go deep on systems. Checkpointing and data sharding. P2P and NAT traversal. Async Python. Prometheus and Grafana.",
  "Here is how the training network fits together. Peers train on their own GPUs. A relay helps peers behind NAT. Checkpoints land in shared storage. Metrics flow to Prometheus.",
  "The stack is mostly Python and PyTorch, with Kubernetes, Prometheus and Grafana.",
  "Now your match. Async Python is a match. Production agents are a match. Distributed training is partly there. NAT traversal is a gap.",
  "The ad puts it plainly. Ship research code to real users.",
  "The ad asks for 5 years. You have 4 of them.",
  "Fit, not flash. Show what you shipped.",
  "So the plan. Learn sharding, show your agents, and ask about the team.",
].join("\n\n") + "\n";

export function afterSpec(): SceneSpec {
  const src = [{ file: "companies/example-labs/jobs/ai-engineer/jd.md" }];
  return {
    version: 3, title: "Example Labs: what the role asks", voice_type: "slides", captions: "rail",
    scenes: [
      { type: "title", cue: "Example Labs wants", kicker: "JD walkthrough", title: "A builder for decentralised training", underline: "builder", sources: src },
      { type: "map-pin", cue: "The role", city: "Brisbane", region: "Queensland", label: "Two days a week in office", sources: src },
      {
        type: "icon-grid", cue: "More must-haves", headline: "Must-haves go deep on systems", sources: src,
        items: [
          { label: "Checkpointing", icon: "hard-drive", cue: "Checkpointing" }, { label: "Data sharding", icon: "split", cue: "data sharding" },
          { label: "P2P and NAT", icon: "share-2", cue: "P2P" }, { label: "Async Python", logo: "python", cue: "Async" },
          { label: "Prometheus", cue: "Prometheus" }, { label: "Grafana", cue: "Grafana" },
        ],
      },
      {
        type: "diagram", kind: "architecture", cue: "Here is how", headline: "How the training network fits", sources: src,
        groups: [{ id: "swarm", label: "Peers" }],
        nodes: [
          { id: "p1", label: "Peer GPU", kind: "gpu", group: "swarm", cue: "Peers train" }, { id: "p2", label: "Peer GPU", kind: "gpu", group: "swarm", cue: "own GPUs" },
          { id: "relay", label: "NAT relay", kind: "router", cue: "relay" }, { id: "ckpt", label: "Checkpoints", kind: "storage", cue: "Checkpoints" },
          { id: "prom", label: "Prometheus", logo: "prometheus", cue: "Metrics" },
        ],
        edges: [{ from: "p1", to: "relay" }, { from: "p2", to: "relay", label: "behind NAT" }, { from: "relay", to: "ckpt" }, { from: "relay", to: "prom" }],
      },
      {
        type: "logo-row", cue: "The stack", headline: "The stack", sources: src,
        items: [{ name: "Python", cue: "Python" }, { name: "PyTorch", cue: "PyTorch" }, { name: "Kubernetes", cue: "Kubernetes" }, { name: "Prometheus", cue: "Prometheus and" }, { name: "Grafana", cue: "Grafana" }],
      },
      {
        type: "match", cue: "Now your match", headline: "Your evidence", sources: [{ file: "me/history/roles.md" }],
        rows: [
          { ask: "Async Python", status: "match", logo: "python", cue: "Async Python" }, { ask: "Production agents", status: "match", icon: "bot", cue: "Production agents" },
          { ask: "Distributed training", status: "partial", icon: "network", cue: "Distributed training" }, { ask: "NAT traversal", status: "gap", icon: "router", cue: "NAT traversal" },
        ],
      },
      { type: "quote", cue: "The ad puts", text: "Ship research code to real users.", by: "From the job ad", sources: [{ file: "companies/example-labs/jobs/ai-engineer/jd.md", quote: "Ship research code to real users." }] },
      { type: "chart", kind: "ring", cue: "The ad asks", value: 4, of: 5, label: "Years of the five asked for", source: "Example Labs job ad and your roles", sources: src },
      { type: "kinetic", cue: "Fit, not", lines: [{ text: "Fit, not flash.", cue: "Fit" }, { text: "Show what you shipped.", cue: "Show" }], emphasis: "shipped" },
      {
        type: "checklist", cue: "So the plan", headline: "Before you apply", sources: src,
        items: [{ text: "Learn sharding", state: "partial", cue: "Learn sharding" }, { text: "Show your agents", state: "yes", cue: "show" }, { text: "Ask about the team", state: "yes", cue: "ask" }],
      },
    ],
  } as SceneSpec;
}
