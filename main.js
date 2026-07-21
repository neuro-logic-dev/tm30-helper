const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { parseDeepLink, DeepLinkKind, PROTOCOL } = require('./deeplink');

// ---------- Single instance ----------
// Повторный запуск (в т.ч. по deep link на Win/Linux) пробрасывается
// в уже работающий процесс через событие 'second-instance'.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ---------- Регистрация протокола tm30:// ----------
if (process.defaultApp) {
  // dev-запуск через `electron .` — регистрируем бинарь electron + путь к проекту
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// ---------- Разбор deep link ----------
// Формат: tm30://open?d=<base64url(JSON)>
//   v1: {name, login, pass}          — legacy, поведение не менялось
//   v2: {v:2, worklist:[...]}        — MO-TM30-014 §7.3
// Сам парсер живёт в ./deeplink.js — без зависимости от electron, чтобы его
// можно было прогонять тестом вместе с эмиттером (test/roundtrip.test.mjs).

function findDeepLinkInArgv(argv) {
  return argv.find(a => typeof a === 'string' && a.startsWith(PROTOCOL + '://')) || null;
}

// ---------- Окна ----------
function toBase64Url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openAccountWindow(acc) {
  const win = new BrowserWindow({
    width: 1240,
    height: 880,
    title: acc.name,
    webPreferences: { webviewTag: true },
  });
  win.loadFile('window.html', { query: { d: toBase64Url(acc) } });
  win.focus();
}

function openStandaloneWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'TM30 Helper',
    webPreferences: { webviewTag: true },
  });
  win.loadFile('index.html');
}

/**
 * A-WEB-4c: v2 → ОДНО окно с ДВУМЯ панелями (`app.html`): слева worklist, справа
 * `<webview>` портала (014 §2.4, §3; макет H1). Заменило собой 4b-заглушку
 * `worklist.html`, которая только доказывала, что провод работает.
 *
 * 🔴 Это окно ТОЛЬКО для v2. v1 (`openAccountWindow` / `openStandaloneWindow`)
 * не тронут — обратная совместимость обязательна (013 §3.5).
 *
 * Механизм передачи данных прежний и намеренно нулевой по зависимостям: payload
 * уезжает в query как base64url — ни preload, ни IPC, ни сети (014 §2.5).
 */
function openWorklistWindow(worklist) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080, // левая панель 360px + панель портала, ниже неё макет ломается
    title: 'TM30 Helper',
    // A-WEB-4d: preload — ТОЛЬКО для v2-окна. Даёт `app.html` ровно два глагола
    // (скачать лист / открыть папку). v1-окна остаются без preload — 013 §3.5.
    webPreferences: { webviewTag: true, preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('app.html', { query: { d: toBase64Url({ v: 2, worklist }) } });
  win.focus();
}

/**
 * 🔴 Громкий отказ (MO-TM30-014 §7.9).
 *
 * Раньше любой неразобранный payload превращался в `null` и молча открывал chooser —
 * сломанная ссылка выглядела как рабочая. Теперь битая ссылка показывает НАТИВНОЕ окно
 * ошибки и НИКОГДА не деградирует до chooser'а. «Нет учётки» и «битая ссылка» — разные
 * состояния, и выглядят они по-разному: первое открывает окно worklist'а, второе — вот это.
 */
function reportBrokenLink(reason, url) {
  console.error('[tm30-helper] BROKEN DEEP LINK:', reason, '\n  url:', url);
  dialog.showErrorBox(
    'TM30 Helper — broken link',
    `This tm30:// link could not be read:\n\n${reason}\n\n` +
      'Nothing was opened. Go back to the web app and try again — if it keeps failing, ' +
      'the link is likely too long or was cut off in transit.'
  );
}

