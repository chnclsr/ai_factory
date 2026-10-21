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

// Removing a folder always needs the user's approval; removing files does not. A recursive
// delete whose every target ends with a wildcard only empties the folder, so it stays allowed.
const RECURSIVE_FLAG = /^(?:--recursive|-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?|-[rfivd]*r[rfivd]*)$/i;
const VALUE_FLAG = /^-(?:l(?:iteral)?p(?:ath)?|p(?:a(?:t(?:h)?)?)?|include|filter)$/i;

function unquote(token) {
  const quoted = token.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2] : token;
}

function unwrapTarget(token) {
  // cmd and PowerShell both accept trailing separators and \\?\ long-path prefixes.
  return unquote(token).replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '');
}

const hasWildcard = target => /[*?]/.test(unwrapTarget(target));

// A path whose last segment carries no extension is treated as a folder. Extensionless files
// (LICENSE, Dockerfile) are then queried too, which is the safe direction for this rule.
function looksLikeFolder(target) {
  const value = unwrapTarget(target);
  if (!value || hasWildcard(target)) return false;
  const base = value.split(/[\\/]/).pop();
  return base.length > 0 && !/\.[^.]+$/.test(base);
}

function segmentRemovesFolder(segment) {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  let recursive = false;
  const targets = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (RECURSIVE_FLAG.test(token)) { recursive = true; continue; }
    if (VALUE_FLAG.test(token)) { if (tokens[i + 1]) targets.push(tokens[++i]); continue; }
    // cmd switches such as /s and /q are flags, not paths.
    if (token.startsWith('-') || /^\/[a-z]$/i.test(token)) continue;
    targets.push(token);
  }
  // A piped target ("Get-ChildItem x | Remove-Item -Recurse") names no path here.
  if (targets.length === 0) return recursive;
  if (targets.some(looksLikeFolder)) return true;
  return recursive && !targets.every(hasWildcard);
}

function removesDirectory(script) {
  if (typeof script !== 'string') return false;
  // PowerShell's backtick escape would otherwise hide a command name.
  const text = script.replaceAll('`', '');
  // These remove a directory and nothing else.
  if (/(?:^|[\s;&|("'])(?:rmdir|rd)(?=\s|$)/i.test(text)) return true;
  if (/(?:shutil\.rmtree|os\.removedirs|(?:\[(?:System\.)?IO\.)?Directory\]?(?:::|\.)Delete|DirectoryInfo[\s\S]{0,80}?\.Delete\s*\(|(?:^|[\s.;([{])(?:os|fs|shutil|Path)?\.?rmdir(?:Sync)?\s*\()/i.test(text)) return true;
  if (/\brm(?:Sync)?\s*\([^)]*recursive\s*:\s*true/i.test(text)) return true;
  // "git clean -d" removes untracked directories as well as untracked files.
  if (/(?:^|[\s;&|("'])git\s+clean(?=\s)[^;&|]*\s-{1,2}[a-z]*d/i.test(text)) return true;
  // robocopy /MIR deletes whatever the source does not contain, subdirectories included.
  if (/(?:^|[\s;&|("'])robocopy(?=\s)[^;&|]*\s\/(?:mir|purge)\b/i.test(text)) return true;
  for (const match of text.matchAll(/(?:^|[\s;&|("'])(?:rm|remove-item|ri|del|erase)\s+([^;&|]*)/gi)) {
    if (segmentRemovesFolder(match[1])) return true;
  }
  return false;
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
        removesDirectory(args.CommandLine || args.command || args.cmd)) {
        console.log(JSON.stringify({ decision: 'deny', reason: 'Deleting a folder requires the user\'s explicit approval: ask them first and run it only after they agree, or let them run it themselves. Deleting files is allowed, including every file inside a folder when the folder itself stays (for example "<folder>/*"); removing the folder is not.' }));
        return;
      }
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

