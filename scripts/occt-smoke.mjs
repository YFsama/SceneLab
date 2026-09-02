/**
 * Smoke-test the real occt-import-js WASM path used by
 * src/lib/io/stepOCCT.ts against curved STEP fixtures (OCCT-authored, with
 * pcurves): ReadStepFile with the importer's exact tessellation params, then
 * sanity-check the returned mesh nodes (vertex/triangle counts, watertight
 * signed volume, brep face ranges).
 *
 * Run: node scripts/occt-smoke.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const dist = path.resolve('node_modules/occt-import-js/dist');
const occtimportjs = require(path.join(dist, 'occt-import-js.js'));
const occt = await occtimportjs({ locateFile: () => path.join(dist, 'occt-import-js.wasm') });

const fixtures = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['e2e/fixtures/conical-surface.step', 'e2e/fixtures/rounded-cube.step'];

let allOk = true;
for (const file of fixtures) {
  const bytes = fs.readFileSync(file);
  // Exact parameters used by importSTEPWithOCCT.
  const result = occt.ReadStepFile(new Uint8Array(bytes), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'absolute_value',
    linearDeflection: 0.1,
    angularDeflection: 0.5,
  });
  if (!result.success) {
    console.log(`${file}: ReadStepFile failed`);
    allOk = false;
    continue;
  }
  for (const [i, m] of result.meshes.entries()) {
    const p = m.attributes?.position?.array;
    const idx = m.index?.array;
    const vertCount = p?.length ? p.length / 3 : 0;
    const triCount = idx?.length ? idx.length / 3 : 0;
    let vol = 0;
    if (p && idx && triCount > 0) {
      const P = (j) => [p[idx[j] * 3], p[idx[j] * 3 + 1], p[idx[j] * 3 + 2]];
      for (let j = 0; j < idx.length; j += 3) {
        const [ax, ay, az] = P(j), [bx, by, bz] = P(j + 1), [cx, cy, cz] = P(j + 2);
        vol += (ax * (by * cz - cy * bz) - bx * (ay * cz - cy * az) + cx * (ay * bz - by * az)) / 6;
      }
    }
    const hasCurvature = triCount > vertCount; // curved faces need more tris than flat quads
    console.log(
      `${path.basename(file)} mesh[${i}] name=${JSON.stringify(m.name)} verts=${vertCount} tris=${triCount}` +
      ` brep_faces=${m.brep_faces?.length ?? 0} signedVol=${vol.toFixed(2)}${m.color ? ' colored' : ''}`,
    );
    if (triCount === 0) allOk = false;
    if (!hasCurvature && triCount > 0) console.log('  (note: flat tessellation)');
    void hasCurvature;
  }
}
console.log(allOk ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(allOk ? 0 : 2);
