// Confirmation dialog system
interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

type ConfirmResolver = (result: boolean) => void;

let pendingResolve: ConfirmResolver | null = null;
let pendingOptions: ConfirmOptions | null = null;
type ConfirmListener = (opts: ConfirmOptions | null) => void;
const listeners = new Set<ConfirmListener>();

function notify(opts: ConfirmOptions | null) {
  for (const l of listeners) l(opts);
}

export function subscribeConfirm(listener: ConfirmListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPendingConfirm() {
  return pendingOptions;
}

export function resolveConfirm(result: boolean) {
  pendingResolve?.(result);
  pendingResolve = null;
  pendingOptions = null;
  notify(null);
}

export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingResolve = resolve;
    pendingOptions = options;
    notify(options);
  });
}
