# Minecraft Bedrock Custom Server: Switch & PS5

Выделенный сервер Minecraft Bedrock с кастомными механиками на TypeScript,
рассчитанный на подключение с Nintendo Switch и PlayStation 5.

---

## Архитектура

Ни одна из консолей не умеет подключаться к серверу по произвольному IP и порту,
но обходные пути у них **разные** — общего решения для PlayStation и Switch нет.

```text
   [ PlayStation 5 ]                      [ Nintendo Switch ]
          │                                       │
          │ Поиск LAN-игр                         │ DNS → BedrockConnect
          │ (broadcast UDP 19132)                 │ (только меню выбора сервера)
          ▼                                       │
   [ Mac: Phantom :19132 ]                        │ затем прямое подключение
          │                                       │ по IP:порт
          │ проброс на 127.0.0.1:19133            │
          ▼                                       ▼
   [ Bedrock Dedicated Server ]  хост :19133 → контейнер :19132
          ├── Фаза 1: Docker на Mac
          └── Фаза 2: VPS DigitalOcean (Frankfurt), хост :19132
```

- **PlayStation** — [Phantom](https://github.com/jhead/phantom) отвечает на
  широковещательные запросы поиска LAN-игр от имени удалённого сервера, и он
  появляется в разделе **Играть → Друзья → Игры по локальной сети**.
- **Nintendo Switch** — Phantom его **не поддерживает** (это заявлено в самом
  Phantom: *«Nintendo Switch is not supported»*). Switch подключается через
  [BedrockConnect](https://github.com/Pugmatt/BedrockConnect), минуя Phantom, —
  см. раздел [Nintendo Switch](#nintendo-switch).

### Порты

Phantom обязан сам занимать UDP 19132 на всех интерфейсах, иначе он не получит
broadcast от консолей. Поэтому локально BDS вешается на 19133 — если оставить
ему 19132, контейнер не поднимется: Docker ответит `port is already allocated`.

| Что | Фаза 1 (Mac) | Фаза 2 (VPS) |
| --- | --- | --- |
| Phantom | UDP 19132 | не запускается |
| BDS (хост) | UDP 19133 (`SERVER_PORT`) | UDP 19132 |
| BDS (внутри контейнера) | UDP 19132 | UDP 19132 |

На VPS Phantom не нужен: PlayStation ходит туда через Phantom на Mac, а Switch —
напрямую по публичному IP дроплета.

## Состав репозитория

| Путь | Назначение |
| --- | --- |
| `addon/` | Behavior Pack: манифест, исходники TypeScript, скомпилированные скрипты |
| `addon/src/core/` | Инфраструктура: логи, реестр механик, команды, хранилище |
| `addon/src/mechanics/` | Игровые механики (по файлу на механику) |
| `tools/` | Хостовые скрипты: сборка, активация пака, запуск Phantom |
| `tests/` | Тесты движка на моках Bedrock API (сервер не нужен) |
| `deploy/` | Первичная настройка VPS |
| `.github/workflows/` | CI (проверка типов и сборка) и CD (деплой на дроплет) |

## Требования

- macOS с Docker Desktop (Фаза 1) или Ubuntu 24.04 (Фаза 2)
- Node.js 20+
- Mac и консоли в одной сети Wi-Fi (для PlayStation обязательно; Switch
  подключается по IP и в одной сети с Mac быть не обязан)
- **Версия BDS должна поддерживать `@minecraft/server 2.9.0`.** В
  `docker-compose.yml` по умолчанию `VERSION=LATEST`. Если в логах появится
  `Failed to load script` или ошибка о версии модуля — см.
  [Диагностику](#диагностика).

---

## Фаза 1. Локальная разработка

### 1. Подготовка проекта

```bash
git clone https://github.com/kovalenkoserhii2107-maker/MinecraftServer.git
cd MinecraftServer
npm install
cp .env.example .env
```

В `.env` укажите свой Xbox-геймертег в `OPS=` — иначе не будет прав оператора
и команда `/mc:toggle` окажется недоступна.

### 2. Сборка аддона

```bash
npm run build
```

Сборка: очистка `addon/scripts/` → сверка версий манифеста с `node_modules` → `tsc`.

### 3. Тесты (необязательно, но быстро)

```bash
npm test
```

Прогоняет сценарии входа, смерти, боя и команд на моках Script API — без
запуска Minecraft. Полезно перед деплоем: те же тесты выполняет CI.

### 4. Запуск сервера

```bash
npm run server:up
npm run server:logs      # дождитесь строки "Server started"
```

При первом запуске BDS скачивает дистрибутив и создаёт мир — это занимает
пару минут.

### 5. Активация behavior pack

BDS **не включает** паки автоматически: список активных паков хранится в мире.

```bash
npm run pack:activate
npm run server:restart
```

Проверьте лог — должна появиться строка `[INFO][engine] Движок механик запущен`:

```bash
npm run server:logs
```

### 6. Запуск Phantom (для PlayStation)

```bash
./tools/phantom.sh --install   # один раз: скачать бинарник
./tools/phantom.sh             # адрес берётся из PHANTOM_SERVER в .env
```

macOS при первом запуске заблокирует неподписанный бинарник — разрешите его в
**Системные настройки → Конфиденциальность и безопасность**.

Phantom должен работать всё время игры: закроете терминал — PlayStation потеряет
сервер. Для Switch Phantom не нужен и не поможет — см.
[Nintendo Switch](#nintendo-switch).

### 7. Подключение с PlayStation

1. Убедитесь, что консоль в той же сети Wi-Fi, что и Mac.
2. Minecraft → **Играть** → вкладка **Друзья**.
3. Сервер появится в разделе **Игры по локальной сети** (10–30 секунд).

### 7a. Подключение с Nintendo Switch

Отдельная процедура — см. [Nintendo Switch](#nintendo-switch) ниже.

### 8. Цикл разработки

```bash
npm run watch      # в одном терминале: пересборка при каждом сохранении
npm run dev        # в другом: сборка + docker restart bds
```

Скрипты монтируются в контейнер напрямую, поэтому пересобирать образ не нужно —
достаточно перезапуска контейнера.

---

## Фаза 2. Продакшн на DigitalOcean

### 1. Создание дроплета

Basic / Premium AMD · 1 vCPU · 2 GiB RAM · 50 GiB NVMe · Ubuntu 24.04 LTS ·
регион **Frankfurt**.

### 2. Настройка сервера

```bash
ssh root@<IP_ДРОПЛЕТА>
git clone https://github.com/kovalenkoserhii2107-maker/MinecraftServer.git /opt/mc-server
cd /opt/mc-server
sudo ./deploy/bootstrap-vps.sh
```

Скрипт устанавливает Docker, создаёт пользователя деплоя `mcdeploy`, включает
UFW (SSH TCP/22, Minecraft UDP/19132) и добавляет 2 ГиБ swap.

### 3. Cloud Firewall

В панели DigitalOcean продублируйте правила входящего трафика:

| Тип | Протокол | Порт | Источник |
| --- | --- | --- | --- |
| Custom | UDP | 19132 | 0.0.0.0/0, ::/0 |
| SSH | TCP | 22 | ваш IP |

### 4. Первый запуск

```bash
sudo -u mcdeploy -s
cd /opt/mc-server
cp .env.example .env && nano .env     # укажите OPS, SERVER_NAME и SERVER_PORT=19132
docker compose up -d
docker logs --tail 50 -f bds          # дождитесь создания мира
node tools/activate-pack.mjs
docker restart bds
```

### 5. Настройка CI/CD

Сгенерируйте отдельный ключ деплоя и положите публичную часть на дроплет:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/mc_deploy -N ""
ssh-copy-id -i ~/.ssh/mc_deploy.pub mcdeploy@<IP_ДРОПЛЕТА>
```

В GitHub → **Settings → Secrets and variables → Actions** добавьте:

| Секрет | Значение |
| --- | --- |
| `DEPLOY_HOST` | IP дроплета |
| `DEPLOY_USER` | `mcdeploy` |
| `DEPLOY_PATH` | `/opt/mc-server` |
| `DEPLOY_SSH_KEY` | содержимое `~/.ssh/mc_deploy` (приватный ключ) |
| `DEPLOY_PORT` | необязательно, по умолчанию `22` |

Деплой запускается **вручную**: GitHub → **Actions** → *Deploy to DigitalOcean* →
**Run workflow**. Он собирает TypeScript, прогоняет тесты, доставляет
`addon/scripts/` и `addon/manifest.json` по rsync и перезапускает контейнер.

Когда дроплет будет обкатан, автодеплой по пушу в `main` включается возвратом
блока `push: branches: [main]` в `.github/workflows/deploy.yml`.

### 6. Переключение консолей на VPS

**PlayStation** — в `.env` на Mac:

```bash
PHANTOM_SERVER=<IP_ДРОПЛЕТА>:19132
```

Затем `./tools/phantom.sh`. Сервер снова появится в списке LAN-игр — на этот раз
облачный. Mac по-прежнему должен работать: Phantom нужен PlayStation всегда.

**Nintendo Switch** — в списке BedrockConnect замените адрес на
`<IP_ДРОПЛЕТА>:19132`. Mac для Switch больше не нужен вообще.

На дроплете в `.env` должно стоять `SERVER_PORT=19132`: Phantom там не
запускается, и занимать порт некому.

---

## Nintendo Switch

Phantom **не поддерживает Switch** — это ограничение самого Phantom, а не
настройки. Никакая правка сети, интерфейсов или портов этого не изменит: сервер
просто никогда не появится в списке LAN-игр на Switch.

Рабочий путь — [BedrockConnect](https://github.com/Pugmatt/BedrockConnect). Он
подменяет список «Featured Servers» на свой, куда можно вписать любой адрес.

**Ключевой момент:** DNS отдаёт Switch только *меню выбора сервера*. Само
подключение идёт **напрямую** с консоли на тот адрес, который вы впишете. Поэтому
Switch ходит мимо Phantom и обращается прямо к порту BDS.

### Настройка

1. Узнайте адрес Mac в локальной сети:

   ```bash
   ipconfig getifaddr en0
   ```

2. На Switch: **Системные настройки → Интернет →** ваша сеть **→ Изменить
   настройки → Настройки DNS → Вручную**
   - Основной DNS: `104.238.130.180`
   - Дополнительный DNS: `8.8.8.8`

3. Minecraft → вкладка **Серверы** → любой из featured-серверов (Mineville,
   The Hive и другие) — вместо него откроется список BedrockConnect.

4. **Добавить сервер** → адрес из шага 1, порт **`19133`** (значение
   `SERVER_PORT` из `.env`, а не 19132 — на 19132 сидит Phantom).

   На Фазе 2 вместо этого указывается публичный IP дроплета и порт `19132`.

### О публичном DNS

`104.238.130.180` — сервер автора BedrockConnect. Пока настройка активна, DNS-запросы
консоли уходят на этот сторонний хост. Для игровой приставки риск невелик, но это
осознанный выбор, а не безобидная галочка. Чтобы вернуть всё как было, переключите
настройки DNS на Switch обратно в **Автоматически**.

Поднять собственный BedrockConnect в текущей топологии нельзя: он обязан слушать
UDP 19132, а этот порт локально занят Phantom, на дроплете — самим BDS. Для своего
экземпляра нужен отдельный хост или второй IP-адрес.

---

## Игровые механики

| ID | Что делает | Команды |
| --- | --- | --- |
| `welcome` | Приветствие, MOTD, стартовый набор при первом входе | `/mc:kit` |
| `death_beacon` | Запоминает место смерти, ограниченный возврат | `/mc:back`, `/mc:deathpoint` |
| `playtime_rewards` | Учёт времени в игре и награды за пороги | `/mc:stats` |
| `combat_feedback` | Полоса здоровья цели, предупреждение о низком HP | — |
| `admin_panel` | Экранная панель (управляется геймпадом) | `/mc:panel` |

Общие команды: `/mc:help`, `/mc:mechanics`, `/mc:toggle <механика> <true|false>`.

`/mc:panel` — основной способ управления с консоли: набирать команды на
геймпаде неудобно, а форма листается стиками.

Механики включаются и выключаются в рантайме; выбор сохраняется в мире и
переживает перезапуск сервера.

### Настройка

Значения по умолчанию — в `addon/src/config.ts` (`DEFAULT_CONFIG`): содержимое
стартового набора, число возвратов к точке смерти, пороги наград, порог
предупреждения о здоровье. После правки — `npm run build && npm run server:restart`.

### Добавление своей механики

1. Создайте `addon/src/mechanics/<name>.ts` с `defineMechanic({...})`.
2. Все подписки и таймеры — через `ctx.store`, иначе они не снимутся при выключении.
3. Добавьте механику в `MECHANICS` в `addon/src/mechanics/index.ts`.
4. Допишите сценарий в `tests/engine.test.mjs`.
5. `npm test && npm run server:restart`.

Подробные правила — в [CLAUDE.md](CLAUDE.md).

---

## Диагностика

**Контейнер не стартует: `port is already allocated`**
- Phantom уже занял UDP 19132 — так и задумано. У BDS в `.env` должен стоять
  `SERVER_PORT=19133`, и тот же порт — в `PHANTOM_SERVER` (`127.0.0.1:19133`).
- Посмотреть, кто держит порт: `lsof -i udp:19132`.

**Сервер не виден на PlayStation**
- Phantom запущен и не выдал ошибок? Запустите его с `-debug` — видно, доходят
  ли до него запросы обнаружения от консоли.
- Mac и консоль в одной сети Wi-Fi? Гостевая сеть и изоляция клиентов
  (AP isolation) на роутере ломают LAN-обнаружение.
- Порт проброшен: `docker compose ps` показывает `19133->19132/udp`.

**Сервер не виден на Nintendo Switch**
- Если вы ждёте его в списке LAN-игр — так и будет: Phantom не поддерживает
  Switch. Нужен BedrockConnect, см. [Nintendo Switch](#nintendo-switch).
- BedrockConnect настроен, но сервер не добавляется — проверьте порт: локально
  это `19133`, а не `19132`.
- Доходит ли Switch до сервера вообще: `npm run server:logs` в момент попытки
  входа. Пусто — трафик не дошёл; строка с ошибкой — проблема уже в рукопожатии
  (версия клиента или авторизация Xbox Live).

**Пак не грузится, механик нет в игре**
- Выполнили `npm run pack:activate` **после** создания мира и перезапустили сервер?
- В логе есть `Failed to load script` или сообщение о версии модуля? Значит
  версия BDS старше, чем `@minecraft/server` в манифесте. Варианты:
  обновить образ (`docker compose pull && docker compose up -d`) либо понизить
  версии сразу в трёх местах — `addon/manifest.json`, `package.json`,
  `npm install` — и пересобрать. `npm run build` проверит согласованность.
- `docker logs bds | grep -i script` покажет ошибки загрузки скриптов.

**Команды `/mc:*` не находятся**
- Кастомные команды регистрируются на старте: проверьте лог на
  `Не удалось зарегистрировать`.
- Наберите `/mc:` — клиент покажет автодополнение доступных команд.

**`/mc:toggle` отвечает отказом**
- Нужны права оператора: добавьте геймертег в `OPS` в `.env` и перезапустите
  контейнер, либо выполните `op <геймертег>` в консоли сервера.

**Просадки TPS на дроплете**
- Уменьшите `VIEW_DISTANCE` и `TICK_DISTANCE` в `.env`.
- `docker stats bds` покажет упор в лимит памяти (`MEM_LIMIT`).

## Резервное копирование

Все данные мира — в `server-data/`:

```bash
docker stop bds
tar -czf "backup-$(date +%F).tar.gz" server-data/worlds
docker start bds
```

## Лицензия

MIT.
