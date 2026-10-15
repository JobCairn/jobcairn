import type { MethodName } from "@careeros/contract";
import type { ServiceContext } from "./context.js";

// Arguments are already validated by the dispatcher (contract METHODS), so handlers take them as typed values.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (ctx: ServiceContext, ...args: any[]) => unknown;
export type HandlerTable = Record<MethodName, Handler>;
