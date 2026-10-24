-- ПРОЕКТ шага 6.3. Не выполнять на рабочей базе. Не Prisma-миграция.
-- Схема transfers. Ссылки на право, записи, занятия и резервы — логические.
-- http_idempotency_keys — только входящий POST /v1/transfers владельца endpoint.
-- Исходящие reserve/rebind/confirm/release — не строки этого журнала; см. transfer_outbound_steps.

CREATE TABLE transfers.transfer_rules (
    id uuid PRIMARY KEY,
    school_cancel_spends_user_limit boolean NOT NULL DEFAULT false
        CHECK (NOT school_cancel_spends_user_limit),
    notice_period_hours integer NOT NULL CHECK (notice_period_hours >= 0),
    created_at timestamptz(6) NOT NULL
);

CREATE TABLE transfers.transfers (
    id uuid PRIMARY KEY,
    rule_id uuid NOT NULL REFERENCES transfers.transfer_rules (id),
    student_id uuid NOT NULL,
    right_id uuid NOT NULL,
    source_booking_id uuid NOT NULL,
    target_lesson_id uuid NOT NULL,
    target_booking_id uuid,
    right_reservation_id uuid,
    seat_reservation_id uuid,
    binding_knowledge text NOT NULL DEFAULT 'unattempted'
        CHECK (binding_knowledge IN ('unattempted', 'outcome_unknown', 'committed', 'owner_rejected')),
    binding_committed_at timestamptz(6),
    current_step text NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted', 'in_progress', 'completed', 'rejected')),
    rejection_reason text,
    created_at timestamptz(6) NOT NULL,
    CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL)),
    CHECK (status <> 'rejected' OR binding_knowledge IN ('unattempted', 'owner_rejected')),
    CHECK (
        (status <> 'completed')
        OR (
            binding_knowledge = 'committed'
            AND target_booking_id IS NOT NULL
        )
    ),
    CHECK (
        (binding_knowledge = 'committed' AND binding_committed_at IS NOT NULL)
        OR (binding_knowledge <> 'committed' AND binding_committed_at IS NULL)
    )
);

CREATE TABLE transfers.transfer_outbound_steps (
    id uuid PRIMARY KEY,
    transfer_id uuid NOT NULL REFERENCES transfers.transfers (id),
    step text NOT NULL CHECK (
        step IN (
            'right_reserve',
            'seat_reserve',
            'rebind',
            'confirm_target',
            'release_source',
            'compensate_seat',
            'compensate_right'
        )
    ),
    owner_service text NOT NULL CHECK (owner_service IN ('subscriptions', 'schedule')),
    actor_kind text NOT NULL CHECK (actor_kind = 'service'),
    actor_id text NOT NULL CHECK (actor_id = 'transfers'),
    method text NOT NULL,
    path_template text NOT NULL,
    path_params jsonb NOT NULL,
    request_body jsonb NOT NULL,
    idempotency_key text NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamptz(6) NOT NULL,
    UNIQUE (transfer_id, step),
    UNIQUE (transfer_id, idempotency_key)
);

CREATE TABLE transfers.transfer_outbound_attempts (
    id uuid PRIMARY KEY,
    step_id uuid NOT NULL REFERENCES transfers.transfer_outbound_steps (id),
    attempt_no integer NOT NULL CHECK (attempt_no >= 1),
    outcome text NOT NULL CHECK (
        outcome IN ('not_sent', 'in_flight', 'succeeded', 'owner_rejected', 'transport_unknown')
    ),
    response_status integer,
    response_body jsonb,
    created_at timestamptz(6) NOT NULL,
    UNIQUE (step_id, attempt_no)
);

CREATE TABLE transfers.http_idempotency_keys (
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
