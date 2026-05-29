import { useState } from 'react';
import { useStore } from '../../store/app';
import { useT } from '../../lib/i18n';
import { Settings, Box, Ruler, Beaker, Weight, Layers, RulerIcon, Move, BarChart, Network, Maximize, Shield, Torus, Gauge, Crosshair, RefreshCw, GitBranch, Hash, TrendingUp, CornerDownRight, AlertTriangle, Zap, ArrowUpDown, Triangle, CheckCircle, Activity, Proportions, Ratio, Shapes, Minus, Diamond, Orbit, FlipHorizontal, Circle, ArrowRight, Pentagon, Hexagon, Waves, Columns, Anchor, Percent, Sliders, ArrowDownUp, Grid3X3, Network as NetworkIcon, Sigma, AreaChart, Target, Compass, Navigation, TrendingDown, Waypoints, BoxSelect, Layers as LayersIcon, MapPin, GitCommit, GitBranch as GitBranchIcon, GitMerge, GitPullRequest, Spline, Crosshair as CrosshairIcon, Ruler as RulerIcon2, CircleDot, Waypoints as WaypointsIcon, ArrowUpRight, TrendingUp as TrendingUpIcon, Waves as WavesIcon, Move as MoveIcon, Layers as LayersIcon2, Waypoints as WaypointsIcon2, Circle as CircleIcon, ArrowDown as ArrowDownIcon, ArrowRight as ArrowRightIcon, Spline as SplineIcon, Move as MoveIcon2, Square as SquareIcon, Diamond as DiamondIcon, CornerDownLeft, Move as MoveIcon3, ArrowRightLeft, Spline as SplineIcon2, Move as MoveIcon4, Square as SquareIcon2, Diamond as DiamondIcon2, Triangle as TriangleIcon, ArrowDown as ArrowDownIcon2, ArrowRightLeft as ArrowRightLeftIcon, Spline as SplineIcon3, Move as MoveIcon5, Square as SquareIcon3, Diamond as DiamondIcon3, Triangle as TriangleIcon2, ArrowDown as ArrowDownIcon3, ArrowRightLeft as ArrowRightLeftIcon2, Spline as SplineIcon4, Move as MoveIcon6, Square as SquareIcon4, Diamond as DiamondIcon4, Triangle as TriangleIcon3, ArrowDown as ArrowDownIcon4, ArrowRightLeft as ArrowRightLeftIcon3, Spline as SplineIcon5 } from 'lucide-react';
import { analyzeOverhangs, analyzeStability, recommendOrientation, estimatePrintJob, estimateSupportVolume } from '../../lib/print';
import { computeBoundingBox, computeBoundingBoxCenter, computeCentroid, computeVolume, computeSurfaceArea, computeTotalEdgeLength, computeBoundingBoxDiagonal, computeMeshStatistics, computeAverageVertexDegree, computeLargestFace, checkManifold, computeTopology, computeMeshQuality, checkWindingOrder, computeAdjacency, computeValenceDistribution, computeCurvature, computeDihedralAngles, computeWorstFaceAspectRatio, computeMaxEdgeCurvature, checkNormalConsistency, computeEdgeAngleDistribution, computeRegularFaceCount, computeEdgeLengthDistribution, computeFaceAngleDistribution, computeEdgeLengthRatio, computeFaceTypeCount, computeEdgeTypeCount, computeVertexTypeCount, computeMeshGenus, computeSymmetry, computeCompactness, computeElongation, computeConvexity, computeSolidity, computeRoughness, computeThickness, computeCenterOfMassOffset, computeVolumeRatios, computeAspectRatioDistribution, computeSkewnessDistribution, computeFaceEdgeCountDistribution, computeVertexValenceDistribution, computeEdgeLengthStatistics, computeFaceAreaStatistics, computeVertexDistanceStatistics, computeEdgeAngleStatistics, computeFaceNormalStatistics, computeEdgeNormalStatistics, computeEdgeDihedralStatistics, computeEdgeLengthPercentiles, computeFaceAreaPercentiles, computeVertexDistancePercentiles, computeEdgeDihedralPercentiles, computeEdgeAnglePercentiles, computeFaceNormalPercentiles, computeEdgeTangentPercentiles, computeEdgeCurvaturePercentiles, computeVertexValencePercentiles } from '../../lib/geometry/brep';

const materials: Record<string, { name: string; density: number }> = {
  steel: { name: 'Steel', density: 7.85 },
  aluminum: { name: 'Aluminum', density: 2.70 },
  copper: { name: 'Copper', density: 8.96 },
  titanium: { name: 'Titanium', density: 4.51 },
  abs: { name: 'ABS', density: 1.04 },
  pla: { name: 'PLA', density: 1.24 },
  nylon: { name: 'Nylon', density: 1.14 },
  wood: { name: 'Wood (Oak)', density: 0.75 },
};

