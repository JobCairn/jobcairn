import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cx } from "../cx";
import { Icons } from "../icons";
import { Icon } from "./Icon";

interface FieldBits { label: string; help?: string; error?: string; hideLabel?: boolean }

function useFieldIds(help?: string, error?: string) {
  const id = useId();
  const helpId = help ? `${id}-help` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return { id, describedBy: [errorId, helpId].filter(Boolean).join(" ") || undefined, helpId, errorId };
}

function Shell({ id, label, hideLabel, help, helpId, error, errorId, children }: FieldBits & { id: string; helpId?: string; errorId?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id} className={cx("field__label", hideLabel && "sr-only")}>{label}</label>
      {children}
      {error ? <span id={errorId} className="field__error">{error}</span> : null}
      {help ? <span id={helpId} className="field__help">{help}</span> : null}
    </div>
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & FieldBits;
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, help, error, hideLabel, className, ...rest }, ref) {
  const ids = useFieldIds(help, error);
  return (
    <Shell {...ids} label={label} help={help} error={error} hideLabel={hideLabel}>
      <input ref={ref} id={ids.id} className={cx("input", className)} aria-invalid={error ? true : undefined} aria-describedby={ids.describedBy} {...rest} />
    </Shell>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & FieldBits;
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ label, help, error, hideLabel, className, ...rest }, ref) {
  const ids = useFieldIds(help, error);
  return (
    <Shell {...ids} label={label} help={help} error={error} hideLabel={hideLabel}>
      <textarea ref={ref} id={ids.id} className={cx("input", "textarea", className)} aria-invalid={error ? true : undefined} aria-describedby={ids.describedBy} {...rest} />
    </Shell>
  );
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & FieldBits & { options: { value: string; label: string }[] };
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ label, help, error, hideLabel, options, className, ...rest }, ref) {
  const ids = useFieldIds(help, error);
  return (
    <Shell {...ids} label={label} help={help} error={error} hideLabel={hideLabel}>
      <span className="select-wrap">
        <select ref={ref} id={ids.id} className={cx("input", "select", className)} aria-invalid={error ? true : undefined} aria-describedby={ids.describedBy} {...rest}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className="select-wrap__chevron" aria-hidden="true"><Icon icon={Icons.expand} size="sm" /></span>
      </span>
    </Shell>
  );
});

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string; help?: string };
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, help, className, ...rest }, ref) {
  const id = useId();
  return (
    <div className={cx("checkbox", className)}>
      <input ref={ref} id={id} type="checkbox" aria-describedby={help ? `${id}-help` : undefined} {...rest} />
      <label htmlFor={id}>{label}</label>
      {help ? <span id={`${id}-help`} className="field__help">{help}</span> : null}
    </div>
  );
});
