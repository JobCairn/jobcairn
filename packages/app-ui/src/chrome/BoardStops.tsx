import { useEffect, useState } from "react";
import { Button, Icon, Icons, Text, useToast } from "@careeros/brand";
import { BOARD_NAMES, type BoardId, type ClaudeRunView } from "@careeros/contract";
import { errorText, useBridge } from "../bridge-context";
import { stopLine } from "./state";

type Diags = NonNullable<ClaudeRunView["browser_diag"]>;

/**
 * The boards a finished find-jobs run stopped early (a security check, a lost tab, a tab that couldn't open in the
 * chosen profile), each as a visible line with "Open <board>": Chrome's own program opens the board's home page in
 * the chosen profile (no remote control), so the person can finish the check there. Nothing when no board stopped.
 */
export function BoardStops({ diags }: { diags: Diags }) {
  const bridge = useBridge();
  const toast = useToast();
  const [names, setNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<BoardId | null>(null);
  const stopped = diags.filter(({ board, diag }) => stopLine(board, diag) !== null);
  const need = stopped.length > 0 && !!bridge.chrome;

  // The chosen profile's name as Chrome shows it ("Career Search"), for the line's wording.
  useEffect(() => {
    if (!need) return;
    let live = true;
    bridge.chrome!.state(false)
      .then((s) => { if (live) setNames(Object.fromEntries((s.profiles ?? []).map((p) => [p.dir, p.name]))); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [need, bridge]);

  if (!stopped.length) return null;
  const openHome = bridge.chrome?.openHome;
  const open = (board: BoardId) => {
    if (!openHome) return;
    setBusy(board);
    openHome(board)
      .catch((e: unknown) => toast({ tone: "danger", text: errorText(e) }))
      .finally(() => setBusy(null));
  };

  return (
    <ul className="list-plain crun__stops" aria-label="Boards that stopped early">
      {stopped.map(({ board, diag }) => (
        <li key={board} className="crun__caution">
          <Icon icon={Icons.info} size="sm" />
          <Text role="body-sm" as="span" className="crun__stop-text">{stopLine(board, diag, names[diag.profile_dir] ?? "")}</Text>
          {openHome ? (
            <Button size="sm" variant="ghost" loading={busy === board} aria-label={`Open ${BOARD_NAMES[board]} in Chrome`} onClick={() => open(board)}>
              {`Open ${BOARD_NAMES[board]}`}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
