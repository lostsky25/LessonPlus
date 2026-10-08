#!/bin/sh
set -eu

: "${POSTGRES_USER:?}"
: "${POSTGRES_DB:?}"
: "${SUBSCRIPTIONS_DB_PASSWORD:?}"
: "${SCHEDULE_DB_PASSWORD:?}"
: "${ATTENDANCE_DB_PASSWORD:?}"
: "${TRANSFERS_DB_PASSWORD:?}"
: "${NOTIFICATIONS_DB_PASSWORD:?}"

create_service() {
  role="$1"
  password="$2"
  schema="$3"

  case "$password" in
    *\'*)
      echo "Пароль роли ${role} содержит одинарную кавычку" >&2
      exit 1
      ;;
  esac

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE ${role} LOGIN PASSWORD '${password}';
CREATE SCHEMA ${schema} AUTHORIZATION ${role};
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO ${role};
ALTER ROLE ${role} SET search_path TO ${schema};
SQL
}

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
REVOKE ALL ON DATABASE "${POSTGRES_DB}" FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL

create_service subscriptions_user "$SUBSCRIPTIONS_DB_PASSWORD" subscriptions
create_service schedule_user "$SCHEDULE_DB_PASSWORD" schedule
create_service attendance_user "$ATTENDANCE_DB_PASSWORD" attendance
create_service transfers_user "$TRANSFERS_DB_PASSWORD" transfers
create_service notifications_user "$NOTIFICATIONS_DB_PASSWORD" notifications
