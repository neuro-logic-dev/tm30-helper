const { app, BrowserWindow } = require('electron');
const path = require('path');

const PROTOCOL = 'tm30';

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
// Формат: tm30://open?d=<base64url(JSON {name, login, pass})>
function parseDeepLink(url) {
  try {
    if (!url || !url.startsWith(PROTOCOL + '://')) return null;
    const u = new URL(url);
    const d = u.searchParams.get('d');
    if (!d) return null;
    const b64 = d.replace(/-/g, '+').replace(/_/g, '/');
    const acc = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    if (!acc || !acc.login) return null;
    return {
      name: String(acc.name || acc.login),
      login: String(acc.login),
      pass: String(acc.pass || ''),
    };
  } catch {
    return null;
  }
}

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

function handleDeepLink(url) {
  const acc = parseDeepLink(url);
  console.log('[tm30-helper] deep link:', acc ? `account="${acc.name}"` : `chooser (${url})`);
  if (acc) {
    openAccountWindow(acc);
  } else if (typeof url === 'string' && url.startsWith(PROTOCOL + '://')) {
    // ссылка без аккаунта (tm30://open) — открываем список аккаунтов
    openStandaloneWindow();
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
