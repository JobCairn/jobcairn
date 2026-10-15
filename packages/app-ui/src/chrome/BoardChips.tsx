import { useId } from "react";
import { Text } from "@careeros/brand";
import { BOARD_NAMES, type BoardId } from "@careeros/contract";
import { BoardIcon } from "../source/SourceBadge";

/** A board's logo, the same one SourceBadge shows on jobs found there (decorative; the name sits next to it). */
export function BoardMark({ id }: { id: BoardId }) {
  return <BoardIcon id={id} size="md" className="cboard__mark" />;
}

/** Job board chips with the board's logo. Each chip is a toggle button (aria-pressed). */

export function BoardChips({ boards, ticked, onChange, label, disabledWhy }: {
  boards: readonly BoardId[]; ticked: readonly BoardId[]; onChange(next: BoardId[]): void; label: string;
  /** When set, the chips are disabled and this says why. */
  disabledWhy?: string;
}) {
  const whyId = useId();
  const toggle = (id: BoardId) => onChange(ticked.includes(id) ? ticked.filter((b) => b !== id) : boards.filter((b) => b === id || ticked.includes(b)));
  return (
    <div className="cboards" role="group" aria-label={label} aria-describedby={disabledWhy ? whyId : undefined}>
      <ul className="cboards__list">
        {boards.map((id) => {
          const on = ticked.includes(id);
          return (
            <li key={id}>
              <button type="button" className="cboard" aria-pressed={on} data-on={on || undefined} disabled={!!disabledWhy} title={disabledWhy || undefined}
                onClick={() => toggle(id)}>
                <BoardMark id={id} />
                <span>{BOARD_NAMES[id]}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {disabledWhy ? <Text role="body-sm" muted id={whyId}>{disabledWhy}</Text> : null}
    </div>
  );
}
