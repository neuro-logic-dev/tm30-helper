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

## Mock-портал: внутренний e2e всего механизма подачи (T3-07)

`test/mock-portal/` — локальный МОК настоящего TM30-портала (login →
Inform Accommodation → серверная валидация xlsx → receipt или поимённый
список нарушений). Позволяет прогнать весь механизм подачи целиком, **не
трогая настоящий иммиграционный сервис**. Валидация повторяет
государственный контракт импорта (Iteration 2 D-2): один лист
«แบบแจ้งที่พัก Inform Accom», 9 байт-точных заголовков, обязательные поля,
Gender ∈ {M,F}, ICAO-национальность, даты `DD/MM/YYYY` (у даты рождения
разрешены заглушки `00`).

Хелпер целится в мок через env `TM30_PORTAL_BASE_URL`: main.js пробрасывает
её в `app.html` query-параметром `portal`, и `TM30_URL` берёт её вместо
`https://tm30.immigration.go.th`. **Без переменной поведение байт-в-байт
прежнее** (существующие сьюты это доказывают).

```bash
cd desktop/tm30-helper

# 1. мок-портал (по умолчанию порт 8630; логин — любая непустая пара,
#    либо закрепите: MOCK_TM30_USER=... MOCK_TM30_PASS=...)
node test/mock-portal/server.mjs --port 8630

# 2. тестовые листы для ручной загрузки (валидный / заведомо битый)
node test/mock-portal/build-sheet.mjs            # → Villa_Demo_..._TM30.xlsx (ждём receipt)
node test/mock-portal/build-sheet.mjs --broken   # → broken_TM30.xlsx (ждём список нарушений)

# 3. deep link с тестовым worklist'ом (печатает tm30://open?d=…)
node test/autofill/fixture.js

# 4. хелпер, нацеленный на мок (Linux: ELECTRON_DISABLE_SANDBOX=1)
TM30_PORTAL_BASE_URL=http://localhost:8630 ELECTRON_DISABLE_SANDBOX=1 \
  npx electron . "tm30://open?d=<из шага 3>"
```

Дальше руками: выбрать виллу → в webview мокового портала кликнуть
«✓ I am human» (фейковый Turnstile: пустой `cf-turnstile-response`
становится непустым) → **штатный автофилл сам подставит логин/пароль** —
селекторы `#user`/`#pass` те же, что у реального портала → Sign in →
страница Inform Accommodation → загрузить лист из шага 2. Валидный даёт
receipt с номером `MOCK-TM30-…` и таблицей гостей; битый — постраничный
список нарушений с номерами строк. `↻ fresh login` сбрасывает партицию
виллы и возвращает на `/login` — у каждой виллы своя cookie-сессия,
изоляция партиций видна вживую.

Юнит/интеграционные тесты мока (node ≥ 21 понимает только glob, не каталог):

```bash
node --test 'test/mock-portal/*.test.mjs'
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
