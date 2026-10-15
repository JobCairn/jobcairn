export interface Clock { now?: Date }
export function iso(c?: Clock): string {
  return (c?.now ?? new Date()).toISOString();
}
