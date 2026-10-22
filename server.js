const express = require('express');
const Busboy = require('busboy');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');

const GB = 1024 * 1024 * 1024;
// Limits for a small shared server: one compression at a time, files up to
// MAX_UPLOAD_GB, results kept for TTL_HOURS, some disk always left free.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_GB || 5) * GB;
const MAX_PARALLEL = Math.max(1, Number(process.env.MAX_PARALLEL || 1));
const TTL_MS = Number(process.env.TTL_HOURS || 24) * 3600 * 1000;
const MIN_FREE_BYTES = Number(process.env.MIN_FREE_GB || 3) * GB;

const jobs = new Map();
const queue = [];
let running = 0;

for (const p of [UPLOAD_DIR, OUTPUT_DIR]) {
  fs.mkdirSync(p, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));

function safeFileName(name) {
  return String(name || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseTimeToSeconds(value) {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value || '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function touch(job) {
  job.updatedAt = new Date().toISOString();
}

async function removeFile(p) {
  if (!p) return;
  try {
    await fsp.unlink(p);
  } catch (e) {
    // ignore missing files
  }
}

/** Start queued jobs while there is a free slot. */
function runNext() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    running += 1;
    startCompression(job);
  }
}

/** A compression is over (done, failed or canceled): free its slot. */
function finished(job) {
  if (!job.slot) return;
  job.slot = false;
  running -= 1;
  runNext();
}

function freeBytes() {
  try {
    const st = fs.statfsSync(DATA_DIR);
    return st.bavail * st.bsize;
  } catch (e) {
    return Infinity;
  }
}

function startCompression(job) {
  const { inputPath, outputPath, qualityPreset } = job;
  const presetMap = {
    high: { crf: '30', preset: 'veryfast' },
    medium: { crf: '26', preset: 'faster' },
    low: { crf: '22', preset: 'medium' }
  };
  const chosen = presetMap[qualityPreset] || presetMap.medium;

  job.status = 'compressing';
  job.slot = true;
  touch(job);

  const args = [
    '-y',
    '-i',
    inputPath,
    '-c:v',
    'libx264',
    '-preset',
    chosen.preset,
    '-crf',
    chosen.crf,
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputPath
  ];

  const ff = spawn('ffmpeg', args);
  job.pid = ff.pid;
  job.ffmpegProcess = ff;
  job.isPaused = false;

  ff.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    const match = text.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/);
    if (match && job.durationSeconds) {
      const sec = parseTimeToSeconds(match[1]);
      if (sec != null) {
        job.processedSeconds = sec;
        job.progress = Math.max(0, Math.min(99, Math.round((sec / job.durationSeconds) * 100)));
        job.updatedAt = new Date().toISOString();
      }
    }
  });

  ff.on('error', (err) => {
    job.status = 'error';
    job.error = `ffmpeg error: ${err.message}`;
    touch(job);
    finished(job);
  });

  ff.on('close', async (code) => {
    job.ffmpegProcess = null;
    finished(job);
    if (job.status === 'canceled') {
      touch(job);
      return;
    }

    if (code !== 0) {
      job.status = 'error';
      job.error = `ffmpeg exited with code ${code}`;
      touch(job);
      await removeFile(job.inputPath);
      await removeFile(job.outputPath);
      return;
    }

    try {
      const [srcStat, outStat] = await Promise.all([fsp.stat(inputPath), fsp.stat(outputPath)]);
      job.status = 'done';
      job.progress = 100;
      job.processedSeconds = job.durationSeconds || job.processedSeconds;
      job.resultSize = outStat.size;
      job.sourceSize = srcStat.size;
      job.savedPercent = srcStat.size > 0 ? Math.round((1 - outStat.size / srcStat.size) * 100) : 0;
      touch(job);
      // Only the result is downloaded: the source frees its disk space now.
      await removeFile(inputPath);
    } catch (err) {
      job.status = 'error';
      job.error = `stat error: ${err.message}`;
      job.updatedAt = new Date().toISOString();
    }
  });
}

