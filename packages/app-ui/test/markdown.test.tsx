import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { autolinkNodes, Markdown, safeUrl } from "../src/components/Markdown";
import { renderApp } from "./render";

const fu = (rel: string) => `careeros-file://ws/${rel}`;

describe("safeUrl", () => {
  it("keeps only https links", () => {
    expect(safeUrl("https://jobs.example.com/1", "link", undefined, fu)).toBe("https://jobs.example.com/1");
    for (const u of [
      "http://jobs.example.com", "javascript:alert(1)", "JaVaScRiPt:alert(1)", "vbscript:alert(1)",
      "file:///etc/passwd", "careeros-file://ws/x", "data:text/html,x", "/abs", "notes.md",
    ]) {
      expect(safeUrl(u, "link", "a", fu), u).toBe("");
    }
  });
  it("serves relative images from the workspace and blocks the rest", () => {
    expect(safeUrl("diagram.png", "image", "companies/acme-corp/jobs/j1", fu)).toBe("careeros-file://ws/companies/acme-corp/jobs/j1/diagram.png");
    expect(safeUrl("./img/a.png", "image", "learning/rag", fu)).toBe("careeros-file://ws/learning/rag/img/a.png");
    for (const u of ["https://cdn.example.com/x.png", "../../../me/identity/passport.png", "/etc/x.png", "data:image/png;base64,AA", "a\\b.png"]) {
      expect(safeUrl(u, "image", "learning/rag", fu), u).toBe("");
    }
    expect(safeUrl("a.png", "image", undefined, fu)).toBe("");
  });
  it("decodes a percent-encoded segment once instead of leaving it for fileUrl to double-encode", () => {
    // "fu" here is intentionally a no-op passthrough, so the decode must happen in safeUrl itself:
    // a literal percent-encoded space must come out as a real space, not the still-escaped "%20".
    expect(safeUrl("my%20diagram.png", "image", "companies/acme-corp/jobs/j1", fu)).toBe("careeros-file://ws/companies/acme-corp/jobs/j1/my diagram.png");
  });
  it("blocks a percent-encoded path-traversal segment after decoding (%2e%2e)", () => {
    expect(safeUrl("%2e%2e/secret.png", "image", "companies/acme-corp/jobs/j1", fu)).toBe("");
    expect(safeUrl("a/%2e%2e/../secret.png", "image", "companies/acme-corp/jobs/j1", fu)).toBe("");
    // A decoded "/" or "\" inside one raw segment must not be treated as a path separator either.
    expect(safeUrl("a%2fb.png", "image", "companies/acme-corp/jobs/j1", fu)).toBe("");
    expect(safeUrl("a%5cb.png", "image", "companies/acme-corp/jobs/j1", fu)).toBe("");
  });
  it("fails closed on a malformed percent-encoded segment", () => {
    expect(safeUrl("my%zzdiagram.png", "image", "companies/acme-corp/jobs/j1", fu)).toBe("");
  });
});

