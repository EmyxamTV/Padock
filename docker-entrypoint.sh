#!/bin/sh
set -eu

prepare_directory() {
  directory="$1"
  if [ -n "$directory" ]; then
    mkdir -p "$directory"
    chown -R node:node "$directory"
  fi
}

prepare_directory "${PADOCK_DATA_DIR:-${PANELMC_DATA_DIR:-}}"
prepare_directory "${PADOCK_SERVERS_DIR:-${PANELMC_SERVERS_DIR:-}}"
prepare_directory "${PADOCK_BACKUPS_DIR:-${PANELMC_BACKUPS_DIR:-}}"
prepare_directory "${PADOCK_GATEWAY_DIR:-${PANELMC_GATEWAY_DIR:-}}"

if [ "${1:-}" = "node" ] && [ "${2:-}" = "build/agent/index.js" ]; then
  # L'agent a besoin de l'accès au socket Docker. Selon l'hôte (notamment
  # Docker Desktop), ce socket peut être root:root sans groupe partageable.
  exec "$@"
fi

exec su-exec node "$@"