function handleDeepLink(url) {
  const result = parseDeepLink(url);
  if (!result) return; // не наша ссылка

  switch (result.kind) {
    case DeepLinkKind.V1:
      console.log('[tm30-helper] deep link v1: account="' + result.account.name + '"');
      openAccountWindow(result.account);
      return;

    case DeepLinkKind.V2: {
      const withCreds = result.worklist.filter((r) => r.account).length;
      console.log(
        `[tm30-helper] deep link v2: ${result.worklist.length} filing(s), ` +
          `${withCreds} with credentials, ${result.worklist.length - withCreds} manual-login`
      );
      openWorklistWindow(result.worklist);
      return;
    }

    case DeepLinkKind.CHOOSER:
      console.log('[tm30-helper] deep link: chooser (no payload)');
      openStandaloneWindow();
      return;

    case DeepLinkKind.ERROR:
    default:
      reportBrokenLink(result.reason, url);
  }
}

// ---------- A-WEB-4d: скачивание листа + открытие папки ----------
// Единственное сетевое действие хелпера — скачивание файла, инициированное человеком
// (005 §8.3.1: «лист скачивается локально, дальше человек грузит его в портал руками»).
// Никаких data-fetch'ей: 014 §2.5 остаётся в силе.

const DOWNLOAD_TIMEOUT_MS = 120_000;

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** `~/Downloads/name.xlsx` → `~/Downloads/name (1).xlsx`, чтобы не затирать прошлый лист. */
function uniqueDownloadPath(dir, rawName) {
  const safe = path.basename(String(rawName || '')).replace(/[/\\]/g, '_') || 'tm30-sheet.xlsx';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || 'tm30-sheet';

  let candidate = path.join(dir, safe);
  for (let n = 1; fs.existsSync(candidate); n += 1) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/**
 * Скачивает `sheet_download_url` в системную папку загрузок и возвращает РЕАЛЬНЫЙ путь —
 * рендерер печатает его в строку статуса (`sheet downloaded ✓`), поэтому путь должен быть
 * тем, что лежит на диске, а не тем, что мы надеялись получить.
 *
 * ⚠️ `will-download` висит на сессии, а не на конкретном запросе, и ту же сессию использует
 * `<webview>` портала. Поэтому слушатель ставится ТОЛЬКО на время нашей загрузки и снимается
 * в `finish()` — иначе загрузка, начатая человеком в портале, приехала бы сюда.
 */
ipcMain.handle('tm30:download-sheet', (event, rawUrl) => {
  if (!isHttpUrl(rawUrl)) return Promise.resolve({ ok: false, error: 'not an http(s) url' });

  const wc = event.sender;
  return new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wc.session.removeListener('will-download', onWillDownload);
      resolve(result);
    };

    const onWillDownload = (_e, item) => {
      const target = uniqueDownloadPath(app.getPath('downloads'), item.getFilename());
      item.setSavePath(target);
      item.once('done', (_ev, state) => {
        finish(
          state === 'completed'
            ? { ok: true, path: target, filename: path.basename(target) }
            : { ok: false, error: state } // 'cancelled' | 'interrupted'
        );
      });
    };

    const timer = setTimeout(() => finish({ ok: false, error: 'timed out' }), DOWNLOAD_TIMEOUT_MS);

    wc.session.on('will-download', onWillDownload);
    wc.downloadURL(String(rawUrl));
  });
});

/** 📁 — отдаём ссылку настоящему браузеру человека. Открыть браузер ≠ сетевой вызов хелпера. */
ipcMain.handle('tm30:open-external', async (_event, rawUrl) => {
  if (!isHttpUrl(rawUrl)) return { ok: false, error: 'not an http(s) url' };
  try {
    await shell.openExternal(String(rawUrl));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// deep link может прилететь до app.whenReady()
let pendingLink = null;

// macOS: ссылки приходят сюда (и при запуске, и в работающее приложение)
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (app.isReady()) handleDeepLink(url);
  else pendingLink = url;
});

// Windows/Linux: ссылка в argv второго инстанса
app.on('second-instance', (_event, argv) => {
  const url = findDeepLinkInArgv(argv);
  if (url) handleDeepLink(url);
});

app.whenReady().then(() => {
  const url = pendingLink || findDeepLinkInArgv(process.argv);
  if (url) {
    handleDeepLink(url);
  } else {
    openStandaloneWindow();
  }
  pendingLink = null;
});

// Хелпер живёт в фоне и ждёт следующие deep links, даже когда все окна закрыты
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) openStandaloneWindow();
});
