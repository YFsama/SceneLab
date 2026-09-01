import { describe, it, expect } from 'vitest';
import { exportSTEP } from './step';
import { importSTEP } from './stepImport';
import { createBox, createCylinder, computeVolume, computeTopology, findBoundaryLoops } from '../geometry/brep';
import { translateBody } from '../geometry/operations';

describe('STEP round-trip', () => {
  it('box survives export → import with exact volume and topology', () => {
    const box = createBox(10, 20, 30);
    const text = exportSTEP(box);
    const back = importSTEP(text);
    expect(back.name).toBe('Box');
    expect(back.faces).toHaveLength(box.faces.length);
    expect(computeVolume(back)).toBeCloseTo(computeVolume(box), 3);
    expect(computeTopology(back).genus).toBe(0);
    expect(findBoundaryLoops(back).loops.length).toBe(0);
  });

  it('cylinder survives export → import', () => {
    const cyl = createCylinder(5, 12, 16);
    const back = importSTEP(exportSTEP(cyl));
    expect(computeVolume(back)).toBeCloseTo(computeVolume(cyl), 2);
    expect(back.faces).toHaveLength(cyl.faces.length);
  });

  it('translated body keeps its position', () => {
    const moved = translateBody(createBox(10, 10, 10), { x: 100, y: 5, z: -20 });
    const back = importSTEP(exportSTEP(moved));
    const xs = back.vertices.map((v) => v.x);
    expect(Math.min(...xs)).toBeCloseTo(95, 3);
    expect(Math.max(...xs)).toBeCloseTo(105, 3);
  });

  it('throws a clear error for non-STEP content', () => {
    expect(() => importSTEP('this is not a STEP file')).toThrow(/No faceted faces/);
  });

  it('parses a hand-written faceted STEP dialect (external files)', () => {
    // A minimal ADVANCED_FACE/EDGE_LOOP chain like FreeCAD's faceted export —
    // two triangles sharing an edge.
    const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test'),'2;1');
FILE_NAME('t.stp','',(''),(''),'','','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('core data');
#10=CARTESIAN_POINT('',(0.0,0.0,0.0));
#11=CARTESIAN_POINT('',(10.0,0.0,0.0));
#12=CARTESIAN_POINT('',(0.0,10.0,0.0));
#13=CARTESIAN_POINT('',(10.0,10.0,5.0));
#20=VERTEX_POINT('',#10);
#21=VERTEX_POINT('',#11);
#22=VERTEX_POINT('',#12);
#23=VERTEX_POINT('',#13);
#30=LINE('',#10,#31);
#31=VECTOR('',#32,10.0);
#32=DIRECTION('',(1.0,0.0,0.0));
#33=LINE('',#11,#34);
#34=VECTOR('',#35,10.0);
#35=DIRECTION('',(0.0,1.0,0.0));
#36=LINE('',#12,#37);
#37=VECTOR('',#38,10.0);
#38=DIRECTION('',(1.0,0.0,0.0));
#40=EDGE_CURVE('','',#20,#21,#30,.T.);
#41=EDGE_CURVE('','',#21,#22,#33,.T.);
#42=EDGE_CURVE('','',#22,#20,#36,.T.);
#43=EDGE_CURVE('','',#21,#23,#33,.T.);
#44=EDGE_CURVE('','',#23,#22,#36,.T.);
#50=ORIENTED_EDGE('',*,*,#40,.T.);
#51=ORIENTED_EDGE('',*,*,#41,.T.);
#52=ORIENTED_EDGE('',*,*,#42,.T.);
#53=ORIENTED_EDGE('',*,*,#43,.T.);
#54=ORIENTED_EDGE('',*,*,#44,.T.);
#55=ORIENTED_EDGE('',*,*,#41,.F.);
#60=EDGE_LOOP('',(#50,#51,#52));
#61=EDGE_LOOP('',(#53,#54,#55));
#70=FACE_OUTER_BOUND('',#60,.T.);
#71=FACE_OUTER_BOUND('',#61,.T.);
#80=ADVANCED_FACE('',(#70),#90,.T.);
#81=ADVANCED_FACE('',(#71),#91,.T.);
#90=PLANE('',#92);
#91=PLANE('',#93);
#92=AXIS2_PLACEMENT_3D('',#10,#94,$);
#93=AXIS2_PLACEMENT_3D('',#11,#95,$);
#94=DIRECTION('',(0.0,0.0,1.0));
#95=DIRECTION('',(0.0,0.0,1.0));
ENDSEC;
END-ISO-10303-21;
`;
    const body = importSTEP(text, 'External');
    expect(body.name).toBe('External');
    expect(body.faces).toHaveLength(2);
    expect(body.faces[0]!.vertices).toHaveLength(3);
    expect(body.faces[1]!.vertices).toHaveLength(3);
  });
});
