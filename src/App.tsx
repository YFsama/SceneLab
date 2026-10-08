import { useEffect } from 'react';
import { useStore } from './store/app';
import { ViewportCanvas } from './components/viewport/ViewportCanvas';
import { InteractiveViewCube } from './components/viewport/InteractiveViewCube';
import { DrawingCanvas } from './components/viewport/DrawingCanvas';
import { Toolbar } from './components/toolbar/Toolbar';
import { SketchToolbar } from './components/toolbar/SketchToolbar';
import { PrimitiveBar } from './components/toolbar/PrimitiveBar';
import { BrowserTree } from './components/panels/BrowserTree';
import { PartsLibrary } from './components/panels/PartsLibrary';
import { TimelineBar } from './components/panels/TimelineBar';
import { PropertiesPanel } from './components/panels/PropertiesPanel';
import { StatusBar } from './components/ui/StatusBar';
import { ToastHost } from './components/ui/ToastHost';
import { ConfirmDialog } from './components/ui/ConfirmDialog';
import { ExtrudeDialog } from './components/ui/ExtrudeDialog';
import { NumericPromptDialog } from './components/ui/NumericPrompt';
import { RevolveDialog } from './components/ui/RevolveDialog';
import { AIPanel } from './components/panels/AIPanel';
import { CAMPanel } from './components/panels/CAMPanel';
import { ParametersPanel } from './components/panels/ParametersPanel';
import { useKeyboardShortcuts, initShortcuts } from './lib/hooks/useKeyboardShortcuts';
import { useAutosave } from './lib/hooks/useAutosave';
import { useResponsive } from './lib/hooks/useResponsive';
import { SkipLink } from './components/ui/SkipLink';
import { CommandPalette } from './components/ui/CommandPalette';
import { PrimitiveDialog } from './components/ui/PrimitiveDialog';
import { ShortcutsHelp } from './components/ui/ShortcutsHelp';
import { PatternDialog } from './components/ui/PatternDialog';
import { MoveDialog } from './components/ui/MoveDialog';
import { RotateDialog } from './components/ui/RotateDialog';
import { ScaleDialog } from './components/ui/ScaleDialog';
import { HollowDialog } from './components/ui/HollowDialog';
import { WelcomeCard } from './components/ui/WelcomeCard';
import { SectionPanel } from './components/ui/SectionPanel';
import { DropZone } from './components/ui/DropZone';
import { RestoreBanner } from './components/ui/RestoreBanner';
import { DiagnosticsDialog } from './components/ui/DiagnosticsDialog';
import { AboutDialog } from './components/ui/AboutDialog';
import { initBuiltinCommands } from './lib/commands/registry';

initShortcuts();
initBuiltinCommands();

export default function App() {
  const theme = useStore((s) => s.theme);
  const workspace = useStore((s) => s.workspace);
  const showBrowserTree = useStore((s) => s.showBrowserTree);
  const showProperties = useStore((s) => s.showProperties);

  // Compact-window layout (I3): below 960 CSS px the docked side panels
  // (browser tree 224px + parts library 240px + properties 240px) squeeze the
  // `flex-1 min-w-0` viewport down to a sliver at the Tauri minimum 800px.
  // Suppression is PURELY at this render layer — showBrowserTree/showProperties
  // are PERSISTED user preferences (scenelab.show* in localStorage) that the
  // shortcuts/commands keep toggling; compact never writes them, so widening
  // the window restores the saved layout immediately. data-viewport mirrors
  // the breakpoint for E2E/visual assertions.
  const breakpoint = useResponsive();
  const compact = breakpoint === 'compact';

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Keyboard shortcuts
  useKeyboardShortcuts();

  // Periodic autosave to localStorage while there are unsaved changes.
  useAutosave();

  return (
    <div className="h-screen flex flex-col" data-theme={theme} data-viewport={breakpoint}>
      <SkipLink />
      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left toolbar */}
        <Toolbar />

        {/* Browser tree (compact windows suppress it at the render layer;
            see the compact note above — the store flag stays untouched) */}
        {showBrowserTree && !compact && <BrowserTree />}

        {/* Parts library (model workspace only; inline, not an overlay, so
            compact hides it the same render-layer way) */}
        {workspace === 'model' && !compact && <PartsLibrary />}

        {/* Viewport area */}
        <main id="main-content" className="flex-1 flex flex-col min-w-0" tabIndex={-1}>
          {workspace === 'drawing' ? (
            <div className="flex-1 relative">
              <DrawingCanvas />
            </div>
          ) : (
            <>
              <div className="flex-1 relative">
                <ViewportCanvas />
                <InteractiveViewCube />
                {workspace === 'sketch' && <SketchToolbar />}
                {workspace === 'model' && <PrimitiveBar />}
                {workspace === 'model' && <WelcomeCard />}
                {workspace === 'model' && <SectionPanel />}
              </div>
              {/* Fusion-style bottom feature timeline */}
              {(workspace === 'model' || workspace === 'sketch') && <TimelineBar />}
            </>
          )}
        </main>

        {/* Properties panel or CAM panel. CAM keeps its right column in
            compact (it is the core CAM workspace UI) but narrows it w-72→w-64
            so the 800px-minimum window still leaves ≥400px of viewport. */}
        {workspace === 'cam' ? (
          <div className={`${compact ? 'w-64' : 'w-72'} bg-panel border-l border-panel-border shrink-0`}>
            <CAMPanel />
          </div>
        ) : (
          showProperties && !compact && <PropertiesPanel />
        )}
      </div>

      {/* Status bar */}
      <StatusBar />

      {/* Overlay UI */}
      <DropZone />
      <ToastHost />
      {/* Crash recovery: probe the stored autosave at boot and offer it. */}
      <RestoreBanner />
      {/* Fusion-style Parameters dialog (opened via the command palette). */}
      <ParametersPanel />
      <ConfirmDialog />
      <NumericPromptDialog />
      <ExtrudeDialog />
      <RevolveDialog />
      <CommandPalette />
      <PrimitiveDialog />
      <ShortcutsHelp />
      <PatternDialog />
      <MoveDialog />
      <RotateDialog />
      <ScaleDialog />
      <HollowDialog />
      <AIPanel />
      {/* Diagnostics (palette "Diagnostics…" / welcome card) and About
          (toolbar Help button / welcome card) — both open via window events. */}
      <DiagnosticsDialog />
      <AboutDialog />
    </div>
  );
}
