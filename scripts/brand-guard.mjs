#!/usr/bin/env node
// brand-guard — fails when a tenant brand string leaks into user-facing code or a built artifact (ADR-0031).
//
// The SAME file lives in villas-be-core, mo-reservation-fe, mo-packages and tm30-helper. Only the
// repo's `brand-guard.json` differs. Change the logic in all four copies at once.
//
// Usage:
//   node scripts/brand-guard.mjs --src         scan sources (comments stripped only where config says so)
//   node scripts/brand-guard.mjs --artifacts   scan the built artifact (.next/static, dist, app.asar files)
//   options: --config <file> (default brand-guard.json), --root <dir> (default: the config's directory)
//
// Exit codes: 0 clean, 1 brand string found (each printed as `file:line:col: [rule] "match"`),
// 2 config or usage error (also: --artifacts found no files, i.e. the build did not run).
//
// There is deliberately no skip flag (ADR-0031 Guidance). A false positive is fixed with an
// allowlist entry in brand-guard.json that says WHY the string is never shown to a user.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MODES = ['src', 'artifacts'];
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.icns', '.bmp', '.avif', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.pdf', '.zip', '.gz', '.br', '.mp3', '.mp4', '.webm', '.mov', '.traineddata', '.node',
  '.wasm', '.exe', '.dmg', '.asar', '.xlsx', '.docx', '.tsbuildinfo',
]);
const COMMENT_SYNTAX = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.css': 'css', '.scss': 'js', '.html': 'html', '.htm': 'html', '.svg': 'html', '.yml': 'hash', '.yaml': 'hash',
};
const MAX_CONTEXT = 50;

function fail(msg) {
  process.stderr.write(`brand-guard: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { modes: [], config: 'brand-guard.json', root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--src') out.modes.push('src');
    else if (a === '--artifacts') out.modes.push('artifacts');
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '-h' || a === '--help') {
      process.stdout.write('usage: brand-guard.mjs [--src] [--artifacts] [--config brand-guard.json] [--root dir]\n');
      process.exit(0);
    } else fail(`unknown argument ${a}`);
  }
  if (out.modes.length === 0) out.modes.push('src');
  return out;
}

// ── globs ────────────────────────────────────────────────────────────────────────────────────────
const GLOB_CHARS = /[*?{[]/;

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) fail(`unbalanced { in glob ${glob}`);
      re += '(?:' + glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')';
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

function compileGlobs(globs) {
  return (globs || []).map((g) => {
    const clean = g.replace(/^\.\//, '').replace(/\/$/, '');
    // A bare path (no glob chars) means "this file, or everything under this directory".
    const re = GLOB_CHARS.test(clean) ? globToRegExp(clean) : new RegExp('^' + clean.replace(/[.+^$()|[\]\\]/g, '\\$&') + '(?:/.*)?$');
    const base = clean.split('/').filter((seg, i, all) => !all.slice(0, i + 1).some((s) => GLOB_CHARS.test(s))).join('/');
    return { glob: g, re, base };
  });
}

const matchesAny = (rel, compiled) => compiled.some((c) => c.re.test(rel));

function walk(root, base, out) {
  const abs = path.join(root, base);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isFile()) { out.add(base); return; }
  if (!st.isDirectory()) return;
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    // Third-party code is never scanned: a brand cannot originate there, and its text is not ours.
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) walk(root, rel, out);
    else if (ent.isFile()) out.add(rel);
  }
}

function listFiles(root, include, exclude) {
  const inc = compileGlobs(include);
  const exc = compileGlobs((exclude || []).map((x, i) => {
    // Excluding a path is an allowlist decision too: it must say why nothing there reaches a user.
    if (!x || typeof x.glob !== 'string' || !(typeof x.reason === 'string' && x.reason.trim().length >= 10)) {
      fail(`exclude[${i}] must be {"glob": "...", "reason": "why nothing under it reaches a user"}`);
    }
    return x.glob;
  }));
  const candidates = new Set();
  for (const c of inc) walk(root, c.base, candidates);
  return [...candidates].filter((rel) => matchesAny(rel, inc) && !matchesAny(rel, exc)).sort();
}

// ── comment stripping (keeps length and newlines, so line/col stay true) ─────────────────────────
const blank = (s) => s.replace(/[^\n]/g, ' ');
const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

function stripJs(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const braceStack = []; // for `${ … }` inside template literals: depth at which the template resumes
  let depth = 0;
  let lastSig = ''; // last significant (non-space, non-comment) chunk, for regex-vs-division
  const regexAllowed = () => {
    if (lastSig === '') return true;
    if (REGEX_PREV.has(lastSig)) return true;
    return REGEX_KEYWORDS.has(lastSig);
  };
  const readTemplate = () => {
    // at src[i] === '`' or resuming after `}`; consume until closing backtick or `${`
    while (i < n) {
      const c = src[i];
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; lastSig = '`'; return; }
      if (c === '$' && src[i + 1] === '{') { out += '${'; i += 2; braceStack.push(depth); depth++; lastSig = '{'; return; }
      out += c; i++;
    }
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += blank(src.slice(i, stop)); i = stop; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1); i = j + 1; lastSig = c; continue;
    }
    if (c === '`') { out += c; i++; readTemplate(); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      while (j + 1 < n && /[a-z]/i.test(src[j + 1])) j++;
      out += src.slice(i, j + 1); i = j + 1; lastSig = '/re'; continue;
    }
    if (c === '{') { depth++; out += c; i++; lastSig = c; continue; }
    if (c === '}') {
      depth--;
      out += c; i++;
      if (braceStack.length && braceStack[braceStack.length - 1] === depth) { braceStack.pop(); readTemplate(); continue; }
      lastSig = c; continue;
    }
    if (/\s/.test(c)) { out += c; i++; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      lastSig = src.slice(i, j); out += lastSig; i = j; continue;
    }
    out += c; i++; lastSig = c;
  }
  return out;
}

