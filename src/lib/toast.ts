// Toast notification system
type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

type ToastListener = (toasts: Toast[]) => void;

let nextId = 0;
let toasts: Toast[] = [];
const listeners = new Set<ToastListener>();

function notify() {
  for (const l of listeners) l([...toasts]);
}

export function subscribe(listener: ToastListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getToasts() {
  return [...toasts];
}

export function clearToasts() {
  toasts = [];
  notify();
}

export function showToast(message: string, type: ToastType = 'info', duration = 3000) {
  const id = nextId++;
  toasts = [...toasts, { id, type, message, duration }];
  notify();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    notify();
  }, duration);
}
