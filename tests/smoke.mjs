// End-to-end check with a real ffmpeg: compress, queue, size limit, cleanup.
// Usage: node tests/smoke.mjs (ffmpeg and ffprobe on PATH).
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, openAsBlob, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(path.join(tmpdir(), 'videopress-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function video(name, seconds, size) {
  const file = path.join(data, name);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-shortest', '-y', file]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

async function upload(file, preset = 'medium') {
  const form = new FormData();
  form.append('qualityPreset', preset);
  form.append('video', await openAsBlob(file), path.basename(file));
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() };
}

const job = async (id) => (await fetch(`${BASE}/api/jobs/${id}`)).json();

async function until(id, statuses, ms = 120000) {
  const end = Date.now() + ms;
  for (;;) {
    const j = await job(id);
    if (statuses.includes(j.status)) return j;
    assert.ok(Date.now() < end, `job ${id} stuck in ${j.status}`);
    await sleep(300);
  }
}

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: data, MAX_UPLOAD_GB: '0.05', MIN_FREE_GB: '0' },
  stdio: ['ignore', 'inherit', 'inherit']
});
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }

  const long = video('long.mp4', 20, '1280x720');
  const short = video('short.mp4', 3, '640x360');

  // One compression at a time: the second waits in the queue.
  const a = await upload(long, 'low');
  assert.equal(a.status, 200);
  await until(a.body.jobId, ['compressing']);
  const b = await upload(short);
  assert.equal(b.status, 200);
  const waiting = await until(b.body.jobId, ['queued']);
  assert.equal(waiting.queuePosition, 1);
  console.log('ok: the second job waits in the queue');

  const doneA = await until(a.body.jobId, ['done']);
  assert.ok(doneA.resultSize > 0 && doneA.resultSize < doneA.sourceSize);
  const doneB = await until(b.body.jobId, ['done']);
  assert.ok(doneB.resultSize > 0);
  console.log('ok: both compressed, one after the other');

  // The result downloads; the source is gone from the disk.
  const res = await fetch(`${BASE}/api/jobs/${a.body.jobId}/download`);
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, doneA.resultSize);
  assert.deepEqual(readdirSync(path.join(data, 'uploads')), []);
  console.log('ok: download works, sources are removed');

  // Canceling one's own job removes its files only.
  const del = await fetch(`${BASE}/api/jobs/${b.body.jobId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(readdirSync(path.join(data, 'outputs')).filter((f) => f.startsWith(a.body.jobId)).length, 1);
  assert.equal(readdirSync(path.join(data, 'outputs')).length, 1);
  console.log('ok: deleting a job keeps the others');

  // Too big: refused, nothing left behind.
  const big = path.join(data, 'big.bin');
  writeFileSync(big, Buffer.alloc(60 * 1024 * 1024));
  const tooBig = await upload(big);
  assert.equal(tooBig.status, 413);
  assert.deepEqual(readdirSync(path.join(data, 'uploads')), []);
  console.log('ok: a file over the limit is refused');

  // The browser goes away mid-upload: the half-written file is removed.
  const boundary = 'x-smoke';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="cut.mp4"\r\nContent-Type: video/mp4\r\n\r\n`;
  const req = http.request(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': 40 * 1024 * 1024 }
  });
  req.on('error', () => {});
  req.write(head);
  req.write(Buffer.alloc(2 * 1024 * 1024));
  await sleep(500);
  assert.equal(readdirSync(path.join(data, 'uploads')).length, 1);
  req.destroy();
  await sleep(500);
  assert.deepEqual(readdirSync(path.join(data, 'uploads')), []);
  console.log('ok: an interrupted upload leaves nothing behind');
} finally {
  server.kill('SIGTERM');
}
