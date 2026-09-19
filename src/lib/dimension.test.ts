import { describe, it, expect } from 'vitest';
import { evalDimension, parseDimensionField, isPlainNumber } from './dimension';

// CAD-style expression evaluation: every numeric field should accept what a
// Fusion 360 / SolidWorks user types — plain numbers and arithmetic — while
// anything unsafe or non-finite is rejected (null) rather than coerced.

describe('evalDimension — plain numbers', () => {
  it('passes plain numbers through', () => {
    expect(evalDimension('10')).toBe(10);
    expect(evalDimension(' 7.5 ')).toBe(7.5);
    expect(evalDimension('-3')).toBe(-3);
    expect(evalDimension('.5')).toBe(0.5);
    expect(evalDimension('12.')).toBe(12);
    expect(evalDimension('1e2')).toBe(100);
    expect(evalDimension('2.5E-2')).toBe(0.025);
  });
});

describe('evalDimension — expressions', () => {
  it('evaluates basic arithmetic', () => {
    expect(evalDimension('20/2')).toBe(10);
    expect(evalDimension('5*2+1.5')).toBe(11.5);
    expect(evalDimension('(30-6)/3')).toBe(8);
    expect(evalDimension('12.5-0.25')).toBe(12.25);
  });

  it('supports the pi constant (case-insensitive)', () => {
    expect(evalDimension('2*pi')).toBeCloseTo(2 * Math.PI, 12);
    expect(evalDimension('2*pi*5')).toBeCloseTo(31.41592653589793, 8);
    expect(evalDimension('PI')).toBeCloseTo(Math.PI, 12);
    expect(evalDimension('Pi/2')).toBeCloseTo(Math.PI / 2, 12);
  });

  it('applies unary minus', () => {
    expect(evalDimension('-5*2')).toBe(-10);
    expect(evalDimension('-(3+2)')).toBe(-5);
    expect(evalDimension('-(-5)')).toBe(5);
    expect(evalDimension('10*-2')).toBe(-20);
  });

  it('respects operator precedence: * and / bind tighter than + and -', () => {
    expect(evalDimension('2+3*4')).toBe(14);
    expect(evalDimension('2*3+4')).toBe(10);
    expect(evalDimension('10-4/2')).toBe(8);
  });

  it('is left-associative for equal precedence', () => {
    expect(evalDimension('20/5/2')).toBe(2);
    expect(evalDimension('10-2-3')).toBe(5);
  });

  it('evaluates nested parentheses', () => {
    expect(evalDimension('((2+3)*(1+1))')).toBe(10);
    expect(evalDimension('((((7))))')).toBe(7);
    expect(evalDimension('(2+3)*(4-1)')).toBe(15);
  });

  it('ignores whitespace anywhere', () => {
    expect(evalDimension(' 20 / 2 ')).toBe(10);
    expect(evalDimension('( 30 - 6 ) / 3')).toBe(8);
  });
});

describe('evalDimension — invalid input returns null', () => {
  it('rejects empty and non-numeric text', () => {
    expect(evalDimension('')).toBeNull();
    expect(evalDimension('   ')).toBeNull();
    expect(evalDimension('abc')).toBeNull();
    expect(evalDimension('pi-ish')).toBeNull();
  });

  it('rejects malformed expressions', () => {
    expect(evalDimension('5+')).toBeNull();
    expect(evalDimension('(3')).toBeNull();
    expect(evalDimension('3)')).toBeNull();
    expect(evalDimension('*5')).toBeNull();
    expect(evalDimension('2**3')).toBeNull();
    expect(evalDimension('1 2')).toBeNull();
    expect(evalDimension('2..5')).toBeNull();
    expect(evalDimension('2e')).toBeNull();
    expect(evalDimension('foo(1)')).toBeNull();
  });

  it('rejects non-finite results', () => {
    expect(evalDimension('1/0')).toBeNull(); // Infinity
    expect(evalDimension('5/2/0')).toBeNull();
    expect(evalDimension('-1/0')).toBeNull();
    expect(evalDimension('0/0')).toBeNull(); // NaN
    expect(evalDimension('1e999')).toBeNull(); // overflow
  });
});

describe('parseDimensionField', () => {
  it('returns plain numbers as-is', () => {
    expect(parseDimensionField('10', 5)).toBe(10);
    expect(parseDimensionField(' 7.5 ', 1)).toBe(7.5);
    expect(parseDimensionField('-3', 0)).toBe(-3);
  });

  it('evaluates expressions', () => {
    expect(parseDimensionField('20/2', 1)).toBe(10);
    expect(parseDimensionField('(30-6)/3', 1)).toBe(8);
    expect(parseDimensionField('2*pi', 1)).toBeCloseTo(2 * Math.PI, 12);
  });

  it('falls back when the text is empty or invalid', () => {
    expect(parseDimensionField('', 7)).toBe(7);
    expect(parseDimensionField('   ', 7)).toBe(7);
    expect(parseDimensionField('abc', 7)).toBe(7);
    expect(parseDimensionField('5+', 7)).toBe(7);
    expect(parseDimensionField('1/0', 7)).toBe(7);
  });
});

describe('isPlainNumber', () => {
  it('accepts plain numbers only', () => {
    expect(isPlainNumber('10')).toBe(true);
    expect(isPlainNumber(' -3.5 ')).toBe(true);
    expect(isPlainNumber('1e3')).toBe(true);
  });

  it('rejects expressions and junk', () => {
    expect(isPlainNumber('20/2')).toBe(false);
    expect(isPlainNumber('2*pi')).toBe(false);
    expect(isPlainNumber('')).toBe(false);
    expect(isPlainNumber('abc')).toBe(false);
  });
});
