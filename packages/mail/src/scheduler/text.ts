import identity from "@careeros/brand/identity.json" with { type: "json" };
export interface ScheduleSpec { label: string; program: string; args: string[]; minutes: number }
// Internal id, not display text: the Windows Task Scheduler task name. Renaming it would orphan
// existing scheduled syncs (docs/rebrand.md).
export const TASK_NAME = "CareerOS Mail Sync";
export const SYSTEMD_UNIT = "careeros-mailsync";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
// Rejects every C0 control character (U+0000-U+001F, including \r, \n and \0) plus DEL
// (U+007F): none of them belong in a plist string, an XML attribute or a shell-less argument
// list, and some (CR/LF/NUL) could otherwise smuggle extra directives into the written file.
const noBreaks = (s: string) => { if (/[\x00-\x1F\x7F]/.test(s)) throw new Error("A scheduled argument can't contain a line break or control character."); return s; };

export function launchdPlist(spec: ScheduleSpec): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xml(spec.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[spec.program, ...spec.args].map((a) => `    <string>${xml(noBreaks(a))}</string>`),
    "  </array>",
    "  <key>StartInterval</key>",
    `  <integer>${spec.minutes * 60}</integer>`,
    "  <key>RunAtLoad</key>",
    "  <false/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

/** One argument, quoted so CommandLineToArgvW gives it back unchanged. */
export function windowsArg(a: string): string {
  noBreaks(a);
  if (a && !/[\s"]/.test(a)) return a;
  return `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function taskSchedulerXml(spec: ScheduleSpec): string {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    `    <Description>${identity.name} reads new job email from Gmail. It never sends.</Description>`,
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <TimeTrigger>",
    "      <Repetition>",
    `        <Interval>PT${spec.minutes}M</Interval>`,
    "        <StopAtDurationEnd>false</StopAtDurationEnd>",
    "      </Repetition>",
    "      <StartBoundary>2026-01-01T00:00:00</StartBoundary>",
    "      <Enabled>true</Enabled>",
    "    </TimeTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>",
    "    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>",
    "    <Hidden>true</Hidden>",
    "    <Enabled>true</Enabled>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    `      <Command>${xml(noBreaks(spec.program))}</Command>`,
    `      <Arguments>${xml(spec.args.map(windowsArg).join(" "))}</Arguments>`,
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

export function taskXmlBytes(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

/** One ExecStart word: double-quoted, backslash and quote escaped, % and $ doubled so systemd doesn't expand them. */
export function systemdArg(a: string): string {
  noBreaks(a);
  return `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

export function systemdService(spec: ScheduleSpec): string {
  return [
    "[Unit]",
    `Description=${identity.name} mail sync (reads job email, never sends)`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${[spec.program, ...spec.args].map(systemdArg).join(" ")}`,
    "Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus",
    "Nice=10",
    "",
  ].join("\n");
}

export function systemdTimer(spec: ScheduleSpec): string {
  return [
    "[Unit]",
    `Description=Run ${identity.name} mail sync every ${spec.minutes} minutes`,
    "",
    "[Timer]",
    "OnBootSec=5min",
    `OnUnitActiveSec=${spec.minutes}min`,
    "Persistent=false",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}
