import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { warmUpBooleanEngine, isManifoldEngineReady } from './lib/geometry/boolean';
import { useStore } from './store/app';
import { installGlobalErrorCapture } from './lib/errorLog';
import { ErrorBoundary } from './components/ui/ErrorBoundary';

// Load the exact-boolean WASM engine right after the FIRST PAINTED frame. The
// request itself is async I/O (541 kB / 208 kB gzip, ~12 ms compile) and never
// blocks the render path; starting it on the second rAF just keeps it out of
// the very first frame's script budget. An idle callback (the old behaviour)
// could sit behind boot work for its whole 2 s timeout — and every boolean
// computed during that window fell back to the slow voxel approximation.
const warmBooleanEngine = () => {
  void warmUpBooleanEngine().then(() => {
    // Cold-computed boolean features (blocky voxel results) re-evaluate now
    // that the exact engine is live: the feature tree's memo refuses to reuse
    // a boolean result across a readiness flip, and the store's public
    // recomputeTree action replays the timeline through it.
    const store = useStore.getState();
    if (isManifoldEngineReady() && store.featureTree.features.length > 0) {
      store.recomputeTree();
    }
  });
};
if (typeof requestAnimationFrame === 'function') {
  // Double rAF: the first fires before this frame paints, the second runs
  // after it — i.e. genuinely post-paint.
  requestAnimationFrame(() => requestAnimationFrame(warmBooleanEngine));
} else {
  setTimeout(warmBooleanEngine, 0);
}

// Catch uncaught window errors + unhandled promise rejections into the
// persistent error log BEFORE anything else can throw. Capture lives at the
// window level, so it must be installed before createRoot renders.
installGlobalErrorCapture();

// StrictMode stays the OUTERMOST component (its dev-only double-render checks
// must wrap the whole tree); the boundary directly beneath it still catches
// every render throw from anywhere inside <App/>.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
