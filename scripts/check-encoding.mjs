#!/usr/bin/env node
/**
 * scripts/check-encoding.mjs - detect and repair double-encoded UTF-8.
 *
 * THE PROBLEM THIS EXISTS FOR
 * --------------------------
 * Windows PowerShell 5.1 decodes files with the ANSI code page (cp1252 on this
 * machine) and pipes native command output as the OEM code page (ibm850). A
 * file containing a real em dash (U+2014, bytes E2 80 94) read by Get-Content
 * and written back by Set-Content -Encoding UTF8 becomes three characters.
 * The file is still valid UTF-8, so every other tool shrugs and opens it
 * happily - the damage is invisible until a human notices that a client's
 * surname now reads "Jaffee-Knapp" with a hyphen and a stray accent.
 *
 * That is not hypothetical. It happened repeatedly in this repo during the
 * booking-funnel work, silently corrupting user-facing error strings three
 * separate times.
 *
 * WHY A DETECTOR AND NOT A POWERSHELL PROFILE
 * -------------------------------------------
 * Because a profile does not cover every writer. Patching
 * Microsoft.PowerShell_profile.ps1 only helps sessions that load it - the agent
 * harness demonstrably does not (verified: a marker written to the profile was
 * absent from the next shell invocation), CI does not, cron does not, and a
 * teammate's editor has its own encoding setting. A check that walks the tree
 * catches the damage no matter which tool caused it, including tools nobody on
 * this machine controls.
 *
 * HOW DETECTION WORKS
 * -------------------
 * A double-encoded file has an exact inverse: encode it back to cp1252 and
 * decode as UTF-8, and you get the original. Confirmation is not "the reversal
 * produced different text" - it is "the reversal REMOVED mangled characters".
 * A clean file containing a real em dash reverses into invalid UTF-8, and a
 * clean ASCII file reverses into itself, so neither can satisfy that test.
 *
 * EVERY NON-ASCII CHARACTER IN THIS FILE IS WRITTEN AS AN ESCAPE on purpose.
 * A regex containing literal mojibake characters is itself corruptible, which
 * is how the first version of this file managed to report a mangled file as
 * clean.
 *
 *   node scripts/check-encoding.mjs            report; exit 1 if anything is bad
 *   node scripts/check-encoding.mjs --fix      repair in place
 *   node scripts/check-encoding.mjs <path>...  limit to specific files
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', 'relay-data',
  '.next', '.cache', '__pycache__', '.venv', 'venv', '.ci-workflows',
  '_probe_results', '_pfp_booking', '_pfp_prints',
]);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mov',
  '.jfif', '.heic', '.pyc', '.so', '.dll', '.exe', '.bin', '.sqlite', '.db',
]);
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

/**
 * cp1252 character -> byte for the 0x80-0x9F block.
 *
 * Node's Buffer knows only utf8/latin1/ascii/utf16le/base64/hex - there is no
 * 'cp1252'. The first version of this file called Buffer.from(text,'cp1252')
 * inside a try/catch, which threw ERR_UNKNOWN_ENCODING on every single call;
 * the catch swallowed it, latin1 was tried instead, produced different bytes,
 * the reversal failed, and the tool reported a file with 1402 mangled
 * characters as clean. A detector that cannot fail loudly is worse than none.
 *
 * latin1 and cp1252 differ ONLY in 0x80-0x9F, which is exactly the block
 * mojibake is built from, so it cannot be skipped.
 */
const CP1252_HIGH = new Map(Object.entries({
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
  '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
  '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
  '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
  '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
  '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F,
}));

/** A cp1252 lead byte followed by the block mojibake is made from. */
const MARKER_RE = /[\u00E2\u00C3\u00C2][\u0080-\u00BF\u20AC\u2013\u2014\u0153\u201D\u201E\u2122]/g;
const markerCount = (s) => (s.match(MARKER_RE) || []).length;

/** Encode one character to its cp1252 byte, or null if it has none. */
function cp1252Byte(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x80) return code;
  const high = CP1252_HIGH.get(ch);
  if (high !== undefined) return high;
  if (code <= 0xFF) return code;   // 0xA0-0xFF agrees with latin1
  return null;                     // outside cp1252 entirely
}

