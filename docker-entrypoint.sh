#!/bin/sh
# ZimaOS crea las carpetas de /DATA/AppData como root: ajustamos permisos
# de /data y ejecutamos el servidor como usuario sin privilegios.
set -e
if [ "$(id -u)" = "0" ]; then
  PUID="${PUID:-1000}"
  PGID="${PGID:-1000}"
  mkdir -p "$DATA_DIR"
  chown -R "$PUID:$PGID" "$DATA_DIR"
  exec su-exec "$PUID:$PGID" "$@"
fi
exec "$@"
