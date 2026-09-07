#!/usr/bin/env bash
#
# Первичная настройка дроплета DigitalOcean под сервер Minecraft Bedrock.
#
# Целевая конфигурация: Basic / Premium AMD, 1 vCPU, 2 GiB RAM, 50 GiB NVMe,
# Ubuntu 24.04 LTS, регион Frankfurt.
#
# Запуск на дроплете от root:
#   curl -fsSL <raw-url>/deploy/bootstrap-vps.sh | bash -s -- <github-user>/<repo>
# либо после клонирования репозитория:
#   sudo ./deploy/bootstrap-vps.sh
#
# Скрипт идемпотентен: повторный запуск ничего не ломает.

set -euo pipefail

REPO="${1:-}"
DEPLOY_USER="${DEPLOY_USER:-mcdeploy}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/mc-server}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите с правами root: sudo $0" >&2
  exit 1
fi

echo "==> Обновление системы"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y
apt-get install -y ca-certificates curl git gnupg rsync ufw

echo "==> Установка Docker Engine + compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

echo "==> Пользователь деплоя: ${DEPLOY_USER}"
if ! id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
usermod -aG docker "$DEPLOY_USER"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 "/home/${DEPLOY_USER}/.ssh"
touch "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh/authorized_keys"
chmod 600 "/home/${DEPLOY_USER}/.ssh/authorized_keys"

echo "==> Каталог развёртывания: ${DEPLOY_PATH}"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_PATH"
if [ -n "$REPO" ] && [ ! -d "${DEPLOY_PATH}/.git" ]; then
  sudo -u "$DEPLOY_USER" git clone "https://github.com/${REPO}.git" "$DEPLOY_PATH"
fi
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "${DEPLOY_PATH}/server-data" "${DEPLOY_PATH}/addon/scripts"

echo "==> Файрвол (UFW): SSH TCP/22 и Minecraft UDP/19132"
ufw allow 22/tcp
ufw allow 19132/udp
ufw allow 19133/udp
ufw --force enable

echo "==> Swap 2 ГиБ (страховка для 2 GiB RAM)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

cat <<EOM

==> Готово.

Дальнейшие шаги:
  1. Добавьте публичный SSH-ключ деплоя в
     /home/${DEPLOY_USER}/.ssh/authorized_keys
  2. Создайте ${DEPLOY_PATH}/.env на основе .env.example
     (обязательно укажите OPS со своим Xbox-геймертегом).
  3. Поднимите сервер:
     sudo -u ${DEPLOY_USER} sh -c 'cd ${DEPLOY_PATH} && docker compose up -d'
  4. Активируйте behavior pack:
     sudo -u ${DEPLOY_USER} sh -c 'cd ${DEPLOY_PATH} && node tools/activate-pack.mjs'
     (после первого запуска, когда мир уже создан) и перезапустите: docker restart bds
  5. Продублируйте правила в Cloud Firewall DigitalOcean:
     входящий UDP 19132 из 0.0.0.0/0 и TCP 22 со своего IP.

Секреты для GitHub Actions (Settings → Secrets and variables → Actions):
  DEPLOY_HOST=<IP дроплета>   DEPLOY_USER=${DEPLOY_USER}
  DEPLOY_PATH=${DEPLOY_PATH}  DEPLOY_SSH_KEY=<приватный ключ>
EOM
