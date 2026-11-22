// main.ts is mend, the CLI SPEC.md specifies (MIT). It does SPEC.md sections 1 to 10: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** For a path that holds a file moved here, the path it was moved from (chains collapse). */
  readonly origin = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    if (v === null) this.origin.delete(p);
    this.now.set(p, v);
  }
  move(from: string, to: string, content: string): void {
    const o = this.origin.get(from) ?? from;
    this.set(from, null);
    this.origin.set(to, o);
    this.set(to, content);
  }
}

type Edit = (tree: Tree, strict: boolean) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and three-tier matching (section 5)
// ---------------------------------------------------------------------------

interface Split {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function joinFile(f: Split): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
/** "surrounding spaces removed", as SPEC.md words it for unified and V4A paths. */
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');

const TIER_NORM: ((s: string) => string)[] = [
  (s) => s,
  (s) => trimEndWs(s),
  (s) => trimWs(s),
];

function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const norm = TIER_NORM[tier]!;
  const p = pat.map(norm);
  const out: number[] = [];
  if (p.length === 0) return out;
  for (let i = 0; i + p.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < p.length; j++) {
      if (norm(lines[i + j]!) !== p[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which pat occurs, with its positions. */
function findTier(lines: string[], pat: string[], strict: boolean, from = 0, eofOnly = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(lines, pat, t).filter((p) => p >= from);
    if (eofOnly) occ = occ.filter((p) => p + pat.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of O or N: `ctx` when it is a context line, written as the file's own matched line. */
interface OL {
  text: string;
  ctx: boolean;
}

/** N as it is written over the matched lines at `pos` (SPEC.md section 5). */
function mapNew(fileLines: string[], pos: number, O: OL[], N: OL[], tier: number): string[] {
  const oCtx: number[] = [];
  const nCtx: number[] = [];
  O.forEach((e, i) => {
    if (e.ctx) oCtx.push(i);
  });
  N.forEach((e, i) => {
    if (e.ctx) nCtx.push(i);
  });
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadingWs(fileLines[pos]!);
    P = leadingWs(O[0]!.text);
  }
  return N.map((e, k) => {
    if (e.ctx) {
      const j = nCtx.indexOf(k);
      const oi = j < 0 ? -1 : oCtx[j]!;
      return oi >= 0 ? fileLines[pos + oi]! : e.text;
    }
    if (tier === 2) {
      const t = e.text;
      if (t === '' || /^[ \t]+$/.test(t)) return t;
      if (t.startsWith(P)) return F + t.slice(P.length);
      return t;
    }
    return e.text;
  });
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  pair: { old: string | null; new: string | null } | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, spaces removed. */
function uniPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = trimSpaces(p);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  const fresh = (): UniSection => ({
    diffOld: null,
    diffNew: null,
    pair: null,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let cur: UniSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null || m[1]!.trim() === '' || m[2]!.trim() === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(hm[1]!, 10), body: [] };
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          hunk.body.push(bl);
          i++;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      cur.hunks.push(hunk);
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = fresh();
        sections.push(cur);
        continue; // reprocess this line as the new section's header
      }
      i++;
      continue;
    }
    if (cur.hunks.length === 0) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pair = { old: uniPath(line), new: uniPath(lines[i + 1]!) };
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = trimSpaces(line.slice(12));
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = trimSpaces(line.slice(10));
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    // After the hunks: a ---/+++ pair starts a new section, the rest is ignored.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = fresh();
      sections.push(cur);
      continue; // reprocess this line as the new section's header
    }
    i++;
  }
  return sections.map((s) => makeUniEdit(s));
}

/** Whether a `\` line follows the hunk body's last context or `+` line. */
function backslashAfterLast(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l === '' || l[0] === ' ' || l[0] === '+') last = k;
  }
  if (last < 0) return false;
  const nx = body[last + 1];
  return nx !== undefined && nx[0] === '\\';
}

