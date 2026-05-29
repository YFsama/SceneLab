import { useT } from '../../lib/i18n';

export function SkipLink() {
  const { t } = useT();
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:bg-accent focus:text-white focus:rounded"
    >
      {t('skip.toContent')}
    </a>
  );
}
