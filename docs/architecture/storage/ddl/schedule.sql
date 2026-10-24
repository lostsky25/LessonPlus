-- ПРОЕКТ шага 6.3. Не выполнять на рабочей базе. Не Prisma-миграция.
-- Схема schedule. outbox_events и processed_events уже существуют.
-- student_id, right_id, transfer_id — логические, кроме составного UNIQUE для локальной сверки hold.

CREATE TABLE schedule.teachers (
    id uuid PRIMARY KEY,
    display_name text NOT NULL,
    created_at timestamptz(6) NOT NULL
);

CREATE TABLE schedule.groups (
    id uuid PRIMARY KEY,
    teacher_id uuid NOT NULL REFERENCES schedule.teachers (id),
    name text NOT NULL,
    created_at timestamptz(6) NOT NULL
);

CREATE TABLE schedule.lessons (
    id uuid PRIMARY KEY,
    group_id uuid NOT NULL REFERENCES schedule.groups (id),
    teacher_id uuid NOT NULL REFERENCES schedule.teachers (id),
    starts_at timestamptz(6) NOT NULL,
    ends_at timestamptz(6) NOT NULL,
    capacity integer NOT NULL CHECK (capacity >= 1),
    confirmed_booking_count integer NOT NULL DEFAULT 0 CHECK (confirmed_booking_count >= 0),
    active_reserve_count integer NOT NULL DEFAULT 0 CHECK (active_reserve_count >= 0),
    status text NOT NULL CHECK (status IN ('scheduled', 'canceled_by_school')),
    CHECK (ends_at > starts_at),
    CHECK (confirmed_booking_count + active_reserve_count <= capacity)
);

CREATE TABLE schedule.bookings (
    id uuid PRIMARY KEY,
    lesson_id uuid NOT NULL REFERENCES schedule.lessons (id),
    student_id uuid NOT NULL,
    right_id uuid NOT NULL,
    transfer_id uuid,
    seat_status text NOT NULL CHECK (seat_status IN ('pending', 'confirmed', 'canceled', 'rejected')),
    hold_kind text NOT NULL CHECK (
        hold_kind IN ('none', 'ordinary_pending', 'covered_by_seat_reservation')
    ),
    created_at timestamptz(6) NOT NULL,
    UNIQUE (id, lesson_id, student_id, right_id),
    CHECK (
        (hold_kind = 'ordinary_pending' AND seat_status = 'pending' AND transfer_id IS NULL)
        OR (hold_kind = 'covered_by_seat_reservation' AND seat_status = 'pending' AND transfer_id IS NOT NULL)
        OR (hold_kind = 'none')
    )
);

CREATE TABLE schedule.seat_reservations (
    id uuid PRIMARY KEY,
    lesson_id uuid NOT NULL REFERENCES schedule.lessons (id),
    transfer_id uuid NOT NULL,
    student_id uuid NOT NULL,
    right_id uuid NOT NULL,
    target_booking_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('active', 'released')),
    expires_at timestamptz(6) NOT NULL,
    -- Авто-TTL не освобождает место: только будит recovery (см. 05-transactions).
    ttl_action text NOT NULL DEFAULT 'wake_recovery'
        CHECK (ttl_action = 'wake_recovery'),
    binding_protected boolean NOT NULL DEFAULT false,
    created_at timestamptz(6) NOT NULL,
    released_at timestamptz(6),
    FOREIGN KEY (target_booking_id, lesson_id, student_id, right_id)
        REFERENCES schedule.bookings (id, lesson_id, student_id, right_id),
    CHECK (
        (status = 'active' AND released_at IS NULL)
        OR (status = 'released' AND released_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX seat_reservations_one_active_per_transfer
    ON schedule.seat_reservations (transfer_id)
    WHERE status = 'active';

CREATE UNIQUE INDEX seat_reservations_one_active_per_booking
    ON schedule.seat_reservations (target_booking_id)
    WHERE status = 'active';

-- Проекция LessonRightReleased: processed_events не ищет по transferId.
-- Заполняется атомарно с processed_events; условие безопасного seat release (05 §4.3).
CREATE TABLE schedule.compensated_right_releases (
    event_id uuid PRIMARY KEY,
    transfer_id uuid NOT NULL,
    right_id uuid NOT NULL,
    student_id uuid NOT NULL,
    right_reservation_id uuid NOT NULL,
    source_booking_id uuid NOT NULL,
    processed_at timestamptz(6) NOT NULL,
    UNIQUE (transfer_id),
    UNIQUE (right_reservation_id)
);

CREATE TABLE schedule.school_cancellations (
    id uuid PRIMARY KEY,
    lesson_id uuid NOT NULL REFERENCES schedule.lessons (id),
    status text NOT NULL CHECK (status IN ('accepted', 'in_progress', 'completed', 'rejected')),
    lesson_effect text NOT NULL CHECK (lesson_effect IN ('pending', 'canceled')),
    right_effect text NOT NULL CHECK (right_effect IN ('pending', 'preserved')),
    transfer_limit_effect text NOT NULL CHECK (transfer_limit_effect IN ('pending', 'not_spent')),
    failure_reason text,
    created_at timestamptz(6) NOT NULL,
    CHECK (
        (status <> 'completed')
        OR (
            lesson_effect = 'canceled'
            AND right_effect = 'preserved'
            AND transfer_limit_effect = 'not_spent'
        )
    ),
    CHECK ((status = 'rejected') = (failure_reason IS NOT NULL))
);

CREATE TABLE schedule.booking_cancellations (
    id uuid PRIMARY KEY,
    booking_id uuid NOT NULL REFERENCES schedule.bookings (id),
    status text NOT NULL CHECK (status IN ('accepted', 'in_progress', 'completed', 'rejected')),
    seat_effect text NOT NULL CHECK (seat_effect IN ('pending', 'canceled')),
    right_binding_effect text NOT NULL CHECK (
        right_binding_effect IN ('pending', 'released', 'not_applicable')
    ),
    failure_reason text,
    created_at timestamptz(6) NOT NULL,
    CHECK (
        (status <> 'completed')
        OR (
            seat_effect = 'canceled'
            AND right_binding_effect IN ('released', 'not_applicable')
        )
    ),
    CHECK ((status = 'rejected') = (failure_reason IS NOT NULL))
);

CREATE TABLE schedule.http_idempotency_keys (
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
