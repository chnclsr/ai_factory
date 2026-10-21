# AI Factory model picker (browser extension)

Adds an engine / model / effort bar above the prompt box on
[antigravity.google.com](https://antigravity.google.com). Your choice is turned into a one-line
instruction that is placed in front of the prompt when you send it, so the agent routes the task
through the AI Factory router with exactly that engine and model.

The Antigravity web UI is served by Google, so its own source cannot be changed. This extension
only alters what your browser renders and what your prompt says; nothing is sent anywhere else.

## Install

1. Open `brave://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this `browser-extension` folder.
4. Reload the Antigravity tab.

The bar appears directly above the prompt box. Selections are remembered per browser profile.

## Using it

| Control | What it does |
|---|---|
| `AI Factory: on/off` | Off sends your prompt untouched. |
| Engine | `auto` adds nothing and lets the router use its free chain. Any other engine is passed as `--engine`. |
| Model | The models the router accepts for that engine, straight from `router_config.json`. |
| Effort | Only shown for Claude, which is the one engine whose CLI takes `--reasoning-effort`. `auto` leaves the choice to the router. |

With `claude` / `opus-5.5` / `high` selected, typing `mimariyi incele` and sending produces:

```
[AI Factory] Delegate this task through the AI Factory router with --engine claude --model opus-5.5 --reasoning-effort high --no-fallback, and report the router's execution report. Task: mimariyi incele
```

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
