import { useEffect } from 'react';
import { useStore } from './store/app';
import { ViewportCanvas } from './components/viewport/ViewportCanvas';
import { ViewCube } from './components/viewport/ViewCube';
import { DrawingCanvas } from './components/viewport/DrawingCanvas';
import { Toolbar } from './components/toolbar/Toolbar';
import { SketchToolbar } from './components/toolbar/SketchToolbar';
import { PrimitiveBar } from './components/toolbar/PrimitiveBar';
import { BrowserTree } from './components/panels/BrowserTree';
import { PropertiesPanel } from './components/panels/PropertiesPanel';
import { StatusBar } from './components/ui/StatusBar';
import { ToastHost } from './components/ui/ToastHost';
import { ConfirmDialog } from './components/ui/ConfirmDialog';
import { ExtrudeDialog } from './components/ui/ExtrudeDialog';
import { AIPanel } from './components/panels/AIPanel';
import { CAMPanel } from './components/panels/CAMPanel';
import { useKeyboardShortcuts, initShortcuts } from './lib/hooks/useKeyboardShortcuts';
import { SkipLink } from './components/ui/SkipLink';

initShortcuts();

export default function App() {
  const theme = useStore((s) => s.theme);
  const workspace = useStore((s) => s.workspace);
  const showBrowserTree = useStore((s) => s.showBrowserTree);
  const showProperties = useStore((s) => s.showProperties);

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Keyboard shortcuts
  useKeyboardShortcuts();

  return (
    <div className="h-screen flex flex-col" data-theme={theme}>
      <SkipLink />
      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left toolbar */}
        <Toolbar />

        {/* Browser tree */}
        {showBrowserTree && <BrowserTree />}

        {/* Viewport area */}
        <main id="main-content" className="flex-1 relative" tabIndex={-1}>
          {workspace === 'drawing' ? (
            <DrawingCanvas />
          ) : (
            <>
              <ViewportCanvas />
              <ViewCube />
              {workspace === 'sketch' && <SketchToolbar />}
              {workspace === 'model' && <PrimitiveBar />}
            </>
          )}
        </main>

        {/* Properties panel or CAM panel */}
        {workspace === 'cam' ? (
          <div className="w-72 bg-panel border-l border-panel-border">
            <CAMPanel />
          </div>
        ) : (
          showProperties && <PropertiesPanel />
        )}
      </div>

      {/* Status bar */}
      <StatusBar />

      {/* Overlay UI */}
      <ToastHost />
      <ConfirmDialog />
      <ExtrudeDialog />
      <AIPanel />
    </div>
  );
}
