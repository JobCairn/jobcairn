import { useState } from "react";
import { Button, Dialog } from "@careeros/brand";
import { ACTIONS, claudeWrites, type ActionId, type ActionTarget } from "@careeros/contract";
import { OptionsIcon } from "./icons";
import { RequestComposer } from "./RequestComposer";

/** A small "Choose how" button next to an action that opens the request composer in a dialog. */
export function ComposeButton({ action, target, name }: { action: ActionId; target: ActionTarget; name?: string }) {
  const [open, setOpen] = useState(false);
  // Resume Studio offers its own actions (rewrite_resume); the generic composer doesn't.
  if (!claudeWrites(action) || ACTIONS[action].surface) return null;
  const label = name ?? ACTIONS[action].label;
  return (
    <>
      <Button size="sm" variant="ghost" icon={OptionsIcon} aria-label={`Choose how: ${label}`} title="Choose how Claude does this" onClick={() => setOpen(true)} />
      <Dialog open={open} onClose={() => setOpen(false)} title={ACTIONS[action].label} hideTitle actions={<Button variant="ghost" onClick={() => setOpen(false)}>Close</Button>}>
        {open ? <RequestComposer action={action} target={target} /> : null}
      </Dialog>
    </>
  );
}
