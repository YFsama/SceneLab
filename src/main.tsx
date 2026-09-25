import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { warmUpBooleanEngine } from './lib/geometry/boolean';

// Load the exact-boolean WASM engine in the background — but only once the
// browser is idle, so the 0.5 MB fetch never competes with first paint (until
// it is ready, boolean operations fall back to the voxel approximation).
const warmIdle = () => { void warmUpBooleanEngine(); };
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(warmIdle, { timeout: 2000 });
} else {
  setTimeout(warmIdle, 300);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
