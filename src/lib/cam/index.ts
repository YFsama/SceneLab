export type {
  ToolDefinition,
  CuttingTool,
  CAMParameters,
  Toolpath,
  ToolpathPoint,
  GCodeLine,
} from './types';
export {
  getAllTools,
  getTool,
  getCustomTools,
  clearCustomTools,
  addCustomTool,
  removeCustomTool,
} from './toolLibrary';
export {
  generatePocketToolpath,
  generateContourToolpath,
  generateDrillToolpath,
  generateFaceToolpath,
} from './toolpath';
export { generateEngraveToolpath } from './engrave';
export type { EngravePoint } from './engrave';
// Text→polyline source layer for engrave ops. The panel (the app layer's only
// legal import path is THIS index) bakes text via textToPolylines into
// CAMOperation.curves, so the textPath surface rides the same boundary.
export { textToPolylines, ENGRAVE_FONTS } from './textPath';
export type { EngraveTextPoint, TextToPolylinesOptions } from './textPath';
export {
  generateGCode,
  generateMultiToolGCode,
  estimateMachiningTime,
  estimateTime,
  programSafeZ,
} from './gcode';
export type { MachineProfile, GCodeOptions } from './gcode';
export { fitArcs } from './arcFit';
export type { ArcSpec } from './arcFit';
export { topSilhouette, offsetPolygon } from './silhouette';
export type { Point2, SilhouetteLoop, TopSilhouette } from './silhouette';
// Clipper-backed region offsetting (multi-loop, round/miter joins) — the
// robust replacement for single-loop offsetPolygon inside the generators.
export { offsetRegion } from './offsetRegion';
export type { RegionComponent, OffsetRegionOptions } from './offsetRegion';
// Adaptive (trochoidal) clearing planner — the pocketStrategy 'adaptive'
// geometry core, exported for direct testing/telemetry.
export { planAdaptiveClearing, minOrbitRadius } from './trochoid';
export type { AdaptiveClearingOptions, AdaptiveClearingPlan, AdaptiveEntryOrbit } from './trochoid';
export { generateOperationToolpath, defaultCamSetup } from './setup';
export type { CAMSetup, CAMOperation } from './setup';
export { computeFeedsAndSpeeds } from './feedsSpeeds';
export type { WorkMaterial, FeedsSpeeds, FeedsSpeedsOptions } from './feedsSpeeds';
export { detectCircularHoles } from '../geometry/query';
export { generateSetupSheetHtml } from './setupSheet';
export type { SetupSheetInput, SetupSheetOp } from './setupSheet';
