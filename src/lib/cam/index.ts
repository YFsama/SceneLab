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
export {
  generateGCode,
  generateMultiToolGCode,
  estimateMachiningTime,
  estimateTime,
} from './gcode';
export type { MachineProfile } from './gcode';
export { topSilhouette, offsetPolygon } from './silhouette';
export type { Point2, SilhouetteLoop, TopSilhouette } from './silhouette';
export { generateOperationToolpath, defaultCamSetup } from './setup';
export type { CAMSetup, CAMOperation } from './setup';
export { computeFeedsAndSpeeds } from './feedsSpeeds';
export type { WorkMaterial, FeedsSpeeds, FeedsSpeedsOptions } from './feedsSpeeds';
export { detectCircularHoles } from '../geometry/query';
