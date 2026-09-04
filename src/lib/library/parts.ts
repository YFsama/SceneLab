// Beginner-focused parts library (TinkerCAD-style shape gallery).
// Pure data + builders: no DOM, no React, no store access. The PartsLibrary
// panel, the command palette and the AI tool all insert through the same
// catalog so every entry point stays consistent.
import {
  createBox, createCylinder, createSphere, createPrism,
  createTube, createWedge, createCoil, createExtrude, createLoft,
} from '../geometry/brep';
import { translateBody, rotateBody, mergeBodies } from '../geometry/operations';
import { booleanOp } from '../geometry/boolean';
import { seatOnBed } from '../print';
import type { SolidBody, Vec3 } from '../geometry/types';

export type PartCategoryId = 'basic' | 'mechanical' | 'holes' | 'fun';

export interface LibraryPart {
  id: string;
  category: PartCategoryId;
  /** Locale-neutral spec shown under the name, e.g. "M8" or "60×60×3". */
  spec: string;
  /** Lowercase search terms, English + Chinese, matched as substrings. */
  keywords: string[];
  build: () => SolidBody;
}

export const LIBRARY_CATEGORIES: { id: PartCategoryId | 'all'; labelKey: string }[] = [
  { id: 'all', labelKey: 'library.all' },
  { id: 'basic', labelKey: 'library.basic' },
  { id: 'mechanical', labelKey: 'library.mechanical' },
  { id: 'holes', labelKey: 'library.holes' },
  { id: 'fun', labelKey: 'library.fun' },
];

/** A gear blank: trapezoid-toothed profile extruded and bored through. */
function buildGear(teeth = 12, rootR = 14, tipR = 16.5, bore = 4, thickness = 5): SolidBody {
  const pts: Vec3[] = [];
  const step = (2 * Math.PI) / teeth;
  const tooth = step * 0.5;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    pts.push({ x: Math.cos(a - step / 2) * rootR, y: 0, z: Math.sin(a - step / 2) * rootR });
    pts.push({ x: Math.cos(a - tooth / 2) * rootR, y: 0, z: Math.sin(a - tooth / 2) * rootR });
    pts.push({ x: Math.cos(a - tooth * 0.35) * tipR, y: 0, z: Math.sin(a - tooth * 0.35) * tipR });
    pts.push({ x: Math.cos(a + tooth * 0.35) * tipR, y: 0, z: Math.sin(a + tooth * 0.35) * tipR });
    pts.push({ x: Math.cos(a + tooth / 2) * rootR, y: 0, z: Math.sin(a + tooth / 2) * rootR });
  }
  const blank = createExtrude({ profile: pts, direction: { x: 0, y: 1, z: 0 }, distance: thickness });
  const cut = booleanOp(blank, createCylinder(bore, thickness), 'difference', 48);
  return { ...(cut ?? blank), name: 'Gear' };
}

/** Hex nut: hexagonal prism with a through bore (M8 ≈ 13 mm across flats). */
function buildHexNut(): SolidBody {
  const h = 6.5;
  // Across-flats 13 → circumradius 13/√3.
  const blank = createPrism(6, 13 / Math.sqrt(3), h);
  const cut = booleanOp(blank, createCylinder(4, h), 'difference', 48);
  return { ...(cut ?? blank), name: 'Hex nut' };
}

/** Arch: block with a round tunnel cut through the top. */
function buildArch(): SolidBody {
  const base = createBox(32, 26, 10);
  // Cylinder along +Y rotated 90° about X lies along +Z, then lifted to the
  // top face so the cut opens upward through the full depth.
  const tool = translateBody(
    rotateBody(createCylinder(11, 10), { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, Math.PI / 2),
    { x: 0, y: 26, z: -5 },
  );
  const cut = booleanOp(base, tool, 'difference', 48);
  return { ...(cut ?? base), name: 'Arch' };
}

/** Merge touching boxes into one body (no booleans needed — they only touch). */
function mergeStacked(parts: SolidBody[], name: string): SolidBody {
  const merged = mergeBodies(parts, name);
  return merged;
}

function starProfile(points: number, outerR: number, innerR: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    pts.push({ x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r });
  }
  return pts;
}