/**
 * Undo one round of cp1252 mangling.
 *
 * PER-RUN, NOT PER-FILE, and that distinction was learned the hard way. A
 * whole-file reversal bails on the first character cp1252 cannot represent: a
 * box-drawing rule, an emoji, a CJK character. So a file that is mostly clean
 * but has a few mangled spots, AND contains a box rule, was reported as clean.
 * That is not hypothetical - it happened to this file's own documentation,
 * which quotes mojibake as examples on purpose.
 *
 * So: locate each mangled run and reverse only that run. Everything outside is
 * untouched, and a file may be arbitrarily mixed.
 *
 * @returns {{text:string, markersBefore:number, markersAfter:number}|null}
 *   null when the file is not double-encoded.
 */
export function undoDoubleEncoding(text) {
  const before = markerCount(text);
  if (!before) return null;

  let out = '';
  let i = 0;
  let repairedRuns = 0;

  while (i < text.length) {
    MARKER_RE.lastIndex = i;
    const m = MARKER_RE.exec(text);
    if (!m) { out += text.slice(i); break; }

    // Grow out to exactly the mangled run. The boundary rule is specific: every
    // byte of a mangled multi-byte UTF-8 sequence decodes to a cp1252 character
    // with code >= 0x80, so a run stops at the first ASCII character. Expanding
    // across ASCII instead would swallow the whole document and drag in any
    // unrelated character, which is how the box rule on AGENTS.md's mojibake
    // examples kept the file from being repaired.
    const growable = (ch) => ch.codePointAt(0) >= 0x80 && cp1252Byte(ch) !== null;
    let start = m.index;
    while (start > i && growable(text[start - 1])) start--;
    let end = m.index + m[0].length;
    while (end < text.length && growable(text[end])) end++;

    const run = text.slice(start, end);
    let repaired = null;
    try {
      const buf = Buffer.alloc(run.length);
      for (let k = 0; k < run.length; k++) buf[k] = cp1252Byte(run[k]);
      const back = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      if (markerCount(back) < markerCount(run)) repaired = back;
    } catch { /* this run did not reverse to valid UTF-8; leave it as it is */ }

    out += text.slice(i, start);
    out += repaired === null ? run : repaired;
    if (repaired !== null) repairedRuns++;
    i = end;
  }

  if (!repairedRuns) return null;
  const after = markerCount(out);
  if (after >= before) return null;
  return { text: out, markersBefore: before, markersAfter: after };
}

function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.github') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      if (SKIP_EXT.has(extname(e.name).toLowerCase())) continue;
      if (SKIP_FILES.has(e.name)) continue;
      yield full;
    }
  }
}

/** 1-based line of the first mangled character, so the report is clickable. */
function firstOffendingLine(text) {
  const m = MARKER_RE.exec(text);
  if (!m) return 1;
  return text.slice(0, m.index).split('\n').length;
}

const BOM = '﻿';
const hasBom = (t) => t.startsWith(BOM);

/**
 * A UTF-8 BOM in source is an accident, not a decision.
 *
 * PowerShell 5.1's Set-Content -Encoding UTF8 writes one whether you asked for
 * it or not, so one careless round-trip leaves three stray bytes at the head of
 * a .mjs file. Node tolerates it, which is exactly why it survives: nothing
 * complains, but it defeats byte-for-byte comparison against an upstream copy.
 */
/**
 * Directories that are worth scanning even though git does not track them.
 *
 * `git ls-files` is the right primary source - it is fast, and a full working
 * tree walk once took over five minutes because it descends into build output
 * and archives. But it has a blind spot that has already bitten: it covers
 * only tracked files, so an untracked working directory is invisible.
 *
 * TempCashDapp is exactly that. It holds live product source - an offline
 * payment ledger, a reserve script, and the design document - none of it
 * committed, all of it real. On 2026-10-17
 * `TempCashDapp/docs/offline-payment-design.md` was found holding 40
 * double-encoded sequences while this checker reported 701 files clean,
 * because not one of them was in the file set it looked at. A backstop that
 * cannot see the damage is not a backstop.
 *
 * SKIP_DIRS already excludes node_modules, .next and dist, so walking these is
 * cheap; the cost of the original problem was walking everything, not walking
 * a named list.
 */
const EXTRA_SCAN_ROOTS = ['TempCashDapp'];

/**
 * The file set to check.
 *
 * Git-tracked files when git is available, because that is the set that
 * actually matters and it is fast. PLUS EXTRA_SCAN_ROOTS, which are walked
 * regardless of tracking state. Falls back to a full filesystem walk only if
 * git is unavailable or the repo is not one.
 */
