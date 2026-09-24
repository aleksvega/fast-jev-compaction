#!/usr/bin/env node
// jev-setup — one-command installer for the Jev tool suite across AI agents/harnesses.
// Usage: npx jev-setup <claude|opencode|codex|hermes|generic> [--dry-run]
// Installs the CLIs globally and wires hooks/config for the chosen agent.
// Fail-safe: every step checks the environment first and reports what it did.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKGS = ['fast-jev-compaction', 'jev-prompt-enhancer', 'jev-skill-router'];
const REPO = 'https://github.com/aleksvega/fast-jev-compaction';
const AGENTS = ['claude', 'opencode', 'codex', 'hermes', 'generic'];
const dry = process.argv.includes('--dry-run');
const agent = process.argv[2];

function sh(cmd) {
  if (dry) { console.log(`  [dry-run] ${cmd}`); return ''; }
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}
function npmBin(name) {
  const w = spawnSync('npx', ['--no-install', name, '--help'], { encoding: 'utf8' });
  return w.status === 0;
}

console.log(`\njev-setup — Jev tool suite installer (Jev v1.13, System One decision layer)\n`);

// 1. Install the three CLIs globally
console.log('1) Installing CLIs: ' + PKGS.join(', '));
try {
  for (const p of PKGS) {
    if (!npmBin(p.replace('fast-jev-compaction', 'jev-compact')) && !dry) { /* not local; check global */ }
  }
  sh(`npm install -g ${PKGS.join(' ')}`);
  console.log('   ok');
} catch {
  console.log('   (already installed or npm error — continuing)');
}

// 2. Agent-specific wiring
const home = homedir();
switch (agent) {
  case 'claude': {
    console.log('2) Claude Code: registering plugin marketplace');
    sh(`claude plugin marketplace add aleksvega/fast-jev-compaction`);
    sh(`claude plugin install jev-compaction@jev-compaction`);
    break;
  }
  case 'opencode': {
    console.log('2) OpenCode: writing hook config to ~/.config/opencode/opencode.json');
    const dir = join(home, '.config', 'opencode');
    mkdirSync(dir, { recursive: true });
    const cfgPath = join(dir, 'opencode.json');
    let cfg = {};
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch {}
    cfg.hook = cfg.hook || {};
    cfg.hook.session_completed = 'jev-compact --auto';
    if (!dry) writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    console.log(`   wrote ${cfgPath} (session_completed hook)`);
    break;
  }
  case 'codex': {
    console.log('2) Codex: appending Jev instructions to ~/.codex/AGENTS.md');
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, 'AGENTS.md');
    const block = `\n## Jev tools\n- Context too long → run: jev-compact --stdin < transcript.txt\n- Vague user request → jev-enhance "<query>" (JSON; use "enhanced" when verdicts true)\n- Repo/classification decisions → jev-find / jev-qa\nSet OPENROUTER_API_KEY in your environment.\n`;
    if (!dry) {
      let cur = '';
      try { cur = readFileSync(f, 'utf8'); } catch {}
      if (!cur.includes('## Jev tools')) writeFileSync(f, cur + block);
    }
    console.log(`   updated ${f}`);
    break;
  }
  case 'hermes': {
    console.log('2) Hermes: installing jev-layer plugin');
    const src = join(REPO_LOCAL(), 'plugins', 'jev-layer');
    const dst = join(home, '.hermes', 'plugins', 'jev-layer');
    mkdirSync(dst, { recursive: true });
    for (const f of ['plugin.yaml', '__init__.py']) {
      if (existsSync(join(src, f))) { if (!dry) copyFileSync(join(src, f), join(dst, f)); console.log(`   copied ${f}`); }
      else console.log(`   (plugin file ${f} not found in repo — clone ${REPO} first)`);
    }
    try { sh('hermes plugins enable jev-layer'); console.log('   enabled'); } catch { console.log('   enable manually: hermes plugins enable jev-layer'); }
    break;
  }
  case 'generic': {
    console.log('2) Generic agent: appending Jev instructions to ./AGENTS.md');
    const block = `\n## Jev tools\n- Context too long → jev-compact --stdin < transcript.txt\n- Vague request → jev-enhance "<query>"\n- Repo decisions → jev-find / jev-qa\nSet OPENROUTER_API_KEY.\n`;
    if (!dry) {
      let cur = '';
      try { cur = readFileSync('AGENTS.md', 'utf8'); } catch {}
      if (!cur.includes('## Jev tools')) writeFileSync('AGENTS.md', cur + block);
    }
    console.log('   wrote ./AGENTS.md');
    break;
  }
  default:
    console.error(`Unknown agent "${agent}". Choose one of: ${AGENTS.join(', ')}`);
    process.exit(1);
}

function REPO_LOCAL() {
  // repo root = two levels above cli/jev-setup.mjs when run from a clone
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

// 3. Verify
console.log('3) Verify:');
if (!dry) {
  for (const b of ['jev-enhance', 'jev-find', 'jev-qa']) {
    const ok = npmBin(b);
    console.log(`   ${ok ? 'ok' : 'MISSING'}: ${b}`);
  }
}
console.log(`\nDone. Docs: ${REPO}\nEnv: OPENROUTER_API_KEY (https://openrouter.ai/keys)\n`);