function probeDuration(inputPath) {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      inputPath
    ]);

    let out = '';
    ffprobe.stdout.on('data', (d) => {
      out += d.toString();
    });

    ffprobe.on('close', () => {
      const n = Number(out.trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });

    ffprobe.on('error', () => resolve(null));
  });
}

app.post('/api/upload', (req, res) => {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return res.status(413).json({ error: `Файл больше ${process.env.MAX_UPLOAD_GB || 5} ГБ` });
  }
  // The source and the result both need room, and the server some more.
  if (freeBytes() < declared * 2 + MIN_FREE_BYTES) {
    return res.status(507).json({ error: 'На сервере мало места, попробуйте позже' });
  }

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      limits: {
        files: 1,
        fileSize: MAX_UPLOAD_BYTES
      }
    });
  } catch (err) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }

  const jobId = randomUUID();
  // Queued once both happened, in whatever order: the request is fully
  // received, and the file is flushed to disk.
  let uploaded = false;
  let flushed = false;
  let fileHandled = false;
  let writeStream = null;
  let tempPath = null;
  let fileName = 'video.mp4';
  let qualityPreset = 'medium';

  busboy.on('field', (name, val) => {
    if (name === 'qualityPreset') {
      qualityPreset = ['high', 'medium', 'low'].includes(val) ? val : 'medium';
      const current = jobs.get(jobId);
      if (current && current.status === 'uploading') {
        current.qualityPreset = qualityPreset;
        current.updatedAt = new Date().toISOString();
      }
    }
  });

  busboy.on('file', (fieldName, file, info) => {
    if (fieldName !== 'video') {
      file.resume();
      return;
    }

    fileHandled = true;
    fileName = safeFileName(info.filename || 'video.mp4');

    tempPath = path.join(UPLOAD_DIR, `${jobId}__${fileName}`);
    writeStream = fs.createWriteStream(tempPath);

    const job = {
      id: jobId,
      fileName,
      qualityPreset,
      status: 'uploading',
      progress: 0,
      processedSeconds: 0,
      inputPath: tempPath,
      outputPath: path.join(OUTPUT_DIR, `${jobId}__compressed.mp4`),
      sourceSize: 0,
      resultSize: 0,
      savedPercent: 0,
      error: null,
      durationSeconds: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    jobs.set(jobId, job);

    file.on('data', (chunk) => {
      const current = jobs.get(jobId);
      if (current) {
        current.sourceSize += chunk.length;
        current.updatedAt = new Date().toISOString();
      }
    });

    file.on('limit', () => {
      const current = jobs.get(jobId);
      if (current) {
        current.status = 'error';
        current.error = `Файл больше ${process.env.MAX_UPLOAD_GB || 5} ГБ`;
        touch(current);
      }
      file.unpipe(writeStream);
      writeStream.destroy();
      removeFile(tempPath);
      file.resume();
    });

    file.pipe(writeStream);

    writeStream.on('error', () => {
      const current = jobs.get(jobId);
      if (current) {
        current.status = 'error';
        current.error = 'Write stream error';
        touch(current);
      }
      removeFile(tempPath);
    });

    writeStream.on('close', () => {
      flushed = true;
      enqueue();
    });
  });

  async function enqueue() {
    const current = jobs.get(jobId);
    if (!uploaded || !flushed || !current || current.status !== 'uploading') return;
    current.durationSeconds = await probeDuration(current.inputPath);
    if (current.status !== 'uploading') return;
    current.status = 'queued';
    touch(current);
    queue.push(current);
    runNext();
  }

  // The browser went away mid-upload: drop the half-written file.
  req.on('aborted', () => {
    if (uploaded) return;
    const current = jobs.get(jobId);
    if (current) {
      current.status = 'canceled';
      jobs.delete(jobId);
    }
    if (writeStream) writeStream.destroy();
    removeFile(tempPath);
  });

  busboy.on('error', (err) => {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  });

  busboy.on('finish', () => {
    if (!fileHandled || !tempPath) {
      return res.status(400).json({ error: 'No video file provided' });
    }
    const current = jobs.get(jobId);
    if (current && current.status === 'error') {
      jobs.delete(jobId);
      return res.status(413).json({ error: current.error });
    }
    uploaded = true;
    enqueue();
    return res.json({ jobId });
  });

  req.pipe(busboy);
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.json({
    id: job.id,
    fileName: job.fileName,
    qualityPreset: job.qualityPreset,
    status: job.status,
    queuePosition: job.status === 'queued' ? queue.indexOf(job) + 1 : 0,
    isPaused: Boolean(job.isPaused),
    progress: job.progress,
    processedSeconds: job.processedSeconds,
    durationSeconds: job.durationSeconds,
    sourceSize: job.sourceSize,
    resultSize: job.resultSize,
    savedPercent: job.savedPercent,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  });
});

