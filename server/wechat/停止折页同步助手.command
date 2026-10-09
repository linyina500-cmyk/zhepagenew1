#!/bin/sh
set -u
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
exec "$SCRIPT_DIR/折页同步助手.command" stop
