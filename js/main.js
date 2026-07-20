import * as db from './db.js';
import { parseFile, guessMapping } from './parser.js';
import { extractDoi, fetchAbstract } from './enrich.js';
import { screenBatch } from './llm.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEPS = ['step-settings', 'step-upload', 'step-enrich', 'step-criteria', 'step-run', 'step-results'];
function reveal(id) {
  const idx = STEPS.indexOf(id);
  STEPS.forEach((s, i) => {
    if (i <= idx) $(s).classList.remove('hidden');
  });
}

// ---------- settings persistence ----------
const SETTINGS_KEYS = ['apiKey', 'model', 'batchSize', 'delayMs', 'criteria', 'targetN'];
function loadSettings() {
  for (const key of SETTINGS_KEYS) {
    const val = localStorage.getItem('as_' + key);
    if (val !== null && $(key)) $(key).value = val;
  }
}
function saveSetting(key) {
  if ($(key)) localStorage.setItem('as_' + key, $(key).value);
}
SETTINGS_KEYS.forEach((key) => {
  const node = $(key);
  if (node) node.addEventListener('change', () => saveSetting(key));
});

function getSettings() {
  return {
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    batchSize: Math.max(1, parseInt($('batchSize').value, 10) || 15),
    delayMs: Math.max(0, parseInt($('delayMs').value, 10) || 1000),
    criteria: $('criteria').value.trim(),
    targetN: Math.max(1, parseInt($('targetN').value, 10) || 100)
  };
}

// ---------- upload & mapping ----------
let parsedRows = [];
let parsedColumns = [];

$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  $('uploadInfo').textContent = 'Обработка файла...';
  try {
    const { rows, columns } = await parseFile(file);
    parsedRows = rows;
    parsedColumns = columns;
    $('uploadInfo').textContent = `Файл прочитан: ${rows.length} строк, ${columns.length} колонок.`;
    populateMapping(columns, rows);
  } catch (err) {
    $('uploadInfo').textContent = 'Ошибка чтения файла: ' + err.message;
  }
});

function populateMapping(columns, rows) {
  const guess = guessMapping(columns);
  fillSelect($('colTitle'), columns, guess.title);
  fillSelect($('colCode'), columns, guess.code);
  fillSelect($('colAbstract'), ['— нет —', ...columns], guess.abstract || '— нет —');
  $('rowCount').textContent = rows.length;
  renderPreview(columns, rows.slice(0, 8));
  $('mappingBlock').classList.remove('hidden');
}

function fillSelect(select, options, selected) {
  select.innerHTML = '';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    if (opt === selected) o.selected = true;
    select.appendChild(o);
  }
}

