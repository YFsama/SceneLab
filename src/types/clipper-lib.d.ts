/**
 * clipper-lib@6.4.2 ships no TypeScript declarations. It is a UMD/CJS bundle
 * (`module.exports = ClipperLib`), so the whole library arrives as one default
 * export; this file declares only the subset the CAM offset layer uses
 * (ClipperOffset + PolyTree). Angus Johnson's Clipper is orientation-algebraic:
 * a positive shoelace area is "outer", a negative one is a hole — the library
 * never inspects which way the display Y axis points.
 */
declare module 'clipper-lib' {
  export interface ClipperIntPoint {
    X: number;
    Y: number;
  }

  export interface ClipperPolyNode {
    ChildCount(): number;
    Childs(): ClipperPolyNode[];
    /** The node's polygon in scaled integer coordinates (last ≠ first). */
    Contour(): ClipperIntPoint[];
    IsHole(): boolean;
    Parent(): ClipperPolyNode | null;
  }

  /** Result tree of {@link ClipperOffset.Execute}: children are outer rings,
   * grandchildren the holes nested inside them. */
  export interface ClipperPolyTree extends ClipperPolyNode {
    Total(): number;
  }

  export interface ClipperOffset {
    AddPath(path: ClipperIntPoint[], joinType: number, endType: number): void;
    AddPaths(paths: ClipperIntPoint[][], joinType: number, endType: number): void;
    Execute(solution: ClipperPolyTree, delta: number): void;
    Clear(): void;
  }

  const ClipperLib: {
    ClipperOffset: new (miterLimit?: number, arcTolerance?: number) => ClipperOffset;
    PolyTree: new () => ClipperPolyTree;
    JoinType: { jtSquare: number; jtRound: number; jtMiter: number };
    EndType: {
      etOpenSquare: number;
      etOpenRound: number;
      etOpenButt: number;
      etClosedLine: number;
      etClosedPolygon: number;
    };
  };

  export default ClipperLib;
}
