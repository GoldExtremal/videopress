const form = document.getElementById('uploadForm');
const statusPlaceholder = document.getElementById('statusPlaceholder');
const statusContent = document.getElementById('statusContent');
const statusMiddle = document.getElementById('statusMiddle');
const compressionFail = document.getElementById('compressionFail');
const statusText = document.getElementById('statusText');
const bar = document.getElementById('bar');
const stats = document.getElementById('stats');
const downloadLink = document.getElementById('downloadLink');
const percentValue = document.getElementById('percentValue');
const etaValue = document.getElementById('etaValue');
const fileInput = document.getElementById('videoInput');
const filePicker = document.getElementById('filePicker');
const fileAction = document.getElementById('fileAction');
const fileName = document.getElementById('fileName');
const pauseBtn = document.getElementById('pauseBtn');
const pauseIcon = document.getElementById('pauseIcon');
const cancelBtn = document.getElementById('cancelBtn');
const controlRow = document.getElementById('controlRow');
const startBtn = document.getElementById('startBtn');

let estimateState = null;
let currentJobId = null;
let pollTimer = null;
let isPaused = false;
let inputLocked = false;
let hasStartedForCurrentFile = false;

function bytesToHuman(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

function setStatus(text, progress) {
  const safeProgress = Math.max(0, Math.min(100, progress));
  statusText.textContent = text;
  bar.style.width = `${safeProgress}%`;
  percentValue.textContent = `${safeProgress}%`;
}

function setCompressionFailMode(enabled) {
  statusMiddle.classList.toggle('hidden', enabled);
  compressionFail.classList.toggle('hidden', !enabled);
  percentValue.classList.toggle('hidden', enabled);
}

function renderStatusPanel() {
  statusPlaceholder.classList.toggle('hidden', hasStartedForCurrentFile);
  statusContent.classList.toggle('hidden', !hasStartedForCurrentFile);
}

function setPauseButtonState(paused) {
  isPaused = paused;
  pauseBtn.lastChild.textContent = paused ? 'Продолжить' : 'Пауза';
  pauseIcon.src = paused ? '/icons/play.svg' : '/icons/pause.svg';
}

function setInputLock(locked) {
  inputLocked = locked;
  fileInput.disabled = locked;
  filePicker.classList.toggle('disabled', locked);
}

function refreshFileAction() {
  const hasFile = Boolean(fileInput.files && fileInput.files.length);
  if (hasFile) {
    fileAction.classList.add('trash');
    fileAction.innerHTML = '<img class="btn-icon" src="/icons/trash.svg" alt="Удалить файл" />';
  } else {
    fileAction.classList.remove('trash');
    fileAction.textContent = 'Выбрать файл';
  }
}

function computeEta(job) {
  if (!estimateState) {
    estimateState = {
      wallStartedAt: Date.now(),
      firstProcessedSeconds: job.processedSeconds || 0
    };
  }

  if (job.status !== 'compressing') return null;
  if (!Number.isFinite(job.durationSeconds) || !Number.isFinite(job.processedSeconds)) return null;

  const elapsedWall = (Date.now() - estimateState.wallStartedAt) / 1000;
  const processedDelta = Math.max(0, job.processedSeconds - estimateState.firstProcessedSeconds);
  if (elapsedWall < 2 || processedDelta <= 0.5) return null;

  const speed = processedDelta / elapsedWall;
  if (speed <= 0) return null;

  const remainingMediaSeconds = Math.max(0, job.durationSeconds - job.processedSeconds);
  return remainingMediaSeconds / speed;
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function togglePause() {
  if (!currentJobId) return;
  pauseBtn.disabled = true;
  const endpoint = isPaused ? 'resume' : 'pause';

  try {
    const res = await fetch(`/api/jobs/${currentJobId}/${endpoint}`, { method: 'POST' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      // During rapid clicks/status refresh, backend may briefly return 409.
      // In that case we silently wait for the next poll update.
      if (res.status === 409) return;
      throw new Error(payload.error || 'Ошибка изменения состояния');
    }
  } catch (err) {
    console.error(err);
  } finally {
    pauseBtn.disabled = false;
  }
}

async function cancelJob() {
  if (!currentJobId) return;

  try {
    const res = await fetch(`/api/jobs/${currentJobId}`, { method: 'DELETE' });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Ошибка отмены');

    stopPolling();
    setStatus('Обработка отменена', 0);
    etaValue.classList.add('hidden');
    setCompressionFailMode(false);
    controlRow.classList.add('controls-hidden');
    stats.textContent = `Исходный размер: 0 B`;
    currentJobId = null;
    startBtn.disabled = false;
    setInputLock(false);
  } catch (err) {
    alert(err.message);
  }
}

async function pollJob(jobId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error('Не удалось получить статус задачи');
      const job = await res.json();

      const labelMap = {
        uploading: 'Загрузка файла на сервер...',
        queued: 'Файл загружен. Подготовка к сжатию...',
        compressing: 'Идет сжатие видео...',
        paused: 'Сжатие приостановлено.',
        done: 'Готово. Можно скачать сжатый файл.',
        error: `Ошибка: ${job.error || 'неизвестно'}`
      };

      setStatus(labelMap[job.status] || job.status, job.progress || 0);

      const isRunning = ['uploading', 'queued', 'compressing', 'paused'].includes(job.status);
      const isCompressionStage = ['compressing', 'paused'].includes(job.status);

      setInputLock(isRunning);
      setPauseButtonState(Boolean(job.isPaused) || job.status === 'paused');

      controlRow.classList.toggle('controls-hidden', !isCompressionStage);
      pauseBtn.disabled = !isCompressionStage;
      cancelBtn.disabled = !isCompressionStage;

      if (job.status === 'compressing') {
        const etaSeconds = computeEta(job);
        if (Number.isFinite(etaSeconds)) {
          etaValue.textContent = `~ ${formatDuration(etaSeconds)}`;
          etaValue.classList.remove('hidden');
        } else {
          etaValue.classList.add('hidden');
        }
      } else {
        etaValue.classList.add('hidden');
      }

      const src = bytesToHuman(job.sourceSize);
      if (job.status === 'done') {
        const out = bytesToHuman(job.resultSize);
        if ((job.savedPercent || 0) < 0) {
          stopPolling();
          setCompressionFailMode(true);
          controlRow.classList.add('controls-hidden');
          etaValue.classList.add('hidden');
          downloadLink.classList.add('download-hidden');
          startBtn.disabled = false;
          setInputLock(false);
          stats.textContent = `Исходный размер: ${src}. Сжатый: ${out}`;
          return;
        }
        setCompressionFailMode(false);
        stats.textContent = `Исходный размер: ${src}. Сжатый: ${out}. Экономия: ${job.savedPercent || 0}%`;
      } else {
        setCompressionFailMode(false);
        stats.textContent = `Исходный размер: ${src}`;
      }

      if (job.status === 'done') {
        stopPolling();
        startBtn.disabled = false;
        setInputLock(false);
        controlRow.classList.add('controls-hidden');
        etaValue.classList.add('hidden');
        downloadLink.href = `/api/jobs/${jobId}/download`;
        downloadLink.classList.remove('download-hidden');
      }

      if (job.status === 'error') {
        stopPolling();
        startBtn.disabled = false;
        setInputLock(false);
        controlRow.classList.add('controls-hidden');
        etaValue.classList.add('hidden');
      }

      refreshFileAction();
    } catch (err) {
      stopPolling();
      setStatus(`Ошибка запроса: ${err.message}`, 0);
      setCompressionFailMode(false);
      startBtn.disabled = false;
      setInputLock(false);
      controlRow.classList.add('controls-hidden');
      etaValue.classList.add('hidden');
    }
  }, 1500);
}