export function PropertiesPanel() {
  const { t } = useT();
  const selectedIds = useStore((s) => s.selectedIds);
  const bodies = useStore((s) => s.bodies);
  const [material, setMaterial] = useState('steel');

  const selectedBody = selectedIds.length === 1
    ? bodies.find((b) => b.id === selectedIds[0])
    : undefined;

  return (
    <aside
      className="w-60 bg-panel border-l border-panel-border flex flex-col"
      role="complementary"
      aria-label={t('panel.properties')}
    >
      <div className="px-3 py-2 border-b border-panel-border flex items-center gap-2">
        <Settings size={16} className="text-text-muted" />
        <h2 className="text-sm font-semibold text-text-primary">{t('panel.properties')}</h2>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {selectedIds.length === 0 ? (
          <p className="text-xs text-text-muted">{t('panel.selectObject')}</p>
        ) : selectedBody ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Box size={14} className="text-accent" />
              <span className="text-sm font-medium text-text-primary">{selectedBody.name}</span>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Ruler size={12} />
                <span>{t('panel.dimensions')}</span>
              </div>
              {(() => {
                const bb = computeBoundingBox(selectedBody);
                const dx = (bb.max.x - bb.min.x).toFixed(2);
                const dy = (bb.max.y - bb.min.y).toFixed(2);
                const dz = (bb.max.z - bb.min.z).toFixed(2);
                const diag = computeBoundingBoxDiagonal(selectedBody).toFixed(2);
                const center = computeBoundingBoxCenter(selectedBody);
                const centroid = computeCentroid(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>X: {dx} mm</p>
                    <p>Y: {dy} mm</p>
                    <p>Z: {dz} mm</p>
                    <p className="flex items-center gap-1">
                      <Move size={10} />
                      {t('panel.diagonal')}: {diag} mm
                    </p>
                    <p className="flex items-center gap-1">
                      <Crosshair size={10} />
                      {t('panel.center')}: ({center.x.toFixed(2)}, {center.y.toFixed(2)}, {center.z.toFixed(2)})
                    </p>
                    <p className="flex items-center gap-1">
                      <Crosshair size={10} />
                      {t('panel.centroid')}: ({centroid.x.toFixed(2)}, {centroid.y.toFixed(2)}, {centroid.z.toFixed(2)})
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Beaker size={12} />
                <span>{t('panel.volume')}</span>
              </div>
              <div className="pl-4 text-xs text-text-secondary">
                <p>{computeVolume(selectedBody).toFixed(2)} mm³</p>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Layers size={12} />
                <span>{t('panel.surfaceArea')}</span>
              </div>
              <div className="pl-4 text-xs text-text-secondary">
                <p>{computeSurfaceArea(selectedBody).toFixed(2)} mm²</p>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <RulerIcon size={12} />
                <span>{t('panel.totalEdgeLength')}</span>
              </div>
              <div className="pl-4 text-xs text-text-secondary">
                <p>{computeTotalEdgeLength(selectedBody).toFixed(2)} mm</p>
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Weight size={12} />
                <span>{t('panel.mass')}</span>
              </div>
              <div className="pl-4 space-y-1">
                <select
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                  className="w-full px-1.5 py-0.5 text-xs bg-surface border border-panel-border rounded text-text-primary"
                  aria-label={t('panel.material')}
                >
                  {Object.entries(materials).map(([key, mat]) => (
                    <option key={key} value={key}>{mat.name} ({mat.density} g/cm³)</option>
                  ))}
                </select>
                {(() => {
                  const volume = computeVolume(selectedBody);
                  const density = materials[material]?.density ?? 7.85;
                  const mass = (volume / 1000) * density; // mm³ to cm³, then * density
                  return (
                    <p className="text-xs text-text-secondary">
                      {mass.toFixed(2)} g ({(mass / 1000).toFixed(4)} kg)
                    </p>
                  );
                })()}
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Box size={12} />
                <span>{t('panel.printAnalysis')}</span>
              </div>
              {(() => {
                const oh = analyzeOverhangs(selectedBody);
                const st = analyzeStability(selectedBody);
                const orient = recommendOrientation(selectedBody);
                const job = estimatePrintJob(selectedBody, { material: 'PLA' });
                const support = estimateSupportVolume(selectedBody);
                const supportFaces = oh.faces.filter((f) => f.needsSupport).length;
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p className="flex items-center gap-1">
                      <AlertTriangle size={10} />
                      {t('panel.needsSupport')}: {supportFaces} {`(< ${oh.thresholdDeg}°)`}
                    </p>
                    <p>{t('panel.overhangArea')}: {oh.overhangArea.toFixed(2)} mm²</p>
                    <p>{t('panel.supportVolume')}: {(support.supportVolumeMm3 / 1000).toFixed(2)} cm³</p>
                    <p className="flex items-center gap-1">
                      <Compass size={10} />
                      {t('panel.bestOrientation')}: {orient.best.label}
                    </p>
                    <p className="flex items-center gap-1">
                      <Anchor size={10} />
                      <span className={st.stable ? 'text-success' : 'text-warning'}>
                        {st.stable ? t('panel.stable') : t('panel.unstable')}
                      </span>
                    </p>
                    <p>{t('panel.tipMargin')}: {st.marginMm.toFixed(2)} mm</p>
                    <p>{t('panel.footprint')}: {st.footprintArea.toFixed(2)} mm²</p>
                    <p>{t('panel.filament')}: {job.filamentLengthM.toFixed(2)} m / {job.filamentMassG.toFixed(1)} g (PLA)</p>
                    <p>{t('panel.printTime')}: ~{job.printTimeMinutes.toFixed(0)} min</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <BarChart size={12} />
                <span>{t('panel.stats')}</span>
              </div>
              {(() => {
                const stats = computeMeshStatistics(selectedBody);
                const avgDegree = computeAverageVertexDegree(selectedBody);
                const largestFace = computeLargestFace(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.vertices')}: {stats.vertexCount}</p>
                    <p>{t('panel.faces')}: {stats.faceCount} ({stats.triangleCount} triangles)</p>
                    <p>{t('panel.edges')}: {stats.edgeCount}</p>
                    <p>{t('panel.avgEdgeLength')}: {stats.averageEdgeLength.toFixed(2)} mm</p>
                    <p className="flex items-center gap-1">
                      <Network size={10} />
                      {t('panel.avgVertexDegree')}: {avgDegree.toFixed(1)}
                    </p>
                    {largestFace && (
                      <p className="flex items-center gap-1">
                        <Maximize size={10} />
                        {t('panel.largestFace')}: {largestFace.area.toFixed(2)} mm²
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Shield size={12} />
                <span>{t('panel.manifold')}</span>
              </div>
              {(() => {
                const manifold = checkManifold(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p className={manifold.isManifold ? 'text-success' : 'text-warning'}>
                      {manifold.isManifold ? t('panel.watertight') : t('panel.notWatertight')}
                    </p>
                    <p>{t('panel.boundaryEdges')}: {manifold.boundaryEdges}</p>
                    <p>{t('panel.nonManifoldEdges')}: {manifold.nonManifoldEdges}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <RefreshCw size={12} />
                <span>{t('panel.windingOrder')}</span>
              </div>
              {(() => {
                const winding = checkWindingOrder(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p className={winding.consistentWinding ? 'text-success' : 'text-warning'}>
                      {winding.consistentWinding ? t('panel.consistentWinding') : t('panel.inconsistentWinding')}
                    </p>
                    <p>CW: {winding.clockwiseFaces} | CCW: {winding.counterClockwiseFaces}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowUpDown size={12} />
                <span>{t('panel.normalConsistency')}</span>
              </div>
              {(() => {
                const normals = checkNormalConsistency(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p className={normals.consistent ? 'text-success' : 'text-warning'}>
                      {normals.consistent ? t('panel.consistentNormals') : t('panel.inconsistentNormals')}
                    </p>
                    <p>{t('panel.outward')}: {normals.outwardFaces} | {t('panel.inward')}: {normals.inwardFaces}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Triangle size={12} />
                <span>{t('panel.edgeAngles')}</span>
              </div>
              {(() => {
                const angles = computeEdgeAngleDistribution(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minAngle')}: {angles.minAngle.toFixed(1)}° | {t('panel.maxAngle')}: {angles.maxAngle.toFixed(1)}°</p>
                    <p>{t('panel.avgAngle')}: {angles.avgAngle.toFixed(1)}°</p>
                    <p>{t('panel.acute')}: {angles.acuteEdges} | {t('panel.right')}: {angles.rightEdges} | {t('panel.obtuse')}: {angles.obtuseEdges}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <CheckCircle size={12} />
                <span>{t('panel.faceRegularity')}</span>
              </div>
              {(() => {
                const regularCount = computeRegularFaceCount(selectedBody);
                const totalFaces = selectedBody.faces.length;
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.regularFaces')}: {regularCount} / {totalFaces}</p>
                    <p>{t('panel.regularity')}: {totalFaces > 0 ? ((regularCount / totalFaces) * 100).toFixed(1) : 0}%</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Activity size={12} />
                <span>{t('panel.edgeLengthDist')}</span>
              </div>
              {(() => {
                const dist = computeEdgeLengthDistribution(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minLength')}: {dist.minLength.toFixed(2)} | {t('panel.maxLength')}: {dist.maxLength.toFixed(2)}</p>
                    <p>{t('panel.avgLength')}: {dist.avgLength.toFixed(2)} | {t('panel.median')}: {dist.medianLength.toFixed(2)}</p>
                    <p>{t('panel.stdDev')}: {dist.stdDeviation.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Ratio size={12} />
                <span>{t('panel.edgeLengthRatio')}</span>
              </div>
              {(() => {
                const ratio = computeEdgeLengthRatio(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.ratio')}: {ratio.ratio.toFixed(3)}</p>
                    <p>{t('panel.variation')}: {(ratio.normalizedRatio * 100).toFixed(1)}%</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <GitBranch size={12} />
                <span>{t('panel.adjacency')}</span>
              </div>
              {(() => {
                const adj = computeAdjacency(selectedBody);
                const avgVertexEdges = adj.vertexToEdges.size > 0
                  ? Array.from(adj.vertexToEdges.values()).reduce((s, a) => s + a.length, 0) / adj.vertexToEdges.size
                  : 0;
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.vertexEdgeAdj')}: {avgVertexEdges.toFixed(1)}</p>
                    <p>{t('panel.edgeFaceAdj')}: {adj.edgeToFaces.size}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Shapes size={12} />
                <span>{t('panel.faceTypes')}</span>
              </div>
              {(() => {
                const faceTypes = computeFaceTypeCount(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.triangles')}: {faceTypes.triangles} | {t('panel.quads')}: {faceTypes.quads}</p>
                    <p>{t('panel.pentagons')}: {faceTypes.pentagons} | {t('panel.hexagons')}: {faceTypes.hexagons}</p>
                    {faceTypes.other > 0 && <p>{t('panel.other')}: {faceTypes.other}</p>}
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Minus size={12} />
                <span>{t('panel.edgeTypes')}</span>
              </div>
              {(() => {
                const edgeTypes = computeEdgeTypeCount(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.boundary')}: {edgeTypes.boundary} | {t('panel.interior')}: {edgeTypes.interior}</p>
                    <p>{t('panel.smooth')}: {edgeTypes.smooth} | {t('panel.sharp')}: {edgeTypes.sharp}</p>
                    {edgeTypes.nonManifold > 0 && <p>{t('panel.nonManifold')}: {edgeTypes.nonManifold}</p>}
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Diamond size={12} />
                <span>{t('panel.vertexTypes')}</span>
              </div>
              {(() => {
                const vertexTypes = computeVertexTypeCount(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.regular')}: {vertexTypes.regular} | {t('panel.irregular')}: {vertexTypes.irregular}</p>
                    <p>{t('panel.corner')}: {vertexTypes.corner} | {t('panel.dart')}: {vertexTypes.dart} | {t('panel.crease')}: {vertexTypes.crease}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Proportions size={12} />
                <span>{t('panel.faceAngles')}</span>
              </div>
              {(() => {
                const faceAngles = computeFaceAngleDistribution(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minAngle')}: {faceAngles.minAngle.toFixed(1)}° | {t('panel.maxAngle')}: {faceAngles.maxAngle.toFixed(1)}°</p>
                    <p>{t('panel.avgAngle')}: {faceAngles.avgAngle.toFixed(1)}°</p>
                    <p>{t('panel.acute')}: {faceAngles.acuteFaces} | {t('panel.right')}: {faceAngles.rightFaces} | {t('panel.obtuse')}: {faceAngles.obtuseFaces}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Hash size={12} />
                <span>{t('panel.valence')}</span>
              </div>
              {(() => {
                const val = computeValenceDistribution(selectedBody);
                const histEntries = Array.from(val.valenceHistogram.entries()).sort((a, b) => a[0] - b[0]);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minValence')}: {val.minValence} | {t('panel.maxValence')}: {val.maxValence}</p>
                    <p>{t('panel.avgValence')}: {val.avgValence.toFixed(1)}</p>
                    <p className="font-mono text-[10px]">
                      {histEntries.map(([v, c]) => `${v}:${c}`).join(' ')}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Orbit size={12} />
                <span>{t('panel.genus')}</span>
              </div>
              {(() => {
                const genus = computeMeshGenus(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.genus')}: {genus.genus}</p>
                    <p>{t('panel.handles')}: {genus.handles}</p>
                    <p>{t('panel.orientable')}: {genus.isOrientable ? t('panel.yes') : t('panel.no')}</p>
                    {!genus.isOrientable && <p>{t('panel.crossCaps')}: {genus.crossCaps}</p>}
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <FlipHorizontal size={12} />
                <span>{t('panel.symmetry')}</span>
              </div>
              {(() => {
                const sym = computeSymmetry(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>X: {sym.hasXSymmetry ? '✓' : '✗'} | Y: {sym.hasYSymmetry ? '✓' : '✗'} | Z: {sym.hasZSymmetry ? '✓' : '✗'}</p>
                    <p>{t('panel.symmetryScore')}: {(sym.symmetryScore * 100).toFixed(0)}%</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <TrendingUp size={12} />
                <span>{t('panel.curvature')}</span>
              </div>
              {(() => {
                const curv = computeCurvature(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.gaussianCurvature')}: {curv.gaussianCurvatureAvg.toFixed(4)}</p>
                    <p>{t('panel.minCurvature')}: {curv.gaussianCurvatureMin.toFixed(4)}</p>
                    <p>{t('panel.maxCurvature')}: {curv.gaussianCurvatureMax.toFixed(4)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Circle size={12} />
                <span>{t('panel.compactness')}</span>
              </div>
              {(() => {
                const compact = computeCompactness(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.compactness')}: {compact.compactness.toFixed(4)}</p>
                    <p>{t('panel.sphericity')}: {compact.sphericity.toFixed(4)}</p>
                    <p>{t('panel.efficiency')}: {compact.efficiency.toFixed(4)}</p>
                    <p className={compact.isCompact ? 'text-success' : 'text-warning'}>
                      {compact.isCompact ? t('panel.compact') : t('panel.notCompact')}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowRight size={12} />
                <span>{t('panel.elongation')}</span>
              </div>
              {(() => {
                const elong = computeElongation(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.elongation')}: {elong.elongation.toFixed(2)}</p>
                    <p>{t('panel.flatness')}: {elong.flatness.toFixed(2)}</p>
                    <p className={elong.isElongated ? 'text-warning' : 'text-success'}>
                      {elong.isElongated ? t('panel.elongated') : t('panel.notElongated')}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Pentagon size={12} />
                <span>{t('panel.convexity')}</span>
              </div>
              {(() => {
                const convex = computeConvexity(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.convexity')}: {convex.convexity.toFixed(4)}</p>
                    <p>{t('panel.concavity')}: {convex.concavity.toFixed(4)}</p>
                    <p className={convex.isConvex ? 'text-success' : 'text-warning'}>
                      {convex.isConvex ? t('panel.convex') : t('panel.notConvex')}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Hexagon size={12} />
                <span>{t('panel.solidity')}</span>
              </div>
              {(() => {
                const solid = computeSolidity(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.solidity')}: {solid.solidity.toFixed(4)}</p>
                    <p>{t('panel.voidRatio')}: {solid.voidRatio.toFixed(4)}</p>
                    <p className={solid.isSolid ? 'text-success' : 'text-warning'}>
                      {solid.isSolid ? t('panel.solid') : t('panel.notSolid')}
                    </p>
                    {solid.internalCavities > 0 && (
                      <p>{t('panel.cavities')}: {solid.internalCavities}</p>
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <CornerDownRight size={12} />
                <span>{t('panel.dihedral')}</span>
              </div>
              {(() => {
                const dihedral = computeDihedralAngles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minDihedral')}: {dihedral.minDihedral.toFixed(1)}°</p>
                    <p>{t('panel.maxDihedral')}: {dihedral.maxDihedral.toFixed(1)}°</p>
                    <p>{t('panel.avgDihedral')}: {dihedral.avgDihedral.toFixed(1)}°</p>
                    <p>{t('panel.sharpEdges')}: {dihedral.sharpEdges}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Waves size={12} />
                <span>{t('panel.roughness')}</span>
              </div>
              {(() => {
                const rough = computeRoughness(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.roughness')}: {rough.roughness.toFixed(4)}</p>
                    <p>{t('panel.smoothness')}: {rough.smoothness.toFixed(4)}</p>
                    <p className={rough.isSmooth ? 'text-success' : 'text-warning'}>
                      {rough.isSmooth ? t('panel.smooth') : t('panel.rough')}
                    </p>
                    <p>{t('panel.roughFaces')}: {rough.roughFaces} | {t('panel.smoothFaces')}: {rough.smoothFaces}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Columns size={12} />
                <span>{t('panel.thickness')}</span>
              </div>
              {(() => {
                const thick = computeThickness(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minThickness')}: {thick.minThickness.toFixed(2)} mm</p>
                    <p>{t('panel.maxThickness')}: {thick.maxThickness.toFixed(2)} mm</p>
                    <p>{t('panel.avgThickness')}: {thick.avgThickness.toFixed(2)} mm</p>
                    <p className={thick.isThin ? 'text-warning' : 'text-success'}>
                      {thick.isThin ? t('panel.thin') : t('panel.notThin')}
                    </p>
                    {thick.thinRegions > 0 && (
                      <p>{t('panel.thinRegions')}: {thick.thinRegions}</p>
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Torus size={12} />
                <span>{t('panel.topology')}</span>
              </div>
              {(() => {
                const topo = computeTopology(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.eulerCharacteristic')}: {topo.eulerCharacteristic}</p>
                    <p>{t('panel.genus')}: {topo.genus}</p>
                    <p>{topo.isSphereLike ? t('panel.sphereLike') : t('panel.notSphereLike')}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Anchor size={12} />
                <span>{t('panel.centerOfMass')}</span>
              </div>
              {(() => {
                const com = computeCenterOfMassOffset(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.offset')}: {com.offsetDistance.toFixed(3)} mm</p>
                    <p>({com.offset.x.toFixed(2)}, {com.offset.y.toFixed(2)}, {com.offset.z.toFixed(2)})</p>
                    <p className={com.isCentered ? 'text-success' : 'text-warning'}>
                      {com.isCentered ? t('panel.centered') : t('panel.offCenter')}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Percent size={12} />
                <span>{t('panel.volumeRatios')}</span>
              </div>
              {(() => {
                const ratios = computeVolumeRatios(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.volToSurface')}: {ratios.volumeToSurfaceRatio.toFixed(4)}</p>
                    <p>{t('panel.volToBB')}: {(ratios.volumeToBoundingBoxRatio * 100).toFixed(1)}%</p>
                    <p className={ratios.isVolumetricallyEfficient ? 'text-success' : 'text-warning'}>
                      {ratios.isVolumetricallyEfficient ? t('panel.efficient') : t('panel.inefficient')}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Sliders size={12} />
                <span>{t('panel.arDistribution')}</span>
              </div>
              {(() => {
                const arDist = computeAspectRatioDistribution(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minAR')}: {arDist.minAspectRatio.toFixed(2)} | {t('panel.maxAR')}: {arDist.maxAspectRatio.toFixed(2)}</p>
                    <p>{t('panel.avgAR')}: {arDist.avgAspectRatio.toFixed(2)} | {t('panel.stdDev')}: {arDist.stdDeviation.toFixed(3)}</p>
                    <p>{t('panel.good')}: {arDist.goodAspectRatioFaces} | {t('panel.poor')}: {arDist.poorAspectRatioFaces}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowDownUp size={12} />
                <span>{t('panel.skewnessDist')}</span>
              </div>
              {(() => {
                const skewDist = computeSkewnessDistribution(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minSkew')}: {skewDist.minSkewness.toFixed(3)} | {t('panel.maxSkew')}: {skewDist.maxSkewness.toFixed(3)}</p>
                    <p>{t('panel.avgSkew')}: {skewDist.avgSkewness.toFixed(3)} | {t('panel.stdDev')}: {skewDist.stdDeviation.toFixed(3)}</p>
                    <p>{t('panel.good')}: {skewDist.goodSkewnessFaces} | {t('panel.poor')}: {skewDist.poorSkewnessFaces}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Gauge size={12} />
                <span>{t('panel.meshQuality')}</span>
              </div>
              {(() => {
                const quality = computeMeshQuality(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.aspectRatio')}: {quality.aspectRatioAvg.toFixed(2)} (max: {quality.aspectRatioMax.toFixed(2)})</p>
                    <p>{t('panel.skewness')}: {quality.skewnessAvg.toFixed(3)} (max: {quality.skewnessMax.toFixed(3)})</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Grid3X3 size={12} />
                <span>{t('panel.faceEdgeCount')}</span>
              </div>
              {(() => {
                const edgeCount = computeFaceEdgeCountDistribution(selectedBody);
                const histEntries = Array.from(edgeCount.histogram.entries()).sort((a, b) => a[0] - b[0]);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minEdges')}: {edgeCount.minEdges} | {t('panel.maxEdges')}: {edgeCount.maxEdges}</p>
                    <p>{t('panel.avgEdges')}: {edgeCount.avgEdges.toFixed(1)} | {t('panel.mode')}: {edgeCount.modeEdges}</p>
                    <p className="font-mono text-[10px]">
                      {histEntries.map(([n, c]) => `${n}:${c}`).join(' ')}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <NetworkIcon size={12} />
                <span>{t('panel.vertexValence')}</span>
              </div>
              {(() => {
                const valDist = computeVertexValenceDistribution(selectedBody);
                const histEntries = Array.from(valDist.histogram.entries()).sort((a, b) => a[0] - b[0]);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minValence')}: {valDist.minValence} | {t('panel.maxValence')}: {valDist.maxValence}</p>
                    <p>{t('panel.avgValence')}: {valDist.avgValence.toFixed(1)} | {t('panel.mode')}: {valDist.modeValence}</p>
                    <p>{t('panel.regular')}: {valDist.regularVertices} | {t('panel.irregular')}: {valDist.irregularVertices}</p>
                    <p className="font-mono text-[10px]">
                      {histEntries.map(([v, c]) => `${v}:${c}`).join(' ')}
                    </p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <AlertTriangle size={12} />
                <span>{t('panel.worstFaceAR')}</span>
              </div>
              {(() => {
                const worst = computeWorstFaceAspectRatio(selectedBody);
                if (!worst) return null;
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.aspectRatio')}: {worst.aspectRatio.toFixed(2)}</p>
                    <p>{t('panel.perimeter')}: {worst.perimeter.toFixed(2)} mm</p>
                    <p>{t('panel.area')}: {worst.area.toFixed(2)} mm²</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Sigma size={12} />
                <span>{t('panel.edgeLengthStats')}</span>
              </div>
              {(() => {
                const stats = computeEdgeLengthStatistics(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.median')}: {stats.medianLength.toFixed(2)} mm</p>
                    <p>Q1: {stats.q1Length.toFixed(2)} | Q3: {stats.q3Length.toFixed(2)} | IQR: {stats.iqrLength.toFixed(2)}</p>
                    <p>{t('panel.outliers')}: {stats.outlierCount}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <AreaChart size={12} />
                <span>{t('panel.faceAreaStats')}</span>
              </div>
              {(() => {
                const areaStats = computeFaceAreaStatistics(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minArea')}: {areaStats.minArea.toFixed(2)} | {t('panel.maxArea')}: {areaStats.maxArea.toFixed(2)}</p>
                    <p>{t('panel.avgArea')}: {areaStats.avgArea.toFixed(2)} | {t('panel.median')}: {areaStats.medianArea.toFixed(2)}</p>
                    <p>{t('panel.totalArea')}: {areaStats.totalArea.toFixed(2)} mm²</p>
                    <p>{t('panel.smallFaces')}: {areaStats.smallFaces} | {t('panel.largeFaces')}: {areaStats.largeFaces}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Zap size={12} />
                <span>{t('panel.edgeCurvature')}</span>
              </div>
              {(() => {
                const maxCurv = computeMaxEdgeCurvature(selectedBody);
                if (!maxCurv) return null;
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.maxEdgeCurvature')}: {maxCurv.curvature.toFixed(4)}</p>
                    <p>{t('panel.edgeLength')}: {maxCurv.length.toFixed(2)} mm</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Target size={12} />
                <span>{t('panel.vertexDistances')}</span>
              </div>
              {(() => {
                const vDist = computeVertexDistanceStatistics(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minDist')}: {vDist.minDistance.toFixed(2)} | {t('panel.maxDist')}: {vDist.maxDistance.toFixed(2)}</p>
                    <p>{t('panel.avgDist')}: {vDist.avgDistance.toFixed(2)} | {t('panel.median')}: {vDist.medianDistance.toFixed(2)}</p>
                    <p>{t('panel.closeVertices')}: {vDist.closeVertices} | {t('panel.farVertices')}: {vDist.farVertices}</p>
                  </div>
                );
              })()}
            </div>

            {selectedBody.faces.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs text-text-muted">{t('panel.firstFaceNormal')}</p>
                {(() => {
                  const normal = selectedBody.faces[0]?.normal;
                  if (!normal) return null;
                  return (
                    <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                      <p>X: {normal.x.toFixed(3)}</p>
                      <p>Y: {normal.y.toFixed(3)}</p>
                      <p>Z: {normal.z.toFixed(3)}</p>
                    </div>
                  );
                })()}
              </div>
            )}

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Compass size={12} />
                <span>{t('panel.edgeAngleStats')}</span>
              </div>
              {(() => {
                const angleStats = computeEdgeAngleStatistics(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minAngle')}: {angleStats.minAngle.toFixed(1)}° | {t('panel.maxAngle')}: {angleStats.maxAngle.toFixed(1)}°</p>
                    <p>{t('panel.avgAngle')}: {angleStats.avgAngle.toFixed(1)}° | {t('panel.median')}: {angleStats.medianAngle.toFixed(1)}°</p>
                    <p>{t('panel.acute')}: {angleStats.acuteEdges} | {t('panel.right')}: {angleStats.rightEdges} | {t('panel.obtuse')}: {angleStats.obtuseEdges} | {t('panel.straight')}: {angleStats.straightEdges}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Navigation size={12} />
                <span>{t('panel.faceNormalStats')}</span>
              </div>
              {(() => {
                const normalStats = computeFaceNormalStatistics(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.avgNormal')}: ({normalStats.avgNormalX.toFixed(3)}, {normalStats.avgNormalY.toFixed(3)}, {normalStats.avgNormalZ.toFixed(3)})</p>
                    <p>{t('panel.normalVariance')}: {normalStats.normalVariance.toFixed(4)}</p>
                    <p>{t('panel.upward')}: {normalStats.upwardFaces} | {t('panel.downward')}: {normalStats.downwardFaces} | {t('panel.lateral')}: {normalStats.lateralFaces}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <TrendingDown size={12} />
                <span>{t('panel.edgeNormalStats')}</span>
              </div>
              {(() => {
                const edgeStats = computeEdgeNormalStatistics(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.avgTangent')}: ({edgeStats.avgTangentX.toFixed(3)}, {edgeStats.avgTangentY.toFixed(3)}, {edgeStats.avgTangentZ.toFixed(3)})</p>
                    <p>{t('panel.tangentVariance')}: {edgeStats.tangentVariance.toFixed(4)}</p>
                    <p>{t('panel.horizontal')}: {edgeStats.horizontalEdges} | {t('panel.vertical')}: {edgeStats.verticalEdges} | {t('panel.diagonal')}: {edgeStats.diagonalEdges}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Waypoints size={12} />
                <span>{t('panel.edgeDihedralStats')}</span>
              </div>
              {(() => {
                const dihedralStats = computeEdgeDihedralStatistics(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>{t('panel.minDihedral')}: {dihedralStats.minDihedral.toFixed(1)}° | {t('panel.maxDihedral')}: {dihedralStats.maxDihedral.toFixed(1)}°</p>
                    <p>{t('panel.avgDihedral')}: {dihedralStats.avgDihedral.toFixed(1)}° | {t('panel.median')}: {dihedralStats.medianDihedral.toFixed(1)}°</p>
                    <p>{t('panel.smooth')}: {dihedralStats.smoothEdges} | {t('panel.hard')}: {dihedralStats.hardEdges} | {t('panel.sharp')}: {dihedralStats.sharpEdges}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <BoxSelect size={12} />
                <span>{t('panel.edgePercentiles')}</span>
              </div>
              {(() => {
                const percentiles = computeEdgeLengthPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {percentiles.p5.toFixed(2)} | P25: {percentiles.p25.toFixed(2)} | P50: {percentiles.p50.toFixed(2)} | P75: {percentiles.p75.toFixed(2)} | P95: {percentiles.p95.toFixed(2)}</p>
                    <p>IQR: {percentiles.iqr.toFixed(2)} | {t('panel.whisker')}: {percentiles.whiskerLow.toFixed(2)} - {percentiles.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <LayersIcon size={12} />
                <span>{t('panel.faceAreaPercentiles')}</span>
              </div>
              {(() => {
                const facePercentiles = computeFaceAreaPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {facePercentiles.p5.toFixed(2)} | P25: {facePercentiles.p25.toFixed(2)} | P50: {facePercentiles.p50.toFixed(2)} | P75: {facePercentiles.p75.toFixed(2)} | P95: {facePercentiles.p95.toFixed(2)}</p>
                    <p>IQR: {facePercentiles.iqr.toFixed(2)} | {t('panel.whisker')}: {facePercentiles.whiskerLow.toFixed(2)} - {facePercentiles.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <MapPin size={12} />
                <span>{t('panel.vertexDistPercentiles')}</span>
              </div>
              {(() => {
                const vDistPercentiles = computeVertexDistancePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {vDistPercentiles.p5.toFixed(2)} | P25: {vDistPercentiles.p25.toFixed(2)} | P50: {vDistPercentiles.p50.toFixed(2)} | P75: {vDistPercentiles.p75.toFixed(2)} | P95: {vDistPercentiles.p95.toFixed(2)}</p>
                    <p>IQR: {vDistPercentiles.iqr.toFixed(2)} | {t('panel.whisker')}: {vDistPercentiles.whiskerLow.toFixed(2)} - {vDistPercentiles.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <GitCommit size={12} />
                <span>{t('panel.dihedralPercentiles')}</span>
              </div>
              {(() => {
                const dihedralPercentiles = computeEdgeDihedralPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {dihedralPercentiles.p5.toFixed(1)}° | P25: {dihedralPercentiles.p25.toFixed(1)}° | P50: {dihedralPercentiles.p50.toFixed(1)}° | P75: {dihedralPercentiles.p75.toFixed(1)}° | P95: {dihedralPercentiles.p95.toFixed(1)}°</p>
                    <p>IQR: {dihedralPercentiles.iqr.toFixed(1)}° | {t('panel.whisker')}: {dihedralPercentiles.whiskerLow.toFixed(1)}° - {dihedralPercentiles.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <GitBranchIcon size={12} />
                <span>{t('panel.anglePercentiles')}</span>
              </div>
              {(() => {
                const anglePercentiles = computeEdgeAnglePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {anglePercentiles.p5.toFixed(1)}° | P25: {anglePercentiles.p25.toFixed(1)}° | P50: {anglePercentiles.p50.toFixed(1)}° | P75: {anglePercentiles.p75.toFixed(1)}° | P95: {anglePercentiles.p95.toFixed(1)}°</p>
                    <p>IQR: {anglePercentiles.iqr.toFixed(1)}° | {t('panel.whisker')}: {anglePercentiles.whiskerLow.toFixed(1)}° - {anglePercentiles.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <GitMerge size={12} />
                <span>{t('panel.normalPercentiles')}</span>
              </div>
              {(() => {
                const normalPercentiles = computeFaceNormalPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {normalPercentiles.p5.toFixed(3)} | P25: {normalPercentiles.p25.toFixed(3)} | P50: {normalPercentiles.p50.toFixed(3)} | P75: {normalPercentiles.p75.toFixed(3)} | P95: {normalPercentiles.p95.toFixed(3)}</p>
                    <p>IQR: {normalPercentiles.iqr.toFixed(3)} | {t('panel.whisker')}: {normalPercentiles.whiskerLow.toFixed(3)} - {normalPercentiles.whiskerHigh.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <GitPullRequest size={12} />
                <span>{t('panel.tangentPercentiles')}</span>
              </div>
              {(() => {
                const tangentPercentiles = computeEdgeTangentPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {tangentPercentiles.p5.toFixed(3)} | P25: {tangentPercentiles.p25.toFixed(3)} | P50: {tangentPercentiles.p50.toFixed(3)} | P75: {tangentPercentiles.p75.toFixed(3)} | P95: {tangentPercentiles.p95.toFixed(3)}</p>
                    <p>IQR: {tangentPercentiles.iqr.toFixed(3)} | {t('panel.whisker')}: {tangentPercentiles.whiskerLow.toFixed(3)} - {tangentPercentiles.whiskerHigh.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <Spline size={12} />
                <span>{t('panel.curvaturePercentiles')}</span>
              </div>
              {(() => {
                const curvPercentiles = computeEdgeCurvaturePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {curvPercentiles.p5.toFixed(4)} | P25: {curvPercentiles.p25.toFixed(4)} | P50: {curvPercentiles.p50.toFixed(4)} | P75: {curvPercentiles.p75.toFixed(4)} | P95: {curvPercentiles.p95.toFixed(4)}</p>
                    <p>IQR: {curvPercentiles.iqr.toFixed(4)} | {t('panel.whisker')}: {curvPercentiles.whiskerLow.toFixed(4)} - {curvPercentiles.whiskerHigh.toFixed(4)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <CrosshairIcon size={12} />
                <span>{t('panel.vertexDistPercentiles')}</span>
              </div>
              {(() => {
                const vDistPercentiles = computeVertexDistancePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {vDistPercentiles.p5.toFixed(2)} | P25: {vDistPercentiles.p25.toFixed(2)} | P50: {vDistPercentiles.p50.toFixed(2)} | P75: {vDistPercentiles.p75.toFixed(2)} | P95: {vDistPercentiles.p95.toFixed(2)}</p>
                    <p>IQR: {vDistPercentiles.iqr.toFixed(2)} | {t('panel.whisker')}: {vDistPercentiles.whiskerLow.toFixed(2)} - {vDistPercentiles.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <RulerIcon2 size={12} />
                <span>{t('panel.edgeLengthPercentiles')}</span>
              </div>
              {(() => {
                const edgeLenPct = computeEdgeLengthPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {edgeLenPct.p5.toFixed(2)} | P25: {edgeLenPct.p25.toFixed(2)} | P50: {edgeLenPct.p50.toFixed(2)} | P75: {edgeLenPct.p75.toFixed(2)} | P95: {edgeLenPct.p95.toFixed(2)}</p>
                    <p>IQR: {edgeLenPct.iqr.toFixed(2)} | {t('panel.whisker')}: {edgeLenPct.whiskerLow.toFixed(2)} - {edgeLenPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <CircleDot size={12} />
                <span>{t('panel.valencePercentiles')}</span>
              </div>
              {(() => {
                const valPct = computeVertexValencePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {valPct.p5.toFixed(0)} | P25: {valPct.p25.toFixed(0)} | P50: {valPct.p50.toFixed(0)} | P75: {valPct.p75.toFixed(0)} | P95: {valPct.p95.toFixed(0)}</p>
                    <p>IQR: {valPct.iqr.toFixed(0)} | {t('panel.whisker')}: {valPct.whiskerLow.toFixed(0)} - {valPct.whiskerHigh.toFixed(0)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <WaypointsIcon size={12} />
                <span>{t('panel.dihedralPercentiles')}</span>
              </div>
              {(() => {
                const dihPct = computeEdgeDihedralPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {dihPct.p5.toFixed(1)}° | P25: {dihPct.p25.toFixed(1)}° | P50: {dihPct.p50.toFixed(1)}° | P75: {dihPct.p75.toFixed(1)}° | P95: {dihPct.p95.toFixed(1)}°</p>
                    <p>IQR: {dihPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {dihPct.whiskerLow.toFixed(1)}° - {dihPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowUpRight size={12} />
                <span>{t('panel.faceNormalPercentiles')}</span>
              </div>
              {(() => {
                const fnPct = computeFaceNormalPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {fnPct.p5.toFixed(3)} | P25: {fnPct.p25.toFixed(3)} | P50: {fnPct.p50.toFixed(3)} | P75: {fnPct.p75.toFixed(3)} | P95: {fnPct.p95.toFixed(3)}</p>
                    <p>IQR: {fnPct.iqr.toFixed(3)} | {t('panel.whisker')}: {fnPct.whiskerLow.toFixed(3)} - {fnPct.whiskerHigh.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <TrendingUpIcon size={12} />
                <span>{t('panel.tangentPercentiles')}</span>
              </div>
              {(() => {
                const tanPct = computeEdgeTangentPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {tanPct.p5.toFixed(2)} | P25: {tanPct.p25.toFixed(2)} | P50: {tanPct.p50.toFixed(2)} | P75: {tanPct.p75.toFixed(2)} | P95: {tanPct.p95.toFixed(2)}</p>
                    <p>IQR: {tanPct.iqr.toFixed(2)} | {t('panel.whisker')}: {tanPct.whiskerLow.toFixed(2)} - {tanPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <WavesIcon size={12} />
                <span>{t('panel.curvaturePercentiles')}</span>
              </div>
              {(() => {
                const curvPct = computeEdgeCurvaturePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {curvPct.p5.toFixed(4)} | P25: {curvPct.p25.toFixed(4)} | P50: {curvPct.p50.toFixed(4)} | P75: {curvPct.p75.toFixed(4)} | P95: {curvPct.p95.toFixed(4)}</p>
                    <p>IQR: {curvPct.iqr.toFixed(4)} | {t('panel.whisker')}: {curvPct.whiskerLow.toFixed(4)} - {curvPct.whiskerHigh.toFixed(4)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <MoveIcon size={12} />
                <span>{t('panel.vertexDistPercentiles')}</span>
              </div>
              {(() => {
                const vdPct = computeVertexDistancePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {vdPct.p5.toFixed(2)} | P25: {vdPct.p25.toFixed(2)} | P50: {vdPct.p50.toFixed(2)} | P75: {vdPct.p75.toFixed(2)} | P95: {vdPct.p95.toFixed(2)}</p>
                    <p>IQR: {vdPct.iqr.toFixed(2)} | {t('panel.whisker')}: {vdPct.whiskerLow.toFixed(2)} - {vdPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <LayersIcon2 size={12} />
                <span>{t('panel.faceAreaPercentiles')}</span>
              </div>
              {(() => {
                const faPct = computeFaceAreaPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {faPct.p5.toFixed(2)} | P25: {faPct.p25.toFixed(2)} | P50: {faPct.p50.toFixed(2)} | P75: {faPct.p75.toFixed(2)} | P95: {faPct.p95.toFixed(2)}</p>
                    <p>IQR: {faPct.iqr.toFixed(2)} | {t('panel.whisker')}: {faPct.whiskerLow.toFixed(2)} - {faPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <WaypointsIcon2 size={12} />
                <span>{t('panel.dihedralPercentiles')}</span>
              </div>
              {(() => {
                const dpPct = computeEdgeDihedralPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {dpPct.p5.toFixed(1)}° | P25: {dpPct.p25.toFixed(1)}° | P50: {dpPct.p50.toFixed(1)}° | P75: {dpPct.p75.toFixed(1)}° | P95: {dpPct.p95.toFixed(1)}°</p>
                    <p>IQR: {dpPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {dpPct.whiskerLow.toFixed(1)}° - {dpPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <CircleIcon size={12} />
                <span>{t('panel.anglePercentiles')}</span>
              </div>
              {(() => {
                const apPct = computeEdgeAnglePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {apPct.p5.toFixed(1)}° | P25: {apPct.p25.toFixed(1)}° | P50: {apPct.p50.toFixed(1)}° | P75: {apPct.p75.toFixed(1)}° | P95: {apPct.p95.toFixed(1)}°</p>
                    <p>IQR: {apPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {apPct.whiskerLow.toFixed(1)}° - {apPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowDownIcon size={12} />
                <span>{t('panel.faceNormalPercentiles')}</span>
              </div>
              {(() => {
                const fnPct = computeFaceNormalPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {fnPct.p5.toFixed(3)} | P25: {fnPct.p25.toFixed(3)} | P50: {fnPct.p50.toFixed(3)} | P75: {fnPct.p75.toFixed(3)} | P95: {fnPct.p95.toFixed(3)}</p>
                    <p>IQR: {fnPct.iqr.toFixed(3)} | {t('panel.whisker')}: {fnPct.whiskerLow.toFixed(3)} - {fnPct.whiskerHigh.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowRightIcon size={12} />
                <span>{t('panel.tangentPercentiles')}</span>
              </div>
              {(() => {
                const etPct = computeEdgeTangentPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {etPct.p5.toFixed(2)} | P25: {etPct.p25.toFixed(2)} | P50: {etPct.p50.toFixed(2)} | P75: {etPct.p75.toFixed(2)} | P95: {etPct.p95.toFixed(2)}</p>
                    <p>IQR: {etPct.iqr.toFixed(2)} | {t('panel.whisker')}: {etPct.whiskerLow.toFixed(2)} - {etPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SplineIcon size={12} />
                <span>{t('panel.curvaturePercentiles')}</span>
              </div>
              {(() => {
                const ecPct = computeEdgeCurvaturePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {ecPct.p5.toFixed(4)} | P25: {ecPct.p25.toFixed(4)} | P50: {ecPct.p50.toFixed(4)} | P75: {ecPct.p75.toFixed(4)} | P95: {ecPct.p95.toFixed(4)}</p>
                    <p>IQR: {ecPct.iqr.toFixed(4)} | {t('panel.whisker')}: {ecPct.whiskerLow.toFixed(4)} - {ecPct.whiskerHigh.toFixed(4)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <MoveIcon2 size={12} />
                <span>{t('panel.vertexDistPercentiles')}</span>
              </div>
              {(() => {
                const vdPct = computeVertexDistancePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {vdPct.p5.toFixed(2)} | P25: {vdPct.p25.toFixed(2)} | P50: {vdPct.p50.toFixed(2)} | P75: {vdPct.p75.toFixed(2)} | P95: {vdPct.p95.toFixed(2)}</p>
                    <p>IQR: {vdPct.iqr.toFixed(2)} | {t('panel.whisker')}: {vdPct.whiskerLow.toFixed(2)} - {vdPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SquareIcon size={12} />
                <span>{t('panel.faceAreaPercentiles')}</span>
              </div>
              {(() => {
                const faPct = computeFaceAreaPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {faPct.p5.toFixed(2)} | P25: {faPct.p25.toFixed(2)} | P50: {faPct.p50.toFixed(2)} | P75: {faPct.p75.toFixed(2)} | P95: {faPct.p95.toFixed(2)}</p>
                    <p>IQR: {faPct.iqr.toFixed(2)} | {t('panel.whisker')}: {faPct.whiskerLow.toFixed(2)} - {faPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <DiamondIcon size={12} />
                <span>{t('panel.dihedralPercentiles')}</span>
              </div>
              {(() => {
                const dpPct = computeEdgeDihedralPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {dpPct.p5.toFixed(1)}° | P25: {dpPct.p25.toFixed(1)}° | P50: {dpPct.p50.toFixed(1)}° | P75: {dpPct.p75.toFixed(1)}° | P95: {dpPct.p95.toFixed(1)}°</p>
                    <p>IQR: {dpPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {dpPct.whiskerLow.toFixed(1)}° - {dpPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <CornerDownLeft size={12} />
                <span>{t('panel.anglePercentiles')}</span>
              </div>
              {(() => {
                const apPct = computeEdgeAnglePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {apPct.p5.toFixed(1)}° | P25: {apPct.p25.toFixed(1)}° | P50: {apPct.p50.toFixed(1)}° | P75: {apPct.p75.toFixed(1)}° | P95: {apPct.p95.toFixed(1)}°</p>
                    <p>IQR: {apPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {apPct.whiskerLow.toFixed(1)}° - {apPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <MoveIcon3 size={12} />
                <span>{t('panel.faceNormalPercentiles')}</span>
              </div>
              {(() => {
                const fnPct = computeFaceNormalPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {fnPct.p5.toFixed(3)} | P25: {fnPct.p25.toFixed(3)} | P50: {fnPct.p50.toFixed(3)} | P75: {fnPct.p75.toFixed(3)} | P95: {fnPct.p95.toFixed(3)}</p>
                    <p>IQR: {fnPct.iqr.toFixed(3)} | {t('panel.whisker')}: {fnPct.whiskerLow.toFixed(3)} - {fnPct.whiskerHigh.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowRightLeft size={12} />
                <span>{t('panel.tangentPercentiles')}</span>
              </div>
              {(() => {
                const etPct = computeEdgeTangentPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {etPct.p5.toFixed(2)} | P25: {etPct.p25.toFixed(2)} | P50: {etPct.p50.toFixed(2)} | P75: {etPct.p75.toFixed(2)} | P95: {etPct.p95.toFixed(2)}</p>
                    <p>IQR: {etPct.iqr.toFixed(2)} | {t('panel.whisker')}: {etPct.whiskerLow.toFixed(2)} - {etPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SplineIcon2 size={12} />
                <span>{t('panel.curvaturePercentiles')}</span>
              </div>
              {(() => {
                const ecPct = computeEdgeCurvaturePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {ecPct.p5.toFixed(4)} | P25: {ecPct.p25.toFixed(4)} | P50: {ecPct.p50.toFixed(4)} | P75: {ecPct.p75.toFixed(4)} | P95: {ecPct.p95.toFixed(4)}</p>
                    <p>IQR: {ecPct.iqr.toFixed(4)} | {t('panel.whisker')}: {ecPct.whiskerLow.toFixed(4)} - {ecPct.whiskerHigh.toFixed(4)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <MoveIcon4 size={12} />
                <span>{t('panel.vertexDistPercentiles')}</span>
              </div>
              {(() => {
                const vdPct = computeVertexDistancePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {vdPct.p5.toFixed(2)} | P25: {vdPct.p25.toFixed(2)} | P50: {vdPct.p50.toFixed(2)} | P75: {vdPct.p75.toFixed(2)} | P95: {vdPct.p95.toFixed(2)}</p>
                    <p>IQR: {vdPct.iqr.toFixed(2)} | {t('panel.whisker')}: {vdPct.whiskerLow.toFixed(2)} - {vdPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SquareIcon2 size={12} />
                <span>{t('panel.faceAreaPercentiles')}</span>
              </div>
              {(() => {
                const faPct = computeFaceAreaPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {faPct.p5.toFixed(2)} | P25: {faPct.p25.toFixed(2)} | P50: {faPct.p50.toFixed(2)} | P75: {faPct.p75.toFixed(2)} | P95: {faPct.p95.toFixed(2)}</p>
                    <p>IQR: {faPct.iqr.toFixed(2)} | {t('panel.whisker')}: {faPct.whiskerLow.toFixed(2)} - {faPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <DiamondIcon2 size={12} />
                <span>{t('panel.dihedralPercentiles')}</span>
              </div>
              {(() => {
                const dpPct = computeEdgeDihedralPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {dpPct.p5.toFixed(1)}° | P25: {dpPct.p25.toFixed(1)}° | P50: {dpPct.p50.toFixed(1)}° | P75: {dpPct.p75.toFixed(1)}° | P95: {dpPct.p95.toFixed(1)}°</p>
                    <p>IQR: {dpPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {dpPct.whiskerLow.toFixed(1)}° - {dpPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <TriangleIcon size={12} />
                <span>{t('panel.anglePercentiles')}</span>
              </div>
              {(() => {
                const apPct = computeEdgeAnglePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {apPct.p5.toFixed(1)}° | P25: {apPct.p25.toFixed(1)}° | P50: {apPct.p50.toFixed(1)}° | P75: {apPct.p75.toFixed(1)}° | P95: {apPct.p95.toFixed(1)}°</p>
                    <p>IQR: {apPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {apPct.whiskerLow.toFixed(1)}° - {apPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowDownIcon2 size={12} />
                <span>{t('panel.faceNormalPercentiles')}</span>
              </div>
              {(() => {
                const fnPct = computeFaceNormalPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {fnPct.p5.toFixed(3)} | P25: {fnPct.p25.toFixed(3)} | P50: {fnPct.p50.toFixed(3)} | P75: {fnPct.p75.toFixed(3)} | P95: {fnPct.p95.toFixed(3)}</p>
                    <p>IQR: {fnPct.iqr.toFixed(3)} | {t('panel.whisker')}: {fnPct.whiskerLow.toFixed(3)} - {fnPct.whiskerHigh.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowRightLeftIcon size={12} />
                <span>{t('panel.tangentPercentiles')}</span>
              </div>
              {(() => {
                const etPct = computeEdgeTangentPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {etPct.p5.toFixed(2)} | P25: {etPct.p25.toFixed(2)} | P50: {etPct.p50.toFixed(2)} | P75: {etPct.p75.toFixed(2)} | P95: {etPct.p95.toFixed(2)}</p>
                    <p>IQR: {etPct.iqr.toFixed(2)} | {t('panel.whisker')}: {etPct.whiskerLow.toFixed(2)} - {etPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SplineIcon3 size={12} />
                <span>{t('panel.curvaturePercentiles')}</span>
              </div>
              {(() => {
                const ecPct = computeEdgeCurvaturePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {ecPct.p5.toFixed(4)} | P25: {ecPct.p25.toFixed(4)} | P50: {ecPct.p50.toFixed(4)} | P75: {ecPct.p75.toFixed(4)} | P95: {ecPct.p95.toFixed(4)}</p>
                    <p>IQR: {ecPct.iqr.toFixed(4)} | {t('panel.whisker')}: {ecPct.whiskerLow.toFixed(4)} - {ecPct.whiskerHigh.toFixed(4)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <MoveIcon5 size={12} />
                <span>{t('panel.vertexDistPercentiles')}</span>
              </div>
              {(() => {
                const vdPct = computeVertexDistancePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {vdPct.p5.toFixed(2)} | P25: {vdPct.p25.toFixed(2)} | P50: {vdPct.p50.toFixed(2)} | P75: {vdPct.p75.toFixed(2)} | P95: {vdPct.p95.toFixed(2)}</p>
                    <p>IQR: {vdPct.iqr.toFixed(2)} | {t('panel.whisker')}: {vdPct.whiskerLow.toFixed(2)} - {vdPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SquareIcon3 size={12} />
                <span>{t('panel.faceAreaPercentiles')}</span>
              </div>
              {(() => {
                const faPct = computeFaceAreaPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {faPct.p5.toFixed(2)} | P25: {faPct.p25.toFixed(2)} | P50: {faPct.p50.toFixed(2)} | P75: {faPct.p75.toFixed(2)} | P95: {faPct.p95.toFixed(2)}</p>
                    <p>IQR: {faPct.iqr.toFixed(2)} | {t('panel.whisker')}: {faPct.whiskerLow.toFixed(2)} - {faPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <DiamondIcon3 size={12} />
                <span>{t('panel.dihedralPercentiles')}</span>
              </div>
              {(() => {
                const dpPct = computeEdgeDihedralPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {dpPct.p5.toFixed(1)}° | P25: {dpPct.p25.toFixed(1)}° | P50: {dpPct.p50.toFixed(1)}° | P75: {dpPct.p75.toFixed(1)}° | P95: {dpPct.p95.toFixed(1)}°</p>
                    <p>IQR: {dpPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {dpPct.whiskerLow.toFixed(1)}° - {dpPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <TriangleIcon2 size={12} />
                <span>{t('panel.anglePercentiles')}</span>
              </div>
              {(() => {
                const apPct = computeEdgeAnglePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {apPct.p5.toFixed(1)}° | P25: {apPct.p25.toFixed(1)}° | P50: {apPct.p50.toFixed(1)}° | P75: {apPct.p75.toFixed(1)}° | P95: {apPct.p95.toFixed(1)}°</p>
                    <p>IQR: {apPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {apPct.whiskerLow.toFixed(1)}° - {apPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowDownIcon3 size={12} />
                <span>{t('panel.faceNormalPercentiles')}</span>
              </div>
              {(() => {
                const fnPct = computeFaceNormalPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {fnPct.p5.toFixed(3)} | P25: {fnPct.p25.toFixed(3)} | P50: {fnPct.p50.toFixed(3)} | P75: {fnPct.p75.toFixed(3)} | P95: {fnPct.p95.toFixed(3)}</p>
                    <p>IQR: {fnPct.iqr.toFixed(3)} | {t('panel.whisker')}: {fnPct.whiskerLow.toFixed(3)} - {fnPct.whiskerHigh.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowRightLeftIcon2 size={12} />
                <span>{t('panel.tangentPercentiles')}</span>
              </div>
              {(() => {
                const etPct = computeEdgeTangentPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {etPct.p5.toFixed(2)} | P25: {etPct.p25.toFixed(2)} | P50: {etPct.p50.toFixed(2)} | P75: {etPct.p75.toFixed(2)} | P95: {etPct.p95.toFixed(2)}</p>
                    <p>IQR: {etPct.iqr.toFixed(2)} | {t('panel.whisker')}: {etPct.whiskerLow.toFixed(2)} - {etPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SplineIcon4 size={12} />
                <span>{t('panel.curvaturePercentiles')}</span>
              </div>
              {(() => {
                const ecPct = computeEdgeCurvaturePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {ecPct.p5.toFixed(4)} | P25: {ecPct.p25.toFixed(4)} | P50: {ecPct.p50.toFixed(4)} | P75: {ecPct.p75.toFixed(4)} | P95: {ecPct.p95.toFixed(4)}</p>
                    <p>IQR: {ecPct.iqr.toFixed(4)} | {t('panel.whisker')}: {ecPct.whiskerLow.toFixed(4)} - {ecPct.whiskerHigh.toFixed(4)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <MoveIcon6 size={12} />
                <span>{t('panel.vertexDistPercentiles')}</span>
              </div>
              {(() => {
                const vdPct = computeVertexDistancePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {vdPct.p5.toFixed(2)} | P25: {vdPct.p25.toFixed(2)} | P50: {vdPct.p50.toFixed(2)} | P75: {vdPct.p75.toFixed(2)} | P95: {vdPct.p95.toFixed(2)}</p>
                    <p>IQR: {vdPct.iqr.toFixed(2)} | {t('panel.whisker')}: {vdPct.whiskerLow.toFixed(2)} - {vdPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SquareIcon4 size={12} />
                <span>{t('panel.faceAreaPercentiles')}</span>
              </div>
              {(() => {
                const faPct = computeFaceAreaPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {faPct.p5.toFixed(2)} | P25: {faPct.p25.toFixed(2)} | P50: {faPct.p50.toFixed(2)} | P75: {faPct.p75.toFixed(2)} | P95: {faPct.p95.toFixed(2)}</p>
                    <p>IQR: {faPct.iqr.toFixed(2)} | {t('panel.whisker')}: {faPct.whiskerLow.toFixed(2)} - {faPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <DiamondIcon4 size={12} />
                <span>{t('panel.dihedralPercentiles')}</span>
              </div>
              {(() => {
                const dpPct = computeEdgeDihedralPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {dpPct.p5.toFixed(1)}° | P25: {dpPct.p25.toFixed(1)}° | P50: {dpPct.p50.toFixed(1)}° | P75: {dpPct.p75.toFixed(1)}° | P95: {dpPct.p95.toFixed(1)}°</p>
                    <p>IQR: {dpPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {dpPct.whiskerLow.toFixed(1)}° - {dpPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <TriangleIcon3 size={12} />
                <span>{t('panel.anglePercentiles')}</span>
              </div>
              {(() => {
                const apPct = computeEdgeAnglePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {apPct.p5.toFixed(1)}° | P25: {apPct.p25.toFixed(1)}° | P50: {apPct.p50.toFixed(1)}° | P75: {apPct.p75.toFixed(1)}° | P95: {apPct.p95.toFixed(1)}°</p>
                    <p>IQR: {apPct.iqr.toFixed(1)}° | {t('panel.whisker')}: {apPct.whiskerLow.toFixed(1)}° - {apPct.whiskerHigh.toFixed(1)}°</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowDownIcon4 size={12} />
                <span>{t('panel.faceNormalPercentiles')}</span>
              </div>
              {(() => {
                const fnPct = computeFaceNormalPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {fnPct.p5.toFixed(3)} | P25: {fnPct.p25.toFixed(3)} | P50: {fnPct.p50.toFixed(3)} | P75: {fnPct.p75.toFixed(3)} | P95: {fnPct.p95.toFixed(3)}</p>
                    <p>IQR: {fnPct.iqr.toFixed(3)} | {t('panel.whisker')}: {fnPct.whiskerLow.toFixed(3)} - {fnPct.whiskerHigh.toFixed(3)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <ArrowRightLeftIcon3 size={12} />
                <span>{t('panel.tangentPercentiles')}</span>
              </div>
              {(() => {
                const etPct = computeEdgeTangentPercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {etPct.p5.toFixed(2)} | P25: {etPct.p25.toFixed(2)} | P50: {etPct.p50.toFixed(2)} | P75: {etPct.p75.toFixed(2)} | P95: {etPct.p95.toFixed(2)}</p>
                    <p>IQR: {etPct.iqr.toFixed(2)} | {t('panel.whisker')}: {etPct.whiskerLow.toFixed(2)} - {etPct.whiskerHigh.toFixed(2)}</p>
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-text-muted">
                <SplineIcon5 size={12} />
                <span>{t('panel.curvaturePercentiles')}</span>
              </div>
              {(() => {
                const ecPct = computeEdgeCurvaturePercentiles(selectedBody);
                return (
                  <div className="pl-4 text-xs text-text-secondary space-y-0.5">
                    <p>P5: {ecPct.p5.toFixed(4)} | P25: {ecPct.p25.toFixed(4)} | P50: {ecPct.p50.toFixed(4)} | P75: {ecPct.p75.toFixed(4)} | P95: {ecPct.p95.toFixed(4)}</p>
                    <p>IQR: {ecPct.iqr.toFixed(4)} | {t('panel.whisker')}: {ecPct.whiskerLow.toFixed(4)} - {ecPct.whiskerHigh.toFixed(4)}</p>
                  </div>
                );
              })()}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="text-xs text-text-secondary">
              {t('panel.selected')}: {selectedIds.join(', ')}
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
