#!/bin/sh
set -e
case "$1" in
  web)     cd /app/web/apps/web && exec node server.js ;;
  worker)  exec node /app/worker/dist/index.js ;;
  migrate) exec node /app/db/dist/migrate.js ;;
  *)       exec "$@" ;;
esac
