import type { Vec3 } from '../geometry/types';

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNumber(v: unknown): v is number {
  // Reject NaN and ±Infinity so bad inputs can't produce degenerate geometry.
  return typeof v === 'number' && Number.isFinite(v);
}

export function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export function isVec3(v: unknown): v is Vec3 {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  return isNumber(obj.x) && isNumber(obj.y) && isNumber(obj.z);
}

export function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString);
}

export function assertString(v: unknown, name: string): string {
  if (!isString(v)) throw new Error(`Expected ${name} to be a string`);
  return v;
}

export function assertNumber(v: unknown, name: string): number {
  if (!isNumber(v)) throw new Error(`Expected ${name} to be a number`);
  return v;
}

export function assertBoolean(v: unknown, name: string): boolean {
  if (!isBoolean(v)) throw new Error(`Expected ${name} to be a boolean`);
  return v;
}

export function assertVec3(v: unknown, name: string): Vec3 {
  if (!isVec3(v)) throw new Error(`Expected ${name} to be a Vec3 {x, y, z}`);
  return v;
}

export function assertStringArray(v: unknown, name: string): string[] {
  if (!isStringArray(v)) throw new Error(`Expected ${name} to be a string array`);
  return v;
}

export function assertEnum<T extends string>(v: unknown, values: readonly T[], name: string): T {
  if (!isString(v) || !values.includes(v as T)) {
    throw new Error(`Expected ${name} to be one of: ${values.join(', ')}`);
  }
  return v as T;
}
