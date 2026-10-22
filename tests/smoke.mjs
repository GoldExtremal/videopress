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

function video(name, seconds, size, pixFmt = 'yuv420p') {
  const file = path.join(data, name);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10',
    '-pix_fmt', pixFmt, '-shortest', '-y', file]);
  assert.equal(r.status, 0, String(r.stderr));
  return file;
}

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,pix_fmt,codec_name', '-of', 'json', file]);
  return JSON.parse(String(r.stdout)).streams[0];
}

async function save(url, name) {
  const res = await fetch(url);
  assert.equal(res.status, 200, url);
  const file = path.join(data, name);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
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

  // Web profile: a 10-bit vertical phone video becomes 8-bit, 1080 wide,
  // with a poster and a preview loop next to it.
  const phone = video('phone.mp4', 4, '1440x2560', 'yuv420p10le');
  const w = await upload(phone, 'web');
  assert.equal(w.status, 200);
  const doneW = await until(w.body.jobId, ['done', 'error']);
  assert.equal(doneW.status, 'done', doneW.error);
  assert.deepEqual(doneW.extras, ['poster', 'preview']);
  assert.equal(doneW.media.width, 1080);
  assert.equal(doneW.media.height, 1920);
  assert.ok(doneW.media.hasAudio);
  const main = probe(await save(`${BASE}/api/jobs/${w.body.jobId}/download`, 'w_main.mp4'));
  assert.equal(main.pix_fmt, 'yuv420p');
  const poster = probe(await save(`${BASE}/api/jobs/${w.body.jobId}/download/poster`, 'w_poster.jpg'));
  assert.equal(poster.width, 1080);
  const preview = probe(await save(`${BASE}/api/jobs/${w.body.jobId}/download/preview`, 'w_preview.mp4'));
  assert.deepEqual([preview.width, preview.height, preview.pix_fmt], [360, 640, 'yuv420p']);
  console.log('ok: web profile gives an 8-bit 1080p video, a poster and a preview');

  // A small video is not upscaled.
  const small = await upload(short, 'web');
  const doneS = await until(small.body.jobId, ['done', 'error']);
  assert.deepEqual([doneS.media.width, doneS.media.height], [640, 360]);
  console.log('ok: web profile does not upscale');

  // A cinema-wide frame fits 1920 across.
  const wide = await upload(video('wide.mp4', 2, '2880x1080'), 'web');
  const doneWide = await until(wide.body.jobId, ['done', 'error']);
  assert.deepEqual([doneWide.media.width, doneWide.media.height], [1920, 720]);
  console.log('ok: web profile fits a wide frame into 1920');

  // Deleting a web job removes all three of its files.
  await fetch(`${BASE}/api/jobs/${w.body.jobId}`, { method: 'DELETE' });
  assert.equal(readdirSync(path.join(data, 'outputs')).filter((f) => f.startsWith(w.body.jobId)).length, 0);
  console.log('ok: deleting a web job removes its poster and preview too');
} finally {
  server.kill('SIGTERM');
}
