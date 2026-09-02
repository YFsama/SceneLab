/**
 * occt-import-js ships no TypeScript declarations. The module default is an
 * Emscripten MODULARIZE factory: it takes Module overrides (we point
 * locateFile at the Vite ?url wasm asset) and resolves to the import API.
 * The mesh result is structurally typed here.
 */
declare module 'occt-import-js' {
  export interface OcctAttribute {
    array: ArrayLike<number>;
  }
  export interface OcctMeshNode {
    name: string;
    color?: [number, number, number];
    attributes: { position: OcctAttribute; normal?: OcctAttribute };
    index: { array: ArrayLike<number> };
    /** Triangle-index ranges per B-rep face (first/last are triangle indices). */
    brep_faces?: { first: number; last: number; color?: [number, number, number] }[];
  }
  export interface OcctImportResult {
    success: boolean;
    meshes: OcctMeshNode[];
  }
  export interface OcctImportParams {
    linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot';
    linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value';
    linearDeflection?: number;
    angularDeflection?: number;
  }
  export interface OcctImportApi {
    ReadStepFile(content: Uint8Array, params: OcctImportParams | null): OcctImportResult;
  }
  const occtimportjs: (opts?: { locateFile?: (path: string) => string }) => Promise<OcctImportApi>;
  export default occtimportjs;
}
