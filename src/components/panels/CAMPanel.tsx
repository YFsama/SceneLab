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
  generateSetupSheetHtml,
  programSafeZ,
} from '../../lib/cam';
import type {
  MachineProfile, CAMParameters, CAMOperation, WorkMaterial, GCodeOptions, SetupSheetOp,
} from '../../lib/cam';
import { copyText } from '../../lib/errorLog';
import type { SolidBody } from '../../lib/geometry/types';
import { computeBoundingBox } from '../../lib/geometry/brep';
import { GCodePreview } from '../ui/GCodePreview';
import { SetupSheet } from '../ui/SetupSheet';
import {
  Cog, Play, Pause, RotateCcw, Download, Clock, Wrench, Gauge, Trash2, RefreshCw, Plus,
  Pencil, Copy, ChevronUp, ChevronDown, SkipForward, Eye, X, ClipboardList,
} from 'lucide-react';

const WORK_MATERIALS: WorkMaterial[] = [
  'aluminum', 'brass', 'softwood', 'hardwood', 'mdf', 'acrylic', 'steel', 'pcb',
];

const MACHINE_PROFILES: MachineProfile[] = ['grbl', 'linuxcnc'];

/**
 * Machine-simulation transport, panel side: pure window events (the
 * 'scenelab:arm-hole' decoupling pattern — no store field, the viewport owns
 * the sim state in refs and listens). `opId` targets one operation; without
 * it the viewport walks the first enabled op with a cached toolpath.
 * 'step' advances one move; 'speed' re-times playback live (0.25×–8×).
 * Not exported (react-refresh): the test file uses the literal event name.
 */
const CAM_SIM_EVENT = 'scenelab:cam-sim';
function dispatchCamSim(
  action: 'play' | 'pause' | 'reset' | 'seek' | 'step' | 'speed',
  opId?: string,
  t?: number,
  speed?: number,
): void {
  window.dispatchEvent(new CustomEvent(CAM_SIM_EVENT, { detail: { action, opId, t, speed } }));
}

/** Simulation speed factors offered by the transport (dispatched hot). */
const SIM_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;

/**
 * The op-type-specific CAMParameters fields — contour (direction/tabs/
 * springPass/rampEntry) and pass #34 (pocketStrategy/helixEntry/wallFinishPass/
 * drillCycle/dwellSeconds) — bind through dedicated draft controls below, so a
 * stored op's params are STRIPPED of them when loaded into the numeric draft:
 * the dedicated controls are the single source of truth and a stale value can
 * never leak back into a different op type on the next Generate.
 */
function stripOpExtras(p: CAMParameters): CAMParameters {
  const out = { ...p } as CAMParameters & Record<string, unknown>;
  delete out['direction'];
  delete out['tabs'];
  delete out['springPass'];
  delete out['rampEntry'];
  delete out['pocketStrategy'];
  delete out['helixEntry'];
  delete out['wallFinishPass'];
  delete out['drillCycle'];
  delete out['dwellSeconds'];
  return out;
}

/**
 * Tool numbering shared with the post-processor: first appearance over the
 * cached toolpaths in op-list order — generateMultiToolGCode numbers tools
 * walking exactly this sequence, so any consumer of T numbers derives them
 * from this map (pass #33's preview summary, the pass #34 setup sheet).
 */
