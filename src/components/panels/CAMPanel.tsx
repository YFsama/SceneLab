import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import {
  getAllTools,
  getCustomTools,
  addCustomTool,
  removeCustomTool,
  generateMultiToolGCode,
  computeFeedsAndSpeeds,
  detectCircularHoles,
} from '../../lib/cam';
import type { MachineProfile, CAMParameters, CAMOperation, WorkMaterial } from '../../lib/cam';
import type { SolidBody } from '../../lib/geometry/types';
import { computeBoundingBox } from '../../lib/geometry/brep';
import { Cog, Play, Pause, RotateCcw, Download, Clock, Wrench, Gauge, Trash2, RefreshCw, Plus } from 'lucide-react';

const WORK_MATERIALS: WorkMaterial[] = [
  'aluminum', 'brass', 'softwood', 'hardwood', 'mdf', 'acrylic', 'steel', 'pcb',
];

const MACHINE_PROFILES: MachineProfile[] = ['grbl', 'linuxcnc'];

/**
 * Machine-simulation transport, panel side: pure window events (the
 * 'scenelab:arm-hole' decoupling pattern — no store field, the viewport owns
 * the sim state in refs and listens). `opId` targets one operation; without
 * it the viewport walks the first enabled op with a cached toolpath.
 * Not exported (react-refresh): the test file uses the literal event name.
 */
const CAM_SIM_EVENT = 'scenelab:cam-sim';
function dispatchCamSim(action: 'play' | 'pause' | 'reset' | 'seek', opId?: string, t?: number): void {
  window.dispatchEvent(new CustomEvent(CAM_SIM_EVENT, { detail: { action, opId, t } }));
}

/** Fresh unique custom-tool id (randomUUID where available, viewBookmark style). */
let customToolSeq = 0;
function newCustomToolId(): string {
  const uuid = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : null;
  return uuid ? `tool-${uuid.slice(0, 8)}` : `tool-${Date.now().toString(36)}-${(customToolSeq++).toString(36)}`;
}

const defaultParams: CAMParameters = {
  feedRate: 1000,
  plungeRate: 300,
  spindleSpeed: 10000,
  depthOfCut: 2,
  stepover: 3,
  stockTop: 0,
  stockBottom: -10,
};

// --- Toolpath-regen throttling (perf pass #31) ---------------------------------
// The raw effect re-ran the FULL toolpath pipeline synchronously on every
// featureVersion bump — a param-typing burst or undo spam regenerated all ops
// once per keystroke (~580 ms paint block with a 10-op setup). Two guards:
// (a) a 200 ms trailing debounce so bursts coalesce into one regen, and
// (b) an input fingerprint so a regen is SKIPPED entirely when nothing an op
//     consumes changed — featureVersion alone is far too coarse. The
//     fingerprint pairs each op record with its RESOLVED body's reference
//     identity: body ids rotate on every tree recompute (ids can't detect
//     "no geometric change"), but the store memoizes tree results, so the
//     body OBJECT survives every edit that doesn't touch that body's chain —
//     direct bodies (AI/imported parts) survive all tree edits outright.

/** Stable identity token per body reference (WeakMap — no retention). */
let bodyRefSeq = 0;
const bodyRefIds = new WeakMap<object, number>();
function bodyRefToken(body: SolidBody | undefined): number {
  if (!body) return 0; // unresolvable bodyId (dangling after a recompute)
  let token = bodyRefIds.get(body);
  if (token === undefined) {
    token = ++bodyRefSeq;
    bodyRefIds.set(body, token);
  }
  return token;
}

/** Minimal store slice camRegenFingerprint reads (structural — no AppState import). */
interface CamRegenInputs {
  bodies: SolidBody[];
  camSetup: { operations: CAMOperation[] };
  camToolpaths: Record<string, unknown>;
}

/**
 * Fingerprint of every regenerateCamToolpaths input: op records + resolved
 * body references + the ops' RESOLVED TOOLS (the custom-tool library is
 * module state with no store signal — without it here, editing a custom
 * tool's diameter would never trigger a regen).
 */
