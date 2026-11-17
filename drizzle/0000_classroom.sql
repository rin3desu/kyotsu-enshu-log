CREATE TABLE students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  password_digest TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE sessions (
  token_digest TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE attempts (
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  record_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (student_id, record_id)
);
--> statement-breakpoint
CREATE TABLE teacher_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX teacher_comments_student ON teacher_comments(student_id, id);
