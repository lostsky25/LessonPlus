-- ПРОЕКТ шага 6.3. Не выполнять на рабочей базе. Не Prisma-миграция.
-- Схема subscriptions. outbox_events и processed_events уже существуют.

CREATE TABLE subscriptions.students (
    id uuid PRIMARY KEY,
    display_name text NOT NULL,
    parent_name text,
    parent_email text,
    parent_phone text,
    created_at timestamptz(6) NOT NULL
);

CREATE TABLE subscriptions.tariffs (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    lesson_count integer NOT NULL CHECK (lesson_count >= 1),
    validity_days integer NOT NULL CHECK (validity_days >= 1),
    transfer_limit integer NOT NULL CHECK (transfer_limit >= 0),
    notice_period_hours integer NOT NULL CHECK (notice_period_hours >= 0),
    created_at timestamptz(6) NOT NULL
);

CREATE TABLE subscriptions.subscriptions (
    id uuid PRIMARY KEY,
    student_id uuid NOT NULL REFERENCES subscriptions.students (id),
    tariff_id uuid NOT NULL REFERENCES subscriptions.tariffs (id),
    status text NOT NULL CHECK (status IN ('active', 'expired')),
    activated_at timestamptz(6) NOT NULL,
    expires_at timestamptz(6) NOT NULL,
    CHECK (expires_at > activated_at),
    UNIQUE (id, student_id)
);

CREATE TABLE subscriptions.lesson_rights (
    id uuid PRIMARY KEY,
    subscription_id uuid NOT NULL,
    student_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('available', 'reserved', 'bound', 'consumed')),
    booking_id uuid,
    transfer_id uuid,
    created_at timestamptz(6) NOT NULL,
    FOREIGN KEY (subscription_id, student_id)
        REFERENCES subscriptions.subscriptions (id, student_id),
    CHECK (
        (status = 'available' AND booking_id IS NULL AND transfer_id IS NULL)
        OR (status = 'reserved' AND booking_id IS NULL AND transfer_id IS NOT NULL)
        OR (status = 'bound' AND booking_id IS NOT NULL AND transfer_id IS NULL)
        OR (status = 'consumed' AND booking_id IS NULL AND transfer_id IS NULL)
    )
);

CREATE UNIQUE INDEX lesson_rights_one_active_binding
    ON subscriptions.lesson_rights (booking_id)
    WHERE status = 'bound';

CREATE UNIQUE INDEX lesson_rights_one_active_transfer
    ON subscriptions.lesson_rights (transfer_id)
    WHERE status = 'reserved';

CREATE TABLE subscriptions.right_reservations (
    id uuid PRIMARY KEY,
    right_id uuid NOT NULL REFERENCES subscriptions.lesson_rights (id),
    transfer_id uuid NOT NULL,
    source_booking_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'released')),
    close_reason text CHECK (
        close_reason IS NULL OR close_reason IN ('compensated', 'converted')
    ),
    created_at timestamptz(6) NOT NULL,
    released_at timestamptz(6),
    CHECK (
        (status = 'active' AND released_at IS NULL AND close_reason IS NULL)
        OR (
            status = 'released'
            AND released_at IS NOT NULL
            AND close_reason IS NOT NULL
            AND close_reason IN ('compensated', 'converted')
        )
    )
);

CREATE UNIQUE INDEX right_reservations_one_active_per_right
    ON subscriptions.right_reservations (right_id)
    WHERE status = 'active';

CREATE TABLE subscriptions.right_operations (
    id uuid PRIMARY KEY,
    right_id uuid NOT NULL REFERENCES subscriptions.lesson_rights (id),
    kind text NOT NULL CHECK (
        kind IN ('created', 'reserved', 'released', 'rebound', 'consumed', 'restored', 'unbound')
    ),
    from_status text,
    to_status text NOT NULL,
    booking_id uuid,
    lesson_id uuid,
    registration_id uuid,
    transfer_id uuid,
    reservation_id uuid REFERENCES subscriptions.right_reservations (id),
    consumed_operation_id uuid REFERENCES subscriptions.right_operations (id),
    attendance_correction_id uuid,
    event_id uuid,
    occurred_at timestamptz(6) NOT NULL,
    CHECK (
        (
            kind = 'consumed'
            AND booking_id IS NOT NULL
            AND lesson_id IS NOT NULL
            AND registration_id IS NOT NULL
            AND consumed_operation_id IS NULL
            AND attendance_correction_id IS NULL
        )
        OR (
            kind = 'restored'
            AND booking_id IS NOT NULL
            AND lesson_id IS NOT NULL
            AND registration_id IS NOT NULL
            AND consumed_operation_id IS NOT NULL
            AND attendance_correction_id IS NOT NULL
        )
        OR (
            kind NOT IN ('consumed', 'restored')
            AND consumed_operation_id IS NULL
            AND attendance_correction_id IS NULL
        )
    )
);

CREATE UNIQUE INDEX right_operations_consume_once
    ON subscriptions.right_operations (right_id, booking_id)
    WHERE kind = 'consumed';

CREATE UNIQUE INDEX right_operations_restore_once_per_consume
    ON subscriptions.right_operations (consumed_operation_id)
    WHERE kind = 'restored';

CREATE TABLE subscriptions.http_idempotency_keys (
    id uuid PRIMARY KEY,
    actor_kind text NOT NULL,
    actor_id text NOT NULL,
    method text NOT NULL,
    path_template text NOT NULL,
    idempotency_key text NOT NULL,
    fingerprint text NOT NULL,
    status_code integer NOT NULL,
    response_body jsonb NOT NULL,
    created_at timestamptz(6) NOT NULL,
    UNIQUE (actor_kind, actor_id, method, path_template, idempotency_key)
);