function camRegenFingerprint(s: CamRegenInputs): string {
  return s.camSetup.operations
    .map((op) => {
      const tool = getAllTools().find((tl) => tl.id === op.toolId);
      return `${JSON.stringify(op)}@${bodyRefToken(s.bodies.find((b) => b.id === op.bodyId))}@${JSON.stringify(tool ?? null)}`;
    })
    .join(';');
}

/** Trailing-debounce window for featureVersion-driven regens (ms). */
const CAM_REGEN_DEBOUNCE_MS = 200;

/**
 * CAM setup editor, store-driven: the operations list, stock and the derived
 * toolpath cache all live in the app store (undoable + serialized with the
 * project); only the DRAFT for the next operation is local state here.
 */
export function CAMPanel() {
  const { t } = useT();
  const bodies = useStore((s) => s.bodies);
  const stock = useStore((s) => s.camSetup.stock);
  const safeZAboveStock = useStore((s) => s.camSetup.safeZAboveStock);
  const operations = useStore((s) => s.camSetup.operations);
  const camToolpaths = useStore((s) => s.camToolpaths);
  const addCamOperation = useStore((s) => s.addCamOperation);
  const removeCamOperation = useStore((s) => s.removeCamOperation);
  const updateCamOperation = useStore((s) => s.updateCamOperation);
  const setCamStock = useStore((s) => s.setCamStock);
  const regenerateCamToolpaths = useStore((s) => s.regenerateCamToolpaths);

  const [selectedTool, setSelectedTool] = useState<string>('em-6mm');
  const [operation, setOperation] = useState<'pocket' | 'contour' | 'drill' | 'face'>('pocket');
  const [params, setParams] = useState<CAMParameters>(defaultParams);
  const [workMaterial, setWorkMaterial] = useState<WorkMaterial>('aluminum');
  // Explicit body pick (null = whatever the scene offers first). Derived
  // fallback instead of an effect: a vanished body simply falls back to
  // bodies[0] with no cascading render.
  const [pickedBodyId, setPickedBodyId] = useState<string | null>(null);
  const [machineProfile, setMachineProfile] = useState<MachineProfile>('grbl');
  // Drill targets pinned by the detect button. The pin records WHICH body and
  // operation type it was taken on; the derivation below ignores stale pins
  // (no reset effect needed).
  const [pin, setPin] = useState<{ bodyId: string; op: 'drill'; holes: Array<{ x: number; z: number; depth: number }> } | null>(null);

  // Custom tools live in a module array (persisted to localStorage) — bump a
  // dummy state counter on every mutation to force the re-render, and read
  // the lists inline (cheap spreads; no memo means no stale-list hazard).
  const [, setToolVersion] = useState(0);
  const refreshTools = () => setToolVersion(() => 1);
  const tools = getAllTools();
  const customIds = new Set(getCustomTools().map((tl) => tl.id));
  const activeTool = tools.find((tl) => tl.id === selectedTool);
  // No memo: the tool list is re-read per render (module array + version
  // bump), and computeFeedsAndSpeeds is a cheap pure lookup — memoizing on
  // an object sourced from a mutable module array trips the compiler lint.
  const suggestedFeeds = activeTool ? computeFeedsAndSpeeds(activeTool, workMaterial) : null;

  // Body ids rotate on every feature recompute, so cached toolpaths silently
  // dangle after any model edit (or undo). While the CAM workspace is open,
  // re-derive the cache when the tree version moves; ops whose body is gone
  // drop out of the cache and render with the stale hint below. The effect is
  // THROTTLED (see camRegenFingerprint above): the first run for a mount
  // heals a cold cache immediately; later featureVersion bumps coalesce into
  // one trailing-debounced regen and skip entirely when the fingerprint says
  // no op input moved.
  const featureVersion = useStore((s) => s.featureVersion);
  const regenerate = useStore((s) => s.regenerateCamToolpaths);
  const opCount = operations.length;
  const lastRegenInputs = useRef<string | null>(null);
  useEffect(() => {
    if (opCount === 0) {
      lastRegenInputs.current = null; // a wiped setup re-heals on next mount of ops
      return;
    }
    if (lastRegenInputs.current === null) {
      // Cold-cache heal (mount, project load, first op): synchronous, so the
      // panel never renders a stale row it could have healed.
      regenerate();
      lastRegenInputs.current = camRegenFingerprint(useStore.getState());
      return;
    }
    const handle = window.setTimeout(() => {
      const s = useStore.getState();
      const fingerprint = camRegenFingerprint(s);
      // Skip only when BOTH the inputs are identical AND every enabled op
      // still has a cache entry — a lost cache (undo snapshot, load) must
      // rebuild even when the fingerprint happens to match.
      const cacheComplete = s.camSetup.operations.every(
        (op) => !op.enabled || s.camToolpaths[op.id] !== undefined,
      );
      if (fingerprint === lastRegenInputs.current && cacheComplete) return;
      regenerate();
      lastRegenInputs.current = fingerprint;
    }, CAM_REGEN_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [featureVersion, opCount, regenerate]);

  // The effective target body: the user's pick when it still exists, else the
  // first body (never hard-wired — the select below reflects exactly this).
  const targetBody = bodies.find((b) => b.id === pickedBodyId) ?? bodies[0];

  // Drill targets: detectCircularHoles runs live against the TARGET body (the
  // generator also auto-detects when an op carries no holes). The detect
  // button pins the current detection as explicit op holes; a pin taken on
  // another body or operation type is derived away as stale.
  // TODO(i18n): a dedicated 'cam.detectHoles' label — the ⌀ count is
  // language-neutral meanwhile (i18n.ts is owned outside this file).
  const detectedHoles = useMemo(
    () => (operation === 'drill' && targetBody ? detectCircularHoles(targetBody) : []),
    [operation, targetBody],
  );
  const pinnedHoles = pin && pin.bodyId === (targetBody?.id ?? '') && pin.op === operation ? pin.holes : null;
  const drillHoles = pinnedHoles ?? detectedHoles.map((h) => ({ x: h.centre.x, z: h.centre.z, depth: h.depth }));

  const applySuggestedFeeds = () => {
    if (!suggestedFeeds) return;
    setParams((p) => ({
      ...p,
      feedRate: suggestedFeeds.feedRate,
      plungeRate: suggestedFeeds.plungeRate,
      spindleSpeed: suggestedFeeds.spindleRpm,
    }));
  };

  const handleGenerate = () => {
    if (!activeTool) return;
    if (!targetBody) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    // Seed the stock heights from the TARGET BODY's bbox — the raw defaults
    // (0/−10) plan below a body resting on the origin plane and the whole
    // toolpath renders under the part with the G-code cutting negative Z.
    // The setup's safeZAboveStock rides along so the generators' traverse
    // height follows the serialized setup (pass-29 review #10).
    const bb = computeBoundingBox(targetBody);
    addCamOperation({
      name: `${t(`cam.${operation}`)} — ${targetBody.name}`,
      enabled: true,
      type: operation,
      bodyId: targetBody.id,
      toolId: activeTool.id,
      params: { ...params, stockTop: bb.max.y, stockBottom: bb.min.y, safeZAboveStock },
      // Omitted/empty holes → the generator auto-detects on the body.
      ...(operation === 'drill' && drillHoles.length > 0 ? { holes: drillHoles } : {}),
    });
    showToast(t('cam.generated'), 'success');
  };

  const handleExportGCode = async () => {
    const toolpaths = operations
      .map((op) => camToolpaths[op.id]?.toolpath)
      .filter((tp): tp is NonNullable<typeof tp> => tp !== undefined);
    if (toolpaths.length === 0) {
      showToast(t('cam.noToolpaths'), 'warning');
      return;
    }
    const gcode = generateMultiToolGCode(toolpaths, machineProfile);
    // Dynamic import: a static one drags io/studio3d (and its io barrel
    // chain) into the entry chunk; this is an on-click path, latency-free.
    const { downloadFile } = await import('../../lib/io/studio3d');
    downloadFile(gcode, 'toolpath.nc');
    showToast(t('cam.gcodeExported'), 'success');
  };

  const totalTime = useMemo(
    () => operations.reduce((sum, op) => sum + (camToolpaths[op.id]?.timeMin ?? 0), 0),
    [operations, camToolpaths],
  );

  // Any enabled op with a cache = something to simulate; the transport is
  // disabled otherwise (no cached toolpath → nothing to walk).
  const hasCache = operations.some((op) => op.enabled && camToolpaths[op.id]);

  // Tool library: duplicate the selected tool as an editable custom (persisted
  // by toolLibrary), edit diameter/flutes in place (upsert), remove customs.
  const isCustomTool = !!activeTool && customIds.has(activeTool.id);

  const handleAddTool = () => {
    const base = activeTool ?? tools[0];
    if (!base) return;
    const id = newCustomToolId();
    addCustomTool({ ...base, id, name: `⌀${base.diameter} Z${base.flutes}` });
    refreshTools();
    setSelectedTool(id);
  };

  const handleEditTool = (patch: { diameter?: number; flutes?: number }) => {
    if (!activeTool || !isCustomTool) return;
    const diameter = Math.max(0.1, patch.diameter ?? activeTool.diameter);
    const flutes = Math.min(12, Math.max(1, Math.round(patch.flutes ?? activeTool.flutes)));
    // The name is derived (locale-neutral machining notation ⌀d Zf) so the
    // select always reflects the numbers without new i18n keys.
    addCustomTool({ ...activeTool, diameter, flutes, name: `⌀${diameter} Z${flutes}` });
    refreshTools();
  };

  const handleRemoveTool = () => {
    if (!activeTool || !isCustomTool) return;
    removeCustomTool(activeTool.id);
    refreshTools();
    setSelectedTool('em-6mm');
  };

  const stockMode = stock.mode;
  const bboxStock = stockMode === 'bounding-box' ? stock : null;
  const boxStock = stockMode === 'box' ? stock : null;

  return (
    <div className="w-full h-full flex flex-col text-xs">
      <div className="px-3 py-2 border-b border-panel-border flex items-center gap-2">
        <Cog size={16} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-primary">{t('cam.title')}</h2>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Tool selection + library editor */}
        <div>
          <label htmlFor="cam-tool-select" className="block text-text-muted mb-1">{t('cam.tool')}</label>
          <select
            id="cam-tool-select"
            value={selectedTool}
            onChange={(e) => setSelectedTool(e.target.value)}
            className="w-full px-2 py-1.5 bg-surface border border-panel-border rounded text-text-primary"
          >
            {tools.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {tool.name} ({tool.diameter}mm)
              </option>
            ))}
          </select>

          {/* Tool library: Add duplicates the selected tool as an editable
           * custom (persisted to localStorage by lib/cam/toolLibrary). Only
           * customs are editable/removable — defaults stay reference data.
           * Labels: ⌀/Z are locale-neutral machining notation. */}
          <div className="mt-1.5 flex items-center justify-between rounded bg-surface px-2 py-1.5 text-[10px]">
            <span className="text-text-muted">{t('cam.toolLibrary')}</span>
            <button
              id="cam-add-tool"
              onClick={handleAddTool}
              title={t('cam.addTool')}
              aria-label={t('cam.addTool')}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-text-secondary hover:text-text-primary hover:bg-surface-hover"
            >
              <Plus size={11} />
              {t('cam.addTool')}
            </button>
          </div>
          {isCustomTool && activeTool && (
            <div className="mt-1 flex items-center gap-1.5 rounded bg-surface px-2 py-1.5 text-[10px] text-text-secondary">
              <span className="flex-1 truncate" title={activeTool.name}>{activeTool.name}</span>
              <label className="flex items-center gap-1" title={t('dim.diameter')}>
                ⌀
                <input
                  id="cam-tool-diameter"
                  type="number"
                  min={0.1}
                  step={0.5}
                  aria-label={t('dim.diameter')}
                  value={activeTool.diameter}
                  onChange={(e) => handleEditTool({ diameter: Number(e.target.value) })}
                  className="w-14 px-1 py-0.5 bg-surface border border-panel-border rounded text-text-primary"
                />
              </label>
              <label className="flex items-center gap-1" aria-label="Z">
                Z
                <input
                  id="cam-tool-flutes"
                  type="number"
                  min={1}
                  max={12}
                  step={1}
                  aria-label="Z"
                  value={activeTool.flutes}
                  onChange={(e) => handleEditTool({ flutes: Number(e.target.value) })}
                  className="w-10 px-1 py-0.5 bg-surface border border-panel-border rounded text-text-primary"
                />
              </label>
              <button
                id="cam-tool-remove"
                onClick={handleRemoveTool}
                title={t('cam.remove')}
                aria-label={t('cam.remove')}
                className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-surface-hover"
              >
                <Trash2 size={11} />
              </button>
            </div>
          )}
        </div>

        {/* Work material + suggested feeds & speeds */}
        <div>
          <label htmlFor="cam-material" className="block text-text-muted mb-1">{t('cam.workMaterial')}</label>
          <select
            id="cam-material"
            value={workMaterial}
            onChange={(e) => setWorkMaterial(e.target.value as WorkMaterial)}
            className="w-full px-2 py-1.5 bg-surface border border-panel-border rounded text-text-primary"
          >
            {WORK_MATERIALS.map((m) => (
              <option key={m} value={m}>{t(`cam.mat.${m}`)}</option>
            ))}
          </select>
          {suggestedFeeds && (
            <div className="mt-1.5 flex items-center justify-between gap-2 rounded bg-surface px-2 py-1.5 text-[10px] text-text-secondary">
              <span className="flex items-center gap-1">
                <Gauge size={11} />
                {suggestedFeeds.spindleRpm} RPM · {suggestedFeeds.feedRate} mm/min
              </span>
              <button
                onClick={applySuggestedFeeds}
                className="px-2 py-0.5 rounded bg-accent text-white hover:bg-accent-hover"
              >
                {t('cam.applyFeeds')}
              </button>
            </div>
          )}
        </div>

        {/* Target body — operations no longer hard-wire bodies[0]. The select
         * shows the body name itself (no 'cam.body' i18n key exists yet), so
         * it stays language-neutral without inventing hardcoded English. */}
        <select
          id="cam-body-select"
          value={targetBody?.id ?? ''}
          onChange={(e) => setPickedBodyId(e.target.value || null)}
          aria-label={targetBody?.name ?? '—'}
          className="w-full px-2 py-1.5 bg-surface border border-panel-border rounded text-text-primary"
        >
          {bodies.length === 0 && <option value="">—</option>}
          {bodies.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>

        {/* Operation selection */}
        <div>
          <span className="block text-text-muted mb-1">{t('cam.operation')}</span>
          <div className="flex gap-1" role="radiogroup" aria-label={t('cam.operation')}>
            {(['pocket', 'contour', 'drill', 'face'] as const).map((op) => (
              <button
                key={op}
                onClick={() => setOperation(op)}
                role="radio"
                aria-checked={operation === op}
                className={`flex-1 px-2 py-1.5 rounded text-xs transition-colors ${
                  operation === op
                    ? 'bg-accent text-white'
                    : 'bg-surface text-text-secondary hover:bg-surface-hover'
                }`}
              >
                {t(`cam.${op}`)}
              </button>
            ))}
          </div>
        </div>

        {/* Drill preview: how many circular holes the generator will target,
         * with a button to pin the current detection as explicit op holes. */}
        {operation === 'drill' && (
          <div className="flex items-center justify-between rounded bg-surface px-2 py-1.5 text-[10px] text-text-secondary">
            <span className="flex items-center gap-1">
              <Wrench size={11} className="text-text-muted" />
              ⌀ {drillHoles.length}{pinnedHoles ? ' ✓' : ''}
            </span>
            <button
              onClick={() => targetBody && setPin({
                bodyId: targetBody.id,
                op: 'drill',
                holes: detectedHoles.map((h) => ({ x: h.centre.x, z: h.centre.z, depth: h.depth })),
              })}
              title={t('cam.regenerate')}
              aria-label={`⌀ ${detectedHoles.length}`}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover"
            >
              <RefreshCw size={12} />
            </button>
          </div>
        )}

        {/* Parameters */}
        <div className="space-y-2">
          <span className="block text-text-muted">{t('cam.parameters')}</span>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="cam-feed" className="text-text-muted text-[10px]">{t('cam.feedRate')}</label>
              <input
                id="cam-feed"
                type="number"
                value={params.feedRate}
                onChange={(e) => setParams({ ...params, feedRate: Number(e.target.value) })}
                className="w-full px-2 py-1 bg-surface border border-panel-border rounded text-text-primary"
              />
            </div>
            <div>
              <label htmlFor="cam-spindle" className="text-text-muted text-[10px]">{t('cam.spindleSpeed')}</label>
              <input
                id="cam-spindle"
                type="number"
                value={params.spindleSpeed}
                onChange={(e) => setParams({ ...params, spindleSpeed: Number(e.target.value) })}
                className="w-full px-2 py-1 bg-surface border border-panel-border rounded text-text-primary"
              />
            </div>
            <div>
              <label htmlFor="cam-doc" className="text-text-muted text-[10px]">{t('cam.depthOfCut')}</label>
              <input
                id="cam-doc"
                type="number"
                value={params.depthOfCut}
                onChange={(e) => setParams({ ...params, depthOfCut: Number(e.target.value) })}
                className="w-full px-2 py-1 bg-surface border border-panel-border rounded text-text-primary"
              />
            </div>
            <div>
              <label htmlFor="cam-stepover" className="text-text-muted text-[10px]">{t('cam.stepover')}</label>
              <input
                id="cam-stepover"
                type="number"
                value={params.stepover}
                onChange={(e) => setParams({ ...params, stepover: Number(e.target.value) })}
                className="w-full px-2 py-1 bg-surface border border-panel-border rounded text-text-primary"
              />
            </div>
          </div>
        </div>

        {/* Stock definition (serialized with the project; nothing previewed yet) */}
        <div className="space-y-2">
          <span className="block text-text-muted">{t('cam.stock')}</span>
          <select
            id="cam-stock-mode"
            value={stockMode}
            onChange={(e) => {
              if (e.target.value === 'box' && !boxStock) {
                // Switching to an explicit box: seed it from a sane 10 mm cube.
                setCamStock({ mode: 'box', min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } });
              } else if (e.target.value === 'bounding-box' && !bboxStock) {
                setCamStock({ mode: 'bounding-box', margin: 2 });
              }
            }}
            className="w-full px-2 py-1.5 bg-surface border border-panel-border rounded text-text-primary"
          >
            <option value="bounding-box">{t('cam.stock')} · bbox</option>
            <option value="box">{t('cam.stock')} · box</option>
          </select>
          {bboxStock && (
            <div>
              <label htmlFor="cam-stock-margin" className="text-text-muted text-[10px]">{t('cam.margin')}</label>
              <input
                id="cam-stock-margin"
                type="number"
                value={bboxStock.margin}
                onChange={(e) => setCamStock({ mode: 'bounding-box', margin: Number(e.target.value) })}
                className="w-full px-2 py-1 bg-surface border border-panel-border rounded text-text-primary"
              />
            </div>
          )}
          {stockMode === 'box' && boxStock && (
            <div className="grid grid-cols-2 gap-2">
              {(['min', 'max'] as const).map((bound) => (
                <div key={bound}>
                  <span className="text-text-muted text-[10px]">{bound}</span>
                  <div className="flex gap-1">
                    {(['x', 'y', 'z'] as const).map((axis) => (
                      <input
                        key={axis}
                        type="number"
                        aria-label={`cam-stock-${bound}-${axis}`}
                        value={boxStock[bound][axis]}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setCamStock({
                            mode: 'box',
                            min: bound === 'min' ? { ...boxStock.min, [axis]: v } : boxStock.min,
                            max: bound === 'max' ? { ...boxStock.max, [axis]: v } : boxStock.max,
                          });
                        }}
                        className="w-full px-1 py-1 bg-surface border border-panel-border rounded text-text-primary"
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
        >
          <Play size={14} />
          {t('cam.generate')}
        </button>

        {/* Operations (store-driven) */}
        {operations.length > 0 && (
          <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">{t('cam.toolpaths')}</span>
            <div className="flex items-center gap-1 text-text-muted">
              <Clock size={12} />
              <span>{totalTime.toFixed(1)} {t('cam.minutes')}</span>
            </div>
          </div>

          {/* Simulation transport: dispatches window events the viewport owns
           * (no store field — the arm-hole decoupling). Disabled without a
           * cached toolpath; per-row ▶ below targets that specific op. */}
          <div className="flex items-center gap-1" role="group" aria-label={t('cam.simulate')}>
            <button
              id="cam-sim-play"
              onClick={() => dispatchCamSim('play')}
              disabled={!hasCache}
              title={t('cam.simPlay')}
              aria-label={t('cam.simPlay')}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-surface border border-panel-border rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Play size={11} />
            </button>
            <button
              id="cam-sim-pause"
              onClick={() => dispatchCamSim('pause')}
              disabled={!hasCache}
              title={t('cam.simPause')}
              aria-label={t('cam.simPause')}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-surface border border-panel-border rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Pause size={11} />
            </button>
            <button
              id="cam-sim-reset"
              onClick={() => dispatchCamSim('reset')}
              disabled={!hasCache}
              title={t('cam.simReset')}
              aria-label={t('cam.simReset')}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-surface border border-panel-border rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <RotateCcw size={11} />
            </button>
          </div>

            {operations.map((op) => {
              const cache = camToolpaths[op.id];
              // Enabled but uncached = the body was regenerated/deleted since
              // the toolpath was computed (ids rotate on recompute) — flag it
              // instead of silently showing "—".
              const stale = op.enabled && !cache;
              return (
                <div key={op.id} className="flex items-center gap-2 p-2 bg-surface rounded">
                  <input
                    type="checkbox"
                    checked={op.enabled}
                    onChange={(e) => updateCamOperation(op.id, { enabled: e.target.checked })}
                    aria-label={op.name}
                    className="accent-accent"
                  />
                  <Wrench size={12} className="text-text-muted shrink-0" />
                  <span className={`flex-1 truncate ${op.enabled ? 'text-text-secondary' : 'text-text-muted line-through'}`} title={stale ? t('cam.stale') : op.name}>{op.name}</span>
                  <span
                    className={`text-text-muted shrink-0 ${stale ? 'text-warning italic' : ''}`}
                    title={stale ? t('cam.stale') : undefined}
                  >
                    {cache ? `${cache.timeMin.toFixed(1)} ${t('cam.minutes')}` : stale ? t('cam.stale') : '—'}
                  </span>
                  {/* Simulate THIS op (user-picked; the transport buttons walk
                   * the first enabled op instead). */}
                  <button
                    onClick={() => dispatchCamSim('play', op.id)}
                    disabled={!cache}
                    title={t('cam.simulate')}
                    aria-label={`${t('cam.simulate')} ${op.name}`}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Play size={12} />
                  </button>
                  <button
                    onClick={() => regenerateCamToolpaths()}
                    title={t('cam.regenerate')}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover"
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button
                    onClick={() => removeCamOperation(op.id)}
                    title={t('cam.remove')}
                    className="p-1 rounded text-text-muted hover:text-red-400 hover:bg-surface-hover"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}

            {/* Machine profile + export */}
            <div className="flex gap-2">
              <select
                id="cam-profile-select"
                value={machineProfile}
                onChange={(e) => setMachineProfile(e.target.value as MachineProfile)}
                className="flex-1 px-2 py-1.5 bg-surface border border-panel-border rounded text-text-primary"
              >
                {MACHINE_PROFILES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
              <button
                onClick={handleExportGCode}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-surface border border-panel-border text-text-primary rounded hover:bg-surface-hover transition-colors"
              >
                <Download size={14} />
                {t('cam.exportGCode')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