function hunkLines(body: string[]): { O: OL[]; N: OL[] } {
  const O: OL[] = [];
  const N: OL[] = [];
  for (const l of body) {
    if (l === '') {
      O.push({ text: '', ctx: true });
      N.push({ text: '', ctx: true });
    } else if (l[0] === ' ') {
      O.push({ text: l.slice(1), ctx: true });
      N.push({ text: l.slice(1), ctx: true });
    } else if (l[0] === '-') O.push({ text: l.slice(1), ctx: false });
    else if (l[0] === '+') N.push({ text: l.slice(1), ctx: false });
  }
  return { O, N };
}

/** A section's hunks, in order, over the file's text (SPEC.md section 6). */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = hunkLines(h.body);
    const flag = backslashAfterLast(h.body);
    if (O.length === 0) {
      let ins = h.a + d;
      if (ins < 0) ins = 0;
      if (ins > f.lines.length) ins = f.lines.length;
      const atEnd = ins === f.lines.length;
      f.lines.splice(ins, 0, ...N.map((e) => e.text));
      if (atEnd) f.finalBr = !flag;
      d += N.length;
    } else {
      const found = findTier(f.lines, O.map((e) => e.text), strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const runsToEnd = pos + O.length === f.lines.length;
      const mapped = mapNew(f.lines, pos, O, N, found.tier);
      f.lines.splice(pos, O.length, ...mapped);
      if (runsToEnd) f.finalBr = !flag;
      d += N.length - O.length;
    }
  }
  return joinFile(f);
}

