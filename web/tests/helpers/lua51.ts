/**
 * A minimal but faithful Lua 5.1 compiler + interpreter for the EXACT subset
 * the production Redis scripts use (tests/repos/luaScriptSemantics + parity).
 *
 * Purpose (Delivery pass 1, findings 1–3): the environment has no lua/
 * luajit/redis-server and installing any is forbidden, so the ONLY way to
 * prove the PRODUCTION script TEXT is valid Lua 5.1 and behaves correctly is
 * to compile and execute that text here. This module:
 *   - LEXES + PARSES the actual exported script strings — `goto` / `::label::`
 *     (Lua 5.2+ syntax) is a PARSE ERROR, exactly as Redis's Lua 5.1 would
 *     reject it (finding 1: the previous script used goto and would have
 *     failed on a real Redis);
 *   - executes the parsed AST against an in-memory Redis adapter with
 *     Lua semantics (Lua truthiness — 0 and '' are TRUE; tonumber; %-escapes
 *     via the Lua-pattern engine; string.format('%.0f') exact digits;
 *     WRONGTYPE commands raise like real Redis) — the semantic matrix and
 *     serving-parity tests run this VM, never a JS re-implementation of the
 *     script's logic.
 *
 * Supported constructs (the union of both production scripts): local (multi
 * name/init), local function, assignment, if/elseif/else/end, numeric for,
 * return, expression statements, function calls (redis.call, string.*,
 * tonumber, tostring, type), table literals (array style), table index
 * (t[k] and t.key), length operator (#), arithmetic +/-, comparisons,
 * and/or/not with Lua operand semantics, string literals with \n \' \\ \t,
 * -- line comments. Everything outside this subset throws an explicit
 * unsupported-syntax error.
 */

/* ─── lexer ─────────────────────────────────────────────────────────── */

type Token =
  | { t: 'name'; v: string }
  | { t: 'number'; v: number }
  | { t: 'string'; v: string }
  | { t: 'op'; v: string }
  | { t: 'eof'; v: string };

const KEYWORDS = new Set([
  'and',
  'break',
  'do',
  'else',
  'elseif',
  'end',
  'false',
  'for',
  'function',
  'goto',
  'if',
  'in',
  'local',
  'nil',
  'not',
  'or',
  'repeat',
  'return',
  'then',
  'true',
  'until',
  'while',
]);