describe("Markdown", () => {
  const md = [
    "# Role", "", "<script>window.bad = 1</script><b>raw bold</b>", "",
    "![chart](https://cdn.example.com/chart.png)", "", "![diagram](diagram.png)", "",
    "[Apply here](https://jobs.example.com/acme/1) and [bad](javascript:alert(1))",
  ].join("\n");

  it("skips raw HTML, blocks remote images and opens links through the bridge", async () => {
    const { bridge, container } = renderApp(<Markdown text={md} baseDir="companies/acme-corp/jobs/j1" />);
    expect(screen.getByRole("heading", { name: "Role" })).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("Image not shown: chart")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "diagram" })).toHaveAttribute("src", "careeros-file://ws/companies/acme-corp/jobs/j1/diagram.png");
    expect(screen.getByText("bad").closest("a")).toBeNull();
    await userEvent.click(screen.getByRole("link", { name: "Apply here" }));
    expect(bridge.opened).toEqual(["https://jobs.example.com/acme/1"]);
  });

  it("drops raw HTML entirely, including an <img> with an onerror handler", () => {
    const { container } = renderApp(<Markdown text={'before <img src="x" onerror="window.bad = 1"> after'} baseDir="companies/acme-corp/jobs/j1" />);
    // Asserting "no onerror attribute" alone could never fail, because our own `img` component
    // never sets one; the real assertion is that skipHtml dropped the whole raw <img> tag.
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/before/)).toBeInTheDocument();
    expect(screen.getByText(/after/)).toBeInTheDocument();
  });

  it("opens a link through the bridge on middle-click too, and never offers it for dragging", () => {
    const { bridge } = renderApp(<Markdown text="[Apply here](https://jobs.example.com/acme/1)" />);
    const a = screen.getByRole("link", { name: "Apply here" });
    expect(a).toHaveAttribute("draggable", "false");
    fireEvent(a, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
    expect(bridge.opened).toEqual(["https://jobs.example.com/acme/1"]);
  });

  it("ignores a right-click auxclick (no open)", () => {
    const { bridge } = renderApp(<Markdown text="[Apply here](https://jobs.example.com/acme/1)" />);
    const a = screen.getByRole("link", { name: "Apply here" });
    fireEvent(a, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
    expect(bridge.opened).toEqual([]);
  });

  it("decodes an already-encoded filename once instead of double-encoding it", () => {
    renderApp(<Markdown text="![x](my%20diagram.png)" baseDir="companies/acme-corp/jobs/j1" />);
    expect(screen.getByRole("img", { name: "x" })).toHaveAttribute("src", "careeros-file://ws/companies/acme-corp/jobs/j1/my%20diagram.png");
  });

  it("decodes a percent-encoded non-ASCII filename and re-encodes it exactly once", () => {
    renderApp(<Markdown text="![x](caf%C3%A9.png)" baseDir="companies/acme-corp/jobs/j1" />);
    expect(screen.getByRole("img", { name: "x" })).toHaveAttribute("src", "careeros-file://ws/companies/acme-corp/jobs/j1/caf%C3%A9.png");
  });

  describe("link bypass probes (every one must render no <a>)", () => {
    it.each([
      ["mixed-case scheme", "JaVaScRiPt:alert(1)"],
      ["leading whitespace", " javascript:alert(1)"],
      ["entity-hidden tab", "java&#x09;script:alert(1)"],
      ["protocol-relative", "//evil.example"],
      ["our own scheme", "careeros-file://x"],
      ["a bare relative path", "notes.md"],
    ])("%s", (_label, probe) => {
      const { container } = renderApp(<Markdown text={`[bad](<${probe}>)`} />);
      expect(container.querySelector("a")).toBeNull();
    });

    it("the javascript: autolink form", () => {
      const { container } = renderApp(<Markdown text="<javascript:alert(1)>" />);
      expect(container.querySelector("a")).toBeNull();
    });

    it("a reference-style javascript: link", () => {
      const { container } = renderApp(<Markdown text={"[bad][r]\n\n[r]: javascript:alert(1)"} />);
      expect(container.querySelector("a")).toBeNull();
    });
  });

  describe("image bypass probes (every one must show a placeholder)", () => {
    it.each([
      ["a remote https image", "https://example.com/a.png"],
      ["a protocol-relative image", "//example.com/a.png"],
      ["a data: image", "data:image/png;base64,AA=="],
    ])("%s", (_label, src) => {
      renderApp(<Markdown text={`![blocked](${src})`} baseDir="companies/acme-corp/jobs/j1" />);
      expect(screen.getByText("Image not shown: blocked")).toBeInTheDocument();
    });
  });
});

describe("autolinks", () => {
  type N = { type: string; value?: string; url?: string; children?: N[] };
  const links = (tree: N): string[] => (tree.type === "link" ? [tree.url!] : (tree.children ?? []).flatMap(links));
  const para = (...children: N[]): N => ({ type: "root", children: [{ type: "paragraph", children }] });
  const run = (t: N) => { autolinkNodes(t); return links(t); };

  it("links bare https URLs and leaves trailing punctuation out", () => {
    expect(run(para({ type: "text", value: "Apply via https://careers.example.com/jobs/1. Thanks!" }))).toEqual(["https://careers.example.com/jobs/1"]);
  });
  it("keeps balanced parentheses (Wikipedia-style URLs) but not a closing one around the URL", () => {
    expect(run(para({ type: "text", value: "See https://en.wikipedia.org/wiki/Example_(company) for more" }))).toEqual(["https://en.wikipedia.org/wiki/Example_(company)"]);
    expect(run(para({ type: "text", value: "(see https://example.com/a)" }))).toEqual(["https://example.com/a"]);
  });
  it("leaves URLs in inline code and fenced code as text", () => {
    const t: N = { type: "root", children: [
      { type: "paragraph", children: [{ type: "inlineCode", value: "https://example.com/in-code" }] },
      { type: "code", value: "curl https://example.com/in-fence" },
    ] };
    expect(run(t)).toEqual([]);
  });
  it("doesn't link a URL twice inside an existing link", () => {
    const t = para({ type: "link", url: "https://example.com/x", children: [{ type: "text", value: "https://example.com/x" }] });
    expect(run(t)).toEqual(["https://example.com/x"]);
  });
  it("never links http, file: or javascript: text, even next to a good URL", () => {
    expect(run(para({ type: "text", value: "javascript:alert(1) file:///etc/passwd http://example.com/plain https://example.com/ok" })))
      .toEqual(["https://example.com/ok"]);
  });
  it("renders inline code URLs as code, not links", async () => {
    renderApp(<Markdown text={"Run `https://example.com/in-code` now"} />);
    expect(await screen.findByText("https://example.com/in-code")).not.toHaveAttribute("href");
    expect(screen.queryByRole("link")).toBeNull();
  });
});
