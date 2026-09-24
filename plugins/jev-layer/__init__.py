"""jev-layer: architectural Jev decision layer for Hermes (v1.1).

Surfaces (all fail-open — a Jev error never blocks normal work):
  Hooks:
   1. System prompt section "jev-layer.rules" — durable always-on Jev rules.
   2. pre_llm_call — `jev-enhance` on every user message; injects refined phrasing.
   3. pre_tool_call — gates terminal commands (regex pre-filter -> Jev noul gate).
   4. post_tool_call — error observer log.
  Tools (callable by the model like any built-in tool):
   - jev_enhance(query)          -> JSON verdicts + refined prompt
   - jev_decide(state, question) -> raw Jev decision (choice/score/noul)
   - jev_find(query, dir)        -> semantic file search (walker ensemble)
   - jev_route(query)            -> complexity routing + skill suggestion
   - jev_qa(repo, diff)          -> pre-push QA scan
  Management slash commands:
   - /jev-status  — versions, live Jev ping, hook stats from logs
   - /jev-test    — self-test suite (enhance/gate probes, live)
   - /jev-update  — npm update of the jev packages + version report
"""
import json
import os
import re
import subprocess
import time
from pathlib import Path

LOG_DIR = Path(__file__).parent / "logs"
LOG_DIR.mkdir(exist_ok=True)
TOOL_LOG = LOG_DIR / "tool_calls.jsonl"
ENHANCE_LOG = LOG_DIR / "enhance.jsonl"

ENHANCE_MIN_LEN = 15
ENHANCE_SKIP_PREFIXES = ("/", "!", "[", "MEDIA:", "http")
ENHANCE_TIMEOUT_S = 25
JEV_TIMEOUT_S = 8
DANGEROUS_BLOCK_P = 0.80

_JEV_URL = "https://openrouter.ai/api/alpha/decisions"
_JEV_MODEL = "typesafe/jev-1.13"

NPM_PACKAGES = ["fast-jev-compaction", "jev-prompt-enhancer", "jev-skill-router"]

RISK_PATTERNS = [
    r"rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b",
    r"\bgit\s+push\b[^|]*--force",
    r"\bgit\s+reset\s+--hard",
    r"(sk-or-v1-|ghp_|gho_|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY)",
    r"\b(DROP\s+TABLE|TRUNCATE\s+TABLE|DELETE\s+FROM)\b",
    r"\b(sudo\s+rm|mkfs|format\s+[a-zA-Z]:|Remove-Item.*-Recurse.*-Force)",
    r"\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|powershell|iex)",
]


def _openrouter_key():
    for path in (
        Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")) / ".env",
        Path.home() / ".hermes" / ".env",
    ):
        try:
            for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
                if line.startswith("OPENROUTER_API_KEY="):
                    return line.split("=", 1)[1].strip()
        except OSError:
            continue
    return os.environ.get("OPENROUTER_API_KEY")


def _env():
    env = dict(os.environ)
    key = _openrouter_key()
    if key:
        env.setdefault("OPENROUTER_API_KEY", key)
    return env


def _sh(cmd, timeout=60, inp=None):
    """Run a command; on Windows wrap bare exe names via cmd /c (npm .cmd shims)."""
    if os.name == "nt" and isinstance(cmd, list) and cmd and not cmd[0].lower().endswith((".exe", ".py")):
        cmd = ["cmd", "/c"] + cmd
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           encoding="utf-8", errors="replace", input=inp, env=_env())
        return p.returncode, (p.stdout or ""), (p.stderr or "")
    except Exception as e:
        return 1, "", str(e)


