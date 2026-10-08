import { useState, useEffect } from 'react';
import { subscribe, type getToasts } from '../../lib/toast';
import { CheckCircle, AlertTriangle, AlertCircle, Info, Copy, Check } from 'lucide-react';
import { copyText } from '../../lib/errorLog';
import { useT } from '../../lib/i18n';

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
  // id of the toast whose message was just copied (icon shows a check briefly).
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const { t } = useT();

  useEffect(() => subscribe(setToasts), []);

  const copyToast = (id: number, message: string): void => {
    void copyText(message).then((ok) => {
      if (!ok) return;
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    });
  };

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 flex flex-col gap-2 z-50"
      role="status"
      aria-live="polite"
    >
      {toasts.map((item) => {
        const Icon = icons[item.type];
        return (
          <div
            key={item.id}
            className={`flex items-center gap-2 px-3 py-2 rounded-md border bg-panel backdrop-blur-sm shadow-lg text-sm ${colors[item.type]}`}
          >
            <Icon size={16} />
            <span className="text-text-primary">{item.message}</span>
            {item.type === 'error' && (
              <button
                type="button"
                aria-label={t('errlog.copyOne')}
                title={t('errlog.copyOne')}
                className="text-text-muted hover:text-text-primary transition-colors"
                onClick={() => copyToast(item.id, item.message)}
              >
                {copiedId === item.id ? <Check size={14} /> : <Copy size={14} />}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
