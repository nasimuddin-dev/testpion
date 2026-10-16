import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { runStep, type OnboardingStep } from '../lib/onboarding';
import { TOUR_STEPS, useTour } from '../lib/tour';
import { Coachmark } from './ui';

/**
 * The guided tour of the first loop (lib/tour.ts) on screen: each step goes to its view and points the shared Coachmark
 * at the control that does it; "Show me" does what the Get started card's step does (opens what it builds on). Mounted
 * once, by Home (which stays mounted), so it goes on while the tour visits other views.
 */
export function GuidedTour({ progress }: { progress: OnboardingStep[] }) {
  const { open, index, go, close } = useTour();
  const step = TOUR_STEPS[index]!;
  const [anchor, setAnchor] = useState<Element | null>(null);
  const shownView = useApp((s) => s.view);
  useEffect(() => {
    if (!open) return;
    const app = useApp.getState();
    if (app.view !== step.view) app.setView(step.view);
    // a request view with no tab open: a new request, so the request's controls are there to point at
    if (step.view === 'rest' && !document.querySelector('[data-tour="send"]')) app.openIntent('rest', { newTab: true });
    setAnchor(null);
    // the control appears once its view has drawn: look for it for a moment (else the card stands centred)
    let tries = 0;
    const find = () => step.targets.map((t) => [...document.querySelectorAll(t)].find((el) => el.getClientRects().length)).find(Boolean) ?? null;
    const timer = setInterval(() => {
      const el = find();
      if (el || ++tries > 20) {
        clearInterval(timer);
        setAnchor(el);
      }
    }, 75);
    return () => clearInterval(timer);
  }, [open, index]); // eslint-disable-line react-hooks/exhaustive-deps
  // paused while another view is on screen (the person went elsewhere): back on the step's view, it shows again
  if (!open || shownView !== step.view) return null;
  const p = progress.find((x) => x.id === step.id);
  const last = index === TOUR_STEPS.length - 1;
  return (
    <Coachmark
      anchor={anchor}
      title={step.title}
      step={index}
      total={TOUR_STEPS.length}
      done={p?.done}
      onNext={() => (last ? close() : go(index + 1))}
      onBack={() => go(index - 1)}
      onSkip={close}
      action={p ? { label: 'Show me', onClick: () => runStep(p) } : undefined}
    >
      {step.text}
    </Coachmark>
  );
}
