#!/usr/bin/env node
/**
 * jev-qa — fast code-error finder: free syntax stage + Jev semantic stage.
 *
 *   OPENROUTER_API_KEY=... node cli/jev-qa.mjs <repo> [--diff] [--out report.md] [--max N]
 *
 * Stage 1 (free, instant): node --check for js/mjs, python -m py_compile for py.
 * Stage 2 (Jev, ~$0.0002/file): per file, one request with parallel questions:
 *   has_bug (noul), severity (score low/medium/high), plus Noul for
 *   error-handling gaps, security risk, logic bug.
 * Report: markdown, sorted by risk = severity * confidence.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const args = process.argv.slice(2);
const repo = args[0];
const diffOnly = args.includes('--diff');
const outIdx = args.indexOf('--out');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
const maxIdx = args.indexOf('--max');
const maxFiles = maxIdx !== -1 ? Number(args[maxIdx + 1]) : 40;

if (!repo || !existsSync(repo)) {
  console.error('usage: node cli/jev-qa.mjs <repo> [--diff] [--out report.md] [--max N]');
  process.exit(2);
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is not set');
  process.exit(2);
}
const MODEL = process.env.JEV_MODEL || 'typesafe/jev-1.13';
const BASE = (process.env.JEV_BASE_URL || 'https://openrouter.ai/api/alpha/decisions').replace(/\/$/, '');

const walk = (dir, skip = ['node_modules', '.git', 'dist', '.venv', 'venv', '__pycache__', '.next', 'build', 'coverage']) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (skip.some((s) => name === s || name.endsWith(s))) continue;
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isDirectory()) out.push(...walk(p, skip));
    else if (/\.(py|js|mjs|ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
};

let files = walk(repo);
if (diffOnly) {
  const git = (a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const changed = new Set([...git(['diff', '--name-only', 'HEAD']), ...git(['diff', '--name-only'])].map((f) => f.replace(/\\/g, '/')));
  files = files.filter((f) => changed.has(relative(repo, f).replace(/\\/g, '/')));
  if (!files.length) { console.log('jev-qa: no changed code files'); process.exit(0); }
}
files = files.slice(0, maxFiles);

// ---------- stage 1: free syntax checks ----------
const stage1 = [];
for (const f of files) {
  const ext = extname(f);
  let res = null;
  try {
    if (ext === '.py') {
      const r = spawnSync('python', ['-m', 'py_compile', f], { encoding: 'utf8' });
      res = r.status !== 0 ? r.stderr.split('\n').slice(-3).join(' ') : null;
    } else if (['.js', '.mjs'].includes(ext)) {
      const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
      res = r.status !== 0 ? (r.stderr || r.stdout).split('\n').slice(0, 3).join(' ') : null;
    } else if (['.ts', '.tsx'].includes(ext)) {
      const tsc = spawnSync('npx', ['--no-install', 'tsc', '--noEmit', f], { encoding: 'utf8', cwd: repo });
      res = tsc.status !== 0 && tsc.stdout ? tsc.stdout.split('\n').slice(0, 3).join(' ') : null;
    }
  } catch { /* checker missing — skip to stage 2 */ }
  if (res) stage1.push({ file: relative(repo, f), error: res.trim() });
}
const stage1Files = new Set(stage1.map((s) => s.file));

// ---------- stage 2: Jev semantic pass ----------
async function jev(state, questions) {
  const body = { model: MODEL, state, questions };
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const semantic = [];
const t0 = Date.now();
let calls = 0;
for (const f of files) {
  if (stage1Files.has(relative(repo, f))) continue; // already failed syntax; no tokens wasted
  let code = '';
  try { code = readFileSync(f, 'utf8'); } catch { continue; }
  if (!code.trim() || code.length > 100_000) continue;
  const started = Date.now();
  let data;
  try {
    data = await jev(code.slice(0, 60_000), {
      has_bug: { type: 'noul', instructions: 'Does this file contain a real bug or broken logic (not style)?' },
      severity: { type: 'score', instructions: 'How severe is the worst real issue in this file? 1 = harmless, 5 = data loss or security hole', criteria: ['harmless', 'minor', 'user-facing malfunction', 'serious', 'critical: data loss/security'] },
      error_handling_gap: { type: 'noul', instructions: 'Are there unhandled error paths or missing catch/validation around fallible operations?' },
      security_risk: { type: 'noul', instructions: 'Is there an injection, secret leak, or unsafe shell/file handling?' },
      logic_bug: { type: 'noul', instructions: 'Is there a logic error: wrong operator, inverted condition, wrong variable, off-by-one?' },
    });
  } catch (e) {
    console.error('Jev failed on', relative(repo, f), e.message);
    continue;
  }
  calls++;
  const a = data.answers || {};
  const n = (k) => a[k]?.noul ?? a[k]?.probability ?? 0;
  const sev = a.severity?.score ?? 0;
  const conf = a.severity?.confidence ?? a.has_bug?.confidence ?? 0;
  const risk = Number(sev) * Math.max(n('has_bug'), 0.5);
  if (n('has_bug') > 0.5 || sev >= 1) {
    semantic.push({
      file: relative(repo, f),
      has_bug: +n('has_bug').toFixed(2),
      severity: sev,
      confidence: +conf.toFixed(2),
      risk: +risk.toFixed(2),
      error_handling: +n('error_handling_gap').toFixed(2),
      security: +n('security_risk').toFixed(2),
      logic: +n('logic_bug').toFixed(2),
      ms: Date.now() - started,
    });
  }
}
semantic.sort((x, y) => y.risk - x.risk);

// ---------- report ----------
const lines = [`# jev-qa report — ${new Date().toISOString()}`, ''];
lines.push(`Scope: ${files.length} files · stage1 syntax errors: ${stage1.length} · stage2 flagged: ${semantic.length} · Jev calls: ${calls} in ${Date.now() - t0} ms`);
lines.push('');
if (stage1.length) {
  lines.push('## Syntax errors (stage 1, free)');
  for (const s of stage1) lines.push(`- **${s.file}** — \`${s.error}\``);
  lines.push('');
}
if (semantic.length) {
  lines.push('## Semantic flags (stage 2, Jev) — sorted by risk');
  lines.push('');
  lines.push('| file | bug | sev | risk | err-handling | security | logic | ms |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const s of semantic) {
    lines.push(`| ${s.file} | ${s.has_bug} | ${s.severity} | ${s.risk} | ${s.error_handling} | ${s.security} | ${s.logic} | ${s.ms} |`);
  }
} else if (!stage1.length) {
  lines.push('No issues flagged.');
}
const report = lines.join('\n');
if (outFile) writeFileSync(outFile, report + '\n', 'utf8');
console.log(report);
console.log(`\njev-qa done: ${calls} Jev calls, ${Date.now() - t0} ms total${outFile ? ` → ${outFile}` : ''}`);