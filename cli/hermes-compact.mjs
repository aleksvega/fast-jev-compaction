#!/usr/bin/env node
/**
 * hermes-compact — Hermes transcript adapter + compaction, OpenRouter backend.
 * Adapter semantics ported from deadczarvc/hermes-jev-compaction (MIT),
 * which maps OpenAI-chat transcripts onto fast-jev-compaction's Message[].
 * This variant needs no TypeSafe key: Jev runs through OpenRouter
 * /api/alpha/decisions with OPENROUTER_API_KEY.
 *
 * Usage:
 *   OPENROUTER_API_KEY=... node cli/hermes-compact.mjs transcript.json -o compacted.json [--md dump.md]
 *
 * Input: JSON array of OpenAI-chat messages, {"messages":[...]}, or JSONL.
 * Output: JSON {"messages":[...], "stats":{...}} — verbatim kept messages,
 * truncated dropped results, system entries restored as-is.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { compactMessages } from '../dist/index.js';

// ---------- adapter (ported from deadczarvc/hermes-jev-compaction, MIT) ----------
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('');
  }
  return '';
}

function parseInput(raw) {
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* raw wrapper */ }
    return { raw };
  }
  return {};
}

function fromHermes(messages) {
  const out = [];
  const systemTexts = [];
  const systemEntries = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = contentText(m.content);
      if (text) systemTexts.push(text);
      systemEntries.push(m);
      continue;
    }
    if (m.role === 'tool') {
      const result = { tool_use_id: m.tool_call_id ?? '', text: contentText(m.content) };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && prev.text === '' && prev.toolUses.length === 0 && prev.toolResults) {
        prev.toolResults.push(result);
      } else {
        out.push({ role: 'user', text: '', toolUses: [], toolResults: [result] });
      }
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const toolUses = (m.tool_calls ?? []).map((call, i) => ({
      tool_use_id: call.id ?? `call_${i}`,
      tool: call.name ?? call.function?.name ?? 'unknown_tool',
      input: parseInput(call.function?.arguments ?? call.arguments),
    }));
    out.push({ role, text: contentText(m.content), toolUses });
  }
  return { messages: out, systemTexts, systemEntries };
}

function toHermes(messages, systemEntries) {
  const out = [...(systemEntries ?? [])];
  for (const m of messages) {
    const hasTools = m.toolUses.length > 0;
    const results = m.toolResults ?? [];
    if (m.role === 'assistant') {
      if (m.text.length === 0 && !hasTools && results.length === 0) continue;
      if (m.text.length > 0 || hasTools) {
        const entry = { role: 'assistant', content: m.text.length > 0 ? m.text : null };
        if (hasTools) {
          entry.tool_calls = m.toolUses.map((u) => ({
            id: u.tool_use_id,
            type: 'function',
            function: { name: u.tool, arguments: JSON.stringify(u.input ?? {}) },
          }));
        }
        out.push(entry);
      }
      for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.text });
      continue;
    }
    for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: r.text });
    if (m.text.length > 0) out.push({ role: 'user', content: m.text });
  }
  return out;
}
// ---------- end adapter ----------

const args = process.argv.slice(2);
const inFile = args[0];
const outIdx = args.indexOf('-o');
const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
const mdIdx = args.indexOf('--md');
const mdFile = mdIdx !== -1 ? args[mdIdx + 1] : null;
const preserve = (() => {
  const i = args.indexOf('--preserve');
  return i !== -1 ? Number(args[i + 1]) : 4;
})();

if (!inFile) {
  console.error('usage: node cli/hermes-compact.mjs transcript.json [-o compacted.json] [--md dump.md] [--preserve N]');
  process.exit(2);
}

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error('OPENROUTER_API_KEY is not set');
  process.exit(2);
}

let rawText = readFileSync(inFile, 'utf8').trim();
let raw;
if (rawText.startsWith('[') || rawText.startsWith('{')) raw = JSON.parse(rawText);
else raw = rawText.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
if (raw && !Array.isArray(raw) && Array.isArray(raw.messages)) raw = raw.messages;

const { messages, systemTexts, systemEntries } = fromHermes(raw);
const goal = systemTexts.join('\n').slice(0, 8000) || undefined;

const result = await compactMessages(messages, {
  apiKey,
  model: process.env.JEV_MODEL || 'typesafe/jev-1.13',
  baseUrl: process.env.JEV_BASE_URL || 'https://openrouter.ai/api/alpha/decisions',
  goal,
  preserveRecentMessages: preserve,
});

const compacted = toHermes(result.messages, systemEntries);
const payload = { messages: compacted, stats: result.stats, usage: result.usage ?? {} };

const json = JSON.stringify(payload, null, 2);
if (outFile) writeFileSync(outFile, json + '\n', 'utf8');

if (mdFile) {
  const fmt = (s) => (s ?? '').replace(/\r?\n/g, ' ⏎ ').slice(0, 400);
  const lines = [`# hermes-compact dump — ${new Date().toISOString()}`, ''];
  const s = result.stats;
  lines.push(`Stats: ${s.messagesBefore}→${s.messagesAfter} msgs · ${s.charsBefore}→${s.charsAfter} chars · calls ${s.calls} (kept ${s.kept}, dropped ${s.callsDropped}, resultsDropped ${s.resultsDropped}, pinned ${s.pinned}) · ${s.requests} request(s) in ${s.ms} ms`);
  lines.push('');
  for (const [i, m] of result.messages.entries()) {
    lines.push(`## [${i}] ${m.role}`);
    if (m.text?.trim()) lines.push(m.text.trim());
    for (const tu of m.toolUses ?? []) {
      const d = result.decisions.find((x) => x.tool_use_id === tu.tool_use_id);
      lines.push(`- **${d ? d.action : 'pinned'}** \`${tu.tool}\` ${JSON.stringify(tu.input).slice(0, 300)}`);
    }
    lines.push('');
  }
  writeFileSync(mdFile, lines.join('\n'), 'utf8');
}

console.log(
  `hermes-compact: ${result.stats.messagesBefore}→${result.stats.messagesAfter} msgs, ` +
    `${result.stats.charsBefore}→${result.stats.charsAfter} chars, ` +
    `${result.stats.requests} Jev request(s) in ${result.stats.ms} ms` +
    (outFile ? ` → ${outFile}` : ''),
);
if (!outFile) console.log(json);