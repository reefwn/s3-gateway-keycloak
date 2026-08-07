#!/usr/bin/env sh
set -eu

image_name="s3-browser-production-verify:local"

docker build --target production --tag "$image_name" .
docker image inspect "$image_name" --format '{{.Config.User}} {{json .Config.Cmd}} {{json .Config.ExposedPorts}}' \
  | grep -F 'app' \
  | grep -F 'server.js' \
  | grep -F '3000/tcp'
docker run --rm --entrypoint sh "$image_name" -c 'test -f /app/server.js && test -f /app/db/migrations/meta/_journal.json && test -x /usr/local/bin/bun'
