// Icon-per-part map for the PartsLibrary gallery (kept out of the component
// file so React fast-refresh sees only components there).
import {
  Square, RectangleVertical, Cylinder, Circle, CircleDot, CircleDashed, Hexagon,
  Triangle, Spline, Donut, Cog, Disc, Star, Pyramid, Landmark, ListOrdered,
  CornerDownLeft, Container,
  type LucideIcon,
} from 'lucide-react';

export const PART_ICONS: Record<string, LucideIcon> = {
  plate: Square,
  bar: RectangleVertical,
  rod: Cylinder,
  ball: Circle,
  column: Cylinder,
  pipe: CircleDot,
  hexStock: Hexagon,
  ramp: Triangle,
  spring: Spline,
  hexNut: Hexagon,
  washer: CircleDot,
  bushing: CircleDot,
  flange: Donut,
  lBracket: CornerDownLeft,
  uBracket: Container,
  gear: Cog,
  knob: Disc,
  holeM3: CircleDashed,
  holeM4: CircleDashed,
  holeM6: CircleDashed,
  holeM8: CircleDashed,
  star: Star,
  pyramid: Pyramid,
  arch: Landmark,
  steps: ListOrdered,
};