app.get('/api/jobs/:id/download', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'done') return res.status(409).json({ error: 'Result is not ready' });

  const downloadName = `${path.parse(job.fileName).name}_compressed.mp4`;
  res.download(job.outputPath, downloadName);
});

app.post('/api/jobs/:id/pause', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.pid || job.status !== 'compressing') return res.status(409).json({ error: 'Job is not compressing' });
  if (job.isPaused) return res.json({ ok: true, status: 'paused' });

  try {
    process.kill(job.pid, 'SIGSTOP');
    job.isPaused = true;
    job.status = 'paused';
    job.updatedAt = new Date().toISOString();
    return res.json({ ok: true, status: 'paused' });
  } catch (err) {
    return res.status(500).json({ error: `Pause failed: ${err.message}` });
  }
});

app.post('/api/jobs/:id/resume', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.pid || !job.isPaused) return res.status(409).json({ error: 'Job is not paused' });

  try {
    process.kill(job.pid, 'SIGCONT');
    job.isPaused = false;
    job.status = 'compressing';
    job.updatedAt = new Date().toISOString();
    return res.json({ ok: true, status: 'compressing' });
  } catch (err) {
    return res.status(500).json({ error: `Resume failed: ${err.message}` });
  }
});

app.delete('/api/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.pid && (job.status === 'compressing' || job.status === 'paused')) {
    try {
      process.kill(job.pid, 'SIGTERM');
    } catch (e) {
      // ignore
    }
  }

  if (job.status === 'paused') {
    try {
      process.kill(job.pid, 'SIGCONT');
    } catch (e) {
      // ignore
    }
  }

  job.status = 'canceled';
  touch(job);

  jobs.delete(req.params.id);
  const waiting = queue.indexOf(job);
  if (waiting >= 0) queue.splice(waiting, 1);

  await Promise.all([removeFile(job.inputPath), removeFile(job.outputPath)]);
  res.json({ ok: true });
});

// Old jobs and stray files go after TTL_HOURS: the disk is shared.
async function sweep() {
  const now = Date.now();
  for (const job of [...jobs.values()]) {
    const busy = ['uploading', 'queued', 'compressing', 'paused'].includes(job.status);
    if (busy || now - Date.parse(job.updatedAt) < TTL_MS) continue;
    jobs.delete(job.id);
    await Promise.all([removeFile(job.inputPath), removeFile(job.outputPath)]);
  }
  const known = new Set([...jobs.values()].flatMap((job) => [job.inputPath, job.outputPath]));
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (!entry.isFile() || entry.name === '.gitkeep' || known.has(p)) continue;
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > TTL_MS) await removeFile(p);
    }
  }
}
setInterval(() => sweep().catch((err) => console.error('sweep failed', err)), 30 * 60 * 1000).unref();
sweep().catch((err) => console.error('sweep failed', err));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(PORT, () => {
  console.log(`Video compressor is running: http://localhost:${PORT}`);
});
// Uploads of several gigabytes take long: no request timeout.
server.requestTimeout = 0;

// On shutdown (a redeploy) stop ffmpeg too, not to leave it running.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    for (const job of jobs.values()) {
      if (job.ffmpegProcess) {
        try {
          if (job.isPaused) process.kill(job.pid, 'SIGCONT');
          job.ffmpegProcess.kill('SIGTERM');
        } catch (e) {
          // ignore
        }
      }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
