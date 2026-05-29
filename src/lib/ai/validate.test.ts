import { describe, it, expect } from 'vitest';
import {
  isString, isNumber, isBoolean, isVec3, isStringArray,
  assertString, assertNumber, assertBoolean, assertEnum, assertVec3, assertStringArray,
} from './validate';

describe('type guards', () => {
  it('isString', () => {
    expect(isString('hello')).toBe(true);
    expect(isString(123)).toBe(false);
    expect(isString(null)).toBe(false);
    expect(isString(undefined)).toBe(false);
  });

  it('isNumber', () => {
    expect(isNumber(42)).toBe(true);
    expect(isNumber(0)).toBe(true);
    expect(isNumber(NaN)).toBe(false);
    expect(isNumber('42')).toBe(false);
    expect(isNumber(null)).toBe(false);
  });

  it('isBoolean', () => {
    expect(isBoolean(true)).toBe(true);
    expect(isBoolean(false)).toBe(true);
    expect(isBoolean(0)).toBe(false);
    expect(isBoolean('true')).toBe(false);
  });

  it('isVec3', () => {
    expect(isVec3({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(isVec3({ x: 1, y: 2 })).toBe(false);
    expect(isVec3({ x: 1, y: 2, z: 'a' })).toBe(false);
    expect(isVec3(null)).toBe(false);
    expect(isVec3(42)).toBe(false);
  });

  it('isStringArray', () => {
    expect(isStringArray(['a', 'b'])).toBe(true);
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(['a', 1])).toBe(false);
    expect(isStringArray('a')).toBe(false);
  });
});

describe('assert functions', () => {
  it('assertString', () => {
    expect(assertString('hello', 'test')).toBe('hello');
    expect(() => assertString(123, 'test')).toThrow('Expected test to be a string');
  });

  it('assertNumber', () => {
    expect(assertNumber(42, 'test')).toBe(42);
    expect(() => assertNumber('42', 'test')).toThrow('Expected test to be a number');
    expect(() => assertNumber(NaN, 'test')).toThrow('Expected test to be a number');
  });

  it('assertBoolean', () => {
    expect(assertBoolean(true, 'test')).toBe(true);
    expect(() => assertBoolean(0, 'test')).toThrow('Expected test to be a boolean');
  });

  it('assertEnum', () => {
    const values = ['xy', 'xz', 'yz'] as const;
    expect(assertEnum('xy', values, 'plane')).toBe('xy');
    expect(() => assertEnum('ab', values, 'plane')).toThrow('Expected plane to be one of');
    expect(() => assertEnum(123, values, 'plane')).toThrow('Expected plane to be one of');
  });

  it('assertVec3', () => {
    const v = { x: 1, y: 2, z: 3 };
    expect(assertVec3(v, 'test')).toEqual(v);
    expect(() => assertVec3({}, 'test')).toThrow('Expected test to be a Vec3');
  });

  it('assertStringArray', () => {
    expect(assertStringArray(['a', 'b'], 'test')).toEqual(['a', 'b']);
    expect(() => assertStringArray([1, 2], 'test')).toThrow('Expected test to be a string array');
  });
});
