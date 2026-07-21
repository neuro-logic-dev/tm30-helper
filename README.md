# TM30 Helper

Десктопный хелпер (Electron), который открывает `https://tm30.immigration.go.th`
в нативном окне-браузере и **автоматически подставляет логин/пароль аккаунта
после того, как оператор пройдёт капчу Cloudflare Turnstile**.

**Скачать инсталляторы (для операторов):** страница `/tm30-helper` в приложении,
либо публичный релиз-зеркало
<https://github.com/Paroletatel/tm30-helper-releases/releases/latest>.
Ссылки в приложении идут через `/api/tm30-helper/download?os=mac|win`.

Обычный iframe/веб-браузер тут не подходит: TM30 запрещает встраивание
(`X-Frame-Options`), а обойти это можно только из полноценного Chromium —
им и является тег `<webview>` внутри Electron.

## Как это связано с mo-reservation-fe

Веб-приложение не открывает окно само — оно дёргает deep link, а окно
открывает установленный на машине оператора хелпер:

```
Кнопка в mo-reservation-fe  ──tm30://open?d=<base64url(JSON)>──►  TM30 Helper
   (src/components/tm30/OpenTm30Button.tsx)                     (это приложение)
```

Формат ссылки: `tm30://open?d=<base64url(JSON)>`. Payload бывает двух версий,
парсер (`deeplink.js`) ветвится по полю `v`:

| Версия | Payload | Что открывается |
|--------|---------|-----------------|
| **v2** (текущая) | `{v: 2, worklist: [{filing_id, villa, checkin, status, dot?, report_status?, sheet_download_url?, folder_url?, return_url?, account?}, …]}` — весь Stage-B worklist (005 §8.2, 014 §7.3) | `app.html` — одно окно, две панели: список филингов слева, `<webview>` портала справа |
| **v1** (legacy) | `{name, login, pass}` — один аккаунт | `window.html` — окно одного аккаунта. **Поддержка обязательна** (013 §3.5): `OpenTm30Button.tsx` до сих пор шлёт v1 |
| — | `tm30://open` без `d` | `index.html` — chooser |

Строка `account` в v2-строке **необязательна**: пустые креды — нормальное
состояние («войти руками»), а не ошибка. Битый/обрезанный payload не
деградирует до chooser'а, а показывает нативное окно ошибки (014 §7.9).

Хелпер работает как single-instance: одно приложение в фоне, по каждой ссылке
открывается отдельное окно.

Клиентская часть (сборка ссылки, детекция «хелпер не установлен») —
в `src/lib/tm30.ts`.

## Файлы

| Файл | Назначение |
|------|------------|
| `main.js` | Electron main-процесс: регистрация протокола `tm30://`, single-instance, парсинг deep link, открытие окон |
| `deeplink.js` | Парсер `tm30://` без зависимостей (v1 / v2 / chooser / error), прогоняется тестом `test/run.sh` |
| `app.html` | **v2:** одно окно, две панели — worklist слева, `<webview>` портала справа (A-WEB-4c) |
| `window.html` | **v1 legacy:** окно одного аккаунта: `<webview>` с TM30 + автозаполнение после Turnstile |
| `index.html` | **v1 legacy:** standalone-режим (запуск без ссылки): таблица из 5 демо-аккаунтов |
| `package.json` | Зависимости и конфиг electron-builder |

## Разработка

```bash
cd desktop/tm30-helper
npm install
npm start          # standalone-окно с таблицей аккаунтов
```

## Сборка инсталляторов

```bash
npm run dist:mac   # dist/TM30 Helper-<ver>-universal.dmg   (Intel + Apple Silicon)
npm run dist:win   # dist/TM30 Helper Setup <ver>.exe        (Windows x64, one-click)
npm run dist       # оба сразу
```

`npm run dist:win` **не собирается на macOS** без wine + nsis-тулчейна — Windows-
инсталлятор собирается на Windows-машине или в CI. `dist:mac` на mac-машине
собирается как есть.

Протокол `tm30://` регистрируется в ОС при установке — оператору настраивать
ничего не нужно. Проверено на собранном `2.0.0`: установленное из `.dmg`
приложение поднимается по `tm30://`-ссылке «с нуля» и открывает `app.html` для
v2-ссылки и `window.html` для v1-ссылки.

**Публикация:** страница `/tm30-helper` качает файлы с фиксированными именами
`TM30-Helper.dmg` / `TM30-Helper.exe` из `releases/latest` зеркала — при
выкладке артефакт нужно переименовать под это имя, иначе кнопка скачивания
ведёт в 404.

## ⚠️ Подпись кода

Сборки **не подписаны** (нет сертификатов Apple/Microsoft), поэтому при первом
запуске ОС покажет предупреждение:

- **macOS** — Gatekeeper «программа из неопознанного источника». Обход: правый
  клик → «Открыть», либо `xattr -dr com.apple.quarantine "/Applications/TM30 Helper.app"`.
  Для бесшовной установки нужен Apple Developer ID + нотаризация.
- **Windows** — SmartScreen «Windows защитила ваш компьютер» → «Подробнее» →
  «Выполнить в любом случае». Убирается OV/EV code-signing сертификатом.

Когда появятся сертификаты — подпись и нотаризация добавляются в блок `build`
в `package.json`.

## Безопасность

Логин/пароль сейчас едут внутри deep link в base64 (не шифрование). Для пилота
приемлемо. При ужесточении — передавать в ссылке только id аккаунта, а пары
хелпер будет забирать с API.
