import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { puter } from '@heyputer/puter.js';
import { TOKEN_FILE, PORT, BRIDGE_URL } from '../lib/paths.mjs';



let currentToken = process.env.PUTER_TOKEN || null;
if (currentToken) puter.setAuthToken(currentToken);
if (!currentToken && fs.existsSync(TOKEN_FILE)) {
  currentToken = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (currentToken) {
    puter.setAuthToken(currentToken);
    console.log('[Puter Bridge] Loaded saved token from puter_token.txt');
  }
}

process.on('uncaughtException', (err) => {
  console.error('[Puter Bridge UncaughtException]:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Puter Bridge UnhandledRejection]:', reason?.message || reason);
});

function safeWrite(res, data) {
  if (res && !res.destroyed && !res.writableEnded) {
    try {
      res.write(data);
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

function safeEnd(res, data) {
  if (res && !res.destroyed && !res.writableEnded) {
    try {
      if (data !== undefined) res.end(data);
      else res.end();
    } catch (e) {}
  }
}

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <title>Puter Free DeepSeek K\u00f6pr\u00fcs\u00fc</title>
  <script src="https://js.puter.com/v2/"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 32px; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 480px; width: 100%; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #38bdf8; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.5; margin-bottom: 24px; }
    .status { padding: 12px; border-radius: 8px; font-weight: 500; margin-bottom: 20px; font-size: 15px; }
    .status.connected { background: #064e3b; color: #34d399; }
    .status.disconnected { background: #451a03; color: #fb923c; }
    button { background: #0284c7; color: white; border: none; padding: 14px 28px; font-size: 16px; font-weight: 600; border-radius: 8px; cursor: pointer; transition: 0.2s; width: 100%; }
    button:hover { background: #0369a1; }
    .models { margin-top: 24px; text-align: left; background: #0f172a; padding: 14px; border-radius: 8px; font-size: 13px; color: #cbd5e1; }
    .model-badge { display: inline-block; background: #334155; padding: 3px 8px; border-radius: 4px; margin: 2px; color: #38bdf8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Puter DeepSeek K\u00f6pr\u00fcs\u00fc</h1>
    <p>Puter hesab\u0131n\u0131z\u0131 yerel k\u00f6pr\u00fcye ba\u011flay\u0131n. Model eri\u015fimi ve kullan\u0131m s\u0131n\u0131rlar\u0131 hesab\u0131n\u0131za ba\u011fl\u0131d\u0131r.</p>
    
    <div id="statusBox" class="status ${currentToken ? 'connected' : 'disconnected'}">
      ${currentToken ? '\u2705 Durum: Ba\u011fl\u0131 (Kullan\u0131ma Haz\u0131r)' : '\u26a0\ufe0f Durum: Ba\u011fl\u0131 De\u011fil (Giri\u015f Gerekli)'}
    </div>

    <button id="authBtn" onclick="handleAuth()">
      ${currentToken ? 'Yeniden Yetkilendir / Hesap De\u011fi\u015ftir' : 'Puter ile \u00dccretsiz Ba\u011flan'}
    </button>

    <div class="models">
      <strong>Aktif Modeller:</strong><br>
      <span class="model-badge">deepseek/deepseek-v4.1-flash</span>
      <span class="model-badge">deepseek/deepseek-v4-pro</span>
      <span class="model-badge">deepseek/deepseek-r1</span>
    </div>
  </div>

  <script>
    async function handleAuth() {
      const btn = document.getElementById('authBtn');
      const box = document.getElementById('statusBox');
      btn.textContent = 'Ba\u011flan\u0131yor...';
      btn.disabled = true;

      try {
        const res = await puter.auth.signIn({ attempt_temp_user_creation: true });
        if (res && res.token) {
          const saveRes = await fetch('/api/save-token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: res.token })
          });
          const data = await saveRes.json();
          if (data.ok) {
            box.className = 'status connected';
            box.textContent = '\u2705 Ba\u015far\u0131yla Ba\u011fland\u0131! DeepSeek modelleri haz\u0131r.';
            btn.textContent = 'Ba\u011flant\u0131 Ba\u015far\u0131l\u0131';
          }
        }
      } catch (err) {
        console.error(err);
        box.className = 'status disconnected';
        box.textContent = 'Hata: ' + (err.message || 'Ba\u011flan\u0131lamad\u0131');
        btn.textContent = 'Tekrar Dene';
        btn.disabled = false;
      }
    }
  </script>
</body>
</html>`;


function parseDsmlTools(fullText) {
  // 1. Look for XML style <\uff5cDSML\uff5c calls>
  const callsMatch = fullText.match(/<[|\uff5c]DSML[|\uff5c]\s*calls>([\s\S]*?)<\/[|\uff5c]DSML[|\uff5c]\s*calls>/i);
  if (callsMatch) {
    const beforeText = fullText.slice(0, callsMatch.index).trim();
    const inside = callsMatch[1];
    const toolCalls = [];

    const invokeRegex = /<[|\uff5c]DSML[|\uff5c]\s*invoke\s+name="([^"]+)">([\s\S]*?)<\/[|\uff5c]DSML[|\uff5c]\s*invoke>/gi;
    let match;
    while ((match = invokeRegex.exec(inside)) !== null) {
      const toolName = match[1];
      const paramsBlock = match[2];
      const args = {};

      const paramRegex = /<[|\uff5c]DSML[|\uff5c]\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/[|\uff5c]DSML[|\uff5c]\s*parameter>/gi;
      let pMatch;
      while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
        const pName = pMatch[1];
        const pVal = pMatch[2].trim();
        try {
          args[pName] = JSON.parse(pVal);
        } catch (e) {
          args[pName] = pVal;
        }
      }

      // Map path -> file_path if tool is read
      if (toolName === 'read' && args.path && !args.file_path) {
        args.file_path = args.path;
      }

      toolCalls.push({
        id: 'toolu_' + Math.random().toString(36).slice(2, 10),
        name: toolName,
        input: args
      });
    }

    return { text: beforeText, toolCalls };
  }

  // 2. Look for JSON lines style {"type":"tool_use", ...}
  const jsonLines = fullText.split('\n');
  const toolCalls = [];
  let remainingText = [];
  for (const line of jsonLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('{"type":"tool_use"') || trimmed.startsWith('{"type": "tool_use"')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.name === 'read' && parsed.input?.path && !parsed.input?.file_path) {
          parsed.input.file_path = parsed.input.path;
        }
        toolCalls.push({
          id: parsed.id || ('toolu_' + Math.random().toString(36).slice(2, 10)),
          name: parsed.name,
          input: parsed.input || {}
        });
      } catch (e) {
        remainingText.push(line);
      }
    } else {
      remainingText.push(line);
    }
  }

  if (toolCalls.length > 0) {
    return { text: remainingText.join('\n').trim(), toolCalls };
  }

  return { text: fullText, toolCalls: [] };
}

function mapModel(modelName) {
  if (!modelName) return 'openrouter:deepseek/deepseek-v4.1-flash';
  const lower = modelName.toLowerCase();
  if (lower.includes('r1')) return 'openrouter:deepseek/deepseek-r1';
  if (lower.includes('pro') || lower.includes('reasoner')) {
    return 'openrouter:deepseek/deepseek-v4-pro';
  }
  return 'openrouter:deepseek/deepseek-v4.1-flash';
}

const server = http.createServer(async (req, res) => {
  // CORS
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(req.headers.host)) { res.writeHead(403); res.end('Invalid host'); return; }
  if (req.headers.origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(req.headers.origin)) {
    res.writeHead(403); res.end('Origin not allowed'); return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const length = Number(req.headers['content-length'] || 0);
  if (length > 2 * 1024 * 1024) { res.writeHead(413); res.end('Body too large'); return; }
  let received = 0;
  req.on('data', chunk => {
    received += chunk.length;
    if (received > 2 * 1024 * 1024) { res.writeHead(413); res.end('Body too large'); req.destroy(); }
  });

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // UI
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_CONTENT);
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'ai-factory', authenticated: Boolean(currentToken) }));
    return;
  }

  // Save Token API
  if (req.method === 'POST' && url === '/api/save-token') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body);
        if (typeof token === 'string' && token.trim() && token.length <= 16384) {
          currentToken = token;
          puter.setAuthToken(token);
          fs.writeFileSync(TOKEN_FILE, token, { encoding: 'utf8', mode: 0o600 });
          console.log('[Puter Bridge] Auth token successfully saved and active!');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      } catch (e) {}
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid token' }));
    });
    return;
  }

  // OpenAI Models List
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-flash', object: 'model', created: Date.now(), owned_by: 'puter' },
        { id: 'deepseek-v4-pro', object: 'model', created: Date.now(), owned_by: 'puter' },
        { id: 'deepseek/deepseek-v4.1-flash', object: 'model', created: Date.now(), owned_by: 'puter' },
        { id: 'deepseek/deepseek-v4-pro', object: 'model', created: Date.now(), owned_by: 'puter' }
      ]
    }));
    return;
  }

  // OpenAI Chat Completions API
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    if (!currentToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Open ' + BRIDGE_URL + ' to sign in.' } }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const modelToUse = mapModel(payload.model);
        console.log(`[Puter Bridge] Request for model: ${payload.model} -> mapped to: ${modelToUse} (stream: ${!!payload.stream})`);

        if (!currentToken) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              message: 'Puter Bridge is not authenticated. Please open http://localhost:8080 in your browser to sign in.',
              type: 'authentication_error'
            }
          }));
          return;
        }

        // Format messages for puter
        const messages = (payload.messages || []).map(m => {
          let content = m.content;
          if (Array.isArray(content)) {
            content = content.map(part => typeof part === 'string' ? part : (part.text || '')).join('\n');
          }
          return { role: m.role || 'user', content: String(content || '') };
        });

        if (payload.stream) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });

          const streamResponse = await puter.ai.chat(messages, {
            model: modelToUse,
            stream: true
          });

          const id = 'chatcmpl-' + Math.random().toString(36).slice(2);
          for await (const chunk of streamResponse) {
            const text = chunk?.text || '';
            const reasoning = chunk?.reasoning || '';
            
            const sseData = {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: payload.model || modelToUse,
              choices: [{
                index: 0,
                delta: {
                  content: text,
                  ...(reasoning ? { reasoning_content: reasoning } : {})
                },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(sseData)}\n\n`);
          }

          // Final chunk
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: payload.model || modelToUse,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          const resp = await puter.ai.chat(messages, {
            model: modelToUse,
            stream: false
          });

          const content = resp?.message?.content || resp?.text || String(resp || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-' + Math.random().toString(36).slice(2),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: payload.model || modelToUse,
            choices: [{
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop'
            }]
          }));
        }
      } catch (err) {
        console.error('[Puter Bridge] Error:', err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({
          error: {
            message: err.message || 'Internal Puter bridge error',
            type: 'api_error'
          }
        }));
      }
    });
    return;
  }

  // Anthropic Messages API compatibility endpoint
  if (req.method === 'POST' && (url === '/v1/messages' || url === '/messages')) {
    if (!currentToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Open ' + BRIDGE_URL + ' to sign in.' } }));
      return;
    }
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const modelToUse = mapModel(payload.model);
        console.log(`[Puter Bridge Anthropic] Request for: ${payload.model} -> ${modelToUse} (stream: ${!!payload.stream})`);

        let messages = [];
        if (payload.system) {
          messages.push({ role: 'system', content: typeof payload.system === 'string' ? payload.system : JSON.stringify(payload.system) });
        }
        for (const m of (payload.messages || [])) {
          let text = '';
          if (typeof m.content === 'string') text = m.content;
          else if (Array.isArray(m.content)) {
            text = m.content.map(c => c.text || JSON.stringify(c)).join('\n');
          }
          messages.push({ role: m.role || 'user', content: text });
        }

        if (payload.stream) {
          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            });
          }

          const msgId = 'msg_' + Math.random().toString(36).slice(2);
          safeWrite(res, `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: payload.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })}\n\n`);
          safeWrite(res, `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);

          let fullCollectedText = '';
          const streamResp = await puter.ai.chat(messages, { model: modelToUse, stream: true });
          for await (const chunk of streamResp) {
            const text = chunk?.text || '';
            if (text) {
              fullCollectedText += text;
            }
          }

          const { text: cleanText, toolCalls } = parseDsmlTools(fullCollectedText);

          if (toolCalls.length > 0) {
            console.log('[Puter Bridge Anthropic] Detected DSML tool calls:', toolCalls.map(t => t.name));
            // Send clean text block if any
            if (cleanText) {
              safeWrite(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: cleanText } })}\n\n`);
            }
            safeWrite(res, `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);

            // Send tool_use content blocks
            let blockIndex = 1;
            for (const tc of toolCalls) {
              safeWrite(res, `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } })}\n\n`);
              safeWrite(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.input) } })}\n\n`);
              safeWrite(res, `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`);
              blockIndex++;
            }

            safeWrite(res, `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
          } else {
            if (fullCollectedText) {
              safeWrite(res, `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: fullCollectedText } })}\n\n`);
            }
            safeWrite(res, `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
            safeWrite(res, `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`);
          }

          safeWrite(res, `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
          safeEnd(res);
        } else {
          const resp = await puter.ai.chat(messages, { model: modelToUse, stream: false });
          const text = resp?.message?.content || resp?.text || String(resp || '');
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
          }
          safeEnd(res, JSON.stringify({
            id: 'msg_' + Math.random().toString(36).slice(2),
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            model: payload.model,
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 }
          }));
        }
      } catch (err) {
        console.error('[Puter Bridge Anthropic Error]:', err?.message || err);
        if (!res.headersSent) {
          try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'api_error', message: err?.message || 'Internal error' } }));
          } catch (e) {}
        } else {
          safeEnd(res);
        }
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.on('error', (err) => {
  console.error('[Puter Bridge Listen Error]', err?.code || 'listen_failed');
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Puter Bridge] Running on http://localhost:${PORT}`);
  console.log(`[Puter Bridge] OpenAI Endpoint: http://localhost:${PORT}/v1/chat/completions`);
});

