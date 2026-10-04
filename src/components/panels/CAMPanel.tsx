import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import { downloadFile } from '../../lib/io/studio3d';
import {
  getAllTools,
  generateMultiToolGCode,
  computeFeedsAndSpeeds,
  detectCircularHoles,
} from '../../lib/cam';
import type { MachineProfile, CAMParameters, WorkMaterial } from '../../lib/cam';
import { computeBoundingBox } from '../../lib/geometry/brep';
import { Cog, Play, Download, Clock, Wrench, Gauge, Trash2, RefreshCw } from 'lucide-react';

const WORK_MATERIALS: WorkMaterial[] = [
  'aluminum', 'brass', 'softwood', 'hardwood', 'mdf', 'acrylic', 'steel', 'pcb',
];

const MACHINE_PROFILES: MachineProfile[] = ['grbl', 'linuxcnc'];

const defaultParams: CAMParameters = {
  feedRate: 1000,
  plungeRate: 300,
  spindleSpeed: 10000,
  depthOfCut: 2,
  stepover: 3,
  stockTop: 0,
  stockBottom: -10,
};

/**
 * CAM setup editor, store-driven: the operations list, stock and the derived
 * toolpath cache all live in the app store (undoable + serialized with the
 * project); only the DRAFT for the next operation is local state here.
 */
export function CAMPanel() {
  const { t } = useT();
  const bodies = useStore((s) => s.bodies);
  const stock = useStore((s) => s.camSetup.stock);
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

  const tools = useMemo(() => getAllTools(), []);
  const activeTool = tools.find((tl) => tl.id === selectedTool);
  const suggestedFeeds = useMemo(
    () => (activeTool ? computeFeedsAndSpeeds(activeTool, workMaterial) : null),
    [activeTool, workMaterial],
  );

  // Body ids rotate on every feature recompute, so cached toolpaths silently
  // dangle after any model edit (or undo). While the CAM workspace is open,
  // re-derive the cache whenever the tree version moves; ops whose body is
  // gone drop out of the cache and render with the stale hint below.
  const featureVersion = useStore((s) => s.featureVersion);
  const regenerate = useStore((s) => s.regenerateCamToolpaths);
  const opCount = operations.length;
  useEffect(() => {
    if (opCount > 0) regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- featureVersion is the signal; regenerate/opCount are stable enough refs of store actions/state
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
    const bb = computeBoundingBox(targetBody);
    addCamOperation({
      name: `${t(`cam.${operation}`)} — ${targetBody.name}`,
      enabled: true,
      type: operation,
      bodyId: targetBody.id,
      toolId: activeTool.id,
      params: { ...params, stockTop: bb.max.y, stockBottom: bb.min.y },
      // Omitted/empty holes → the generator auto-detects on the body.
      ...(operation === 'drill' && drillHoles.length > 0 ? { holes: drillHoles } : {}),
    });
    showToast(t('cam.generated'), 'success');
  };

  const handleExportGCode = () => {
    const toolpaths = operations
      .map((op) => camToolpaths[op.id]?.toolpath)
      .filter((tp): tp is NonNullable<typeof tp> => tp !== undefined);
    if (toolpaths.length === 0) {
      showToast(t('cam.noToolpaths'), 'warning');
      return;
    }
    const gcode = generateMultiToolGCode(toolpaths, machineProfile);
    downloadFile(gcode, 'toolpath.nc');
    showToast(t('cam.gcodeExported'), 'success');
  };

  const totalTime = useMemo(
    () => operations.reduce((sum, op) => sum + (camToolpaths[op.id]?.timeMin ?? 0), 0),
    [operations, camToolpaths],
  );

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
        {/* Tool selection */}
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
