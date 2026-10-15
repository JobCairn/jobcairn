import { describe, expect, it } from "vitest";
import { linkArtefact, proofHint, resumeProjects } from "../src/index.js";

// A fictional resume for Alex Example.
const RESUME = [
  "# Alex Example",
  "## Experience",
  "- Built things at Acme Corp",
  "## Projects",
  "- **Clinic assistant**: a RAG chatbot over clinic policies with citations, https://github.com/alexexample/clinic-assistant",
  "- Budget app: a React Native app for tracking spending",
  "## Education",
  "- BSc, Example University",
].join("\n");

describe("resumeProjects", () => {
  it("reads each project line in the Projects section, with its link", () => {
    const p = resumeProjects(RESUME);
    expect(p.map((x) => x.label)).toEqual(["Clinic assistant", "Budget app"]);
    expect(p[0]!.url).toBe("https://github.com/alexexample/clinic-assistant");
    expect(p[1]!.url).toBe("");
  });
  it("is empty without a Projects section", () => {
    expect(resumeProjects("# Alex Example\n## Experience\n- Work")).toEqual([]);
  });
});

describe("linkArtefact", () => {
  it("names a profile link by host and path, with the path's words as its text", () => {
    expect(linkArtefact("https://www.github.com/alexexample/rag-demo/")).toEqual({
      label: "github.com/alexexample/rag-demo", url: "https://www.github.com/alexexample/rag-demo/", text: "www.github.com  alexexample rag demo ",
    });
    expect(linkArtefact("not a link")).toBeNull();
    expect(linkArtefact("javascript:alert(1)")).toBeNull();
  });
});

describe("proofHint", () => {
  it("picks the artefact that best backs the top must-have, with a cover-letter line", () => {
    const artefacts = [...resumeProjects(RESUME), linkArtefact("https://example.com/alex")!];
    const h = proofHint("Hands-on work with LLM APIs and retrieval (RAG) in production", artefacts)!;
    expect(h.artefact.label).toBe("Clinic assistant");
    expect(h.matched).toContain("RAG pipelines");
    expect(h.line).toBe("For an example of my RAG pipelines work, see Clinic assistant (https://github.com/alexexample/clinic-assistant).");
  });
  it("uses the link alone when the label is just the address", () => {
    const h = proofHint("React Native mobile apps", [linkArtefact("https://github.com/alexexample/react-native-budget")!])!;
    expect(h.line).toBe("For an example of my React work, see https://github.com/alexexample/react-native-budget.");
  });
  it("is null when nothing matches", () => {
    expect(proofHint("Kubernetes operations", resumeProjects(RESUME))).toBeNull();
    expect(proofHint("", resumeProjects(RESUME))).toBeNull();
  });
});
