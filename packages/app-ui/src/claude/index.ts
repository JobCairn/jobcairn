/** Claude Code engine UI (lane H). See docs/specs/2026-10-10-claude-code-engine.md. */
export { useClaudeRun, useClaudeEngine, useClaudeRuns, type UseClaudeRun } from "./useClaudeRun";
export { ClaudeRunPanel, formatCost, formatElapsed, type ClaudeRunPanelProps } from "./ClaudeRunPanel";
export { RunCard, StepList } from "./RunCard";
export { RunChip } from "./RunChip";
export { ClaudeActivityProvider, ActivityDrawer, useActivity, type ActivityApi } from "./Activity";
export { runsForJob, runRoute } from "./activity-model";
export { JobActivity, useJobRunCount } from "./JobActivity";
export { dedupeSteps } from "./steps";
export { ClaudeSetup, setupStep } from "./ClaudeSetup";
export { ClaudeWorkingIndicator, StatusIcon, type StatusTone } from "./ClaudeWorkingIndicator";
