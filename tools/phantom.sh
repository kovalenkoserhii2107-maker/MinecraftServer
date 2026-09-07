#!/usr/bin/env bash
#
# Запуск Phantom — LAN-прокси, благодаря которому сервер виден на PlayStation
# во вкладке «Друзья» → «Игры по локальной сети».
#
# ВНИМАНИЕ: Nintendo Switch через Phantom не работает — авторы Phantom заявляют
# это прямо ("Nintendo Switch is not supported"). Для Switch используется
# BedrockConnect, см. README, раздел «Nintendo Switch».
#
# Консоли не умеют подключаться к произвольному IP:порту, но рассылают запросы
# обнаружения LAN-серверов по UDP. Phantom отвечает на них от имени удалённого
# сервера и проксирует трафик.
#
# Phantom сам занимает UDP 19132 на всех интерфейсах — иначе он не получит
# broadcast от консолей. Поэтому локально BDS вешается на другой порт
# (SERVER_PORT=19133 в .env), а сюда передаётся его адрес.
#
#   ./tools/phantom.sh                 # адрес берётся из .env (PHANTOM_SERVER)
#   ./tools/phantom.sh 203.0.113.10    # явный адрес VPS
#   ./tools/phantom.sh --install       # скачать бинарник Phantom для этой ОС
#
# ВАЖНО: Mac и консоль должны быть в одной сети Wi-Fi, а Phantom должен
# работать всё время игры.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

PHANTOM_BIN="${PHANTOM_BIN:-./phantom}"
PHANTOM_RELEASE="${PHANTOM_RELEASE:-v0.6.0}"

detect_asset() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64) echo "phantom-macos-arm64" ;;
    Darwin:x86_64) echo "phantom-macos" ;;
    Linux:x86_64) echo "phantom-linux-x64" ;;
    Linux:aarch64) echo "phantom-linux-arm64" ;;
    *) echo "" ;;
  esac
}

install_phantom() {
  local asset url
  asset="$(detect_asset)"
  if [ -z "$asset" ]; then
    echo "Не удалось определить сборку Phantom для $(uname -s)/$(uname -m)." >&2
    echo "Скачайте вручную: https://github.com/jhead/phantom/releases" >&2
    exit 1
  fi
  url="https://github.com/jhead/phantom/releases/download/${PHANTOM_RELEASE}/${asset}"
  echo "Загрузка ${url}"
  curl -fL --retry 3 -o "$PHANTOM_BIN" "$url"
  chmod +x "$PHANTOM_BIN"
  echo "Phantom установлен: $PHANTOM_BIN"
  echo "macOS может потребовать разрешение в «Системные настройки → Конфиденциальность и безопасность»."
}

if [ "${1:-}" = "--install" ]; then
  install_phantom
  exit 0
fi

# Адрес сервера: аргумент → переменная окружения → .env → localhost.
SERVER="${1:-${PHANTOM_SERVER:-}}"
if [ -z "$SERVER" ] && [ -f .env ]; then
  SERVER="$(grep -E '^PHANTOM_SERVER=' .env | tail -n 1 | cut -d= -f2- | tr -d '"' | tr -d "'" | xargs || true)"
fi
SERVER="${SERVER:-127.0.0.1:19133}"

# Если передан только адрес — это Фаза 2 (VPS), где BDS слушает штатный 19132.
case "$SERVER" in
  *:*) ;;
  *) SERVER="${SERVER}:19132" ;;
esac

if [ ! -x "$PHANTOM_BIN" ]; then
  echo "Бинарник Phantom не найден: $PHANTOM_BIN" >&2
  echo "Установите его: ./tools/phantom.sh --install" >&2
  exit 1
fi

echo "Phantom → ${SERVER}"
echo "Откройте на PlayStation: Играть → Друзья → Игры по локальной сети."
echo "Остановка: Ctrl+C"
exec "$PHANTOM_BIN" -server "$SERVER"
