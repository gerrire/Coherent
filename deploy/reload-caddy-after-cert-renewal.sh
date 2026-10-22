#!/bin/sh
set -eu

# Caddy reloads the configured certificate files when it receives USR1.
/usr/bin/docker kill --signal=USR1 coherent-web-1 >/dev/null
# LiveKit reads the TURN/TLS certificate at startup.
/usr/bin/docker restart coherent-livekit-1 >/dev/null