function trackedFiles() {
  const files = [];
  let usedGit = false;
  try {
    const out = execFileSync('git', ['ls-files', '-z'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
    });
    const tracked = out.split('\0').filter(Boolean);
    if (tracked.length) { files.push(...tracked); usedGit = true; }
  } catch { /* not a git repo, or git is missing */ }

  if (!usedGit) files.push(...walk(ROOT));

  // Dedup: a path can be both tracked and inside an extra root.
  const seen = new Set();
  const extra = [];
  for (const root of EXTRA_SCAN_ROOTS) {
    const full = join(ROOT, root);
    if (!existsSync(full)) continue;
    for (const f of walk(full)) {
      const rel = relative(ROOT, f);
      if (seen.has(rel)) continue;
      seen.add(rel);
      extra.push(rel);
    }
  }
  files.push(...extra);

  if (extra.length) {
    console.log(`check-encoding: ${extra.length} file(s) added from untracked roots `
      + `[${EXTRA_SCAN_ROOTS.join(', ')}] (git supplied ${usedGit ? 'the tracked set' : 'nothing, used a full walk'})`);
  }
  return files;
}

/**
 * Is this a text file we may safely rewrite?
 *
 * This check MUST live in the main loop and not only in the filesystem walk.
 * It originally lived only in walk(), so every git-tracked file bypassed it --
 * and the first run of --fix on a tracked list decoded
 * relay/pfp-outputs/pfp-template-1778828567638.png as UTF-8 text and rewrote
 * it, inflating a 2.3 MB image to 4.2 MB. Restored from git, but the lesson
 * stands: a repair tool that can rewrite a binary is a loaded weapon.
 *
 * Belt and braces: a file that contains a NUL byte or a high share of
 * non-printable characters is binary whatever it is named.
 */
function isTextCandidate(file, text) {
  if (SKIP_EXT.has(extname(file).toLowerCase())) return false;
  if (SKIP_FILES.has(file.split(/[\\/]/).pop())) return false;
  if (text.includes('\u0000')) return false;
  let odd = 0;
  for (let i = 0; i < text.length && i < 8192; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x09 || c === 0x0A || c === 0x0D) continue;
    if (c < 0x20 || c === 0x7F) odd++;
  }
  return odd / Math.min(text.length, 8192) < 0.02;
}

function main() {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const paths = args.filter(a => !a.startsWith('--'));

  const files = paths.length ? paths.map(p => p.trim()) : trackedFiles();
  const bad = [];
  const bombed = [];
  let scanned = 0;
  let skipped = 0;

  for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (!isTextCandidate(file, text)) { skipped++; continue; }
    scanned++;

    const bom = hasBom(text);
    if (bom) bombed.push(file);
    if (bom) text = text.slice(1);

    const undone = undoDoubleEncoding(text);
    if (undone) {
      bad.push({ file, before: undone.markersBefore, after: undone.markersAfter,
                 line: firstOffendingLine(text) });
      text = undone.text;
    }
    if (fix && (bom || undone)) writeFileSync(file, text, 'utf8');
  }

  if (bombed.length) {
    console.log(`check-encoding: ${fix ? 'stripped BOM from' : 'BOM found in'} ${bombed.length} file(s):`);
    for (const f of bombed.slice(0, 25)) console.log(`  ${relative(ROOT, f) || f}`);
    if (bombed.length > 25) console.log(`  ... and ${bombed.length - 25} more`);
    console.log('');
  }

  if (!bad.length) {
    console.log(`check-encoding: ${scanned} text files scanned` +
                `${skipped ? `, ${skipped} binary skipped` : ''}, no double-encoded UTF-8.`);
    return bombed.length && !fix ? 1 : 0;
  }

  console.log(`check-encoding: ${fix ? 'FIXED' : 'FOUND'} ${bad.length} double-encoded file(s) of ${scanned} scanned:\n`);
  for (const b of bad) {
    console.log(`  ${relative(ROOT, b.file) || b.file}`);
    console.log(`      ${b.before} mangled characters (first at line ${b.line})` +
                (fix ? ` -> ${b.after} remaining` : ''));
  }
  if (!fix) {
    console.log('\nRepair with:  node scripts/check-encoding.mjs --fix');
    console.log('This corrupts user-facing text silently. Fix before committing.');
  }
  return fix ? 0 : 1;
}

if (process.argv[1]?.endsWith('check-encoding.mjs')) process.exit(main());
