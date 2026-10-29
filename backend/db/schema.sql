-- NFPL Access Control Service schema. Idempotent; runs inside the schema set by search_path.

CREATE TABLE IF NOT EXISTS branches (
  id   SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  user_type     TEXT NOT NULL DEFAULT 'staff' CHECK (user_type IN ('staff','client','service')),
  client_id     INT REFERENCES clients(id),            -- set only for client-side users
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((user_type = 'client') = (client_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));

-- Roles are DATA: a new role next quarter is an INSERT, not a deploy.
-- grantable_roles = roles a holder of grants.manage may hand out (anti-escalation ceiling).
CREATE TABLE IF NOT EXISTS roles (
  name            TEXT PRIMARY KEY,
  description     TEXT,
  permissions     TEXT[] NOT NULL DEFAULT '{}',
  grantable_roles TEXT[] NOT NULL DEFAULT '{}'
);

-- NULL scope column = "all". One row models any slice (client x branch x direction x mode).
CREATE TABLE IF NOT EXISTS grants (
  id         SERIAL PRIMARY KEY,
  user_id    INT  NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL REFERENCES roles(name),
  client_id  INT  REFERENCES clients(id),
  branch_id  INT  REFERENCES branches(id),
  direction  TEXT CHECK (direction IN ('import','export')),
  mode       TEXT CHECK (mode IN ('air','fcl','lcl')),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to   TIMESTAMPTZ,
  created_by INT REFERENCES users(id),                  -- NULL only for the bootstrap admin grant
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  revoked_by INT REFERENCES users(id),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (created_by IS NULL OR created_by <> user_id)   -- DB-level backstop: no self-grants
);
CREATE INDEX IF NOT EXISTS grants_user_active ON grants (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS grants_user_all    ON grants (user_id, valid_from);

CREATE TABLE IF NOT EXISTS delegations (
  id              SERIAL PRIMARY KEY,
  from_user       INT NOT NULL REFERENCES users(id),
  to_user         INT NOT NULL REFERENCES users(id),
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to        TIMESTAMPTZ NOT NULL,
  scope_client_id INT REFERENCES clients(id),           -- optional narrowing
  scope_branch_id INT REFERENCES branches(id),
  reason          TEXT,
  created_by      INT REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  CHECK (from_user <> to_user),
  CHECK (valid_to > valid_from)
);
CREATE INDEX IF NOT EXISTS delegations_to   ON delegations (to_user)   WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS delegations_from ON delegations (from_user) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id                   SERIAL PRIMARY KEY,
  ref                  TEXT NOT NULL UNIQUE,
  client_id            INT  NOT NULL REFERENCES clients(id),
  branch_id            INT  NOT NULL REFERENCES branches(id),
  direction            TEXT NOT NULL CHECK (direction IN ('import','export')),
  mode                 TEXT NOT NULL CHECK (mode IN ('air','fcl','lcl')),
  stage                TEXT NOT NULL DEFAULT 'Confirmed'
                       CHECK (stage IN ('Confirmed','Prepared','Checked','Filed','Cancelled','Reopened')),
  cancelled_from_stage TEXT,
  prepared_by          INT REFERENCES users(id),
  checked_by           INT REFERENCES users(id),
  filed_by             INT REFERENCES users(id),
  responsible_user_id  INT REFERENCES users(id),
  internal_notes       TEXT,                            -- never shown to client-side users
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Waiting-list / visibility filters
CREATE INDEX IF NOT EXISTS jobs_waiting     ON jobs (stage, client_id, branch_id, direction, mode);
CREATE INDEX IF NOT EXISTS jobs_client      ON jobs (client_id, id DESC);
CREATE INDEX IF NOT EXISTS jobs_responsible ON jobs (responsible_user_id) WHERE responsible_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_page        ON jobs (id DESC);

-- Append-only: every decision (ALLOW and DENY) and every grant change.
CREATE TABLE IF NOT EXISTS audit_log (
  id               BIGSERIAL PRIMARY KEY,
  ts               TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id         INT REFERENCES users(id),
  action           TEXT NOT NULL,
  job_id           INT REFERENCES jobs(id),
  from_stage       TEXT,
  to_stage         TEXT,
  decision         TEXT NOT NULL CHECK (decision IN ('ALLOW','DENY')),
  reason           TEXT,
  matched_grant_id INT REFERENCES grants(id),
  meta             JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_job   ON audit_log (job_id, ts);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_log (actor_id, ts);

-- Immutability guards ------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_append_only ON audit_log;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Grants are never deleted; only valid_to / revoked_* may change, and a revocation cannot be undone.
CREATE OR REPLACE FUNCTION grants_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grants are never deleted; revoke instead';
  END IF;
  IF (NEW.user_id, NEW.role, NEW.client_id, NEW.branch_id, NEW.direction, NEW.mode, NEW.valid_from, NEW.created_by)
     IS DISTINCT FROM
     (OLD.user_id, OLD.role, OLD.client_id, OLD.branch_id, OLD.direction, OLD.mode, OLD.valid_from, OLD.created_by) THEN
    RAISE EXCEPTION 'grant scope is immutable; revoke and issue a new grant';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'a revocation cannot be undone';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS grants_guard_trg ON grants;
CREATE TRIGGER grants_guard_trg BEFORE UPDATE OR DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION grants_guard();
