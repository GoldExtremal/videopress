const express = require('express');
const Busboy = require('busboy');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

const jobs = new Map();

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

function startCompression(job) {
  const { inputPath, outputPath, qualityPreset } = job;
  const presetMap = {
    high: { crf: '30', preset: 'veryfast' },
    medium: { crf: '26', preset: 'faster' },
    low: { crf: '22', preset: 'medium' }
  };
  const chosen = presetMap[qualityPreset] || presetMap.medium;

  job.status = 'compressing';
  job.updatedAt = new Date().toISOString();

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
    job.updatedAt = new Date().toISOString();
  });

  ff.on('close', async (code) => {
    if (job.status === 'canceled') {
      job.updatedAt = new Date().toISOString();
      return;
    }

    if (code !== 0) {
      job.status = 'error';
      job.error = `ffmpeg exited with code ${code}`;
      job.updatedAt = new Date().toISOString();
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
      job.updatedAt = new Date().toISOString();
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
  const busboy = Busboy({
    headers: req.headers,
    limits: {
      files: 1,
      fileSize: 100 * 1024 * 1024 * 1024
    }
  });

  const jobId = randomUUID();
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

    file.pipe(writeStream);

    writeStream.on('error', () => {
      const current = jobs.get(jobId);
      if (current) {
        current.status = 'error';
        current.error = 'Write stream error';
        current.updatedAt = new Date().toISOString();
      }
    });

    writeStream.on('close', async () => {
      const current = jobs.get(jobId);
      if (!current || current.status === 'error') return;

      current.status = 'queued';
      current.updatedAt = new Date().toISOString();
      current.durationSeconds = await probeDuration(current.inputPath);
      startCompression(current);
    });
  });

  busboy.on('error', (err) => {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  });

  busboy.on('finish', () => {
    if (!fileHandled || !tempPath) {
      return res.status(400).json({ error: 'No video file provided' });
    }
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

  job.status = 'canceled';
  job.updatedAt = new Date().toISOString();

  jobs.delete(req.params.id);

  const cleanup = [job.inputPath, job.outputPath].map(async (p) => {
    if (!p) return;
    try {
      await fsp.unlink(p);
    } catch (e) {
      // ignore missing files
    }
  });

  await Promise.all(cleanup);
  res.json({ ok: true });
});

app.delete('/api/outputs', async (_req, res) => {
  try {
    const entries = await fsp.readdir(OUTPUT_DIR, { withFileTypes: true });
    const deletions = entries
      .filter((entry) => entry.isFile())
      .map((entry) => fsp.unlink(path.join(OUTPUT_DIR, entry.name)));

    await Promise.all(deletions);
    res.json({ ok: true, removed: deletions.length });
  } catch (err) {
    res.status(500).json({ error: `Failed to clear outputs: ${err.message}` });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Video compressor is running: http://localhost:${PORT}`);
});
