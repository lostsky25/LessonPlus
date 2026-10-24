-- ПРОЕКТ шага 6.3. Не выполнять на рабочей базе. Не Prisma-миграция.
-- Схема notifications. student_id и subject_id — логические ссылки.
-- Один факт может породить несколько поручений (разные student_id).

CREATE TABLE notifications.notifications (
    id uuid PRIMARY KEY,
    student_id uuid NOT NULL,
    subject_type text NOT NULL CHECK (
        subject_type IN ('subscription', 'lesson', 'booking', 'attendance', 'transfer')
    ),
    subject_id uuid NOT NULL,
    source_event_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
    channel text NOT NULL CHECK (channel = 'imitation'),
    recorded_at timestamptz(6) NOT NULL,
    next_attempt_no integer NOT NULL DEFAULT 1 CHECK (next_attempt_no >= 1),
    UNIQUE (source_event_id, student_id, channel)
);

CREATE TABLE notifications.notification_delivery_attempts (
    id uuid PRIMARY KEY,
    notification_id uuid NOT NULL REFERENCES notifications.notifications (id),
    attempt_no integer NOT NULL CHECK (attempt_no >= 1),
    result text NOT NULL CHECK (result IN ('delivered', 'failed')),
    recorded_at timestamptz(6) NOT NULL,
    UNIQUE (notification_id, attempt_no)
);
