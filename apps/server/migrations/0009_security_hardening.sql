ALTER TABLE users
  ADD COLUMN IF NOT EXISTS singleton_key integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF (SELECT count(*) FROM users) > 1 THEN
    RAISE EXCEPTION 'Security migration requires at most one administrator row; found %',
      (SELECT count(*) FROM users);
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS users_singleton_key_unique
  ON users(singleton_key);

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_singleton_key_check;

ALTER TABLE users
  ADD CONSTRAINT users_singleton_key_check CHECK (singleton_key = 1);
