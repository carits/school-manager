#!/bin/bash
set -euo pipefail
umask 077
root=/opt/student-check
cd "$root"
exec 9>"$root/backups/.backup.lock"
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$root/backups/daily-$stamp"
mkdir -p "$backup"
bin/docker-compose exec -T db pg_dump -U student_check -d student_check -Fc > "$backup/database.dump"
bin/docker-compose exec -T db pg_restore --list < "$backup/database.dump" > "$backup/manifest.txt"
cp .env "$backup/environment.env"
cp compose.yml "$backup/compose.yml"
sha256sum "$backup/database.dump" "$backup/environment.env" > "$backup/SHA256SUMS"
sha256sum -c "$backup/SHA256SUMS"
bin/docker-compose exec -T web python manage.py maintenance
# Only rotate known daily backup directories under the fixed application backup root.
find "$root/backups" -mindepth 1 -maxdepth 1 -type d -name 'daily-*' -mtime +6 -exec rm -rf -- {} +
echo "Backup completed: $backup"