filePicker.addEventListener('click', (e) => {
  if (inputLocked) {
    e.preventDefault();
    return;
  }

  const hasFile = Boolean(fileInput.files && fileInput.files.length);
  if (hasFile) {
    e.preventDefault();
    fetch('/api/outputs', { method: 'DELETE' }).catch((err) => console.error(err));
    fileInput.value = '';
    fileName.textContent = 'Файл не выбран';
    hasStartedForCurrentFile = false;
    renderStatusPanel();
    refreshFileAction();
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  fileName.textContent = file ? file.name : 'Файл не выбран';
  hasStartedForCurrentFile = false;
  renderStatusPanel();
  refreshFileAction();
});

pauseBtn.addEventListener('click', togglePause);
cancelBtn.addEventListener('click', cancelJob);

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const qualityPreset = document.querySelector('input[name="qualityPreset"]:checked')?.value || 'medium';
  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Выберите видео');
    return;
  }

  estimateState = null;
  hasStartedForCurrentFile = true;
  renderStatusPanel();
  downloadLink.classList.add('download-hidden');
  setCompressionFailMode(false);
  controlRow.classList.add('controls-hidden');
  etaValue.classList.add('hidden');
  stats.textContent = `Исходный размер: ${bytesToHuman(fileInput.files[0].size)}`;
  setPauseButtonState(false);
  setStatus('Подготовка загрузки...', 0);
  startBtn.disabled = true;
  setInputLock(true);

  const data = new FormData();
  data.append('qualityPreset', qualityPreset);
  data.append('video', fileInput.files[0]);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: data
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || 'Ошибка загрузки');
    }

    const payload = await res.json();
    currentJobId = payload.jobId;
    setStatus('Файл загружен. Ждем обработку...', 5);
    pollJob(payload.jobId);
  } catch (err) {
    setStatus(`Ошибка: ${err.message}`, 0);
    startBtn.disabled = false;
    setInputLock(false);
  }
});

refreshFileAction();
renderStatusPanel();
setCompressionFailMode(false);
