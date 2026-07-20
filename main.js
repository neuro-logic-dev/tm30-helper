const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');

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
    webPreferences: { webviewTag: true },
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
