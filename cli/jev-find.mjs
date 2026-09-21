#!/usr/bin/env node
/**
 * jev-find — natural-language file search with a Jev walker ensemble (blink pattern).
 *
 *   OPENROUTER_API_KEY=... node cli/jev-find.mjs "where is authentication handled?" <dir> [--walkers 20] [--depth 10]
 *
 * N walkers start at <dir>. At every step Jev gets the query + the child list and
 * returns a Choice over children (+ BACK). Walkers that reach a file stop there.
 * Output: table of destination files with share of walkers.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? parseInt(args[i + 1], 10) || def : def;
};
const query = args[0];
const root = args[1];
if (!query || !root || !statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('usage: node cli/jev-find.mjs "<query>" <dir> [--walkers 20] [--depth 10]');
  process.exit(1);
}
const W = flag('--walkers', 20);
const MAXD = flag('--depth', 10);
const SKIP = new Set(['node_modules', '.git', 'dist', '.venv', 'venv', '__pycache__', '.next', 'build', 'coverage', '.vercel']);
const MAX_CHILDREN = 28;

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) { console.error('OPENROUTER_API_KEY not set'); process.exit(1); }

async function jev(state, questions) {
  const res = await fetch('https://openrouter.ai/api/alpha/decisions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.JEV_MODEL || 'typesafe/jev-1.13', state: state.slice(0, 20_000), questions }),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).answers ?? (await res.json());
}

const childrenOf = (dir) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => !SKIP.has(e.name) && !e.name.startsWith('.'))
    .map((e) => ({ name: e.name, path: join(dir, e.name), dir: e.isDirectory() }))
    .slice(0, MAX_CHILDREN);

const t0 = Date.now();
let calls = 0;
const dest = new Map(); // file -> walker count

async function walk(dir, depth) {
  if (depth > MAXD) return;
  const kids = childrenOf(dir);
  if (!kids.length) return;
  const options = kids.map((k) => k.name).concat(['STOP_HERE']);
  const criteria = {};
  for (const k of kids) criteria[k.name] = k.dir ? `folder: ${k.name}/` : `file: ${k.name}`;
  criteria.STOP_HERE = 'this folder already contains the answer as a whole';
  calls++;
  let choice;
  try {
    const a = await jev(
      `Search query: "${query}"\nCurrent folder: ${relative(root, dir) || '.'}\nEntries:\n${kids.map((k) => {
        if (!k.dir) {
          let hint = '';
          try { hint = readFileSync(k.path, 'utf8').slice(0, 400).split('\n').find((l) => l.trim()) || ''; } catch {}
          return `- ${k.name} (file)${hint ? ` — ${hint.slice(0, 120)}` : ''}`;
        }
        let sub = '';
        try { sub = readdirSync(k.path).filter((n) => !SKIP.has(n) && !n.startsWith('.')).slice(0, 12).join(', '); } catch {}
        return `- ${k.name}/ (folder${sub ? `: ${sub}` : ''})`;
      }).join('\n')}`,
      { next: { type: 'choice', criteria, instructions: 'Which entry should the walker descend into next to find what the query asks about? Pick a file when it looks like the answer itself, a folder to go deeper, or STOP_HERE if this folder contains the answer as a whole.' } },
    );
    choice = a.next?.choice;
    // Sample per walker from Jev probabilities so the ensemble actually explores
    const probs = a.next?.probabilities || {};
    const entries = Object.entries(probs).filter(([k, p]) => typeof p === 'number' && p > 0 && kids.some((k2) => k2.name === k));
    if (entries.length) {
      let r = Math.random() * entries.reduce((s, [, p]) => s + p, 0);
      for (const [k, p] of entries) { r -= p; if (r <= 0) { choice = k; break; } }
    }
  } catch (e) {
    return; // walker dies, fail-open
  }
  if (!choice || choice === 'STOP_HERE') return;
  const kid = kids.find((k) => k.name === choice);
  if (!kid) return;
  if (!kid.dir) { dest.set(kid.path, (dest.get(kid.path) || 0) + 1); return; }
  await walk(kid.path, depth + 1);
}

await Promise.all(Array.from({ length: W }, () => walk(root, 0)));

const ms = Date.now() - t0;
const rows = [...dest.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\njev-find "${query}" — ${W} walkers, ${calls} Jev calls, ${(ms / 1000).toFixed(1)} s\n`);
if (!rows.length) { console.log('No walker reached a file. Try more walkers or a different query.'); process.exit(0); }
for (const [path, n] of rows.slice(0, 10)) {
  console.log(`  ${String(Math.round((n / W) * 100)).padStart(3)}%  ${relative(root, path)}`);
}
