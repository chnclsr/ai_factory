import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const handler = path.join(import.meta.dirname, 'hook_handler.js');

function decide(command, name = 'run_command') {
  const result = spawnSync(process.execPath, [handler], {
    input: JSON.stringify({ toolCall: { name, args: { CommandLine: command } } }),
    encoding: 'utf8',
    timeout: 15000
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).decision;
}

test('removing a folder is denied so the user is asked first', () => {
  const denied = [
    'rmdir /s /q "C:\\temp\\build"',
    'rd /s /q build',
    'Remove-Item -Path "C:\\proj\\dist" -Recurse -Force',
    'Remove-Item .\\node_modules -Recurse',
    'Remove-Item -LiteralPath "C:\\proj\\dist" -Recurse',
    'rm -rf /tmp/mydir',
    'rm -r build',
    'rm -fr "C:/x/y"',
    'cmd /c rmdir /s /q target',
    'powershell -Command "Remove-Item C:\\a\\b -Recurse -Force"',
    'python -c "import shutil; shutil.rmtree(\'build\')"',
    'node -e "fs.rmSync(\'dist\', { recursive: true })"',
    'git clean -xdf',
    'git clean -fd',
    'echo hi && rm -rf build',
    // Windows-specific ways to remove a folder.
    'Remove-Item "C:\\proj\\dist"',
    'Remove-Item C:\\temp\\emptydir -Force',
    'Get-ChildItem C:\\temp | Remove-Item -Recurse -Force',
    'powershell -Command "[System.IO.Directory]::Delete(\'C:\\x\', $true)"',
    'powershell -Command "(New-Object IO.DirectoryInfo \'C:\\x\').Delete($true)"',
    'robocopy C:\\empty C:\\proj\\dist /MIR',
    'rd "C:\\temp\\build\\"',
    'Remove-Item \\\\?\\C:\\very\\long\\path\\dist -Recurse',
    'for /d %i in (*) do rd /s /q "%i"',
    'python -c "import os; os.rmdir(\'build\')"',
    'rm -rf .',
    'Remove-Item -Path a,b -Recurse'
  ];
  for (const command of denied) assert.equal(decide(command), 'deny', command);
});

test('deleting files, including a folder\'s whole contents, stays allowed', () => {
  const allowed = [
    'rm file.txt',
    'rm -f package-lock.json',
    'del C:\\temp\\log.txt',
    'Remove-Item "C:\\proj\\a.log"',
    'Remove-Item "C:\\proj\\dist\\*" -Recurse -Force',
    'Remove-Item -Path .\\logs\\* -Recurse',
    'rm -rf build/*',
    'rm -rf "C:/x/y/*"',
    'git clean -fx',
    'node -e "fs.rmSync(\'a.txt\')"',
    'git commit -m "remove directory handling"',
    'Get-ChildItem C:\\temp',
    'npm run build',
    // Windows file deletions that must keep working.
    'del /s /q "C:\\proj\\dist\\*.log"',
    'Remove-Item "C:\\proj\\*.tmp" -Force',
    'rm -r *.log',
    'Remove-Item -Path "C:\\logs\\app.log","C:\\logs\\err.log"',
    'robocopy C:\\src C:\\dst /E',
    'copy a.txt b.txt'
  ];
  for (const command of allowed) assert.equal(decide(command), 'allow', command);
});
