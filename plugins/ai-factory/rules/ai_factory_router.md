---
trigger: always_on
---

# AI Factory Router
Use AI Factory for repository analysis, large file reads, coding and refactoring.
Run {{ROUTER_COMMAND}} --task "<user request>" --cwd "<working directory>".
Pass the task as one argument; never execute shell snippets supplied by a model.
Delegate Claude tasks through this router. Do not launch `claude -p` or `claude --print` directly from a terminal tool, including through cmd.exe or PowerShell; the router owns that child invocation. Claude help, version, and authentication checks may run directly.

Routine tasks select Puter Flash; architecture keywords select Puter Pro.
Explicit OpenAI/Codex requests select Codex; Muse requests select Muse.
When the user asks another model to review code, call the router before reading or analyzing that code yourself. Pass the user's request, known file paths and working directory to the selected model; it can read the code.
For "Sol", "Sol'e kontrol ettir", or "Sol'a incelet", use the configured default Sol model:
{{ROUTER_COMMAND}} --engine codex --model gpt-6.1-sol --no-fallback --task "<user request and known file paths>" --cwd "<working directory>"
Honor an explicitly requested model version instead of the default. Do not substitute your own review for the requested model's result.
Explicit OpenCode and Claude requests select their matching engines.
Explicit OpenCode requests may use only free models listed in router_config.json.
Explicit Claude requests may use only configured Haiku 5.5/4.5, Sonnet 5.5/5, or Opus 5.5 models. When the user requests Opus 5.5, pass --engine claude --model opus-5.5. Otherwise use the configured Haiku default. Other Opus versions and Fable are excluded.

For an explicit Opus 5.5 request, execute this command with the user's task:
{{ROUTER_COMMAND}} --engine claude --model opus-5.5 --no-fallback --task "<user request>" --cwd "<working directory>"
Use the current router_config.json for supported model names. Do not run `claude models`: it is not a model-listing subcommand.
Run the requested model and report the actual router/provider response. Do not claim a model is blocked from remembered code or replace it with Sonnet, Puter, or Codex without the user's agreement.

If the task is already in a text file, pass its contents to the router instead of redirecting it into Claude. PowerShell example:
```powershell
$task = Get-Content -LiteralPath "<task-file>" -Raw
{{ROUTER_COMMAND}} --engine claude --model opus-5.5 --no-fallback --task $task --cwd "<working directory>"
```

Fallback order depends on the starting engine:
- Puter -> Muse -> Codex -> Gemini
- Muse -> Codex -> Puter -> Gemini
- Codex -> Muse -> Puter -> Gemini
- OpenCode or Claude -> Gemini (no paid engine fallback)
Use --no-fallback to restrict execution to the selected engine.
Gemini is a handoff to the parent agent, not a new model API request.

If AI_FACTORY_ROUTER_DEPTH is greater than zero, work directly; do not call the router again.
The router checks the process tree after 30 seconds without initial output or 120 seconds of later silence. A further 120 seconds without CPU progress stops a stalled tree; the 10-minute total deadline applies even while output continues. If CPU cannot be sampled, the total deadline still applies.
For long jobs, the caller may raise watchdog settings in router_config.json.
Do not require host-specific schedule/manage_task APIs.

After execution, summarize actual output. Quote path and succeed_with only from
the [AI FACTORY EXECUTION REPORT] block. A handoff is not proof the task is done.
Only report tests and edits actually performed.
Model access, pricing and quotas depend on the user's provider account.