function renderPreview(columns, rows) {
  const table = $('previewTable');
  table.innerHTML = '';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const c of columns) {
      const td = document.createElement('td');
      td.textContent = String(row[c] ?? '').slice(0, 120);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

$('confirmMappingBtn').addEventListener('click', async () => {
  const existing = await db.countAll();
  if (existing > 0) {
    const ok = confirm('В базе уже есть загруженные статьи и, возможно, результаты анализа. Загрузка нового файла полностью очистит текущие данные. Продолжить?');
    if (!ok) return;
    await db.clearArticles();
  }
  const colTitle = $('colTitle').value;
  const colCode = $('colCode').value;
  const colAbstract = $('colAbstract').value;

  const rows = parsedRows.map((r) => ({
    title: String(r[colTitle] ?? '').trim(),
    code: String(r[colCode] ?? '').trim(),
    abstract: colAbstract !== '— нет —' ? String(r[colAbstract] ?? '').trim() : ''
  })).filter((r) => r.title);

  const originalBtnLabel = $('confirmMappingBtn').textContent;
  $('confirmMappingBtn').disabled = true;
  $('confirmMappingBtn').textContent = 'Загрузка...';
  await db.addArticles(rows);
  $('confirmMappingBtn').disabled = false;
  $('confirmMappingBtn').textContent = originalBtnLabel;
  $('uploadInfo').textContent = `Загружено в базу: ${rows.length} статей.`;
  reveal('step-enrich');
});

// ---------- enrichment ----------
let enrichStop = false;

$('enrichBtn').addEventListener('click', async () => {
  const items = await db.getMissingAbstractItems();
  if (items.length === 0) {
    alert('Статей с DOI без аннотации не найдено — можно переходить к следующему шагу.');
    reveal('step-criteria');
    return;
  }
  enrichStop = false;
  $('enrichProgress').classList.remove('hidden');
  $('enrichBtn').disabled = true;
  $('skipEnrichBtn').disabled = true;

  let done = 0;
  const total = items.length;
  for (const item of items) {
    if (enrichStop) break;
    const doi = extractDoi(item.code);
    if (doi) {
      try {
        const abstract = await fetchAbstract(doi);
        if (abstract) await db.updateArticle(item.id, { abstract });
      } catch (err) {
        if (err.rateLimited) {
          await sleep(15000);
        }
        // otherwise just skip this article's abstract
      }
    }
    done++;
    $('enrichFill').style.width = Math.round((done / total) * 100) + '%';
    $('enrichText').textContent = `${done} / ${total} обработано`;
    await sleep(1100);
  }

  $('enrichBtn').disabled = false;
  $('skipEnrichBtn').disabled = false;
  $('enrichText').textContent += enrichStop ? ' (остановлено)' : ' — готово';
  reveal('step-criteria');
});

$('enrichStopBtn').addEventListener('click', () => {
  enrichStop = true;
});

$('skipEnrichBtn').addEventListener('click', () => {
  reveal('step-criteria');
});

// ---------- run screening ----------
let isPaused = false;
let stopRequested = false;
let isRunning = false;

function log(msg) {
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString('ru-RU');
  line.textContent = `[${time}] ${msg}`;
  $('log').appendChild(line);
  while ($('log').children.length > 300) $('log').removeChild($('log').firstChild);
  $('log').scrollTop = $('log').scrollHeight;
}

function clampScore(v) {
  const n = Math.round(Number(v));
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

async function updateProgressUI() {
  const counts = await db.getCounts();
  const total = counts.pending + counts.include + counts.maybe + counts.exclude + counts.error;
  const processed = total - counts.pending;
  $('runFill').style.width = total ? Math.round((processed / total) * 100) + '%' : '0%';
  $('runText').textContent = `${processed} / ${total}`;
  $('statInclude').textContent = `Включено: ${counts.include}`;
  $('statMaybe').textContent = `Под вопросом: ${counts.maybe}`;
  $('statExclude').textContent = `Исключено: ${counts.exclude}`;
  $('statError').textContent = `Ошибок: ${counts.error}`;
  return counts;
}

async function runScreening() {
  const settings = getSettings();
  if (!settings.apiKey) {
    alert('Укажите API-ключ Google Gemini в настройках (шаг 1).');
    return;
  }
  if (!settings.criteria) {
    alert('Опишите критерии отбора статей.');
    return;
  }

  isRunning = true;
  stopRequested = false;
  isPaused = false;
  $('pauseBtn').textContent = 'Пауза';
  $('pauseBtn').disabled = false;
  $('stopBtn').disabled = false;

  reveal('step-run');
  await updateProgressUI();

  while (true) {
    if (stopRequested) break;
    while (isPaused && !stopRequested) await sleep(300);
    if (stopRequested) break;

    const batch = await db.getNextPending(settings.batchSize);
    if (batch.length === 0) break;

    try {
      const results = await screenBatch({
        apiKey: settings.apiKey,
        model: settings.model,
        criteria: settings.criteria,
        targetN: settings.targetN,
        articles: batch
      });
      const byId = new Map(results.map((r) => [r.id, r]));
      const patches = [];
      for (const a of batch) {
        const r = byId.get(a.id);
        if (r && ['include', 'maybe', 'exclude'].includes(r.decision)) {
          patches.push([a.id, { decision: r.decision, score: clampScore(r.score), reason: String(r.reason || '').slice(0, 500) }]);
        } else {
          patches.push([a.id, { decision: 'error', score: null, reason: 'Модель не вернула решение для этой статьи' }]);
        }
      }
      await db.updateMany(patches);
      log(`Обработан пакет из ${batch.length} стат.`);
    } catch (err) {
      log(`Ошибка пакета (${batch.length} стат.): ${err.message}`);
      await db.updateMany(batch.map((a) => [a.id, { decision: 'error', score: null, reason: 'Ошибка API: ' + err.message.slice(0, 300) }]));
      if (/HTTP 400|HTTP 401|HTTP 403|API key|API_KEY/i.test(err.message)) {
        alert('Похоже, проблема с API-ключом или названием модели: ' + err.message);
        stopRequested = true;
      }
    }

    await updateProgressUI();
    if (stopRequested) break;
    await sleep(settings.delayMs);
  }

  isRunning = false;
  $('pauseBtn').disabled = true;
  $('stopBtn').disabled = true;
  const counts = await updateProgressUI();
  log(counts.pending > 0 ? `Остановлено. Осталось необработанных: ${counts.pending}.` : 'Анализ завершён — все статьи обработаны.');

  reveal('step-results');
  await refreshResultsView();
}

$('startBtn').addEventListener('click', () => {
  runScreening();
});

$('pauseBtn').addEventListener('click', () => {
  isPaused = !isPaused;
  $('pauseBtn').textContent = isPaused ? 'Продолжить' : 'Пауза';
});

$('stopBtn').addEventListener('click', () => {
  stopRequested = true;
  isPaused = false;
});

// ---------- results ----------
let page = 0;
const PAGE_SIZE = 50;

async function refreshResultsView() {
  const decision = $('filterDecision').value;
  const search = $('searchBox').value;
  const { total, rows } = await db.getPage({ decision, search, offset: page * PAGE_SIZE, limit: PAGE_SIZE });
  renderResultsTable(rows);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  $('pageInfo').textContent = `Стр. ${page + 1} из ${totalPages} (всего ${total})`;
  $('prevPageBtn').disabled = page <= 0;
  $('nextPageBtn').disabled = page + 1 >= totalPages;
}

function renderResultsTable(rows) {
  const table = $('resultsTable');
  table.innerHTML = '';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th style="width:38%">Название</th><th style="width:14%">Код</th><th style="width:8%">Оценка</th><th style="width:12%">Решение</th><th style="width:28%">Обоснование</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  const labels = { include: 'Включить', maybe: 'Под вопросом', exclude: 'Исключить', error: 'Ошибка', pending: 'В очереди' };
  for (const v of rows) {
    const tr = document.createElement('tr');
    tr.className = 'decision-' + v.decision;
    const tdTitle = document.createElement('td');
    tdTitle.className = 'title';
    tdTitle.textContent = v.title;
    const tdCode = document.createElement('td');
    tdCode.textContent = v.code;
    tdCode.title = v.code;
    const tdScore = document.createElement('td');
    tdScore.textContent = v.score ?? '';
    const tdDecision = document.createElement('td');
    tdDecision.textContent = labels[v.decision] || v.decision;
    const tdReason = document.createElement('td');
    tdReason.textContent = v.reason;
    tdReason.title = v.reason;
    tr.append(tdTitle, tdCode, tdScore, tdDecision, tdReason);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}

$('filterDecision').addEventListener('change', () => { page = 0; refreshResultsView(); });
$('searchBox').addEventListener('input', debounce(() => { page = 0; refreshResultsView(); }, 300));
$('prevPageBtn').addEventListener('click', () => { page = Math.max(0, page - 1); refreshResultsView(); });
$('nextPageBtn').addEventListener('click', () => { page += 1; refreshResultsView(); });

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- export ----------
function toCsv(rows, fields) {
  const escape = (v) => {
    const s = String(v ?? '');
    if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const header = fields.map(escape).join(',');
  const lines = rows.map((r) => fields.map((f) => escape(r[f])).join(','));
  return '﻿' + [header, ...lines].join('\n');
}

function downloadCsv(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

$('exportIncludedBtn').addEventListener('click', async () => {
  const all = await db.getAll();
  const rows = all.filter((r) => r.decision === 'include').sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (rows.length === 0) { alert('Нет статей со статусом "Включить".'); return; }
  downloadCsv(toCsv(rows, ['title', 'code', 'score', 'decision', 'reason']), 'included.csv');
});

$('exportTopNBtn').addEventListener('click', async () => {
  const settings = getSettings();
  const all = await db.getAll();
  const pool = all.filter((r) => r.decision === 'include' || r.decision === 'maybe').sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const rows = pool.slice(0, settings.targetN);
  if (rows.length === 0) { alert('Нет подходящих статей для экспорта.'); return; }
  if (rows.length < settings.targetN) alert(`Доступно только ${rows.length} статей из запрошенных ${settings.targetN}.`);
  downloadCsv(toCsv(rows, ['title', 'code', 'score', 'decision', 'reason']), `top-${settings.targetN}.csv`);
});

$('exportAllBtn').addEventListener('click', async () => {
  const all = await db.getAll();
  downloadCsv(toCsv(all, ['title', 'code', 'abstract', 'score', 'decision', 'reason']), 'all-results.csv');
});

$('retryErrorsBtn').addEventListener('click', async () => {
  const all = await db.getAll();
  const errors = all.filter((r) => r.decision === 'error');
  if (errors.length === 0) { alert('Ошибок нет.'); return; }
  await db.updateMany(errors.map((r) => [r.id, { decision: 'pending', score: null, reason: '' }]));
  alert(`${errors.length} статей возвращены в очередь. Нажмите "Начать анализ" (или запуск начнётся автоматически).`);
  runScreening();
});

$('resetBtn').addEventListener('click', async () => {
  const ok = confirm('Это удалит все загруженные статьи и результаты анализа из этого браузера. Продолжить?');
  if (!ok) return;
  await db.clearArticles();
  localStorage.removeItem('as_criteria');
  location.reload();
});

// ---------- init ----------
(async function init() {
  loadSettings();
  const total = await db.countAll();
  if (total > 0) {
    $('uploadInfo').textContent = `В базе уже есть ${total} загруженных статей (сохранено с прошлого раза).`;
    reveal('step-results');
    await refreshResultsView();
    await updateProgressUI();
  }
})();
