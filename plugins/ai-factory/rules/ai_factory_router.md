# AI Factory Router
Use AI Factory for repository analysis, large file reads, coding and refactoring.
Run {{ROUTER_COMMAND}} --task "<user request>" --cwd "<working directory>".
Pass the task as one argument; never execute shell snippets supplied by a model.

Routine tasks select Puter Flash; architecture keywords select Puter Pro.
Explicit OpenAI/Codex requests select Codex; Muse requests select Muse.
Fallback order depends on the starting engine:
- Puter -> Muse -> Codex -> Gemini
- Muse -> Codex -> Puter -> Gemini
- Codex -> Muse -> Puter -> Gemini
Use --no-fallback to restrict execution to the selected engine.
Gemini is a handoff to the parent agent, not a new model API request.

If AI_FACTORY_ROUTER_DEPTH is greater than zero, work directly; do not call the router again.
The router owns its 30-second initial / 120-second idle watchdog.
For long jobs, the caller may raise watchdog settings in router_config.json.
Do not require host-specific schedule/manage_task APIs.

After execution, summarize actual output. Quote path and succeed_with only from
the [AI FACTORY EXECUTION REPORT] block. A handoff is not proof the task is done.
Only report tests and edits actually performed.
Model access, pricing and quotas depend on the user's provider account.