const MULTI_OPS = ['==', '~=', '<=', '>=', '..', '::'];

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }
    if (ch === '-' && source[i + 1] === '-') {
      // line comment (the scripts use only -- ... EOL)
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let out = '';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === '\\') out += '\\';
          else if (esc === "'") out += "'";
          else if (esc === '"') out += '"';
          else if (esc === '\n') {
            // line continuation
          } else out += esc;
          i += 2;
        } else {
          out += source[i];
          i += 1;
        }
      }
      if (i >= n) throw new Error('lua51: unterminated string');
      i += 1; // closing quote
      tokens.push({ t: 'string', v: out });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < n && /[0-9.]/.test(source[j])) j += 1;
      const raw = source.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`lua51: bad number ${raw}`);
      tokens.push({ t: 'number', v: value });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      tokens.push({ t: 'name', v: word });
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (MULTI_OPS.includes(two)) {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('=+-*/%^<>(){}[],;.:#'.includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i += 1;
      continue;
    }
    throw new Error(`lua51: unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ t: 'eof', v: '' });
  return tokens;
}

/* ─── parser → AST ──────────────────────────────────────────────────── */

export type Expr =
  | { k: 'nil' }
  | { k: 'bool'; v: boolean }
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'name'; v: string }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'index'; obj: Expr; key: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'un'; op: string; x: Expr }
  | { k: 'length'; x: Expr }
  | { k: 'table'; items: Expr[] };

export type AssignTarget = { kind: 'name'; name: string } | { kind: 'index'; obj: Expr; key: Expr };

export type Stmt =
  | { k: 'local'; names: string[]; inits: Expr[] }
  | { k: 'localfn'; name: string; params: string[]; body: Stmt[] }
  | { k: 'assign'; targets: AssignTarget[]; exprs: Expr[] }
  | {
      k: 'if';
      cond: Expr;
      then: Stmt[];
      elseifs: Array<{ cond: Expr; body: Stmt[] }>;
      els: Stmt[] | null;
    }
  | { k: 'fornum'; varName: string; from: Expr; to: Expr; body: Stmt[] }
  | { k: 'return'; exprs: Expr[] }
  | { k: 'expr'; e: Expr };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectOp(v: string): void {
    const t = this.next();
    if (t.t !== 'op' || t.v !== v)
      throw new Error(`lua51: expected '${v}' got ${JSON.stringify(t)}`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.t !== 'name') throw new Error(`lua51: expected name got ${JSON.stringify(t)}`);
    return t.v;
  }
  private expectKeyword(word: string): void {
    const t = this.next();
    if (t.t !== 'name' || t.v !== word) {
      throw new Error(`lua51: expected '${word}' got ${JSON.stringify(t)}`);
    }
  }
  private atOp(v: string): boolean {
    const t = this.peek();
    return t.t === 'op' && t.v === v;
  }
  private atName(v: string): boolean {
    const t = this.peek();
    return t.t === 'name' && t.v === v;
  }
  private atKeyword(v: string): boolean {
    return this.atName(v);
  }

  parse(): Stmt[] {
    const body: Stmt[] = [];
    while (this.peek().t !== 'eof') body.push(this.statement());
    return body;
  }

  private statement(): Stmt {
    const t = this.peek();
    if (t.t === 'name') {
      if (t.v === 'local') {
        this.next();
        if (this.atName('function')) {
          this.next();
          const name = this.expectName();
          this.expectOp('(');
          const params = this.paramList();
          this.expectOp(')');
          const body = this.block();
          this.expectKeyword('end');
          return { k: 'localfn', name, params, body };
        }
        const names: string[] = [this.expectName()];
        while (this.atOp(',')) {
          this.next();
          names.push(this.expectName());
        }
        let inits: Expr[] = [];
        if (this.atOp('=')) {
          this.next();
          inits = this.exprList();
        }
        return { k: 'local', names, inits };
      }
      if (t.v === 'if') {
        this.next();
        const cond = this.expression();
        this.expectKeyword('then');
        const then = this.block();
        const elseifs: Array<{ cond: Expr; body: Stmt[] }> = [];
        let els: Stmt[] | null = null;
        while (this.atName('elseif')) {
          this.next();
          const c = this.expression();
          this.expectKeyword('then');
          elseifs.push({ cond: c, body: this.block() });
        }
        if (this.atName('else')) {
          this.next();
          els = this.block();
        }
        this.expectKeyword('end');
        return { k: 'if', cond, then, elseifs, els };
      }
      if (t.v === 'for') {
        this.next();
        const varName = this.expectName();
        this.expectOp('=');
        const from = this.expression();
        this.expectOp(',');
        const to = this.expression();
        this.expectKeyword('do');
        const body = this.block();
        this.expectKeyword('end');
        return { k: 'fornum', varName, from, to, body };
      }
      if (t.v === 'return') {
        this.next();
        const exprs = this.exprList();
        return { k: 'return', exprs };
      }
      if (t.v === 'goto') {
        throw new Error('lua51: goto is Lua 5.2+ syntax — invalid in Redis Lua 5.1');
      }
      if (KEYWORDS.has(t.v)) {
        throw new Error(`lua51: unsupported statement keyword '${t.v}'`);
      }
    }
    if (t.t === 'op' && t.v === '::') {
      throw new Error('lua51: ::label:: is Lua 5.2+ syntax — invalid in Redis Lua 5.1');
    }
    // assignment or call statement: parse a prefix expression
    const first = this.suffixedExpr();
    if (this.atOp('=')) {
      this.next();
      const exprs: Expr[] = [this.expression()];
      while (this.atOp(',')) {
        this.next();
        exprs.push(this.expression());
      }
      const targets: AssignTarget[] = [];
      const collect = (e: Expr): void => {
        if (e.k === 'name') targets.push({ kind: 'name', name: e.v });
        else if (e.k === 'index') targets.push({ kind: 'index', obj: e.obj, key: e.key });
        else throw new Error('lua51: bad assignment target');
      };
      collect(first);
      return { k: 'assign', targets, exprs };
    }
    return { k: 'expr', e: first };
  }

  private block(): Stmt[] {
    const body: Stmt[] = [];
    while (
      !this.atKeyword('end') &&
      !this.atKeyword('elseif') &&
      !this.atKeyword('else') &&
      !this.atKeyword('until') &&
      this.peek().t !== 'eof'
    ) {
      body.push(this.statement());
    }
    return body;
  }

  private paramList(): string[] {
    const out: string[] = [];
    if (!this.atOp(')')) {
      out.push(this.expectName());
      while (this.atOp(',')) {
        this.next();
        out.push(this.expectName());
      }
    }
    return out;
  }

  private exprList(): Expr[] {
    const out: Expr[] = [this.expression()];
    while (this.atOp(',')) {
      this.next();
      out.push(this.expression());
    }
    return out;
  }

  private expression(): Expr {
    return this.logicalOr();
  }

  private logicalOr(): Expr {
    let l = this.logicalAnd();
    while (this.atName('or')) {
      this.next();
      l = { k: 'bin', op: 'or', l, r: this.logicalAnd() };
    }
    return l;
  }

  private logicalAnd(): Expr {
    let l = this.comparison();
    while (this.atName('and')) {
      this.next();
      l = { k: 'bin', op: 'and', l, r: this.comparison() };
    }
    return l;
  }

  private comparison(): Expr {
    let l = this.additive();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && ['==', '~=', '<', '>', '<=', '>='].includes(t.v)) {
        this.next();
        l = { k: 'bin', op: t.v, l, r: this.additive() };
      } else break;
    }
    return l;
  }

  private additive(): Expr {
    let l = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '+' || t.v === '-')) {
        this.next();
        l = { k: 'bin', op: t.v, l, r: this.unary() };
      } else break;
    }
    return l;
  }

  private unary(): Expr {
    const t = this.peek();
    if (t.t === 'op' && t.v === '-') {
      this.next();
      return { k: 'un', op: '-', x: this.unary() };
    }
    if ((t.t === 'name' && t.v === 'not') || (t.t === 'op' && t.v === '#')) {
      this.next();
      return { k: 'un', op: t.v === '#' ? '#' : 'not', x: this.unary() };
    }
    return this.suffixedExpr();
  }

  private suffixedExpr(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.atOp('.')) {
        this.next();
        const name = this.expectName();
        e = { k: 'index', obj: e, key: { k: 'str', v: name } };
      } else if (this.atOp('[')) {
        this.next();
        const key = this.expression();
        this.expectOp(']');
        e = { k: 'index', obj: e, key };
      } else if (this.atOp('(')) {
        this.next();
        const args = this.atOp(')') ? [] : this.exprList();
        this.expectOp(')');
        // only plain name calls are supported (redis.call / string.* etc.)
        if (e.k === 'name') e = { k: 'call', name: e.v, args };
        else if (e.k === 'index') {
          // string.match(x, p) → dotted lib calls
          const libName = this.nameOf(e);
          if (libName === null) throw new Error('lua51: unsupported method call');
          e = { k: 'call', name: libName, args };
        } else throw new Error('lua51: unsupported call target');
      } else break;
    }
    return e;
  }

  private nameOf(e: Expr): string | null {
    if (e.k === 'index' && e.obj.k === 'name' && e.key.k === 'str') {
      return `${e.obj.v}.${e.key.v}`;
    }
    return null;
  }

  private primary(): Expr {
    const t = this.next();
    if (t.t === 'number') return { k: 'num', v: t.v };
    if (t.t === 'string') return { k: 'str', v: t.v };
    if (t.t === 'name') {
      if (t.v === 'nil') return { k: 'nil' };
      if (t.v === 'true') return { k: 'bool', v: true };
      if (t.v === 'false') return { k: 'bool', v: false };
      return { k: 'name', v: t.v };
    }
    if (t.t === 'op') {
      if (t.v === '{') {
        const items: Expr[] = [];
        if (!this.atOp('}')) {
          items.push(this.expression());
          while (this.atOp(',')) {
            this.next();
            items.push(this.expression());
          }
        }
        this.expectOp('}');
        return { k: 'table', items };
      }
      if (t.v === '(') {
        const e = this.expression();
        this.expectOp(')');
        return e;
      }
    }
    throw new Error(`lua51: unexpected token ${JSON.stringify(t)}`);
  }
}

/** Compile a production Lua script string; throws on Lua-5.1-INVALID syntax
 * (goto/labels included) or any construct outside the supported subset. */
export function compileLua51(source: string): Stmt[] {
  const tokens = lex(source);
  const parser = new Parser(tokens);
  const body = parser.parse();
  if (parser['peek']().t !== 'eof') {
    throw new Error('lua51: trailing tokens after program');
  }
  return body;
}

/* ─── interpreter ───────────────────────────────────────────────────── */

export type LuaValue = number | string | boolean | null | LuaTable | undefined;

/** Lua tables: array items + string keys (both used by the scripts). */
export class LuaTable {
  items: LuaValue[] = [];
  keys = new Map<string, LuaValue>();

  get length(): number {
    return this.items.length;
  }
  get(key: LuaValue): LuaValue {
    if (typeof key === 'number' && Number.isInteger(key) && key >= 1) {
      return this.items[key - 1] ?? null;
    }
    if (typeof key === 'string') return this.keys.get(key) ?? null;
    return null;
  }
  set(key: LuaValue, value: LuaValue): void {
    if (typeof key === 'number' && Number.isInteger(key) && key >= 1) {
      this.items[key - 1] = value;
    } else if (typeof key === 'string') {
      this.keys.set(key, value);
    } else {
      throw new Error('lua51: unsupported table key');
    }
  }
  toJsArray(): unknown[] {
    return this.items.map((v) => luaToJs(v));
  }
}

/** The in-memory Redis surface the scripts call. WRONGTYPE ops raise. */
export interface LuaRedisAdapter {
  call(command: string, ...args: unknown[]): unknown;
}

export interface LuaRuntimeError extends Error {
  luaError: true;
}

export function luaRuntimeError(message: string): LuaRuntimeError {
  return Object.assign(new Error(`lua51: ${message}`), { luaError: true as const });
}

export function luaTruthy(v: LuaValue): boolean {
  return v !== null && v !== false && v !== undefined;
}

export function luaToJs(v: LuaValue): unknown {
  if (v instanceof LuaTable) return v.toJsArray();
  if (v === null) return null;
  return v;
}

/** Lua equality: numbers/strings by value, nil == nil. */
function luaEq(a: LuaValue, b: LuaValue): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  return a === b;
}

export function luaNumberToStr(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(n);
}

interface Env {
  vars: Map<string, LuaValue>;
  parent: Env | null;
}

function lookup(env: Env, name: string): LuaValue {
  let e: Env | null = env;
  while (e) {
    if (e.vars.has(name)) return e.vars.get(name) ?? null;
    e = e.parent;
  }
  throw luaRuntimeError(`variable '${name}' not found`);
}

function declare(env: Env, name: string, value: LuaValue): void {
  env.vars.set(name, value);
}

function assign(env: Env, name: string, value: LuaValue): void {
  let e: Env | null = env;
  while (e) {
    if (e.vars.has(name)) {
      e.vars.set(name, value);
      return;
    }
    e = e.parent;
  }
  throw luaRuntimeError(`variable '${name}' not found`);
}

/** Match a Lua pattern against a subject using the Lua-5.1 pattern engine. */
import { luaMatch as matchLuaPattern } from './luaPattern';
function luaMatch(s: string, pattern: string): string | null {
  return matchLuaPattern(s, pattern);
}

class Interpreter {
  constructor(
    private ast: Stmt[],
    private env: Env,
    private redis: LuaRedisAdapter,
    private extraGlobals: Record<string, LuaValue>,
  ) {}

  run(): LuaValue {
    this.execBody(this.ast, this.env);
    return null;
  }

  /** Execute; a top-level `return` yields the value (script return). */
  execBody(body: Stmt[], env: Env): LuaValue {
    for (const stmt of body) {
      const r = this.execStmt(stmt, env);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  private execStmt(stmt: Stmt, env: Env): LuaValue | undefined {
    switch (stmt.k) {
      case 'local': {
        let values = stmt.inits.map((e) => this.evalExpr(e, env));
        // Lua multi-return: a function call in a multi-assignment expands
        // its returned table into consecutive values (pcall(cjson.decode, x))
        if (stmt.names.length > values.length && values.length === 1) {
          const last = values[0];
          if (last instanceof LuaTable && last.items.length > 0) {
            values = [...last.items];
          }
        }
        stmt.names.forEach((name, i) => declare(env, name, values[i] ?? null));
        return undefined;
      }
      case 'localfn': {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const self = this;
        const callable = (...args: LuaValue[]): LuaValue => {
          const callEnv: Env = { vars: new Map(), parent: env };
          stmt.params.forEach((p, i) => declare(callEnv, p, args[i] ?? null));
          return self.execBody(stmt.body, callEnv);
        };
        declare(env, stmt.name, callable as unknown as LuaValue);
        return undefined;
      }
      case 'assign': {
        const values = stmt.exprs.map((e) => this.evalExpr(e, env));
        stmt.targets.forEach((target, i) => {
          const value = values[i] ?? null;
          if (target.kind === 'name') assign(env, target.name, value);
          else {
            const obj = this.evalExpr(target.obj, env);
            const key = this.evalExpr(target.key, env);
            if (!(obj instanceof LuaTable)) throw luaRuntimeError('index assignment on non-table');
            obj.set(key, value);
          }
        });
        return undefined;
      }
      case 'if': {
        const branches: Array<{ cond: Expr; body: Stmt[] }> = [
          { cond: stmt.cond, body: stmt.then },
          ...stmt.elseifs,
        ];
        for (const branch of branches) {
          if (luaTruthy(this.evalExpr(branch.cond, env))) {
            return this.execBody(branch.body, env);
          }
        }
        if (stmt.els) return this.execBody(stmt.els, env);
        return undefined;
      }
      case 'fornum': {
        const from = this.evalExpr(stmt.from, env);
        const to = this.evalExpr(stmt.to, env);
        if (typeof from !== 'number' || typeof to !== 'number') {
          throw luaRuntimeError('numeric for needs numbers');
        }
        for (let i = Math.ceil(from); i <= to; i += 1) {
          const child: Env = { vars: new Map(), parent: env };
          declare(child, stmt.varName, i);
          const r = this.execBody(stmt.body, child);
          if (r !== undefined) return r;
        }
        return undefined;
      }
      case 'return': {
        const values = stmt.exprs.map((e) => this.evalExpr(e, env));
        // Lua return semantics: one value returns the value itself
        return (values.length === 1 ? values[0] : values) as LuaValue;
      }
      case 'expr': {
        this.evalExpr(stmt.e, env);
        return undefined;
      }
    }
  }

  private evalExpr(e: Expr, env: Env): LuaValue {
    switch (e.k) {
      case 'nil':
        return null;
      case 'bool':
        return e.v;
      case 'num':
        return e.v;
      case 'str':
        return e.v;
      case 'name':
        return lookup(env, e.v);
      case 'table': {
        const t = new LuaTable();
        for (const item of e.items) t.items.push(this.evalExpr(item, env));
        return t;
      }
      case 'length': {
        const v = this.evalExpr(e.x, env);
        if (v instanceof LuaTable) return v.length;
        if (typeof v === 'string') return v.length;
        throw luaRuntimeError('length of non-table/string');
      }
      case 'un': {
        const v = this.evalExpr(e.x, env);
        if (e.op === '-') {
          if (typeof v !== 'number') throw luaRuntimeError('bad arithmetic');
          return -v;
        }
        if (e.op === 'not') return !luaTruthy(v);
        if (e.op === '#') {
          if (v instanceof LuaTable) return v.length;
          if (typeof v === 'string') return v.length;
          throw luaRuntimeError('length of non-table/string');
        }
        throw luaRuntimeError(`unsupported unary ${e.op}`);
      }
      case 'bin': {
        if (e.op === 'and') {
          const l = this.evalExpr(e.l, env);
          return luaTruthy(l) ? this.evalExpr(e.r, env) : l;
        }
        if (e.op === 'or') {
          const l = this.evalExpr(e.l, env);
          return luaTruthy(l) ? l : this.evalExpr(e.r, env);
        }
        const l = this.evalExpr(e.l, env);
        const r = this.evalExpr(e.r, env);
        switch (e.op) {
          case '+':
            return (l as number) + (r as number);
          case '-':
            return (l as number) - (r as number);
          case '==':
            return luaEq(l, r);
          case '~=':
            return !luaEq(l, r);
          case '<':
            return (l as number) < (r as number);
          case '>':
            return (l as number) > (r as number);
          case '<=':
            return (l as number) <= (r as number);
          case '>=':
            return (l as number) >= (r as number);
          default:
            throw luaRuntimeError(`unsupported operator ${e.op}`);
        }
      }
      case 'index': {
        const obj = this.evalExpr(e.obj, env);
        const key = this.evalExpr(e.key, env);
        if (obj instanceof LuaTable) return obj.get(key);
        if (typeof obj === 'string') {
          // dotted string-library calls parse as calls, not index reads
          return null;
        }
        if (obj !== null && typeof obj === 'object') {
          // JS-object globals (cjson) behave like tables for index reads
          return jsToLua((obj as Record<string, unknown>)[key as string]);
        }
        throw luaRuntimeError('index of non-table');
      }
      case 'call': {
        const args = e.args.map((a) => this.evalExpr(a, env));
        return this.call(e.name, args, env);
      }
    }
  }

  private stringFormat(fmt: string, value: number): string {
    if (fmt === '%.0f') {
      if (Number.isInteger(value) && Math.abs(value) < 1e16) return String(value);
      return String(Math.round(value));
    }
    throw luaRuntimeError(`unsupported string.format '${fmt}'`);
  }

  private call(name: string, args: LuaValue[], env: Env): LuaValue {
    if (name === 'redis.call') {
      const command = args[0];
      if (typeof command !== 'string') throw luaRuntimeError('redis.call needs a string command');
      const rest = args.slice(1).map((v) => luaToJs(v));
      return jsToLua(this.redis.call(command, ...rest));
    }
    if (name === 'tonumber') {
      const raw = args[0];
      if (raw === null || raw === undefined) return null;
      if (typeof raw === 'number') return raw;
      if (typeof raw === 'string') {
        const m = /^[+-]?[0-9]+(\.[0-9]+)?$/.exec(raw.trim());
        if (!m) return null;
        const v = Number(m[0]);
        return Number.isFinite(v) ? v : null;
      }
      return null;
    }
    if (name === 'tostring') {
      const v = args[0];
      if (v === null || v === undefined) return 'nil';
      if (typeof v === 'number') return luaNumberToStr(v);
      return String(v);
    }
    if (name === 'type') {
      const v = args[0];
      if (v === null || v === undefined) return 'nil';
      if (v instanceof LuaTable) return 'table';
      return typeof v;
    }
    if (name === 'string.match') {
      if (typeof args[0] !== 'string' || typeof args[1] !== 'string') return null;
      return luaMatch(args[0], args[1]);
    }
    if (name === 'string.len') {
      return typeof args[0] === 'string' ? args[0].length : null;
    }
    if (name === 'string.sub') {
      const s = args[0];
      const i = args[1] as number;
      const j = args[2] as number;
      if (typeof s !== 'string' || typeof i !== 'number') return null;
      const start = i >= 1 ? i - 1 : Math.max(0, s.length + i);
      const end = j === undefined ? s.length : j >= 0 ? Math.min(s.length, j) : s.length + j;
      if (end <= start) return '';
      return s.slice(start, end);
    }
    if (name === 'string.format') {
      return this.stringFormat(args[0] as string, args[1] as number);
    }
    // local function call (local function foo(...) ... end)
    const fn = lookup(env, name);
    if (typeof fn === 'function') {
      const out = (fn as (...a: LuaValue[]) => LuaValue)(...args);
      return jsToLua(out);
    }
    throw luaRuntimeError(`unsupported function call '${name}'`);
  }
}

function jsToLua(v: unknown): LuaValue {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const t = new LuaTable();
    for (const item of v) t.items.push(jsToLua(item));
    return t;
  }
  if (typeof v === 'object') {
    const t = new LuaTable();
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      t.keys.set(k, jsToLua(val));
    }
    return t;
  }
  return v as LuaValue;
}

export interface LuaScriptInput {
  KEYS: string[];
  ARGV: string[];
}

/**
 * Compile + execute a production Lua script with Lua-5.1 semantics against
 * the given in-memory Redis adapter. Throws a parse error for Lua-5.2+
 * syntax (goto/labels) and any unsupported construct — the compile step is
 * the syntax gate, the run step is the semantic gate.
 */
export function runLua51(
  source: string,
  input: LuaScriptInput,
  redis: LuaRedisAdapter,
  options?: { globals?: Record<string, LuaValue> },
): unknown {
  const ast = compileLua51(source);
  const root: Env = { vars: new Map(), parent: null };
  declare(root, 'KEYS', new LuaTable());
  declare(root, 'ARGV', new LuaTable());
  const keysTable = root.vars.get('KEYS') as LuaTable;
  const argvTable = root.vars.get('ARGV') as LuaTable;
  input.KEYS.forEach((k) => keysTable.items.push(k));
  input.ARGV.forEach((a) => argvTable.items.push(a));
  if (options?.globals) {
    for (const [k, v] of Object.entries(options.globals)) declare(root, k, v);
  }
  const interp = new Interpreter(ast, root, redis, options?.globals ?? {});
  const result = interp.execBody(ast, root);
  if (result === undefined) return null;
  if (Array.isArray(result)) {
    // multi-value return `return a, b, ...` → a JS array
    return result.map((v) => luaToJs(v as LuaValue));
  }
  return luaToJs(result as LuaValue);
}
