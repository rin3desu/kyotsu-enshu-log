ALTER TABLE students ADD COLUMN password_attempts INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE students ADD COLUMN password_window INTEGER NOT NULL DEFAULT 0;
