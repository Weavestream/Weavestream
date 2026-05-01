#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Worker container entrypoint.
#
# Bind-mounted host directories (`${FILE_STORAGE_DIR}` and
# `${BACKUP_STORAGE_DIR}`) take their ownership from whoever first
# created them on the host — usually `root:root` when the Docker
# daemon auto-creates them, or the host user's UID:GID if `mkdir`
# was run manually. Either way, the unprivileged `app` user we drop
# to inside the container won't be able to write there without an
# explicit chown. We do that fix-up exactly once on boot, then `exec`
# the real worker process under the `app` user.
#
# This is intentionally idempotent: directories that are already owned
# by `app` are left untouched, so an operator who has chosen to chown
# the host directory to a specific UID:GID up front isn't fought by
# the container on every restart.
set -eu

ensure_writable() {
  dir="$1"
  if [ -z "$dir" ]; then
    return 0
  fi
  mkdir -p "$dir"
  if ! su-exec app sh -c "test -w \"$dir\""; then
    chown -R app:app "$dir"
  fi
}

ensure_writable "${FILE_STORAGE_DIR:-/var/lib/weavestream/files}"
ensure_writable "${BACKUP_STORAGE_DIR:-/var/lib/weavestream/backup}"

exec /sbin/tini -- su-exec app "$@"