function stripBlockComments(src, open, close) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const s = src.indexOf(open, i);
    if (s < 0) { out += src.slice(i); break; }
    const e = src.indexOf(close, s + open.length);
    const stop = e < 0 ? src.length : e + close.length;
    out += src.slice(i, s) + blank(src.slice(s, stop));
    i = stop;
  }
  return out;
}

function stripHash(src) {
  // YAML: `#` starts a comment at line start or after whitespace, outside quotes (good enough for CI files).
  return src.split('\n').map((line) => {
    let q = null;
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '#' && (k === 0 || /\s/.test(line[k - 1]))) return line.slice(0, k) + blank(line.slice(k));
    }
    return line;
  }).join('\n');
}

function stripComments(src, ext) {
  switch (COMMENT_SYNTAX[ext]) {
    case 'js': return stripJs(src);
    case 'css': return stripBlockComments(src, '/*', '*/');
    case 'html': return stripBlockComments(src, '<!--', '-->');
    case 'hash': return stripHash(src);
    default: return src;
  }
}

// ── config ──────────────────────────────────────────────────────────────────────────────────────
function compileRule(r, kind, idx) {
  if (!r || typeof r.pattern !== 'string') fail(`${kind}[${idx}] has no "pattern"`);
  if (kind !== 'forbidden' && !(typeof r.reason === 'string' && r.reason.trim().length >= 10)) {
    fail(`${kind}[${idx}] (${r.id || r.pattern}) needs a "reason" saying why the string is never shown to a user`);
  }
  const flags = (r.flags || '').replace(/g/g, '') + 'g';
  let re;
  try { re = new RegExp(r.pattern, flags); } catch (e) { fail(`${kind}[${idx}] bad regex: ${e.message}`); }
  const modes = r.modes || MODES;
  for (const m of modes) if (!MODES.includes(m)) fail(`${kind}[${idx}] unknown mode ${m}`);
  return { id: r.id || r.pattern, re, modes, files: r.files ? compileGlobs(r.files) : null };
}

function loadConfig(file) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { fail(`cannot read ${file}: ${e.message}`); }
  if (!Array.isArray(cfg.forbidden) || cfg.forbidden.length === 0) fail('config has no "forbidden" rules');
  return {
    raw: cfg,
    forbidden: cfg.forbidden.map((r, i) => compileRule(r, 'forbidden', i)),
    allow: (cfg.allow || []).map((r, i) => compileRule(r, 'allow', i)),
    allowLines: (cfg.allowLines || []).map((r, i) => {
      if (!r.file || !r.contains) fail(`allowLines[${i}] needs "file" and "contains"`);
      if (!(typeof r.reason === 'string' && r.reason.trim().length >= 10)) fail(`allowLines[${i}] needs a "reason"`);
      return { ...r, fileRe: compileGlobs([r.file])[0].re, modes: r.modes || MODES, used: false };
    }),
  };
}