function postToolNumbers(toolpaths: Array<{ tool: { id: string } }>): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const tp of toolpaths) {
    if (!numbers.has(tp.tool.id)) numbers.set(tp.tool.id, numbers.size + 1);
  }
  return numbers;
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
  const moveCamOperation = useStore((s) => s.moveCamOperation);
  const duplicateCamOperation = useStore((s) => s.duplicateCamOperation);
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
  // WCS checkbox beside the profile picker (pass #34): opts the post into
  // emitting the G54 work offset. Off by default — legacy programs unchanged.
  const [wcs, setWcs] = useState(false);
  // Drill targets pinned by the detect button. The pin records WHICH body and
  // operation type it was taken on; the derivation below ignores stale pins
  // (no reset effect needed).
  const [pin, setPin] = useState<{ bodyId: string; op: 'drill'; holes: Array<{ x: number; z: number; depth: number }> } | null>(null);

  // Editing session: a row's Edit loads that op into the draft states above
  // (type/tool/body/params) and pins it; Generate becomes Update until
  // committed or cancelled. Derived away when the op disappears (deleted,
  // undo) — the pickedBodyId fallback style, no reset effect.
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingOp = editingId ? operations.find((o) => o.id === editingId) : undefined;

  // Contour-only draft fields (the ContourParams contract names; they ride in
  // op.params on generate/update). Disabled switches are OMITTED on generate
  // (params stay clean — undefined is the default) and written as undefined
  // on update, so the key-wise params merge clears whatever an earlier edit
  // left behind.
  const [direction, setDirection] = useState<'climb' | 'conventional'>('climb');
  const [tabsEnabled, setTabsEnabled] = useState(false);
  const [tabCount, setTabCount] = useState(3);
  const [tabHeight, setTabHeight] = useState(3);
  const [tabWidth, setTabWidth] = useState(6);
  const [springPass, setSpringPass] = useState(false);
  const [rampEntry, setRampEntry] = useState(false);

  // Pocket-only drafts (pass #34, same omit/undefined rule; the strategy
  // select is always-concrete like `direction` — 'raster' is the default).
  const [pocketStrategy, setPocketStrategy] = useState<'raster' | 'offset'>('raster');
  const [helixEntry, setHelixEntry] = useState(false);
  const [wallFinishPass, setWallFinishPass] = useState(false);
  // Drill-only drafts (pass #34): the cycle select is always-concrete
  // ('peck' default); dwell seconds ride along only for the dwell cycle.
  const [drillCycle, setDrillCycle] = useState<'peck' | 'simple' | 'dwell'>('peck');
  const [dwellSeconds, setDwellSeconds] = useState(0.5);

  // G-code preview modal (generated on demand; never cached in the store).
  const [preview, setPreview] = useState<{
    gcode: string;
    lineCount: number;
    sizeBytes: number;
    toolsUsed: string;
    feedRange: string;
  } | null>(null);

  // Setup sheet modal (pass #34): the HTML document generated on demand from
  // the CURRENT ops + cache; never cached in the store.
  const [setupSheetHtml, setSetupSheetHtml] = useState<string | null>(null);

  // Project name for the setup sheet header (the store's save-slot name).
  const projectName = useStore((s) => s.projectName);

  // Simulation speed for the transport (dispatched hot — the viewport owns
  // playback and re-times without pausing).
  const [simSpeed, setSimSpeed] = useState<number>(1);

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

  /** Compose the op params from the drafts: numeric base + stock seeding from
   * the TARGET BODY's bbox (the raw 0/−10 defaults would plan below a body
   * resting on the origin plane) + the op-type-specific fields (contour and
   * the pass #34 pocket/drill contracts; see the draft blocks for the
   * omit/undefined rule). */
  const opParams = (mode: 'add' | 'update', bb: ReturnType<typeof computeBoundingBox>): CAMParameters => {
    const out: CAMParameters = { ...params, stockTop: bb.max.y, stockBottom: bb.min.y, safeZAboveStock };
    if (operation === 'contour') {
      out.direction = direction; // select — always concrete ('climb' default)
      if (tabsEnabled) out.tabs = { count: tabCount, height: tabHeight, width: tabWidth };
      else if (mode === 'update') out.tabs = undefined;
      if (springPass) out.springPass = true;
      else if (mode === 'update') out.springPass = undefined;
      if (rampEntry) out.rampEntry = true;
      else if (mode === 'update') out.rampEntry = undefined;
    } else if (mode === 'update') {
      // Editing away from contour: explicitly clear fields an earlier edit of
      // this op may have written (the merge is key-wise).
      out.direction = undefined;
      out.tabs = undefined;
      out.springPass = undefined;
      out.rampEntry = undefined;
    }
    if (operation === 'pocket') {
      out.pocketStrategy = pocketStrategy; // select — always concrete ('raster' default)
      if (helixEntry) out.helixEntry = true;
      else if (mode === 'update') out.helixEntry = undefined;
      if (wallFinishPass) out.wallFinishPass = true;
      else if (mode === 'update') out.wallFinishPass = undefined;
    } else if (mode === 'update') {
      out.pocketStrategy = undefined;
      out.helixEntry = undefined;
      out.wallFinishPass = undefined;
    }
    if (operation === 'drill') {
      out.drillCycle = drillCycle; // select — always concrete ('peck' default)
      if (drillCycle === 'dwell') out.dwellSeconds = dwellSeconds;
      else if (mode === 'update') out.dwellSeconds = undefined;
    } else if (mode === 'update') {
      out.drillCycle = undefined;
      out.dwellSeconds = undefined;
    }
    return out;
  };

  const handleGenerate = () => {
    if (!activeTool) return;
    if (!targetBody) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    const bb = computeBoundingBox(targetBody);
    addCamOperation({
      name: `${t(`cam.${operation}`)} — ${targetBody.name}`,
      enabled: true,
      type: operation,
      bodyId: targetBody.id,
      toolId: activeTool.id,
      params: opParams('add', bb),
      // Omitted/empty holes → the generator auto-detects on the body.
      ...(operation === 'drill' && drillHoles.length > 0 ? { holes: drillHoles } : {}),
    });
    showToast(t('cam.generated'), 'success');
  };

  /** Commit the editing session: patch the op in place (never appends) and
   * drop back to the Generate CTA. */
  const handleUpdate = () => {
    if (!editingOp || !activeTool) return;
    if (!targetBody) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }
    const bb = computeBoundingBox(targetBody);
    const bodyChanged = editingOp.bodyId !== targetBody.id;
    // Derived name (pass #34): rebuilt ONLY when a derivation input moved
    // (type or body) — a name the user curated (or a duplicate's copy
    // suffix) survives an edit that changed neither. A rebuild re-appends
    // the localized copy suffix so editing a duplicate doesn't launder it
    // into an "original" name (duplicateCamOperation's no-stacking rule).
    const copySuffix = t('cam.copySuffix');
    const name = editingOp.type === operation && !bodyChanged
      ? editingOp.name
      : `${t(`cam.${operation}`)} — ${targetBody.name}${editingOp.name.endsWith(copySuffix) ? copySuffix : ''}`;
    updateCamOperation(editingOp.id, {
      name,
      type: operation,
      bodyId: targetBody.id,
      toolId: activeTool.id,
      params: opParams('update', bb),
      // Retargeting a drill re-detects its holes on the NEW body (pass #34):
      // pins from the old body's geometry would silently drill stale
      // positions. An empty detection writes an empty list, which the
      // generator treats as the auto-detect case — it then throws honestly
      // on a body with no circular holes and the stale hint surfaces it
      // (same semantics as the detect button / auto-detect path). Same body
      // → holes untouched.
      ...(operation === 'drill' && bodyChanged
        ? { holes: detectedHoles.map((h) => ({ x: h.centre.x, z: h.centre.z, depth: h.depth })) }
        : {}),
    });
    setEditingId(null);
    showToast(t('cam.generated'), 'success');
  };

  /** Load an op back into the draft and enter the editing session. */
  const handleEdit = (op: CAMOperation) => {
    setEditingId(op.id);
    setOperation(op.type);
    setSelectedTool(op.toolId);
    setPickedBodyId(op.bodyId);
    // Numeric base stripped of the op-type-specific fields; those load into
    // their dedicated draft controls (the single source of truth, see
    // opParams).
    setParams(stripOpExtras(op.params));
    setDirection(op.params.direction ?? 'climb');
    setTabsEnabled(!!op.params.tabs);
    if (op.params.tabs) {
      setTabCount(op.params.tabs.count);
      setTabHeight(op.params.tabs.height);
      setTabWidth(op.params.tabs.width);
    }
    setSpringPass(!!op.params.springPass);
    setRampEntry(!!op.params.rampEntry);
    setPocketStrategy(op.params.pocketStrategy ?? 'raster');
    setHelixEntry(!!op.params.helixEntry);
    setWallFinishPass(!!op.params.wallFinishPass);
    setDrillCycle(op.params.drillCycle ?? 'peck');
    setDwellSeconds(op.params.dwellSeconds ?? 0.5);
  };

  const handleDuplicate = (id: string) => {
    const newId = duplicateCamOperation(id);
    if (newId) showToast(t('cam.duplicated'), 'success');
  };

  /** The currently cached toolpaths in op-list order (the export/preview base). */
  const cachedToolpaths = () => operations
    .map((op) => camToolpaths[op.id]?.toolpath)
    .filter((tp): tp is NonNullable<typeof tp> => tp !== undefined);

  /**
   * Post-processor options from the drafts: the WCS checkbox beside the
   * profile picker (G54 work-offset emission, off by default so legacy
   * programs are unchanged).
   */
  const gcodeOptions = (): GCodeOptions => ({ wcs });

  const handleExportGCode = async () => {
    const toolpaths = cachedToolpaths();
    if (toolpaths.length === 0) {
      showToast(t('cam.noToolpaths'), 'warning');
      return;
    }
    const gcode = generateMultiToolGCode(toolpaths, machineProfile, gcodeOptions());
    // Dynamic import: a static one drags io/studio3d (and its io barrel
    // chain) into the entry chunk; this is an on-click path, latency-free.
    const { downloadFile } = await import('../../lib/io/studio3d');
    downloadFile(gcode, 'toolpath.nc');
    showToast(t('cam.gcodeExported'), 'success');
  };

  /** Open the preview modal over the program for the CURRENT cache + profile. */
  const handlePreviewGCode = () => {
    const toolpaths = cachedToolpaths();
    if (toolpaths.length === 0) {
      showToast(t('cam.noToolpaths'), 'warning');
      return;
    }
    const gcode = generateMultiToolGCode(toolpaths, machineProfile, gcodeOptions());
    // Tool summary in T-number order (map iteration order = insertion order
    // = first appearance = the post-processor's numbering).
    const diameters = new Map(toolpaths.map((tp) => [tp.tool.id, tp.tool.diameter]));
    const toolsUsed = [...postToolNumbers(toolpaths)]
      .map(([id, n]) => `T${n} ⌀${diameters.get(id)}`)
      .join(' · ');
    // Feed range: scan the emitted program's F words (covers plunge/cut feeds
    // of every op in one pass).
    const feeds = (gcode.match(/F\d+(?:\.\d+)?/g) ?? []).map((f) => Number(f.slice(1)));
    const lo = feeds.length > 0 ? Math.min(...feeds) : 0;
    const hi = feeds.length > 0 ? Math.max(...feeds) : 0;
    setPreview({
      gcode,
      lineCount: gcode === '' ? 0 : gcode.split('\n').length - (gcode.endsWith('\n') ? 1 : 0),
      sizeBytes: new TextEncoder().encode(gcode).length,
      toolsUsed,
      feedRange: feeds.length === 0
        ? '—'
        : lo === hi
          ? `${Math.round(lo)} mm/min`
          : `${Math.round(lo)}–${Math.round(hi)} mm/min`,
    });
  };

  const handleCopyPreview = async () => {
    if (!preview) return;
    // copyText: async Clipboard API with the hidden-textarea+execCommand
    // fallback for webviews that deny it — failure surfaces as a toast.
    const ok = await copyText(preview.gcode);
    showToast(ok ? t('cam.copied') : t('cam.copyFailed'), ok ? 'success' : 'error');
  };

  const handleDownloadPreview = async () => {
    if (!preview) return;
    const { downloadFile } = await import('../../lib/io/studio3d');
    downloadFile(preview.gcode, 'toolpath.nc');
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
  // One-line stock description for the setup sheet header (locale-neutral
  // machining notation — the document itself is English by convention).
  const stockText = boxStock
    ? `${(boxStock.max.x - boxStock.min.x).toFixed(1)}×${(boxStock.max.y - boxStock.min.y).toFixed(1)}×${(boxStock.max.z - boxStock.min.z).toFixed(1)} mm`
    : `bbox +${bboxStock?.margin ?? 0} mm`;

  /**
   * Open the setup sheet modal over the CURRENT setup (pass #34). Works with
   * no cached toolpath at all — every op is listed, uncached rows just show
   * "—" in the time column. T numbers mirror the post-processor exactly (the
   * posted sequence numbers first); a tool only an uncached/disabled op uses
   * trails AFTER them so its row still names a T number without shifting the
   * numbers the G-code will emit. (Declared after every input it reads —
   * earlier-declared captures trip the React Compiler's memo-preservation
   * bailout for the totalTime memo above.)
   */
  const handleSetupSheet = () => {
    const numbers = postToolNumbers(cachedToolpaths());
    const numberFor = (toolId: string): number => {
      let n = numbers.get(toolId);
      if (n === undefined) {
        n = numbers.size + 1;
        numbers.set(toolId, n);
      }
      return n;
    };
    const ops: SetupSheetOp[] = operations.map((op) => {
      const tool = getAllTools().find((tl) => tl.id === op.toolId);
      return {
        name: op.name,
        type: op.type,
        toolName: tool?.name ?? op.toolId,
        toolNumber: numberFor(op.toolId),
        diameter: tool?.diameter ?? 0,
        timeMin: camToolpaths[op.id]?.timeMin ?? 0,
        feedRate: op.params.feedRate,
        spindleSpeed: op.params.spindleSpeed,
        enabled: op.enabled,
      };
    });
    // Safe Z straight from the post-processor's own programSafeZ rule (the
    // first op seeds it, exactly like emitProgram does) — the sheet must
    // document the traverse height the program ACTUALLY emits, not a
    // lookalike formula (pass #34 review P2: stockTop+margin ≠ the post's
    // stockTop+max(10, margin)).
    const firstTp = operations
      .map((op) => camToolpaths[op.id]?.toolpath)
      .find((tp) => tp !== undefined);
    setSetupSheetHtml(generateSetupSheetHtml({
      projectName,
      profile: machineProfile,
      stock: stockText,
      safeZ: programSafeZ(firstTp),
      totalTimeMin: totalTime,
      ops,
    }));
  };

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

          {/* Contour-only parameters (locked contract fields): cut direction,
           * holding tabs (enable + count/height/width), spring pass and ramp
           * entry. Disabled switches keep the op params clean — see opParams. */}
          {operation === 'contour' && (
            <div className="space-y-1.5 rounded bg-surface p-2">
              <div>
                <label htmlFor="cam-direction" className="text-text-muted text-[10px]">{t('cam.direction')}</label>
                <select
                  id="cam-direction"
                  value={direction}
                  onChange={(e) => setDirection(e.target.value === 'conventional' ? 'conventional' : 'climb')}
                  className="w-full px-2 py-1 bg-surface border border-panel-border rounded text-text-primary"
                >
                  <option value="climb">{t('cam.climb')}</option>
                  <option value="conventional">{t('cam.conventional')}</option>
                </select>
              </div>
              <div>
                <label htmlFor="cam-tabs-enable" className="flex items-center gap-1.5 text-text-muted text-[10px]">
                  <input
                    id="cam-tabs-enable"
                    type="checkbox"
                    checked={tabsEnabled}
                    onChange={(e) => setTabsEnabled(e.target.checked)}
                    className="accent-accent"
                  />
                  {t('cam.tabs')}
                </label>
                <div className={`mt-1 grid grid-cols-3 gap-1.5 ${tabsEnabled ? '' : 'opacity-50 pointer-events-none'}`}>
                  <div>
                    <label htmlFor="cam-tab-count" className="text-text-muted text-[10px]">{t('cam.tabCount')}</label>
                    <input
                      id="cam-tab-count"
                      type="number"
                      min={1}
                      step={1}
                      disabled={!tabsEnabled}
                      value={tabCount}
                      onChange={(e) => setTabCount(Number(e.target.value))}
                      className="w-full px-1 py-1 bg-surface border border-panel-border rounded text-text-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor="cam-tab-height" className="text-text-muted text-[10px]">{t('cam.tabHeight')}</label>
                    <input
                      id="cam-tab-height"
                      type="number"
                      min={0.1}
                      step={0.5}
                      disabled={!tabsEnabled}
                      value={tabHeight}
                      onChange={(e) => setTabHeight(Number(e.target.value))}
                      className="w-full px-1 py-1 bg-surface border border-panel-border rounded text-text-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor="cam-tab-width" className="text-text-muted text-[10px]">{t('cam.tabWidth')}</label>
                    <input
                      id="cam-tab-width"
                      type="number"
                      min={0.1}
                      step={0.5}
                      disabled={!tabsEnabled}
                      value={tabWidth}
                      onChange={(e) => setTabWidth(Number(e.target.value))}
                      className="w-full px-1 py-1 bg-surface border border-panel-border rounded text-text-primary"
                    />
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-3">
                <label htmlFor="cam-spring-pass" className="flex items-center gap-1.5 text-text-secondary">
                  <input
                    id="cam-spring-pass"
                    type="checkbox"
                    checked={springPass}
                    onChange={(e) => setSpringPass(e.target.checked)}
                    className="accent-accent"
                  />
                  {t('cam.springPass')}
                </label>
                <label htmlFor="cam-ramp-entry" className="flex items-center gap-1.5 text-text-secondary">
                  <input
                    id="cam-ramp-entry"
                    type="checkbox"
                    checked={rampEntry}
                    onChange={(e) => setRampEntry(e.target.checked)}
                    className="accent-accent"
                  />
                  {t('cam.rampEntry')}
                </label>
              </div>
            </div>
          )}

          {/* Pocket-only parameters (pass #34): strategy select — offset stays
           * selectable even when the pocket has through holes (the generator
           * falls back to raster itself; the title says so, no UI coupling) —
           * plus helix entry and wall finish switches (omit/undefined rule,
           * see opParams). */}
          {operation === 'pocket' && (
            <div className="space-y-1.5 rounded bg-surface p-2">
              <div>
                <label htmlFor="cam-pocket-strategy" className="text-text-muted text-[10px]">{t('cam.pocketStrategy')}</label>
                <select
                  id="cam-pocket-strategy"
                  value={pocketStrategy}
                  onChange={(e) => setPocketStrategy(e.target.value === 'offset' ? 'offset' : 'raster')}
                  title={t('cam.offsetHint')}
                  className="w-full px-2 py-1 bg-surface border border-panel-border rounded text-text-primary"
                >
                  <option value="raster">{t('cam.raster')}</option>
                  <option value="offset">{t('cam.offset')}</option>
                </select>
              </div>
              <div className="flex flex-wrap gap-3">
                <label htmlFor="cam-helix-entry" className="flex items-center gap-1.5 text-text-secondary">
                  <input
                    id="cam-helix-entry"
                    type="checkbox"
                    checked={helixEntry}
                    onChange={(e) => setHelixEntry(e.target.checked)}
                    className="accent-accent"
                  />
                  {t('cam.helixEntry')}
                </label>
                <label htmlFor="cam-wall-finish" className="flex items-center gap-1.5 text-text-secondary">
                  <input
                    id="cam-wall-finish"
                    type="checkbox"
                    checked={wallFinishPass}
                    onChange={(e) => setWallFinishPass(e.target.checked)}
                    className="accent-accent"
                  />
                  {t('cam.wallFinish')}
                </label>
              </div>
            </div>
          )}

          {/* Drill-only parameters (pass #34): cycle select + the dwell
           * seconds input that only the dwell cycle shows (default 0.5 s). */}
          {operation === 'drill' && (
            <div className="space-y-1.5 rounded bg-surface p-2">
              <div>
                <label htmlFor="cam-drill-cycle" className="text-text-muted text-[10px]">{t('cam.drillCycle')}</label>
                <select
                  id="cam-drill-cycle"
                  value={drillCycle}
                  onChange={(e) => setDrillCycle(
                    e.target.value === 'simple' ? 'simple' : e.target.value === 'dwell' ? 'dwell' : 'peck',
                  )}
                  className="w-full px-2 py-1 bg-surface border border-panel-border rounded text-text-primary"
                >
                  <option value="peck">{t('cam.peck')}</option>
                  <option value="simple">{t('cam.simple')}</option>
                  <option value="dwell">{t('cam.dwell')}</option>
                </select>
              </div>
              {drillCycle === 'dwell' && (
                <div>
                  <label htmlFor="cam-dwell-seconds" className="text-text-muted text-[10px]">{t('cam.dwellSeconds')}</label>
                  <input
                    id="cam-dwell-seconds"
                    type="number"
                    min={0}
                    step={0.1}
                    value={dwellSeconds}
                    onChange={(e) => setDwellSeconds(Number(e.target.value))}
                    className="w-full px-1 py-1 bg-surface border border-panel-border rounded text-text-primary"
                  />
                </div>
              )}
            </div>
          )}
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

        {/* Generate / Update CTA: while an editing session is pinned the button
         * commits the patch (updateCamOperation — never appends), with a Cancel
         * escape and a warning banner naming the op under edit. */}
        {editingOp ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1 rounded bg-surface px-2 py-1.5 text-[10px] text-warning" title={t('cam.editing', { name: editingOp.name })}>
              <Pencil size={11} className="shrink-0" />
              <span className="truncate">{t('cam.editing', { name: editingOp.name })}</span>
            </div>
            <div className="flex gap-1">
              <button
                onClick={handleUpdate}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
              >
                <Play size={14} />
                {t('cam.update')}
              </button>
              <button
                onClick={() => setEditingId(null)}
                title={t('cam.cancelOp')}
                aria-label={t('cam.cancelOp')}
                className="flex items-center justify-center px-3 py-2 bg-surface border border-panel-border text-text-secondary rounded hover:bg-surface-hover hover:text-text-primary transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={handleGenerate}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
          >
            <Play size={14} />
            {t('cam.generate')}
          </button>
        )}

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
           * cached toolpath; per-row ▶ below targets that specific op. The
           * speed select re-times playback hot ('speed' event, no pause); the
           * step button advances one move ('step'). */}
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
            <button
              id="cam-sim-step"
              onClick={() => dispatchCamSim('step')}
              disabled={!hasCache}
              title={t('cam.simStep')}
              aria-label={t('cam.simStep')}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 bg-surface border border-panel-border rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <SkipForward size={11} />
            </button>
            <select
              id="cam-sim-speed"
              value={simSpeed}
              onChange={(e) => {
                const speed = Number(e.target.value);
                setSimSpeed(speed);
                dispatchCamSim('speed', undefined, undefined, speed);
              }}
              disabled={!hasCache}
              title={t('cam.simSpeed')}
              aria-label={t('cam.simSpeed')}
              className="w-14 px-1 py-1.5 bg-surface border border-panel-border rounded text-text-secondary text-xs disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {SIM_SPEEDS.map((v) => (
                <option key={v} value={v}>{v}×</option>
              ))}
            </select>
          </div>

            {operations.map((op, i) => {
              const cache = camToolpaths[op.id];
              // Enabled but uncached = the body was regenerated/deleted since
              // the toolpath was computed (ids rotate on recompute) — flag it
              // instead of silently showing "—".
              const stale = op.enabled && !cache;
              return (
                <div key={op.id} className="flex items-center gap-1.5 p-2 bg-surface rounded">
                  <input
                    type="checkbox"
                    checked={op.enabled}
                    onChange={(e) => updateCamOperation(op.id, { enabled: e.target.checked })}
                    aria-label={op.name}
                    className="accent-accent"
                  />
                  <span className={`flex-1 truncate ${op.enabled ? 'text-text-secondary' : 'text-text-muted line-through'}`} title={stale ? t('cam.stale') : op.name}>{op.name}</span>
                  <span
                    className={`text-text-muted shrink-0 ${stale ? 'text-warning italic' : ''}`}
                    title={stale ? t('cam.stale') : undefined}
                  >
                    {cache ? `${cache.timeMin.toFixed(1)} ${t('cam.minutes')}` : stale ? t('cam.stale') : '—'}
                  </span>
                  {/* Reorder (bounds-disabled), duplicate, edit — the G-code
                   * order follows this list. The pencil highlights the row an
                   * editing session is pinned to. */}
                  <button
                    onClick={() => moveCamOperation(op.id, -1)}
                    disabled={i === 0}
                    title={t('cam.moveUp')}
                    aria-label={`${t('cam.moveUp')} ${op.name}`}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    onClick={() => moveCamOperation(op.id, 1)}
                    disabled={i === operations.length - 1}
                    title={t('cam.moveDown')}
                    aria-label={`${t('cam.moveDown')} ${op.name}`}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    onClick={() => handleDuplicate(op.id)}
                    title={t('cam.duplicate')}
                    aria-label={`${t('cam.duplicate')} ${op.name}`}
                    className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-hover"
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    onClick={() => handleEdit(op)}
                    title={t('cam.edit')}
                    aria-label={`${t('cam.edit')} ${op.name}`}
                    className={`p-1 rounded hover:bg-surface-hover ${editingOp?.id === op.id ? 'text-accent' : 'text-text-muted hover:text-text-primary'}`}
                  >
                    <Pencil size={12} />
                  </button>
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

            {/* Machine profile + WCS + preview/export/setup-sheet. The WCS
             * checkbox rides the post-processor options (G54 work-offset
             * emission; off by default so legacy programs are unchanged). */}
            <div className="flex items-center gap-2">
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
              <label
                htmlFor="cam-wcs"
                title={t('cam.wcs')}
                className="flex items-center gap-1 px-2 py-1.5 text-text-secondary"
              >
                <input
                  id="cam-wcs"
                  type="checkbox"
                  checked={wcs}
                  onChange={(e) => setWcs(e.target.checked)}
                  className="accent-accent"
                />
                G54
              </label>
            </div>
            <div className="flex gap-2">
              <button
                id="cam-gcode-preview"
                onClick={handlePreviewGCode}
                disabled={!hasCache}
                title={t('cam.preview')}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-2 bg-surface border border-panel-border text-text-primary rounded hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Eye size={13} />
                {t('cam.preview')}
              </button>
              <button
                onClick={handleExportGCode}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2 bg-surface border border-panel-border text-text-primary rounded hover:bg-surface-hover transition-colors"
              >
                <Download size={14} />
                {t('cam.exportGCode')}
              </button>
              {/* Setup sheet works without any cached toolpath (uncached rows
               * degrade to "—" in the time column), so it stays enabled. */}
              <button
                id="cam-setup-sheet"
                onClick={handleSetupSheet}
                title={t('cam.setupSheet')}
                className="flex items-center justify-center gap-1.5 px-2 py-2 bg-surface border border-panel-border text-text-primary rounded hover:bg-surface-hover transition-colors"
              >
                <ClipboardList size={13} />
                {t('cam.setupSheet')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Preview modal as the panel root's last child: fixed-positioned to the
       * viewport (out of flow, so the scrolling column never clips or lays it
       * out) — the same overlay style as the global dialogs. */}
      {preview && (
        <GCodePreview
          gcode={preview.gcode}
          lineCount={preview.lineCount}
          sizeBytes={preview.sizeBytes}
          toolsUsed={preview.toolsUsed}
          feedRange={preview.feedRange}
          timeMin={totalTime}
          profile={machineProfile}
          onClose={() => setPreview(null)}
          onCopy={() => { void handleCopyPreview(); }}
          onDownload={() => { void handleDownloadPreview(); }}
        />
      )}

      {/* Setup sheet modal, same fixed-overlay pattern as the preview. */}
      {setupSheetHtml && (
        <SetupSheet
          html={setupSheetHtml}
          onClose={() => setSetupSheetHtml(null)}
        />
      )}
    </div>
  );
}
