#!/bin/bash
set -euo pipefail
cd /opt/student-check
dump=${1:?Provide a backup database.dump path}
test -s "$dump"
db=student_check_restore_drill
if bin/docker-compose exec -T db psql -U student_check -d postgres -Atc "SELECT datname FROM pg_database WHERE datname='$db'" | grep -q "$db"; then
  echo 'Restore drill database already exists; refusing to overwrite.'; exit 1
fi
bin/docker-compose exec -T db createdb -U student_check "$db"
trap 'bin/docker-compose exec -T db dropdb -U student_check student_check_restore_drill' EXIT
bin/docker-compose exec -T db pg_restore --exit-on-error --no-owner -U student_check -d "$db" < "$dump"
bin/docker-compose exec -T -e DB_NAME="$db" web python manage.py shell -c 'from checks.models import Student; assert Student.objects.exists(); assert all(s.original.get("B") for s in Student.objects.all()); print("Restore and decryption verified; students:",Student.objects.count())'
