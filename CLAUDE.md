# Instructions for Claude Code: Minecraft Bedrock Addon Engine

## Project Context

- **Target:** Minecraft Bedrock Dedicated Server (BDS) в Docker.
- **Client Platforms:** PlayStation 5 через LAN-прокси Phantom; Nintendo Switch
  через BedrockConnect — **Phantom Switch не поддерживает** («Nintendo Switch is
  not supported» в его README). Подробности и порты — в README.
- **Core Technology:** TypeScript → JavaScript (ES2020) для `@minecraft/server` (Bedrock Script API).
- **Environment:** локальная разработка в Docker на macOS → продакшн на Ubuntu VPS (DigitalOcean, Frankfurt).

## Core Commands

| Задача | Команда |
| --- | --- |
| Установка зависимостей | `npm install` |
| Сборка | `npm run build` (clean → check:manifest → `tsc`) |
| Режим наблюдения | `npm run watch` |
| Только проверка типов | `npm run typecheck` |
| Тесты движка | `npm test` (сборка + прогон на моках API) |
| Активация пака в мире | `npm run pack:activate` |
| Поднять сервер | `npm run server:up` |
| Перезапуск сервера | `npm run server:restart` (`docker restart bds`) |
| Логи сервера | `npm run server:logs` (`docker logs --tail 50 -f bds`) |
| Пересобрать и перезапустить | `npm run dev` |

## Project Architecture & Structure

```text
MinecraftServer/
├── .github/workflows/
│   ├── ci.yml                  # Проверка типов и сборка на PR
│   └── deploy.yml              # CI/CD на DigitalOcean по пушу в main
├── CLAUDE.md                   # Этот файл
├── README.md                   # Руководство по настройке и эксплуатации
├── docker-compose.yml          # Определение локального и продакшн-сервера
│                               # Локально BDS слушает хост-порт 19133:
│                               # 19132 занимает Phantom (см. .env.example)
├── package.json                # Зависимости и скрипты
├── tsconfig.json               # Конфигурация сборки TypeScript
├── addon/                      # Behavior Pack (монтируется в контейнер)
│   ├── manifest.json           # Манифест пака — UUID НЕ ТРОГАТЬ
│   ├── pack_icon.png
│   ├── src/                    # Исходники TypeScript
│   │   ├── index.ts            # Точка входа
│   │   ├── config.ts           # Конфигурация движка
│   │   ├── core/               # Инфраструктура (логи, реестр, команды)
│   │   ├── mechanics/          # Модульные игровые механики
│   │   └── types/runtime.d.ts  # Объявления среды QuickJS (console)
│   └── scripts/                # Скомпилированный JS (генерируется, в git не хранится)
├── tools/                      # Хостовые скрипты (Node.js/bash — НЕ для движка)
└── deploy/bootstrap-vps.sh     # Первичная настройка дроплета
```

## TypeScript & Script API Guidelines

### API Compliance

- Целевые версии зафиксированы в `addon/manifest.json` и `package.json`:
  `@minecraft/server 2.9.0`, `@minecraft/server-ui 2.1.0`. Они обязаны совпадать —
  `npm run build` падает при расхождении (`tools/check-manifest.mjs`).
- Используйте `world.afterEvents.*` для реактивных механик и
  `system.runInterval` / `system.runTimeout` для планирования.
- Точки жизненного цикла: `system.beforeEvents.startup` (единственная фаза, где
  доступен `customCommandRegistry`; `world` ещё недоступен) →
  `world.afterEvents.worldLoad` (мир готов) → `system.beforeEvents.shutdown`.
- `world.beforeEvents.chatSend` в стабильном API **отсутствует**. Не пишите
  чат-команды с префиксом — используйте кастомные слэш-команды.

### Custom Commands

- Регистрируйте команды через `MechanicCommand` в поле `commands` механики —
  ядро само зарегистрирует их при старте и проверит, активна ли механика.
- **Обработчики команд выполняются в read-only режиме.** Любая мутация мира
  (телепорт, выдача предметов, эффекты, показ форм) должна быть завёрнута в
  `defer(...)` из `core/commands.ts` (обёртка над `system.run`).
