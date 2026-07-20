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

Формат ссылки: `tm30://open?d=<base64url(JSON {name, login, pass})>`.
Хелпер работает как single-instance: одно приложение в фоне, по каждой ссылке
открывается отдельное окно под нужный аккаунт.

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

Протокол `tm30://` регистрируется в ОС при установке — оператору настраивать
ничего не нужно.

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
