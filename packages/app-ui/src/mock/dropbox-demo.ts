import type { MockOptions } from "./MockBridge";

/**
 * `?dropbox` preview: a drop box with a saved job ad, a resume, an unsure file for Ask Claude, a long name and the
 * usual cover letter and visa letter. All fictional.
 */
export function dropboxDemo(): Pick<MockOptions, "inbox" | "inboxTexts" | "inboxClaude"> {
  return {
    inbox: [
      "acme-corp-cover-letter.pdf", "Visa_Grant_Notice.pdf", "Applied AI Engineer - Example Robotics (saved ad).md",
      "alex-example-resume-2026.md", "weekend-robot-notes.txt",
      "Alex Example - Senior AI Engineer application notes for Example Labs final-v2.md",
    ],
    inboxTexts: {
      "Applied AI Engineer - Example Robotics (saved ad).md": "# Applied AI Engineer\n\nExample Robotics is hiring an Applied AI Engineer in Brisbane.\n\n## About the role\nYou will build agents.\n\n## Responsibilities\n- Ship LLM features\n\n## Requirements\n- Python\n\nSalary: $140,000 per annum. How to apply: use the form.\n",
      "alex-example-resume-2026.md": "Alex Example\nalex@example.com\n\nProfessional summary\nAI Engineer.\n\nExperience\nExample Labs, AI Engineer, 2023 - Present\n\nEducation\nBSc, 2021\n\nSkills\nPython\n",
      "weekend-robot-notes.txt": "Notes about a weekend robot build: motors, a camera and a small vision model.",
    },
    inboxClaude: "auto",
  };
}
