import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './testing/helpers.mjs';
import { snapshotProject } from './store.mjs';
import { recordTurnCommit, readMeta, resumeTarget } from './session.mjs';

const GOOD = '123e4567-e89b-42d3-a456-426614174000';
const KILLED = '223e4567-e89b-42d3-a456-426614174000';

function setup(t) {
  const dir = tempDir(t, 'sess-restore-');
  const repo = path.join(dir, 'memory.git');
  const project = { key: 'restore-proj', name: 'restore-proj', source: 'test' };
  const sid = 'restore-sid';
  const record = (outcome) => recordTurnCommit(repo, { sid, project, cwd: dir },
    { engine: 'claude', model: 'haiku', output: 'reply', task: 'work', attempts: [], ...outcome });
  const snap = () => snapshotProject(repo, project.key);
  return { record, snap, sid };
}

test('an interrupted turn keeps its engine session id findable and resumable', t => {
  const { record, snap, sid } = setup(t);
  record({ ok: true, engineSessionId: GOOD });
  record({ ok: false, engineSessionId: KILLED });

  const meta = readMeta(snap(), sid);
  assert.equal(meta.engine_sessions.claude, GOOD, 'the last clean engine session is untouched');
  assert.equal(meta.interrupted_sessions.claude, KILLED);
  assert.equal(meta.status, 'interrupted');
  assert.deepEqual(meta.restore.interrupted, { engine: 'claude', engine_session: KILLED });

  const target = resumeTarget(snap(), sid);
  assert.equal(target.interrupted, true);
  assert.equal(target.engine_session, KILLED);
  assert.equal(target.interrupted_session, KILLED);
});

test('a failed turn without an engine session id changes no interrupted session, and a later success clears it', t => {
  const { record, snap, sid } = setup(t);
  record({ ok: false, engineSessionId: KILLED });
  record({ ok: false });
  assert.equal(readMeta(snap(), sid).interrupted_sessions.claude, KILLED);

  record({ ok: true, engineSessionId: GOOD });
  const meta = readMeta(snap(), sid);
  assert.equal(meta.interrupted_sessions.claude, undefined);
  assert.equal(meta.status, 'active');
  assert.equal(meta.restore.interrupted, undefined);
  const target = resumeTarget(snap(), sid);
  assert.equal(target.engine_session, GOOD);
  assert.equal(target.interrupted_session, null);
});
