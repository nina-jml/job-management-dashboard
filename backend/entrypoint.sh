#!/usr/bin/env bash
#
# Wait for Postgres, apply migrations, then hand off to the CMD.
#
# Compose's `depends_on: service_healthy` already gates startup, but a container
# restart can outrace the DB. Migrating here (rather than in a separate one-shot
# service) keeps `make up` a single command and keeps the schema in lockstep with
# the image that is about to serve it.

set -euo pipefail

echo "[entrypoint] waiting for postgres at ${POSTGRES_HOST}:${POSTGRES_PORT}…"
until python -c "
import os, sys, psycopg
try:
    psycopg.connect(
        dbname=os.environ['POSTGRES_DB'],
        user=os.environ['POSTGRES_USER'],
        password=os.environ['POSTGRES_PASSWORD'],
        host=os.environ['POSTGRES_HOST'],
        port=os.environ['POSTGRES_PORT'],
        connect_timeout=2,
    ).close()
except Exception as exc:
    print(exc, file=sys.stderr)
    sys.exit(1)
" 2>/dev/null; do
  sleep 1
done
echo "[entrypoint] postgres is up"

python manage.py migrate --noinput
echo "[entrypoint] migrations applied"

exec "$@"
