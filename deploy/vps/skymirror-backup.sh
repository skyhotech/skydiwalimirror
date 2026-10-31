#!/usr/bin/env bash
# Installed as /usr/local/sbin/skymirror-backup. Nightly MySQL dump plus the
# uploaded media, kept for 7 days in /var/backups/skymirror (root only).
# These copies live on this server only; download them for off-site safety.
set -euo pipefail
umask 077
DIR=/var/backups/skymirror
STAMP=$(date +%Y%m%d-%H%M%S)
mysqldump --single-transaction --quick --routines --no-tablespaces skymirror | gzip > "$DIR/db-$STAMP.sql.gz"
tar -C /var/lib/skymirror -czf "$DIR/media-$STAMP.tar.gz" media
find "$DIR" -name 'db-*.sql.gz' -mtime +7 -delete
find "$DIR" -name 'media-*.tar.gz' -mtime +7 -delete
echo "backup ok: $(du -sh "$DIR" | cut -f1) in $DIR"
