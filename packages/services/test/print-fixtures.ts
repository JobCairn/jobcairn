/** Fictional resume Markdown shared by the print and export tests. */
export const EMAIL = "alex" + "@" + "example.com";
export const RESUME = [
  "# Alex Example", "", `Sampletown NSW · ${EMAIL}`, "",
  "## Experience", "", "### AI Engineer, Example Labs", "",
  "- Built retrieval pipelines with **Python** and *TypeScript*", "  - Cut answer time in half (fictional)", "",
  "1. First", "2. Second", "",
  "<script>alert(1)</script>", "<img src=\"https://tracker.example.com/p.png\">", "",
  "![logo](https://cdn.example.com/logo.png) ![local](logo.png)", "",
  "See [my portfolio](https://portfolio.example.com) and [notes](notes.md).", "",
  "---", "",
  "###### Deep heading",
].join("\n");
