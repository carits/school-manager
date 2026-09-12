#!/bin/bash
set -euo pipefail
umask 077
root=/opt/student-check
mkdir -p "$root/backups" "$root/bin"
available=$(df -Pk / | awk 'NR==2{print $4}')
if [ "$available" -lt 4194304 ]; then echo 'Less than 4 GiB free; refusing deployment.'; exit 1; fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$root/backups/preflight-$stamp"
mkdir -p "$backup"
tar -czf "$backup/nginx.tar.gz" /etc/nginx 2>/dev/null
tar -tzf "$backup/nginx.tar.gz" >/dev/null
docker exec oi-postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup/oj.dump"
test -s "$backup/oj.dump"
docker exec -i oi-postgres sh -c 'pg_restore --list' < "$backup/oj.dump" > "$backup/oj-manifest.txt"
test -s "$backup/oj-manifest.txt"
sha256sum "$backup/oj.dump" "$backup/nginx.tar.gz" > "$backup/SHA256SUMS"
sha256sum -c "$backup/SHA256SUMS"
echo "Preflight backup verified: $backup"
