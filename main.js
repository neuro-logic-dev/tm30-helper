const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { autoUpdater } = require('electron-updater');

const { parseDeepLink, DeepLinkKind, PROTOCOL } = require('./deeplink');
const { registerInsertSheet } = require('./insert-sheet');

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
//   v3: {v:3, rows:[...], villas, *_base} — ADR-0015, the compact shape. Normalised to the
//       SAME rows by deeplink.js, so nothing below this line can tell the two apart.
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
  // Версия уезжает в query, а не вшита в разметку: с автообновлением приложение
  // меняет версию само, и жёстко прописанная строка на экране начинает врать.
  win.loadFile('index.html', { query: { v: app.getVersion() } });
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
function openWorklistWindow(worklist, focusFilingId) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080, // левая панель 360px + панель портала, ниже неё макет ломается
    title: 'TM30 Helper',
    // A-WEB-4d: preload — ТОЛЬКО для v2-окна. Даёт `app.html` ровно два глагола
    // (скачать лист / открыть папку). v1-окна остаются без preload — 013 §3.5.
    webPreferences: { webviewTag: true, preload: path.join(__dirname, 'preload.js') },
  });
  // T3-03: focus_filing_id уезжает в НОВОЕ окно тем же query-механизмом. Каждая v2-ссылка
  // открывает СВОЁ окно, так что фокус по построению существует только на initial boot —
  // ни один уже открытый webview никогда не перенавигируется этим полем.
  win.loadFile('app.html', {
    query: {
      d: toBase64Url({
        v: 2,
        worklist,
        ...(Number.isFinite(focusFilingId) ? { focus_filing_id: focusFilingId } : {}),
      }),
      // T3-07: portal-base override for the internal MOCK-portal e2e (test/mock-portal/).
      // Unset ⇒ the param is absent ⇒ app.html falls back to the real portal URL, byte-identical.
      ...(process.env.TM30_PORTAL_BASE_URL ? { portal: process.env.TM30_PORTAL_BASE_URL } : {}),
    },
  });
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
        `[tm30-helper] deep link v${result.payload_version}: ${result.worklist.length} filing(s), ` +
          `${withCreds} with credentials, ${result.worklist.length - withCreds} manual-login` +
          (result.focus_filing_id !== undefined ? `, focus filing #${result.focus_filing_id}` : '')
      );
      openWorklistWindow(result.worklist, result.focus_filing_id);
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
 * ⚠️ `will-download` висит на сессии, а не на конкретном запросе. Загрузка идёт через сессию
 * ОКНА (`event.sender` — это app.html, его сессия — дефолтная), и с A-WEB-4g это уже НЕ та
 * сессия, где живут webview портала: у каждой виллы своя партиция `persist:tm30-v-…`, так что
 * загрузки, начатые человеком в портале, сюда физически не приезжают. Слушатель всё равно
 * ставится ТОЛЬКО на время нашей загрузки и снимается в `finish()` — параллельные скачивания
 * листов из самого окна не должны перехватывать друг друга.
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

/**
 * A-WEB-4g: ↻ fresh login — сброс портальной сессии ОДНОЙ виллы.
 *
 * 🔴 Префикс `persist:tm30-` — единственная граница этого глагола, и она проверяется ЗДЕСЬ,
 * в main, а не в renderer'е: renderer не должен уметь попросить очистку чужой партиции
 * (в т.ч. дефолтной сессии, где живёт само окно и его загрузки листов). Всё, что не наше, —
 * `{ok:false}` и НИЧЕГО не очищено.
 *
 * `session.fromPartition` создаёт партицию, если её ещё нет — очистка пустой партиции
 * корректна и честно возвращает ok. Это не сетевой вызов хелпера (014 §2.5): стирается
 * локальное хранилище, ни одного байта наружу.
 */
ipcMain.handle('tm30:reset-portal-session', async (_event, partition) => {
  if (typeof partition !== 'string' || !partition.startsWith('persist:tm30-')) {
    return { ok: false, error: 'not a tm30 partition' };
  }
  try {
    await session.fromPartition(partition).clearStorageData();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/**
 * T3-08: ⇥ insert — скачивание листа в per-task каталог ({userData}/tm30-sheets/{filing_id}/)
 * + программная подстановка файла в input[type=file] портальной webview (CDP primary, in-page
 * fallback, read-back verification). Весь движок живёт в ./insert-sheet.js, чтобы insert-харнесс
 * (который, как и autofill-харнесс, бутается САМ вместо main.js) регистрировал ТОТ ЖЕ
 * production-обработчик, а не дрейфующую копию.
 */
registerInsertSheet();

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

// ---------- Автообновление ----------
/**
 * Помощник обновляет себя сам, молча. Ничего не спрашиваем и ничего не показываем:
 * человек открывает его, чтобы подать TM30, а не чтобы обслуживать приложение.
 *
 * Как это ложится на жизненный цикл: на Windows приложение выходит, как только
 * закрыто последнее окно (см. `window-all-closed` ниже), то есть живёт от одной
 * задачи до другой. Проверка на старте + установка при выходе означают, что
 * обновление приезжает буквально к следующему открытию — окна для «забыл
 * обновиться» почти не остаётся. На macOS процесс живёт дольше, поэтому там
 * дополнительно работает периодическая проверка.
 *
 * 🔴 Обязательные условия, без которых механизм молча мёртв:
 *   • релиз собран с `--publish always`, чтобы рядом с артефактами лежали
 *     `latest.yml` / `latest-mac.yml` — апдейтер читает их, а не список файлов;
 *   • имена артефактов стабильные (`artifactName` в package.json): переименование
 *     файла руками расходится с именем внутри latest.yml и даёт 404;
 *   • macOS обновляется ТОЛЬКО из подписанного и нотаризованного билда — это
 *     требование Squirrel.Mac, а не настройка. Неподписанная сборка ставится
 *     руками и обновляться не будет.
 */
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function initAutoUpdate() {
  // Запуск через `electron .` не имеет фида обновлений — апдейтер там только шумит.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log('[tm30-helper] update available:', info && info.version);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log('[tm30-helper] update downloaded, installs on quit:', info && info.version);
  });
  // Сеть недоступна, релиз ещё не опубликован, GitHub прилёг — это не повод мешать
  // человеку работать. Ошибка идёт в лог, приложение продолжает как ни в чём не бывало.
  autoUpdater.on('error', (err) => {
    console.error('[tm30-helper] update check failed:', (err && err.message) || err);
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

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
  initAutoUpdate();

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
