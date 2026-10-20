#!/bin/sh
set -eu

# Caddy reloads the configured certificate files when it receives USR1.
/usr/bin/docker kill --signal=USR1 coherent-web-1 >/dev/null
