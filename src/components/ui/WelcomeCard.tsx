import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { loadSampleProject, sampleLabel } from '../../lib/library/loadSample';
import { SAMPLE_PROJECTS } from '../../lib/library/samples';
import { ONBOARDING_STEPS, shouldShowWelcome } from '../../lib/onboarding';
import { Box, Shapes, PenTool, Bot, Check, X, Sparkles } from 'lucide-react';

/**
 * First-run welcome card: quick-start buttons, starter projects and a live
 * getting-started checklist (TinkerCAD-style lessons bar). Auto-hides as soon
 * as the scene stops being empty, so it never blocks real work.
 */
export function WelcomeCard() {
  const { t } = useT();
  const workspace = useStore((s) => s.workspace);
  const bodyCount = useStore((s) => s.bodies.length);
  const featureCount = useStore((s) => s.featureTree.features.length);
  const sketchActive = useStore((s) => s.sketchActive);
  const welcomeDismissed = useStore((s) => s.welcomeDismissed);
  const welcomeSessionHidden = useStore((s) => s.welcomeSessionHidden);
  const onboardingSteps = useStore((s) => s.onboardingSteps);

  const show = shouldShowWelcome({
    workspace,
    bodyCount,
    featureCount,
    sketchActive,
    welcomeDismissed,
    welcomeSessionHidden,
  });
  if (!show) return null;

  const st = useStore.getState();

  const quickActions = [
    {
      icon: Box,
      label: t('welcome.insertBox'),
      onClick: () => st.addPrimitive('box'),
    },
    {
      icon: Shapes,
      label: t('welcome.openLibrary'),
      onClick: () => { if (!st.showPartsLibrary) st.togglePartsLibrary(); },
    },
    {
      icon: PenTool,
      label: t('welcome.startSketch'),
      onClick: () => { st.setWorkspace('sketch'); st.setSketchActive(true); },
    },
    {
      icon: Bot,
      label: t('welcome.askAI'),
      onClick: () => window.dispatchEvent(new CustomEvent('scenelab:open-ai')),
    },
  ];

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none"
      aria-label={t('welcome.title')}
    >
      <div className="pointer-events-auto w-[24rem] max-w-[90%] bg-panel border border-panel-border rounded-xl shadow-2xl p-4 space-y-3">
        <div className="flex items-start gap-2">
          <Sparkles size={16} className="text-accent mt-0.5" />
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-text-primary">{t('welcome.title')}</h2>
            <p className="text-xs text-text-secondary">{t('welcome.subtitle')}</p>
          </div>
          <button
            onClick={() => useStore.getState().hideWelcomeForSession()}
            className="text-text-muted hover:text-text-primary"
            aria-label={t('dialog.close')}
            title={t('dialog.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {quickActions.map(({ icon: Icon, label, onClick }) => (
            <button
              key={label}
              onClick={onClick}
              className="flex items-center gap-2 px-2 py-2 rounded-md border border-panel-border hover:border-accent hover:bg-surface-hover transition-colors text-left"
            >
              <Icon size={16} className="text-accent shrink-0" />
              <span className="text-xs text-text-primary">{label}</span>
            </button>
          ))}
        </div>

        <section>
          <h3 className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
            {t('welcome.samples')}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {SAMPLE_PROJECTS.map((s) => (
              <button
                key={s.id}
                onClick={() => { void loadSampleProject(s.id); }}
                className="px-2 py-1 rounded-md bg-surface border border-panel-border hover:border-accent text-xs text-text-secondary hover:text-text-primary transition-colors"
              >
                {sampleLabel(s.id)}
              </button>
            ))}
          </div>
        </section>

        <section className="border-t border-panel-border pt-2">
          <h3 className="text-[10px] font-medium text-text-muted uppercase tracking-wider mb-1">
            {t('welcome.checklist')} · {onboardingSteps.filter((x) => (ONBOARDING_STEPS as readonly string[]).includes(x)).length}/{ONBOARDING_STEPS.length}
          </h3>
          <ul className="space-y-0.5">
            {ONBOARDING_STEPS.map((step) => {
              const done = onboardingSteps.includes(step);
              return (
                <li key={step} className={`flex items-center gap-1.5 text-xs ${done ? 'text-text-muted line-through' : 'text-text-secondary'}`}>
                  <span
                    className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center shrink-0 ${
                      done ? 'bg-accent/20 border-accent text-accent' : 'border-panel-border'
                    }`}
                    aria-hidden="true"
                  >
                    {done && <Check size={9} />}
                  </span>
                  {t(`welcome.step.${step}`)}
                </li>
              );
            })}
          </ul>
        </section>

        <button
          onClick={() => useStore.getState().dismissWelcome()}
          className="text-[10px] text-text-muted hover:text-text-primary underline underline-offset-2"
        >
          {t('welcome.dismiss')}
        </button>
      </div>
    </div>
  );
}
