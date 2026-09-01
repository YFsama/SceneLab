import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { warmUpBooleanEngine } from './lib/geometry/boolean';

// Load the exact-boolean WASM engine in the background; until it is ready (or
// if it never loads) boolean operations fall back to the voxel approximation.
void warmUpBooleanEngine();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
