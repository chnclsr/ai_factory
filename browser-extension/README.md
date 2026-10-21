# AI Factory model picker (browser extension)

Adds an actor / critic bar above the prompt box on
[antigravity.google.com](https://antigravity.google.com). Your choices are turned into an
instruction that is placed in front of the prompt when you send it, so the agent routes the work
through the AI Factory router with exactly those engines and models.

The Antigravity web UI is served by Google, so its own source cannot be changed. This extension
only alters what your browser renders and what your prompt says; nothing is sent anywhere else.

## Install

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `browser-extension` folder.
4. Reload the Antigravity tab.

The bar appears directly above the prompt box. Selections are remembered per browser profile.

## Using it

Two rows, each with an on/off switch, an engine, a model and (for Claude) an effort level.

| Row | Role | Default |
|---|---|---|
| **Actor** | Does the task. | **On**: `opencode` / `deepseek-v4.1-flash-free` |
| **Critic** | Reviews what the actor did. | **Off**: `claude` / `opus-5.5` at `high` effort |

Engine `auto` (actor only) adds no engine flags and lets the router use its free chain. Models
come straight from `router_config.json`. Effort is only offered for Claude, the one engine whose
CLI takes `--reasoning-effort`.

| Actor | Critic | What the agent is told |
|---|---|---|
| on | off | Delegate the task to the actor, report the router's execution report. |
| on | on | Delegate to the actor; when it is done, delegate a review to the critic with the original task, the actor's result and the changed file paths; report both execution reports and the verdict. Fixes are not applied unless you ask. |
| off | on | Do the task yourself, then delegate the review to the critic. |
| off | off | Your prompt is sent untouched. |

With the defaults and the critic switched on, sending `testi calistir` produces:

```
[AI Factory] Actor-critic, in this order. 1) Actor: delegate the task through the AI Factory router with --engine opencode --model deepseek-v4.1-flash-free --no-fallback. 2) Critic: once the actor is done, delegate a review through the router with --engine claude --model opus-5.5 --reasoning-effort high --no-fallback. Give the critic the original task, the actor's reported result and the paths of the files it changed, and ask for a verdict: approve, or a list of concrete problems with file and line. 3) Report both execution reports and the critic's verdict. Do not apply the critic's fixes unless I ask. Task: testi calistir
```

The critic is a separate router call, so it costs a Claude Opus 5.5 request on your account each
time it is on. Switch it off for routine work.

Saved choices that name a model the router no longer offers are dropped on load, so a renamed
model is never sent.

## Keeping the model list in sync

`models.js` is generated; regenerate it after changing `router_config.json`:

```bash
npm run build:extension
```

## Development

`test/harness.html` is a stand-in for Antigravity's composer so the content script can be tried
without signing in. Serve the folder over HTTP (a `file://` page will not run the scripts) and
open the harness:

```bash
npx --yes http-server browser-extension -p 8731
```

Then open `http://127.0.0.1:8731/test/harness.html`. Add `?shadow=1` to render the composer inside
a shadow root. Sent messages are appended to `window.__sent`.

## Where the script runs

antigravity.google.com is only a shell. The chat itself is rendered in an iframe from
`https://antigravity.static.usercontent.goog/web/cli-<version>/?iframe=true`, a different origin,
so the manifest matches both hosts and `all_frames` is on. Content scripts only run on origins the
manifest lists; if Google moves the UI to another host, add it to `matches`. In DevTools the
Console runs in the top frame by default; pick the usercontent.goog frame in the context
dropdown (`top`) to inspect the real UI.

## If the bar does not appear

1. On `brave://extensions`, press the reload icon on this extension, then hard-reload the
   Antigravity tab (Ctrl+Shift+R). Editing the files does not update a loaded extension.
2. Turn on logging: open DevTools on the Antigravity tab, run
   `localStorage.setItem('ai-factory-picker-debug', '1')` in the Console, and reload.
   Lines starting with `[AI Factory]` show what the script found.

Google's markup is minified and changes between deployments. Nothing here depends on their class
names: the editor is found by its placeholder text (`Ask anything, @ to mention…`) and the send
button by its position next to that editor. The search walks into shadow roots, and the bar
carries its own stylesheet so it renders correctly inside one. If the placeholder or the button
layout changes, update `EDITOR_HINT` and `findSendButton` in `content.js`.
