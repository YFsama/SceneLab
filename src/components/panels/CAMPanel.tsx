import { useState, useMemo } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { showToast } from '../../lib/toast';
import { downloadFile } from '../../lib/io/studio3d';
import {
  getAllTools,
  generatePocketToolpath,
  generateContourToolpath,
  generateDrillToolpath,
  generateFaceToolpath,
  generateGCode,
  generateMultiToolGCode,
  estimateMachiningTime,
  computeFeedsAndSpeeds,
} from '../../lib/cam';
import type { CAMParameters, Toolpath, WorkMaterial } from '../../lib/cam';
import { Cog, Play, Download, Clock, Wrench, Gauge } from 'lucide-react';

const WORK_MATERIALS: WorkMaterial[] = [
  'aluminum', 'brass', 'softwood', 'hardwood', 'mdf', 'acrylic', 'steel', 'pcb',
];

const defaultParams: CAMParameters = {
  feedRate: 1000,
  plungeRate: 300,
  spindleSpeed: 10000,
  depthOfCut: 2,
  stepover: 3,
  stockTop: 0,
  stockBottom: -10,
};

export function CAMPanel() {
  const { t } = useT();
  const bodies = useStore((s) => s.bodies);
  const [selectedTool, setSelectedTool] = useState<string>('em-6mm');
  const [operation, setOperation] = useState<'pocket' | 'contour' | 'drill' | 'face'>('pocket');
  const [params, setParams] = useState<CAMParameters>(defaultParams);
  const [toolpaths, setToolpaths] = useState<Toolpath[]>([]);
  const [workMaterial, setWorkMaterial] = useState<WorkMaterial>('aluminum');

  const tools = useMemo(() => getAllTools(), []);
  const activeTool = tools.find((t) => t.id === selectedTool);
  const suggestedFeeds = useMemo(
    () => (activeTool ? computeFeedsAndSpeeds(activeTool, workMaterial) : null),
    [activeTool, workMaterial],
  );

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
    if (bodies.length === 0) {
      showToast(t('toast.noBodies'), 'warning');
      return;
    }

    const body = bodies[0]!;
    let tp: Toolpath;

    // Compute bounds
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const v of body.vertices) {
      minX = Math.min(minX, v.x);
      minY = Math.min(minY, v.y);
      minZ = Math.min(minZ, v.z);
      maxX = Math.max(maxX, v.x);
      maxY = Math.max(maxY, v.y);
      maxZ = Math.max(maxZ, v.z);
    }

    const bounds = {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ },
    };

    switch (operation) {
      case 'pocket':
        tp = generatePocketToolpath(bounds, activeTool, params);
        break;
      case 'contour':
        tp = generateContourToolpath(body, activeTool, params);
        break;
      case 'drill':
        tp = generateDrillToolpath(
          [{ x: (minX + maxX) / 2, y: (minY + maxY) / 2, depth: 10 }],
          activeTool,
          params,
        );
        break;
      case 'face':
        tp = generateFaceToolpath(bounds, activeTool, params);
        break;
    }

    setToolpaths((prev) => [...prev, tp]);
    showToast(`Generated ${operation} toolpath`, 'success');
  };

  const handleExportGCode = () => {
    if (toolpaths.length === 0) {
      showToast('No toolpaths to export', 'warning');
      return;
    }
    const gcode = toolpaths.length === 1
      ? generateGCode(toolpaths[0]!)
      : generateMultiToolGCode(toolpaths);
    downloadFile(gcode, 'toolpath.nc');
    showToast('G-code exported', 'success');
  };

  const totalTime = useMemo(
    () => toolpaths.reduce((sum, tp) => sum + estimateMachiningTime(tp), 0),
    [toolpaths],
  );

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

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent text-white rounded hover:bg-accent-hover transition-colors"
        >
          <Play size={14} />
          {t('cam.generate')}
        </button>

        {/* Toolpaths list */}
        {toolpaths.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-text-muted">{t('cam.toolpaths')}</span>
              <div className="flex items-center gap-1 text-text-muted">
                <Clock size={12} />
                <span>{totalTime.toFixed(1)} min</span>
              </div>
            </div>

            {toolpaths.map((tp) => (
              <div key={tp.id} className="flex items-center gap-2 p-2 bg-surface rounded">
                <Wrench size={12} className="text-text-muted" />
                <span className="flex-1 text-text-secondary">{tp.name}</span>
                <span className="text-text-muted">{estimateMachiningTime(tp).toFixed(1)}m</span>
              </div>
            ))}

            <button
              onClick={handleExportGCode}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-surface border border-panel-border text-text-primary rounded hover:bg-surface-hover transition-colors"
            >
              <Download size={14} />
              {t('cam.exportGCode')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
