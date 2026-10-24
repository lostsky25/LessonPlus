-- ПРОЕКТ шага 6.3. Не выполнять на рабочей базе. Не Prisma-миграция.
-- Схема attendance. booking_id, student_id, lesson_id, right_id — логические ссылки.

CREATE TABLE attendance.attendance_registrations (
    id uuid PRIMARY KEY,
    booking_id uuid NOT NULL,
    student_id uuid NOT NULL,
    lesson_id uuid NOT NULL,
    right_id uuid NOT NULL,
    mark text NOT NULL CHECK (mark IN ('presence', 'absence')),
    status text NOT NULL CHECK (
        status IN ('accepted', 'pending', 'recorded', 'absent', 'rejected')
    ),
    right_effect text NOT NULL CHECK (
        right_effect IN ('none', 'consume_pending', 'consumed', 'unspecified')
    ),
    attendance_id uuid,
    failure_reason text,
    created_at timestamptz(6) NOT NULL,
    UNIQUE (id, booking_id, student_id, lesson_id, right_id)
);

CREATE TABLE attendance.attendances (
    id uuid PRIMARY KEY,
    registration_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    student_id uuid NOT NULL,
    lesson_id uuid NOT NULL,
    right_id uuid NOT NULL,
    mark text NOT NULL CHECK (mark IN ('presence', 'absence')),
    status text NOT NULL CHECK (status IN ('recorded', 'absent', 'correction_pending')),
    right_effect text NOT NULL CHECK (
        right_effect IN ('none', 'consume_pending', 'consumed', 'unspecified')
    ),
    UNIQUE (booking_id),
    UNIQUE (registration_id),
    UNIQUE (id, registration_id),
    FOREIGN KEY (registration_id, booking_id, student_id, lesson_id, right_id)
        REFERENCES attendance.attendance_registrations (id, booking_id, student_id, lesson_id, right_id)
);

ALTER TABLE attendance.attendance_registrations
    ADD CONSTRAINT attendance_registrations_attendance_fk
    FOREIGN KEY (attendance_id) REFERENCES attendance.attendances (id);

CREATE TABLE attendance.attendance_corrections (
    id uuid PRIMARY KEY,
    attendance_id uuid NOT NULL,
    source_registration_id uuid NOT NULL,
    consumed_registration_id uuid,
    requested_mark text NOT NULL CHECK (requested_mark IN ('presence', 'absence')),
    reason text NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted', 'in_progress', 'completed', 'rejected')),
    mark_effect text NOT NULL CHECK (mark_effect IN ('pending', 'applied')),
    right_effect text NOT NULL CHECK (
        right_effect IN ('pending', 'none', 'consume_pending', 'consumed', 'unspecified')
    ),
    previous_mark text CHECK (previous_mark IS NULL OR previous_mark IN ('presence', 'absence')),
    new_mark text CHECK (new_mark IS NULL OR new_mark IN ('presence', 'absence')),
    previous_right_effect text CHECK (
        previous_right_effect IS NULL
        OR previous_right_effect IN ('none', 'consume_pending', 'consumed', 'unspecified')
    ),
    new_right_effect text CHECK (
        new_right_effect IS NULL
        OR new_right_effect IN ('none', 'consume_pending', 'consumed', 'unspecified')
    ),
    applied_at timestamptz(6),
    failure_reason text,
    created_at timestamptz(6) NOT NULL,
    FOREIGN KEY (attendance_id, source_registration_id)
        REFERENCES attendance.attendances (id, registration_id),
    CHECK ((status = 'rejected') = (failure_reason IS NOT NULL)),
    CHECK (
        (status IN ('accepted', 'in_progress') AND mark_effect = 'pending' AND applied_at IS NULL
            AND previous_mark IS NULL AND new_mark IS NULL
            AND previous_right_effect IS NULL AND new_right_effect IS NULL)
        OR (status = 'rejected' AND mark_effect = 'pending' AND applied_at IS NULL
            AND previous_mark IS NULL AND new_mark IS NULL
            AND previous_right_effect IS NULL AND new_right_effect IS NULL)
        OR (
            status = 'completed'
            AND mark_effect = 'applied'
            AND applied_at IS NOT NULL
            AND previous_mark IS NOT NULL
            AND new_mark IS NOT NULL
            AND previous_right_effect IS NOT NULL
            AND new_right_effect IS NOT NULL
            AND right_effect IN ('none', 'consumed', 'unspecified')
        )
    )
);

CREATE UNIQUE INDEX attendance_corrections_one_inflight
    ON attendance.attendance_corrections (attendance_id)
    WHERE status IN ('accepted', 'in_progress');

CREATE TABLE attendance.http_idempotency_keys (
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