def _jev_decide(state: str, question: dict):
    """One Jev call. Returns answers dict or None on any failure (fail-open)."""
    key = _openrouter_key()
    if not key:
        return None
    import urllib.request

    body = {"model": _JEV_MODEL, "state": state[:55000], "questions": {"q": question}}
    req = urllib.request.Request(
        _JEV_URL, data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=JEV_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8")).get("answers") or {}
    except Exception:
        return None


def _log(path: Path, obj: dict):
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    except OSError:
        pass


# --- hooks -------------------------------------------------------------------
JEV_RULES = """### Jev layer (plugin jev-layer)
This profile runs a Jev decision layer:
- Every user message is automatically checked by `jev-enhance` before you see it. If a refinement note ("Treat the user's request as...") appears, the refined text preserves the user's intent — follow it, but the user's original words still take precedence on any disagreement.
- Terminal commands that look dangerous are gated by Jev (pre_tool_call). If a command you proposed is blocked, do NOT retry the same command; diagnose first and propose a safer alternative.
- Registered Jev tools (call them like built-in tools): jev_enhance (improve a vague prompt), jev_decide (any classification/score/yes-no decision), jev_find (semantic file search in a repo), jev_route (complexity routing / skill suggestion), jev_qa (pre-push QA scan of a repo, diff=true for changed files only).
- Jev is a decision model (typesafe/jev-1.13 via OpenRouter /api/alpha/decisions), not a text generator: use it for decisions, not for writing content.
- Fail-open rule: if a jev tool fails, continue the task without it and note the failure.
- `/jev-status`, `/jev-test`, `/jev-update` manage and monitor the layer."""


def _rules(session_info=None):
    return JEV_RULES


def _enhance_hook(**kwargs):
    user_message = kwargs.get("user_message") or ""
    if not isinstance(user_message, str) or len(user_message) < ENHANCE_MIN_LEN:
        return None
    if user_message.lstrip().startswith(ENHANCE_SKIP_PREFIXES):
        return None
    rc, out, err = _sh(["jev-enhance", user_message], timeout=ENHANCE_TIMEOUT_S)
    out = out.strip()
    if rc != 0 or not out.startswith("{"):
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None
    if data.get("error"):
        return None
    _log(ENHANCE_LOG, {
        "t": time.time(), "enhance": data.get("enhance"),
        "needs": data.get("needs_refinement"), "problem": data.get("problem"),
        "latency_ms": data.get("latency_ms"), "user": user_message[:120],
    })
    if not data.get("enhance"):
        return None
    enhanced = data.get("enhanced") or ""
    if not enhanced or enhanced.strip() == user_message.strip():
        return None
    return (
        "[Prompt refinement note (Jev): the user's request, technically refined, "
        f"same intent: \"{enhanced}\". The user's original message above remains "
        "the source of truth; if the refinement and the original disagree, ask.]"
    )


def _tool_gate(**kwargs):
    if (kwargs.get("tool_name") or "") != "terminal":
        return None
    args = kwargs.get("args") or {}
    command = args.get("command") or ""
    if not isinstance(command, str) or not command:
        return None
    if not any(re.search(p, command) for p in RISK_PATTERNS):
        return None
    answers = _jev_decide(
        f"Terminal command proposed for execution on the user's Windows machine:\n{command}",
        {
            "type": "noul",
            "instructions": (
                "Is this command dangerous to execute — i.e. irreversible data loss, "
                "publishing secrets, force-push/destructive git operation, or destructive "
                "system change? Routine builds, installs, tests, git commits/pushes (non-force) "
                "and file edits are NOT dangerous. Answer with probability of dangerous."
            ),
        },
    )
    if not answers:
        return None  # Jev unreachable -> fail-open
    prob = answers.get("q", {}).get("noul", 0.0)
    _log(TOOL_LOG, {"t": time.time(), "gate": "pre_tool_call", "p": prob, "cmd": command[:200]})
    if prob >= DANGEROUS_BLOCK_P:
        return {"decision": "block", "reason": (
            f"jev-layer gate: Jev rates this command dangerous (p={prob:.2f}). "
            "Diagnose and propose a safer alternative instead of retrying."
        )}
    return None


def _post_tool(**kwargs):
    if kwargs.get("status") not in (None, "ok", "success"):
        _log(TOOL_LOG, {
            "t": time.time(), "tool": kwargs.get("tool_name"),
            "status": kwargs.get("status"), "error": (kwargs.get("error_message") or "")[:200],
        })
    return None


# --- tools (model-callable) ---------------------------------------------------
def _tool_jev_enhance(params, **kwargs):
    q = (params or {}).get("query", "")
    rc, out, err = _sh(["jev-enhance", q], timeout=ENHANCE_TIMEOUT_S)
    return out.strip() or json.dumps({"error": (err or "no output")[:200]})


def _tool_jev_decide(params, **kwargs):
    p = params or {}
    try:
        question = p.get("question") if isinstance(p.get("question"), dict) \
            else json.loads(p.get("question", "{}"))
    except json.JSONDecodeError:
        return json.dumps({"error": "question must be JSON: {type, instructions, options?/criteria?}"})
    answers = _jev_decide(p.get("state", ""), question)
    if not answers:
        return json.dumps({"error": "jev unreachable (fail-open)"})
    return json.dumps(answers, ensure_ascii=False)


def _tool_jev_find(params, **kwargs):
    p = params or {}
    cmd = ["jev-find", p.get("query", ""), p.get("dir", ".")]
    if p.get("walkers"):
        cmd += ["--walkers", str(int(p["walkers"]))]
    rc, out, err = _sh(cmd, timeout=120)
    return (out.strip() + ("\n" + err.strip() if err.strip() else "")) or "no matches"


def _tool_jev_route(params, **kwargs):
    rc, out, err = _sh(["jev-skill-router", (params or {}).get("query", "")], timeout=30)
    return out.strip() or json.dumps({"error": (err or "no output")[:200]})


def _tool_jev_qa(params, **kwargs):
    p = params or {}
    cmd = ["jev-qa", p.get("repo", ".")]
    if p.get("diff"):
        cmd.append("--diff")
    rc, out, err = _sh(cmd, timeout=300)
    return (out.strip() + ("\n" + err.strip() if err.strip() else "")) or json.dumps({"error": "no output"})


# --- management commands -------------------------------------------------------
def _npm_versions():
    rc, out, _ = _sh(["npm", "ls", "-g", "--depth=0"], timeout=60)
    installed = {}
    for pkg in NPM_PACKAGES:
        m = re.search(re.escape(pkg) + r"@([\d.]+)", out)
        installed[pkg] = m.group(1) if m else "not installed"
    return installed


def _cmd_status(params=None, **kwargs):
    key_ok = bool(_openrouter_key())
    ping = _jev_decide("ping", {"type": "noul", "instructions": "Reply with probability 0.5."})
    lines = ["*jev-layer status*", f"- OPENROUTER_API_KEY: {'ok' if key_ok else 'MISSING'}",
             f"- Jev live ping: {'ok' if ping else 'FAILED'}", "- npm packages (installed):"]
    for pkg, ver in _npm_versions().items():
        lines.append(f"  - {pkg}: {ver}")
    for name, path in (("enhance", ENHANCE_LOG), ("gate/errors", TOOL_LOG)):
        try:
            n = sum(1 for _ in open(path, encoding="utf-8", errors="ignore"))
        except OSError:
            n = 0
        lines.append(f"- {name} log entries: {n}")
    blocks = 0
    try:
        for line in open(TOOL_LOG, encoding="utf-8", errors="ignore"):
            try:
                if json.loads(line).get("p", 0) >= DANGEROUS_BLOCK_P:
                    blocks += 1
            except Exception:
                pass
    except OSError:
        pass
    lines.append(f"- commands blocked by gate so far: {blocks}")
    return "\n".join(lines)


def _cmd_test(params=None, **kwargs):
    results = []
    t0 = time.time()
    rc, out, _ = _sh(["jev-enhance", "зделай что-нить для сайта штоб быстрее работал"], timeout=ENHANCE_TIMEOUT_S)
    try:
        d = json.loads(out)
        results.append(("enhance garbled -> refined", bool(d.get("enhance")), f"needs={d.get('needs_refinement')}"))
    except Exception:
        results.append(("enhance garbled -> refined", False, "parse fail"))
    rc, out, _ = _sh(["jev-enhance", "Fix the failing test in tests/auth.spec.ts"], timeout=ENHANCE_TIMEOUT_S)
    try:
        d = json.loads(out)
        results.append(("enhance clear -> untouched", not d.get("enhance"), f"needs={d.get('needs_refinement')}"))
    except Exception:
        results.append(("enhance clear -> untouched", False, "parse fail"))
    a1 = _jev_decide("Terminal command: rm -rf /c/Users/bistr/Projects",
                     {"type": "noul", "instructions": "Is this command dangerous (irreversible data loss)? Probability of dangerous."})
    a2 = _jev_decide("Terminal command: npm test",
                     {"type": "noul", "instructions": "Is this command dangerous (irreversible data loss)? Probability of dangerous."})
    p1 = (a1 or {}).get("q", {}).get("noul")
    p2 = (a2 or {}).get("q", {}).get("noul")
    results.append(("gate dangerous (rm -rf) p>=0.8", bool(p1 and p1 >= DANGEROUS_BLOCK_P), f"p={p1}"))
    results.append(("gate safe (npm test) p<0.8", bool(p2 is not None and p2 < DANGEROUS_BLOCK_P), f"p={p2}"))
    lines = ["*jev-layer self-test*", f"total {round(time.time()-t0, 1)}s"]
    ok = 0
    for name, passed, detail in results:
        ok += passed
        lines.append(f"- {'PASS' if passed else 'FAIL'} {name} ({detail})")
    lines.append(f"**{ok}/{len(results)} passed**")
    return "\n".join(lines)


def _cmd_update(params=None, **kwargs):
    before = _npm_versions()
    rc, out, err = _sh(["npm", "install", "-g"] + NPM_PACKAGES, timeout=300)
    after = _npm_versions()
    lines = ["*jev-layer update*"]
    for pkg in NPM_PACKAGES:
        mark = "updated" if before[pkg] != after[pkg] else "same"
        lines.append(f"- {pkg}: {before[pkg]} -> {after[pkg]} ({mark})")
    if rc != 0:
        lines.append(f"- npm error: {(err or out)[:200]}")
    lines.append("- Restart the gateway (or /new) if CLI contracts changed.")
    return "\n".join(lines)


def register(ctx):
    ctx.register_system_prompt_section("jev-layer.rules", _rules,
                                       position="after_memory", max_chars=4000)
    ctx.register_hook("pre_llm_call", _enhance_hook)
    ctx.register_hook("pre_tool_call", _tool_gate)
    ctx.register_hook("post_tool_call", _post_tool)

    ctx.register_tool(
        name="jev_enhance", toolset="jev",
        schema={"name": "jev_enhance",
                "description": "Check a user query via Jev; returns refined phrasing + verdicts if it needs refinement.",
                "parameters": {"type": "object", "properties": {
                    "query": {"type": "string", "description": "Raw user query"}},
                    "required": ["query"]}},
        handler=_tool_jev_enhance)
    ctx.register_tool(
        name="jev_decide", toolset="jev",
        schema={"name": "jev_decide",
                "description": "Ask Jev (typesafe/jev-1.13) a structured decision. question JSON: {type: choice|score|noul, instructions, options?/criteria?}. Use for classification/gating, never text generation.",
                "parameters": {"type": "object", "properties": {
                    "state": {"type": "string", "description": "Context data (<= ~50k chars)"},
                    "question": {"type": ["object", "string"], "description": "Question object or JSON string"}},
                    "required": ["state", "question"]}},
        handler=_tool_jev_decide)
    ctx.register_tool(
        name="jev_find", toolset="jev",
        schema={"name": "jev_find",
                "description": "Semantic file search in a repo via Jev walker ensemble (finds by meaning, not keywords).",
                "parameters": {"type": "object", "properties": {
                    "query": {"type": "string"}, "dir": {"type": "string"},
                    "walkers": {"type": "integer", "description": "default 8"}},
                    "required": ["query", "dir"]}},
        handler=_tool_jev_find)
    ctx.register_tool(
        name="jev_route", toolset="jev",
        schema={"name": "jev_route",
                "description": "Complexity routing: returns complexity score + suggested skill for a request.",
                "parameters": {"type": "object", "properties": {
                    "query": {"type": "string"}}, "required": ["query"]}},
        handler=_tool_jev_route)
    ctx.register_tool(
        name="jev_qa", toolset="jev",
        schema={"name": "jev_qa",
                "description": "Pre-push QA scan of a repo (free syntax stage, then Jev semantic stage sorted by risk).",
                "parameters": {"type": "object", "properties": {
                    "repo": {"type": "string"}, "diff": {"type": "boolean", "description": "scan only changed files"}},
                    "required": ["repo"]}},
        handler=_tool_jev_qa)

    ctx.register_command("jev-status", _cmd_status, "jev-layer: versions, live Jev ping, hook stats")
    ctx.register_command("jev-test", _cmd_test, "jev-layer: run self-test suite (live Jev calls)")
    ctx.register_command("jev-update", _cmd_update, "jev-layer: npm-update the jev packages and report versions")
