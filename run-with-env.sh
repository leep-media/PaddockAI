#!/bin/zsh
set -a
source .env.local
set +a
exec node server.js
