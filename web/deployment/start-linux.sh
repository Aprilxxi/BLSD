#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")/.."
node deployment/check-environment.mjs
exec node server/index.mjs
