const fs = require('node:fs');
const path = require('node:path');

function isDirectClaudePrint(script) {
  if (typeof script !== 'string') return false;
  let command = script.trim();
  for (let depth = 0; depth < 3; depth++) {
    command = command.replace(/^&\s*/, '');
    const wrapper = command.match(/^(?:cmd(?:\.exe)?\s+(?:\/[ds]\s+)*\/[ck]|(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-NoProfile|-NonInteractive)\s+)*-(?:Command|c))\s+/i);
    if (!wrapper) break;
    command = command.slice(wrapper[0].length).trim();
    const quoted = command.match(/^(['"])([\s\S]*)\1$/);
    if (quoted) command = quoted[2];
  }
  const invocation = command.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/);
  if (!invocation) return false;
  const executable = path.posix.basename((invocation[1] || invocation[2] || invocation[3]).replaceAll('\\', '/'));
  return /^claude(?:\.(?:cmd|exe|ps1))?$/i.test(executable) && /(?:^|\s)(?:-p|--print)(?=\s|=|$)/.test(invocation[4]);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {});
process.stdout.on('error', () => {});
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 262144) { console.log(JSON.stringify({ decision: 'allow' })); process.exit(0); }
});
process.stdin.on('end', () => {
  try {
    const payload = input.trim() ? JSON.parse(input) : {};
    if (Number(process.env.AI_FACTORY_ROUTER_DEPTH || 0) > 0) {
      console.log(JSON.stringify({ decision: 'allow' })); return;
    }
    const pluginRoot = path.resolve(__dirname, '..');
    const installFile = path.join(pluginRoot, 'installation.json');
    const installation = fs.existsSync(installFile)
      ? JSON.parse(fs.readFileSync(installFile, 'utf8'))
      : { node: process.execPath, router: path.resolve(__dirname, '../../..', 'router.mjs') };
    const command = (process.platform === 'win32' ? '& ' : '') + JSON.stringify(installation.node) + ' ' + JSON.stringify(installation.router);
    if (payload.toolCall) {
      const name = payload.toolCall.name;
      const args = payload.toolCall.args || {};
      if (['run_command', 'execute_command', 'run_terminal_command'].includes(name) &&
        isDirectClaudePrint(args.CommandLine || args.command || args.cmd)) {
        console.log(JSON.stringify({ decision: 'deny', reason: 'Delegate Claude work through AI Factory: ' + command + ' --engine claude --model <requested-model> --no-fallback --task <request> --cwd <working-directory>. For a task file, read its contents and pass them with --task; do not invoke claude -p directly.' }));
        return;
      }
      let repository = false;
      try {
        const hostname = new URL(String(args.Url || args.url || '')).hostname.toLowerCase();
        repository = ['github.com', 'gitlab.com', 'raw.githubusercontent.com'].some(host => hostname === host || hostname.endsWith('.' + host));
      } catch {}
      if (['read_url_content', 'read_browser_page', 'browser_navigate'].includes(name) && repository) {
        console.log(JSON.stringify({ decision: 'deny', reason: 'Delegate repository analysis with ' + command + ' --task <request>; pass the task as one argument.' }));
      } else {
        console.log(JSON.stringify({ decision: 'allow' }));
      }
      return;
    }
    const rule = fs.readFileSync(path.join(pluginRoot, 'rules', 'ai_factory_router.md'), 'utf8').replaceAll('{{ROUTER_COMMAND}}', command);
    console.log(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: rule } }] }));
  } catch {
    // A malformed payload or unavailable file must never block the host session.
    console.log(JSON.stringify({ decision: 'allow' }));
  }
});