- Для игроков ставьте `cheatsRequired: false`, иначе команда потребует читов.
- Имена команд и enum-параметров обязаны иметь namespace `mc:`.

### Performance Constraints

- BDS работает в одном главном тик-лупе. Никаких тяжёлых блокирующих вычислений.
- Не обходите все сущности мира на каждом тике. Опрос онлайн-игроков —
  раз в секунду и реже (см. `playtimeRewards`, интервал 1200 тиков).
- Все подписки и таймеры регистрируйте только через `ctx.store`
  (`DisposableStore`): при `/mc:toggle` они снимаются автоматически.
  Прямые `world.afterEvents.X.subscribe` и `system.runInterval` внутри механик — ошибка.
- Коллекции, растущие по игрокам (`Map<playerId, ...>`), обязаны чиститься
  по `playerLeave` и в `ctx.store.add(() => map.clear())`.

### No Direct Node.js APIs

Код в `addon/src/` исполняется в QuickJS внутри Minecraft. Запрещены `fs`, `path`,
`http`, `process`, `Buffer`, `setTimeout`/`setInterval`. В `tsconfig.json` стоит
`"types": []`, а CI отдельно проверяет отсутствие Node-импортов в сборке.
Хостовые скрипты (`tools/`) — единственное место, где Node.js разрешён.

### Module Imports

`tsc` не переписывает пути. Относительные импорты пишите **с расширением `.js`**:
`import { createLogger } from './core/logger.js';` — иначе движок не найдёт модуль
в рантайме. Пакеты `@minecraft/*` импортируются по «голому» имени.

### Error Handling

- Оборачивайте обработчики событий и команд в try/catch. Внутри механик это
  делает `ctx.store.subscribe` автоматически — исключение в обработчике
  прерывает весь тик сервера.
- Для отладки пишите через `ctx.log` (`createLogger`), а не `console` напрямую:
  логгер уважает уровень и дублирует WARN/ERROR операторам в чат.
- Обращение к dynamic properties невалидного игрока бросает исключение —
  используйте хелперы из `core/storage.ts`, они возвращают fallback.

### Persistence

Единственное хранилище — dynamic properties (`core/storage.ts`). Ключи именуются
`mc:<домен>_<поле>`. Строка — до 32 КБ, суммарный объём на мир ограничен:
храните счётчики и координаты, а не журналы.

### Manifest Guard

**Никогда** не перегенерируйте и не меняйте `uuid` в `addon/manifest.json` без
явной команды: смена UUID сбрасывает регистрацию пака в существующих мирах,
и весь прогресс, хранящийся в dynamic properties мира, становится недоступен.
Версии в `dependencies` меняются только вместе с `package.json`.

## Build Rules

- Все исходники строго в `addon/src/`.
- Выходной каталог строго `addon/scripts/` (в git не хранится, кроме `.gitkeep`).
- Всегда убеждайтесь, что `npm run build` проходит без ошибок, прежде чем
  сообщать о готовности.
- Изменения в `core/` и в механиках проверяйте через `npm test`: `tests/`
  подменяет `@minecraft/server` моками (`tests/loader.mjs`) и прогоняет
  сценарии входа, смерти, боя, команд и выключения механик без реального
  сервера. Мок расширяется по мере надобности — это часть работы над механикой,
  а не отдельная задача.

## Adding a New Mechanic

1. Создайте `addon/src/mechanics/<name>.ts`, экспортируйте `defineMechanic({...})`.
2. Подписки и таймеры — только через `ctx.store`.
3. Команды — в поле `commands`, мутации внутри `defer(...)`.
4. Добавьте механику в массив `MECHANICS` в `addon/src/mechanics/index.ts`.
5. Настройки по умолчанию — в `DEFAULT_CONFIG` (`addon/src/config.ts`).
6. Допишите сценарий в `tests/engine.test.mjs`.
7. `npm test`, затем `npm run server:restart` и проверка в игре.
