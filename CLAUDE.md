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
| Установка карты `.mcworld` | `npm run world:install -- <файл> [--yes]` |
| Проверить порты в `.env` | `npm run check:env` |
| Поднять сервер | `npm run server:up` (check:env → `docker compose up -d`) |
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
│   │   ├── ui/panel.ts         # Панель сервера: общая для предмета и команды
│   │   ├── mechanics/          # Модульные игровые механики
│   │   └── types/runtime.d.ts  # Объявления среды QuickJS (console)
│   └── scripts/                # Скомпилированный JS (генерируется, в git не хранится)
├── tools/                      # Хостовые скрипты (Node.js/bash — НЕ для движка)
│                               # env.mjs — общий разбор .env
│                               # check-env.mjs — сверка портов до запуска
│                               # install-world.mjs — установка карты .mcworld
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

### Управление — только через UI

Чат-команд у движка нет, кроме `/mc:device` (страховка на случай потерянного
коммуникатора). Новые возможности добавляйте **разделом в панель**
(`addon/src/ui/panel.ts`), а не командой: на консолях набирать текст неудобно,
а они основная платформа.

Механизм `MechanicCommand` в `core/commands.ts` сохранён для этой единственной
команды. Если она всё же понадобится: обработчики выполняются в read-only
режиме, поэтому любая мутация мира заворачивается в `defer(...)`, а
`cheatsRequired` должен быть `false`.

`world.beforeEvents.chatSend` в стабильном API **отсутствует** — обработчиков
чата в проекте нет и быть не может.

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

## Экономика и участки

Валюта — `core/economy.ts`. Любые списания и начисления из механик только через
него (`withdraw`, `deposit`, `canAfford`); после изменения баланса вызывайте
`refreshDisplay` из `mechanics/economy.ts`, иначе табло отстанет.

Участки — `core/plots.ts`. Владение хранится по одному dynamic property мира на
чанк и кэшируется в памяти: проверка владельца выполняется на каждый сломанный и
поставленный блок, это горячий путь. Любая запись владельца обязана идти через
`setOwner`/`clearOwner` — они обновляют кэш.

Установку блоков в стабильном API перехватить before-событием нельзя: такого
события нет. Защита строится на `playerInteractWithBlock` плюс откат в
`afterEvents.playerPlaceBlock`.

## Миры

`.mcworld` — ZIP с папкой мира; распаковка в `tools/install-world.mjs` сделана
на `zlib` без внешнего `unzip`, чтобы одинаково работать на macOS и Ubuntu.
Пути из архива проверяются до первой записи на диск: иначе архив с выходом за
каталог успел бы переименовать существующий мир и оборваться.

Замена мира стирает весь прогресс движка — балансы, участки и чертежи лежат в
dynamic properties мира. Прежний мир всегда переименовывается в резервную
копию, а не удаляется.

## Служебные предметы

Коммуникатор и чертёж создаются через `core/markedItem.ts`: метка хранится в
dynamic property самого `ItemStack`, поэтому переименование наковальней предмет
не подделывает. Новые служебные предметы добавляйте тем же способом, а не
проверкой `nameTag`.

## Чертежи

`core/blueprints.ts` — карточки зданий (имя, идентификатор структуры, габарит,
цена) в свойствах мира; геометрия живёт в `world.structureManager`.

`runCommandAsync` в стабильном API **отсутствует** — структуры ставятся через
`structureManager.place`, а не командной строкой. Голограмма рисуется
`player.spawnParticle` (видна только этому игроку) с ограничением числа точек:
она обновляется несколько раз в секунду и не должна утяжелять тик.

## Слои и панель управления

Зависимости идут строго в одну сторону: **`core/` ← `ui/` ← `mechanics/`**.

- `core/` — логика и хранение. Не импортирует ни `ui/`, ни `mechanics/`.
- `ui/` — формы коммуникатора. Импортирует только `core/`.
- `mechanics/` — подписки на события. Импортируют `core/` и `ui/`.

Правило нужно из-за циклов: панель вызывает операции (покупка участка,
сохранение чертежа), а механики открывают панель. Если операция живёт в
механике, импорт замыкается в кольцо. Поэтому вся логика — в `core/`
(`economy`, `plots`, `building`, `playerActions`), а механики только
разводят события.

Показ формы — не read-only операция, но мутации внутри обработчика формы
(покупка, выдача предмета, телепорт) оборачивайте в `system.run` через
хелпер `apply(...)` в `panel.ts`.

## Adding a New Mechanic

1. Создайте `addon/src/mechanics/<name>.ts`, экспортируйте `defineMechanic({...})`.
2. Подписки и таймеры — только через `ctx.store`.
3. Команды — в поле `commands`, мутации внутри `defer(...)`.
4. Добавьте механику в массив `MECHANICS` в `addon/src/mechanics/index.ts`.
5. Настройки по умолчанию — в `DEFAULT_CONFIG` (`addon/src/config.ts`).
6. Допишите сценарий в `tests/engine.test.mjs`.
7. `npm test`, затем `npm run server:restart` и проверка в игре.
