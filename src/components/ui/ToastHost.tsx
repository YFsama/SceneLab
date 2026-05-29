import { useState, useEffect } from 'react';
import { subscribe, type getToasts } from '../../lib/toast';
import { CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react';

type ToastData = ReturnType<typeof getToasts>[number];

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

const colors = {
  success: 'text-success border-success/30',
  error: 'text-error border-error/30',
  warning: 'text-warning border-warning/30',
  info: 'text-accent border-accent/30',
} as const;

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastData[]>([]);

  useEffect(() => subscribe(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 flex flex-col gap-2 z-50"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => {
        const Icon = icons[t.type];
        return (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-3 py-2 rounded-md border bg-panel backdrop-blur-sm shadow-lg text-sm ${colors[t.type]}`}
          >
            <Icon size={16} />
            <span className="text-text-primary">{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}
