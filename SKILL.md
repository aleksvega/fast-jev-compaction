---
name: jev-tools
description: Use when a user asks to install or use Jev tools (jev-compact, jev-enhance, jev-find, jev-qa, jev-skill-router) — one-command setup across AI agents/harnesses.
---

# Jev Tool Suite

A decision layer built on [Jev](https://openrouter.ai) (System One, typesafe/jev-1.13) via OpenRouter.
Three CLIs + optional plugins for Claude Code, OpenCode, Codex, Hermes, and generic agents.

## Tools
| CLI | Purpose |
|---|---|
| `jev-compact` / `jev-compact --stdin` | Verbatim context dump / auto-compaction before `/new` or when context is long |
| `jev-enhance "<query>"` | Prompt refinement; JSON out `{enhanced, verdicts[], enhance}` — use `enhanced` when all verdicts true |
| `jev-find "<query>" --dir <repo>` | Semantic file search (repo/classification decisions) |
| `jev-qa <repo> [--diff]` | Pre-push QA scan of a repo or changed files |
| `jev-skill-router "<query>"` | Suggests which tool/skill fits a request |

## Install (3–5 seconds)
```bash
npx jev-setup <claude|opencode|codex|hermes|generic>
```
Requires only `OPENROUTER_API_KEY` in the environment (get one at openrouter.ai/keys).

## Rules for the agent
1. Before compaction or `/new`: dump context with `jev-compact`.
2. Before pushing to production: run `jev-qa <repo> --diff`.
3. When a user message is vague or voice-transcribed: run `jev-enhance` and use the refined phrasing (intent preserved).
4. Fail-open: if any Jev call errors or times out, proceed without it and note the failure.
