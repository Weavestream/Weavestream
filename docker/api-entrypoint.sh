#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# API container entrypoint.
#
# Mirrors `worker-entrypoint.sh`: ensures bind-mounted host
# directories are writable by the unprivileged `app` user, then
# drops privileges and execs the real command. The api only writes
# to ${FILE_STORAGE_DIR}; ${BACKUP_STORAGE_DIR} is mounted read-only
# (downloads only — the worker is the sole writer) so we deliberately
# do NOT touch its ownership here.
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

exec /sbin/tini -- su-exec app "$@"