function sectionIncludes(root, section) {
  const inc = [...(section.include || [])];
  if (section.includeFromPackageJson) {
    // e.g. "build.files" — the electron-builder list of what goes into app.asar.
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const list = section.includeFromPackageJson.split('.').reduce((o, k) => (o ? o[k] : undefined), pkg);
    if (!Array.isArray(list)) fail(`package.json has no array at ${section.includeFromPackageJson}`);
    inc.push(...list.filter((g) => typeof g === 'string' && !g.startsWith('!')));
  }
  return inc;
}

// ── scan ────────────────────────────────────────────────────────────────────────────────────────
function context(line, s, e) {
  const from = Math.max(0, s - MAX_CONTEXT);
  const to = Math.min(line.length, e + MAX_CONTEXT);
  return (from > 0 ? '…' : '') + line.slice(from, to).trim() + (to < line.length ? '…' : '');
}

function scanMode(root, cfg, mode) {
  const section = cfg.raw[mode];
  if (!section) fail(`config has no "${mode}" section`);
  const include = sectionIncludes(root, section);
  const files = listFiles(root, include, section.exclude);
  if (files.length === 0) {
    fail(`[${mode}] no files matched ${JSON.stringify(include)} under ${root}` + (mode === 'artifacts' ? ' — run the build first' : ''));
  }
  const strip = new Set(section.stripComments || []);
  const forbidden = cfg.forbidden.filter((r) => r.modes.includes(mode));
  const hits = [];
  let scanned = 0;
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    const buf = fs.readFileSync(path.join(root, rel));
    if (buf.subarray(0, 8192).includes(0)) continue;
    scanned++;
    let text = buf.toString('utf8');
    if (strip.has(ext)) text = stripComments(text, ext);
    const allow = cfg.allow.filter((r) => r.modes.includes(mode) && (!r.files || matchesAny(rel, r.files)));
    const allowLines = cfg.allowLines.filter((r) => r.modes.includes(mode) && r.fileRe.test(rel));
    const lines = text.split('\n');
    for (let ln = 0; ln < lines.length; ln++) {
      const line = lines[ln];
      if (line.trim() === '') continue;
      let lineHits = [];
      for (const rule of forbidden) {
        rule.re.lastIndex = 0;
        for (const m of line.matchAll(rule.re)) {
          if (m[0] === '') continue;
          lineHits.push({ rule: rule.id, s: m.index, e: m.index + m[0].length, text: m[0] });
        }
      }
      if (lineHits.length === 0) continue;
      const ranges = [];
      for (const a of allow) for (const m of line.matchAll(a.re)) if (m[0]) ranges.push([m.index, m.index + m[0].length]);
      lineHits = lineHits.filter((h) => !ranges.some(([s, e]) => s <= h.s && h.e <= e));
      if (lineHits.length === 0) continue;
      const exempt = allowLines.find((a) => line.includes(a.contains));
      if (exempt) { exempt.used = true; continue; }
      for (const h of lineHits) hits.push(`${rel}:${ln + 1}:${h.s + 1}: [${h.rule}] "${h.text}"  ${context(line, h.s, h.e)}`);
    }
  }
  return { hits, scanned };
}

const args = parseArgs(process.argv.slice(2));
const configPath = path.resolve(args.config);
const root = path.resolve(args.root || path.dirname(configPath));
const cfg = loadConfig(configPath);
let total = 0;
for (const mode of args.modes) {
  const { hits, scanned } = scanMode(root, cfg, mode);
  for (const h of hits) process.stdout.write(h + '\n');
  process.stdout.write(`brand-guard [${mode}]: ${scanned} files scanned, ${hits.length} brand string(s) found\n`);
  total += hits.length;
}
for (const a of cfg.allowLines) {
  if (!a.used && a.modes.some((m) => args.modes.includes(m))) {
    process.stderr.write(`brand-guard: warning: allowLines entry ${a.file} "${a.contains}" matched nothing — remove it if stale\n`);
  }
}
if (total > 0) {
  process.stdout.write('brand-guard: FAILED. Remove the brand string, or — only if it is an internal identifier a user never sees — add an allowlist entry with a reason to brand-guard.json (ADR-0031).\n');
  process.exit(1);
}
