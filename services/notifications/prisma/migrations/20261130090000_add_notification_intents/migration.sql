CREATE TABLE "notifications"."notifications" (
    "id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL CHECK ("subject_type" IN ('subscription', 'lesson', 'booking', 'attendance', 'transfer')),
    "subject_id" UUID NOT NULL,
    "source_event_id" UUID NOT NULL,
    "status" TEXT NOT NULL CHECK ("status" IN ('pending', 'delivered', 'failed')),
    "channel" TEXT NOT NULL CHECK ("channel" = 'imitation'),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "next_attempt_no" INTEGER NOT NULL DEFAULT 1 CHECK ("next_attempt_no" >= 1),
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notifications_source_event_id_student_id_channel_key"
    ON "notifications"."notifications" ("source_event_id", "student_id", "channel");
