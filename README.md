# AI Factory

> **Smart Token Offloading and Multi-Engine Orchestrator for Antigravity**

AI Factory is an automated routing and token offloading orchestrator designed for Antigravity and Gemini environments. It preserves context window capacity and model quotas by delegating heavy codebase inspection, repository analysis, large document processing, and deep algorithmic reasoning to zero-cost ($0) backend engines.

---

## Architecture and Core Principles

### 1. Zero-Cost Engine Hierarchy
When a task is submitted, AI Factory delegates work sequentially across configured engines:

1. **Puter Flash (DeepSeek Flash - $0):** Default engine for repository analysis, file structure mapping, function inspection, and general codebase exploration.
2. **Puter Pro (DeepSeek R1/Pro - $0):** Activated for deep algorithmic reasoning, mathematical optimization, and structural refactoring.
3. **Muse Coding Agent (muse-spark-1.3-contributor - $0):** Primary autonomous fallback powered by Meta, hard-locked to contributor mode to prevent billed usage.
4. **OpenAI Codex (GPT-6 / 5.6):** Secondary fallback and sandbox execution engine.
5. **Antigravity / Gemini:** Final orchestrator responsible for surgical application and user delivery.

### 2. Staged Watchdog Protocol (30s -> 120s -> 240s)
Background tasks are monitored through a multi-stage watchdog to detect timeouts or interactive prompts without early cancellation:
- **Stage 1 (30s):** Fast health check for immediate failures or prompts.
- **Stage 2 (120s):** Standard execution check for ongoing tasks.
- **Stage 3 (240s):** Extended window for intensive refactoring jobs.
- All stages strictly use `TimerCondition='never'` to ensure progress logs do not prematurely dismiss timers.

### 3. Dynamic Execution Path Reporting
Every execution records and displays only the engines that were actively engaged:
```text
path: gemini --> puter(deepseek-flash) [OK]
succeed_with: puter
```

### 4. Global Plugin and Hook Integration
AI Factory registers globally inside Antigravity through event hooks (`hooks.json`, `hook_handler.js`), providing persistent token offloading across all workspaces and conversations without manual invocation.

### 5. Multi-Provider Quota Tracker
Real-time quota monitoring across Puter, Muse, Codex, and Antigravity via RPC and official metering endpoints.

---

## Directory Structure

```text
ai_factory/
├── router.mjs                 # Main CLI entry point
├── server.mjs                 # Puter RPC and local bridge service
├── quota_tracker.mjs          # Multi-provider quota inspection utility
├── check_quotas.ps1           # PowerShell quota check runner
├── deploy_skill.mjs           # Distribution script for global Antigravity dirs
├── router_config.json         # Engine models and watchdog parameters
├── src/                       # Core implementation modules
│   ├── router.mjs
│   ├── server.mjs
│   └── quota_tracker.mjs
├── lib/                       # Path resolution and plugin utilities
│   ├── paths.mjs
│   └── plugin.mjs
├── scripts/
│   └── setup.mjs              # Environment initialization
└── plugins/ai-factory/        # Global Antigravity Plugin
    ├── plugin.json            # Plugin manifest
    ├── hooks.json             # Event hooks (PreInvocation, PreToolUse)
    ├── hooks/
    │   ├── hook_handler.js    # Context protection and auto-delegation hook
    │   └── inject.js          # System prompt injection helper
    ├── rules/
    │   ├── AGENTS.md          # Global agent rules and watchdog protocol
    │   ├── GEMINI.md          # Gemini synchronization rules
    │   └── ai_factory_router.md
    └── skills/ai-factory/
        └── SKILL.md           # Antigravity skill specification
```

---

## Installation

### Prerequisites
- Node.js 18 or higher
- Antigravity CLI (`agy`) or Antigravity IDE

### Setup
1. Clone the repository:
   ```bash
   git clone https://github.com/chnclsr/ai_factory.git
   cd ai_factory
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Deploy rules and skills globally to Antigravity directories:
   ```bash
   node deploy_skill.mjs
   ```

---

## Usage

### Default Code/Repo Delegation (0$ Puter Flash)
```bash
node router.mjs --task "Analyze the repository structure and summarize dependencies"
```

### Deep Reasoning Mode (0$ Puter Pro / R1)
```bash
node router.mjs --engine puter --model pro --task "Optimize algorithmic complexity for the core pipeline"
```

### Meta Muse Agent (0$ Contributor Mode)
```bash
node router.mjs --engine muse --task "Implement missing unit tests for the router module"
```

### OpenAI Codex Engine
```bash
node router.mjs --engine codex --model gpt-6.1-sol --task "Produce architectural refactoring roadmap"
```

### Live Quota Status Check
```bash
node router.mjs --quota
```
Or via PowerShell:
```powershell
.\check_quotas.ps1
```

---

## Security

- Authentication tokens (`puter_token.txt`) and session registries are listed in `.gitignore` to prevent credential exposure.
- Muse integration is hard-locked to `muse-spark-1.3-contributor`, preventing accidental charges from billed models.

---

## License
MIT License