function makeUniEdit(sec: UniSection): Edit {
  return (tree, strict) => {
    const oldP = sec.pair !== null ? sec.pair.old : (sec.renameFrom ?? sec.diffOld);
    const newP = sec.pair !== null ? sec.pair.new : (sec.renameTo ?? sec.diffNew);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (oldP === null || sec.newFile) {
      // creation
      const p = newP;
      if (p === null) throw new Fail('unsafe', '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlus: { h: Hunk; k: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]![0] === '+') {
            plus.push(h.body[k]!.slice(1));
            lastPlus = { h, k };
          }
        }
      }
      let noBreak = false;
      if (lastPlus !== null) {
        const nx = lastPlus.h.body[lastPlus.k + 1];
        noBreak = nx !== undefined && nx[0] === '\\';
      }
      tree.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (newP === null || sec.deletedFile) {
      // deletion; its hunks are not read
      const p = oldP;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.set(p, null);
      return;
    }
    if (oldP !== newP) {
      // move
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.move(oldP, newP, applyHunks(before, sec.hunks, strict, oldP));
      return;
    }
    // change of the one path
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let k = i + 1;
    let sep = -1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      k++;
    }
    if (sep === -1) throw new Exit2(`error: parse ${searchLine}`);
    k = sep + 1;
    let end = -1;
    while (k < lines.length) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      k++;
    }
    if (end === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(makeSREdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return (tree, strict) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const mapped = mapNew(
      f.lines,
      pos,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      found.tier,
    );
    f.lines.splice(pos, oldLines.length, ...mapped);
    tree.set(path, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4Chunk {
  anchor: string | null;
  eof: boolean;
  O: OL[];
  N: OL[];
}

function parseV4A(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      const headerLine = i + 1;
      const kind = line.startsWith('*** Add File: ') ? 'add' : line.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const prefix = kind === 'add' ? 14 : 17;
      const path = trimSpaces(line.slice(prefix));
      i++;
      const raw: number[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        raw.push(i);
        i++;
      }
      while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
      if (kind === 'add') {
        const fl: string[] = [];
        for (const idx of raw) {
          const l = lines[idx]!;
          if (l === '') fl.push('');
          else if (l[0] === '+') fl.push(l.slice(1));
          else throw new Exit2(`error: parse ${idx + 1}`);
        }
        edits.push(makeV4Add(path, fl));
      } else if (kind === 'delete') {
        for (const idx of raw) {
          if (!blank(lines[idx]!)) throw new Exit2(`error: parse ${idx + 1}`);
        }
        edits.push(makeV4Delete(path));
      } else {
        let j = 0;
        let moveTo: string | null = null;
        if (j < raw.length && lines[raw[j]!]!.startsWith('*** Move to: ')) {
          moveTo = trimSpaces(lines[raw[j]!]!.slice(13));
          j++;
        }
        const chunks: V4Chunk[] = [];
        let cur: V4Chunk | null = null;
        let between = false;
        for (; j < raw.length; j++) {
          const idx = raw[j]!;
          const l = lines[idx]!;
          if (l.startsWith('@@')) {
            const anchor = trimSpaces(l.slice(2));
            cur = { anchor: anchor === '' ? null : anchor, eof: false, O: [], N: [] };
            chunks.push(cur);
            between = false;
            continue;
          }
          if (l === '*** End of File') {
            if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
            cur.eof = true;
            cur = null;
            between = true;
            continue;
          }
          if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
            if (cur === null) {
              if (chunks.length === 0 && !between) {
                cur = { anchor: null, eof: false, O: [], N: [] };
                chunks.push(cur);
              } else throw new Exit2(`error: parse ${idx + 1}`);
            }
            if (l === '') {
              cur.O.push({ text: '', ctx: true });
              cur.N.push({ text: '', ctx: true });
            } else if (l[0] === ' ') {
              cur.O.push({ text: l.slice(1), ctx: true });
              cur.N.push({ text: l.slice(1), ctx: true });
            } else if (l[0] === '-') cur.O.push({ text: l.slice(1), ctx: false });
            else cur.N.push({ text: l.slice(1), ctx: false });
            continue;
          }
          throw new Exit2(`error: parse ${idx + 1}`);
        }
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
        edits.push(makeV4Update(path, moveTo, chunks));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function makeV4Add(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4Delete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.set(path, null);
  };
}

function makeV4Update(path: string, moveTo: string | null, chunks: V4Chunk[]): Edit {
  return (tree, strict) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(f.lines, [ch.anchor], strict, cursor, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.O.length === 0) {
        const ins = ch.eof ? f.lines.length : cursor;
        f.lines.splice(ins, 0, ...ch.N.map((e) => e.text));
        cursor = ins + ch.N.length;
      } else {
        const found = findTier(f.lines, ch.O.map((e) => e.text), strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        const mapped = mapNew(f.lines, pos, ch.O, ch.N, found.tier);
        f.lines.splice(pos, ch.O.length, ...mapped);
        cursor = pos + mapped.length;
      }
    }
    const content = joinFile(f);
    if (moveTo !== null) tree.move(path, moveTo, content);
    else tree.set(path, content);
  };
}

// ---------------------------------------------------------------------------
// Output (SPEC.md section 2) and the run
// ---------------------------------------------------------------------------

function outputRows(tree: Tree): string[] {
  const rows: { key: string; line: string }[] = [];
  const rTargets = new Set<string>();
  const rOlds = new Set<string>();
  for (const [p, o] of tree.origin) {
    const now = tree.now.get(p);
    if (now === undefined || now === null) continue;
    if (tree.original(o) === null) continue;
    if (tree.now.get(o) !== null) continue;
    rows.push({ key: p, line: `R ${o} -> ${p}` });
    rTargets.add(p);
    rOlds.add(o);
  }
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) {
      if (rOlds.has(p)) continue;
      rows.push({ key: p, line: `D ${p}` });
    } else if (was === null) {
      if (rTargets.has(p)) continue;
      rows.push({ key: p, line: `A ${p}` });
    } else {
      rows.push({ key: p, line: `M ${p}` });
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  return rows.map((r) => r.line);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines)
          : kind === 'search-replace'
            ? parseSearchReplace(lines)
            : parseV4A(lines);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeOrigin = new Map(tree.origin);
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.origin.clear();
      for (const [k, v] of beforeOrigin) tree.origin.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = outputRows(tree);
  if (!check) {
    const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)).sort(byteOrder);
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const v = tree.now.get(p)!;
      if (v !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