export const LIBRARY_PARTS: LibraryPart[] = [
  // ---- Basic, practical sizes ----
  {
    id: 'plate', category: 'basic', spec: '60×60×3',
    keywords: ['plate', 'sheet', 'base', 'ban', 'hu', 'jiachi', '板', '薄板', '底板'],
    build: () => ({ ...createBox(60, 3, 60), name: 'Plate' }),
  },
  {
    id: 'bar', category: 'basic', spec: '10×10×60',
    keywords: ['bar', 'stick', 'square', 'tiao', '方条', '方钢'],
    build: () => ({ ...createBox(10, 10, 60), name: 'Bar' }),
  },
  {
    id: 'rod', category: 'basic', spec: '⌀8×60',
    keywords: ['rod', 'shaft', 'round', 'gan', '圆棒', '圆杆', '轴'],
    build: () => ({ ...createCylinder(4, 60), name: 'Rod' }),
  },
  {
    id: 'ball', category: 'basic', spec: '⌀20',
    keywords: ['ball', 'sphere', 'qiu', '球'],
    // Spheres are origin-centred; lift one radius so it rests on the plate.
    build: () => ({ ...translateBody(createSphere(10), { x: 0, y: 10, z: 0 }), name: 'Ball' }),
  },
  {
    id: 'column', category: 'basic', spec: '⌀16×40',
    keywords: ['column', 'pillar', 'post', 'zhu', '柱', '圆柱'],
    build: () => ({ ...createCylinder(8, 40), name: 'Column' }),
  },
  {
    id: 'pipe', category: 'basic', spec: '⌀20×⌀14×30',
    keywords: ['pipe', 'tube', 'hollow', 'guan', '管'],
    build: () => ({ ...createTube(10, 7, 30), name: 'Pipe' }),
  },
  {
    id: 'hexStock', category: 'basic', spec: 'AF 20×20',
    keywords: ['hex', 'hexagon', 'stock', 'liu', '六棱', '六角'],
    build: () => ({ ...createPrism(6, 20 / Math.sqrt(3), 20), name: 'Hex stock' }),
  },
  {
    id: 'ramp', category: 'basic', spec: '30×20×30',
    keywords: ['ramp', 'wedge', 'incline', 'xie', 'po', '楔', '斜坡'],
    build: () => ({ ...createWedge(30, 20, 30), name: 'Ramp' }),
  },
  {
    id: 'spring', category: 'basic', spec: '⌀16×⌀3.2',
    keywords: ['spring', 'coil', 'tan', 'huang', '弹簧', '线圈'],
    // Coils wrap the origin; seat the result on the plate.
    build: () => ({ ...seatOnBed(createCoil(8, 1.6, 5, 5)), name: 'Spring' }),
  },

  // ---- Mechanical ----
  {
    id: 'hexNut', category: 'mechanical', spec: 'M8',
    keywords: ['nut', 'hex', 'thread', 'luo', 'mu', '螺母', '六角螺母', 'nuts'],
    build: buildHexNut,
  },
  {
    id: 'washer', category: 'mechanical', spec: 'M8',
    keywords: ['washer', 'shim', 'dian', 'quan', '垫圈', '垫片'],
    build: () => ({ ...createTube(8, 4.2, 1.6), name: 'Washer' }),
  },
  {
    id: 'bushing', category: 'mechanical', spec: '⌀12×⌀6×15',
    keywords: ['bush', 'bushing', 'sleeve', 'bearing', 'zhou', 'tao', '轴套', '衬套'],
    build: () => ({ ...createTube(6, 3, 15), name: 'Bushing' }),
  },
  {
    id: 'flange', category: 'mechanical', spec: '⌀48×⌀12×5',
    keywords: ['flange', 'disc', 'ring', 'fa', 'lan', '法兰', '法兰盘'],
    build: () => ({ ...createTube(24, 6, 5), name: 'Flange' }),
  },
  {
    id: 'lBracket', category: 'mechanical', spec: '40×40',
    keywords: ['bracket', 'angle', 'l', 'zhi', 'jia', '支架', '角码', 'l型'],
    build: () => mergeStacked(
      [createBox(40, 4, 30), translateBody(createBox(4, 36, 30), { x: 22, y: 4, z: 0 })],
      'L-bracket',
    ),
  },
  {
    id: 'uBracket', category: 'mechanical', spec: '44×34×30',
    keywords: ['bracket', 'u', 'channel', 'zhi', 'jia', '支架', 'u型', '槽'],
    build: () => mergeStacked(
      [
        createBox(40, 4, 30),
        translateBody(createBox(4, 30, 30), { x: 22, y: 4, z: 0 }),
        translateBody(createBox(4, 30, 30), { x: -22, y: 4, z: 0 }),
      ],
      'U-bracket',
    ),
  },
  {
    id: 'gear', category: 'mechanical', spec: 'z12 ⌀33',
    keywords: ['gear', 'cog', 'teeth', 'chi', 'lun', '齿轮'],
    build: () => buildGear(),
  },
  {
    id: 'knob', category: 'mechanical', spec: '⌀24×22',
    keywords: ['knob', 'dial', 'handle', 'xuan', 'niu', '旋钮', '把手'],
    build: () => mergeStacked(
      [createCylinder(12, 8), translateBody(createCylinder(6, 14), { x: 0, y: 8, z: 0 })],
      'Knob',
    ),
  },

  // ---- Hole cutters (for boolean subtract workflows / dowel pins) ----
  {
    id: 'holeM3', category: 'holes', spec: 'M3 ⌀3.6',
    keywords: ['hole', 'm3', 'drill', 'kong', '孔', '钻孔'],
    build: () => ({ ...createCylinder(1.8, 20), name: 'M3 hole' }),
  },
  {
    id: 'holeM4', category: 'holes', spec: 'M4 ⌀4.6',
    keywords: ['hole', 'm4', 'drill', 'kong', '孔', '钻孔'],
    build: () => ({ ...createCylinder(2.3, 20), name: 'M4 hole' }),
  },
  {
    id: 'holeM6', category: 'holes', spec: 'M6 ⌀6.4',
    keywords: ['hole', 'm6', 'drill', 'kong', '孔', '钻孔'],
    build: () => ({ ...createCylinder(3.2, 20), name: 'M6 hole' }),
  },
  {
    id: 'holeM8', category: 'holes', spec: 'M8 ⌀8.6',
    keywords: ['hole', 'm8', 'drill', 'kong', '孔', '钻孔'],
    build: () => ({ ...createCylinder(4.3, 20), name: 'M8 hole' }),
  },

  // ---- Fun / starter shapes ----
  {
    id: 'star', category: 'fun', spec: '⌀30×4',
    keywords: ['star', 'decoration', 'xing', 'xing', '星', '五角星'],
    build: () => ({
      ...createExtrude({ profile: starProfile(5, 15, 6.5), direction: { x: 0, y: 1, z: 0 }, distance: 4 }),
      name: 'Star',
    }),
  },
  {
    id: 'pyramid', category: 'fun', spec: '24×24×22',
    keywords: ['pyramid', 'taper', 'jiao', 'zhui', '金字塔', '锥'],
    build: () => {
      const s = 12;
      const base = [
        { x: -s, y: 0, z: -s }, { x: s, y: 0, z: -s }, { x: s, y: 0, z: s }, { x: -s, y: 0, z: s },
      ];
      const top = base.map((p) => ({ x: p.x / 16, y: 22, z: p.z / 16 }));
      return { ...createLoft(base, top), name: 'Pyramid' };
    },
  },
  {
    id: 'arch', category: 'fun', spec: '32×26×10',
    keywords: ['arch', 'gate', 'tunnel', 'gong', '拱', '拱门'],
    build: buildArch,
  },
  {
    id: 'steps', category: 'fun', spec: '30×30×30',
    keywords: ['steps', 'stairs', 'tai', 'jie', '台阶', '楼梯'],
    build: () => mergeStacked(
      [
        translateBody(createBox(10, 10, 30), { x: -10, y: 0, z: 0 }),
        createBox(10, 20, 30),
        translateBody(createBox(10, 30, 30), { x: 10, y: 0, z: 0 }),
      ],
      'Steps',
    ),
  },
];

/** Look up a part by id (used by the store insert action and the AI tool). */
export function findLibraryPart(id: string): LibraryPart | undefined {
  return LIBRARY_PARTS.find((p) => p.id === id);
}

/**
 * Substring search over id / keywords / spec, case-insensitive. Chinese input
 * matches the Chinese keywords directly (substring, not pinyin).
 */
export function searchLibraryParts(query: string, parts: LibraryPart[] = LIBRARY_PARTS): LibraryPart[] {
  const q = query.trim().toLowerCase();
  if (!q) return parts;
  return parts.filter((p) => {
    const hay = [p.id, p.spec, ...p.keywords].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** The panel's combined category + search filter (pure, unit-tested). */
export function filterLibraryParts(
  query: string,
  category: PartCategoryId | 'all' = 'all',
  parts: LibraryPart[] = LIBRARY_PARTS,
): LibraryPart[] {
  const pool = category === 'all' ? parts : parts.filter((p) => p.category === category);
  return searchLibraryParts(query, pool);
}
