// CAD-style numeric expression evaluation for dimension fields.
//
// Real CAD tools (Fusion 360, SolidWorks) evaluate arithmetic in every
// numeric field: typing `20/2`, `(30-6)/3` or `2*pi` commits the computed
// value instead of being rejected as text. This module provides that for
// SceneLab's dialogs via a small recursive-descent parser — no eval(), no
// Function(), so field text can never execute arbitrary code.

/**
 * A lexical token produced while scanning a dimension expression.
 */
type Token =
  | { kind: 'number'; value: number }
  | { kind: 'constant'; value: number }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const DIGIT_RE = /[0-9]/;
const LETTER_RE = /[a-zA-Z]/;

/**
 * Split an input string into tokens, or return `null` on any character that
 * cannot appear in a dimension expression.
 *
 * Numbers accept integer, fractional (`12.5`, `.5`, `12.`) and exponent
 * (`1e3`, `2.5E-2`) notation. The only accepted identifier is `pi`
 * (case-insensitive), mapped to `Math.PI`.
 */
function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ kind: 'op', op: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (DIGIT_RE.test(ch) || ch === '.') {
      const start = i;
      while (i < input.length && DIGIT_RE.test(input[i]!)) i += 1;
      if (input[i] === '.') {
        i += 1;
        while (i < input.length && DIGIT_RE.test(input[i]!)) i += 1;
      }
      const mantissa = input.slice(start, i);
      // A lone `.` or a second decimal point (`1.2.3`) is invalid.
      if (mantissa === '.' || !/^(\d+\.?\d*|\.\d+)$/.test(mantissa)) return null;
      // Consume an exponent only when it is well-formed (`e`, `E`, optional
      // sign, at least one digit) so `2e` still fails instead of half-parsing.
      let end = i;
      if (input[i] === 'e' || input[i] === 'E') {
        let j = i + 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        const digitsStart = j;
        while (j < input.length && DIGIT_RE.test(input[j]!)) j += 1;
        if (j > digitsStart) end = j;
      }
      const value = Number(input.slice(start, end));
      if (!Number.isFinite(value)) return null; // e.g. `1e999` overflows
      tokens.push({ kind: 'number', value });
      i = end;
      continue;
    }
    if (LETTER_RE.test(ch)) {
      const start = i;
      while (i < input.length && LETTER_RE.test(input[i]!)) i += 1;
      const word = input.slice(start, i);
      if (word.toLowerCase() === 'pi') {
        tokens.push({ kind: 'constant', value: Math.PI });
        continue;
      }
      return null; // unknown identifier
    }
    return null; // unknown character
  }
  return tokens;
}

/**
 * Recursive-descent parser over the token stream.
 *
 * Grammar (precedence from lowest to highest, all binary operators
 * left-associative):
 *
 * ```text
 * expr    := term (('+' | '-') term)*
 * term    := unary (('*' | '/') unary)*
 * unary   := ('-' | '+') unary | primary
 * primary := NUMBER | 'pi' | '(' expr ')'
 * ```
 */
class DimensionParser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  /** Parse the whole stream; `null` on syntax errors or leftover tokens. */
  parse(): number | null {
    const value = this.parseExpr();
    if (value === null) return null;
    // Everything must be consumed: `3)` or `1 2` are not valid expressions.
    if (this.pos !== this.tokens.length) return null;
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseExpr(): number | null {
    let left = this.parseTerm();
    if (left === null) return null;
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.op === '+' || t.op === '-')) {
        this.pos += 1;
        const right = this.parseTerm();
        if (right === null) return null;
        left = t.op === '+' ? left + right : left - right;
      } else {
        return left;
      }
    }
  }

  private parseTerm(): number | null {
    let left = this.parseUnary();
    if (left === null) return null;
    for (;;) {
      const t = this.peek();
      if (t && t.kind === 'op' && (t.op === '*' || t.op === '/')) {
        this.pos += 1;
        const right = this.parseUnary();
        if (right === null) return null;
        // Division by zero yields ±Infinity / NaN, rejected by the final
        // finite check in {@link evalDimension}.
        left = t.op === '*' ? left * right : left / right;
      } else {
        return left;
      }
    }
  }

  private parseUnary(): number | null {
    const t = this.peek();
    if (t && t.kind === 'op' && (t.op === '-' || t.op === '+')) {
      this.pos += 1;
      const value = this.parseUnary();
      if (value === null) return null;
      return t.op === '-' ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number | null {
    const t = this.peek();
    if (t && (t.kind === 'number' || t.kind === 'constant')) {
      this.pos += 1;
      return t.value;
    }
    if (t && t.kind === 'lparen') {
      this.pos += 1;
      const value = this.parseExpr();
      if (value === null) return null;
      const close = this.peek();
      if (!close || close.kind !== 'rparen') return null;
      this.pos += 1;
      return value;
    }
    return null;
  }
}

/**
 * Evaluate a CAD-style dimension expression.
 *
 * Supports `+ - * /`, parentheses, unary minus/plus, decimal numbers,
 * exponent notation and the constant `pi` (case-insensitive). Whitespace is
 * ignored. No eval/Function is involved.
 *
 * @param input Raw field text, e.g. `"20/2"` or `"(30-6)/3"`.
 * @returns The computed value, or `null` when the input is empty,
 *   syntactically invalid, or evaluates to a non-finite number (NaN, ±Infinity
 *   — so `1/0` is rejected).
 *
 * @example
 * evalDimension('20/2');      // 10
 * evalDimension('2*pi*5');    // 31.41592653589793
 * evalDimension('5+');        // null
 * evalDimension('1/0');       // null (Infinity is non-finite)
 */
export function evalDimension(input: string): number | null {
  if (typeof input !== 'string') return null;
  const tokens = tokenize(input);
  if (tokens === null || tokens.length === 0) return null; // empty/whitespace-only
  const result = new DimensionParser(tokens).parse();
  if (result === null || !Number.isFinite(result)) return null;
  return result;
}

/** Matches plain decimal numbers (with optional sign and exponent) — no operators. */
const PLAIN_NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Whether a text is a plain number (no expression operators involved).
 * Used by dialogs to decide whether an "= result" preview is worth showing.
 */
export function isPlainNumber(text: string): boolean {
  const trimmed = text.trim();
  return trimmed !== '' && PLAIN_NUMBER_RE.test(trimmed);
}

/**
 * Resolve dimension field text to a commit value, falling back gracefully.
 *
 * Plain numbers (including exponent notation) pass through unchanged;
 * anything else is evaluated as an expression; when neither works the
 * caller-supplied fallback (usually the field's current value) is returned.
 *
 * @param input    Raw field text.
 * @param fallback Value returned when the text is empty or invalid.
 *
 * @example
 * parseDimensionField('10', 5);     // 10
 * parseDimensionField('20/2', 1);   // 10
 * parseDimensionField('abc', 7);    // 7
 */
export function parseDimensionField(input: string, fallback: number): number {
  const trimmed = input.trim();
  if (isPlainNumber(trimmed)) {
    const value = Number(trimmed);
    if (Number.isFinite(value)) return value;
  }
  const evaluated = evalDimension(input);
  return evaluated === null ? fallback : evaluated;
}

/**
 * Format an evaluated dimension for display in live previews, trimming
 * floating-point noise so `0.1+0.2` previews as `= 0.3` rather than
 * `= 0.30000000000000004`.
 */
export function formatDimensionValue(value: number): string {
  return String(Number(value.toPrecision(12)));
}
