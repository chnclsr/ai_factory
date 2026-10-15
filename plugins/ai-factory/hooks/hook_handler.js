const fs = require('node:fs');
const path = require('node:path');

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
    const command = JSON.stringify(installation.node) + ' ' + JSON.stringify(installation.router);
    if (payload.toolCall) {
      const name = payload.toolCall.name;
      const args = payload.toolCall.args || {};
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

