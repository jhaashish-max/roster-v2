-- ============================================================
-- ROSTER V2 — Multi-Department Schema
-- Run this in the new Supabase project's SQL Editor
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. DEPARTMENTS
-- ============================================================
CREATE TABLE departments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    slug        TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 2. TEAMS (scoped to a department)
-- ============================================================
CREATE TABLE teams (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id   UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    custom_prompt   TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(department_id, name)
);
CREATE INDEX idx_teams_dept ON teams(department_id);

-- ============================================================
-- 3. MEMBERS (central identity)
-- ============================================================
CREATE TABLE members (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    full_name     TEXT NOT NULL,
    display_name  TEXT,
    is_active     BOOLEAN DEFAULT TRUE,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- 4. TEAM MEMBERSHIPS (many-to-many with role)
-- ============================================================
CREATE TABLE team_memberships (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
    joined_at   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(team_id, member_id)
);
CREATE INDEX idx_tm_team ON team_memberships(team_id);
CREATE INDEX idx_tm_member ON team_memberships(member_id);

-- ============================================================
-- 5. ROSTER (FK-based, no TEXT names)
-- ============================================================
CREATE TABLE roster (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    date        DATE NOT NULL,
    member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    shift_name  TEXT,
    updated_by  UUID REFERENCES members(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(date, member_id, team_id)
);
CREATE INDEX idx_roster_team_date ON roster(team_id, date);
CREATE INDEX idx_roster_member_date ON roster(member_id, date);
CREATE INDEX idx_roster_date ON roster(date);

-- ============================================================
-- 6. DEPARTMENT ROLES (replaces flat admins table)
-- ============================================================
CREATE TABLE department_roles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id       UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    department_id   UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('dept_admin', 'dept_lead')),
    granted_by      UUID REFERENCES members(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(member_id, department_id, role)
);
CREATE INDEX idx_dr_member ON department_roles(member_id);
CREATE INDEX idx_dr_dept ON department_roles(department_id);

-- ============================================================
-- 7. PLATFORM ADMINS (cross-department super admins)
-- ============================================================
CREATE TABLE platform_admins (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id   UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    granted_by  UUID REFERENCES members(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(member_id)
);

-- ============================================================
-- 8. LEAVE REQUESTS
-- ============================================================
CREATE TABLE leave_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id    UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    request_type    TEXT NOT NULL CHECK (request_type IN ('PL', 'WL', 'WFH')),
    dates           DATE[] NOT NULL,
    reason          TEXT,
    status          TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
    reviewed_by     UUID REFERENCES members(id),
    reviewed_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_lr_requester ON leave_requests(requester_id);
CREATE INDEX idx_lr_team_status ON leave_requests(team_id, status);

-- ============================================================
-- 9. SHIFT CONFIGURATIONS
-- ============================================================
CREATE TABLE shift_configurations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    shift_name  TEXT NOT NULL,
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    color       TEXT,
    UNIQUE(team_id, shift_name)
);

-- ============================================================
-- 10. AUDIT LOG
-- ============================================================
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        UUID NOT NULL REFERENCES members(id) ON DELETE SET NULL,
    department_id   UUID REFERENCES departments(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    target_type     TEXT,
    target_id       UUID,
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_dept ON audit_log(department_id);
CREATE INDEX idx_audit_actor ON audit_log(actor_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- ============================================================
-- 11. HELPER: member_emails VIEW (backward compat)
-- Provides name→email mapping like the old roster_member_emails table
-- ============================================================
CREATE VIEW member_emails AS
SELECT
    m.id,
    m.full_name AS name,
    m.email,
    m.display_name,
    m.is_active
FROM members m;

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-update updated_at on roster
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_roster_updated_at ON roster;
CREATE TRIGGER update_roster_updated_at
    BEFORE UPDATE ON roster
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- HELPER FUNCTIONS
-- ============================================================

-- Resolve member_id from email (used by API layer)
CREATE OR REPLACE FUNCTION resolve_member_id(p_email TEXT)
RETURNS UUID AS $$
    SELECT id FROM members WHERE email = LOWER(p_email) AND is_active = TRUE;
$$ LANGUAGE sql STABLE;

-- Resolve team_id from team name + department
CREATE OR REPLACE FUNCTION resolve_team_id(p_team_name TEXT, p_department_id UUID)
RETURNS UUID AS $$
    SELECT id FROM teams WHERE name = p_team_name AND department_id = p_department_id;
$$ LANGUAGE sql STABLE;

-- Get member's departments (for auth context)
CREATE OR REPLACE FUNCTION get_member_departments(p_member_id UUID)
RETURNS TABLE(department_id UUID, department_name TEXT, role TEXT) AS $$
    -- From team memberships
    SELECT d.id AS department_id, d.name AS department_name, 'member'::TEXT AS role
    FROM team_memberships tm
    JOIN teams t ON t.id = tm.team_id
    JOIN departments d ON d.id = t.department_id
    WHERE tm.member_id = p_member_id

    UNION

    -- From department roles (overrides with higher role)
    SELECT dr.department_id, d.name AS department_name, dr.role
    FROM department_roles dr
    JOIN departments d ON d.id = dr.department_id
    WHERE dr.member_id = p_member_id;
$$ LANGUAGE sql STABLE;
