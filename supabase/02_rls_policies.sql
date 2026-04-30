-- ============================================================
-- ROSTER V2 — Row Level Security Policies
-- Run AFTER 01_schema.sql
-- ============================================================

-- Enable RLS on all data tables
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_configurations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- HELPER: Check if auth user is a platform admin
-- ============================================================
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM platform_admins pa
        JOIN members m ON m.id = pa.member_id
        WHERE m.email = auth.jwt() ->> 'email'
        AND m.is_active = TRUE
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ============================================================
-- HELPER: Check if auth user has access to a department
-- ============================================================
CREATE OR REPLACE FUNCTION has_department_access(p_dept_id UUID)
RETURNS BOOLEAN AS $$
    DECLARE
        v_email TEXT;
        v_member_id UUID;
    BEGIN
        -- Platform admins have access to everything
        IF is_platform_admin() THEN RETURN TRUE; END IF;

        v_email := auth.jwt() ->> 'email';
        SELECT id INTO v_member_id FROM members WHERE email = LOWER(v_email) AND is_active = TRUE;
        IF v_member_id IS NULL THEN RETURN FALSE; END IF;

        -- Check department roles
        IF EXISTS (
            SELECT 1 FROM department_roles
            WHERE member_id = v_member_id AND department_id = p_dept_id
        ) THEN RETURN TRUE; END IF;

        -- Check team memberships in that department
        IF EXISTS (
            SELECT 1 FROM team_memberships tm
            JOIN teams t ON t.id = tm.team_id
            WHERE tm.member_id = v_member_id AND t.department_id = p_dept_id
        ) THEN RETURN TRUE; END IF;

        RETURN FALSE;
    END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

-- ============================================================
-- HELPER: Get the member_id for the current auth user
-- ============================================================
CREATE OR REPLACE FUNCTION auth_member_id()
RETURNS UUID AS $$
    SELECT id FROM members
    WHERE email = LOWER(auth.jwt() ->> 'email')
    AND is_active = TRUE;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ============================================================
-- DEPARTMENTS
-- ============================================================
-- Anyone authenticated can see departments they belong to
CREATE POLICY "members_read_own_departments" ON departments
    FOR SELECT USING (
        is_platform_admin()
        OR has_department_access(id)
    );

-- Only platform admins can create/update/delete departments
CREATE POLICY "platform_admins_manage_departments" ON departments
    FOR ALL USING (is_platform_admin())
    WITH CHECK (is_platform_admin());

-- ============================================================
-- TEAMS
-- ============================================================
-- Users can see teams in departments they have access to
CREATE POLICY "members_read_own_teams" ON teams
    FOR SELECT USING (has_department_access(department_id));

-- Dept admins and platform admins can manage teams
CREATE POLICY "admins_manage_teams" ON teams
    FOR INSERT WITH CHECK (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = department_id
            AND dr.role IN ('dept_admin')
        )
    );

CREATE POLICY "admins_update_teams" ON teams
    FOR UPDATE USING (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = department_id
            AND dr.role IN ('dept_admin')
        )
    );

CREATE POLICY "admins_delete_teams" ON teams
    FOR DELETE USING (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = department_id
            AND dr.role IN ('dept_admin')
        )
    );

-- ============================================================
-- MEMBERS
-- ============================================================
-- Anyone authenticated can read members (needed for roster display)
CREATE POLICY "authenticated_read_members" ON members
    FOR SELECT USING (true);

-- Only platform admins and dept admins can create/update members
CREATE POLICY "admins_manage_members" ON members
    FOR INSERT WITH CHECK (is_platform_admin());
CREATE POLICY "admins_update_members" ON members
    FOR UPDATE USING (is_platform_admin());
CREATE POLICY "admins_delete_members" ON members
    FOR DELETE USING (is_platform_admin());

-- ============================================================
-- TEAM MEMBERSHIPS
-- ============================================================
-- Users can see memberships for teams they have access to
CREATE POLICY "members_read_own_memberships" ON team_memberships
    FOR SELECT USING (
        has_department_access((SELECT department_id FROM teams WHERE id = team_id))
    );

-- Dept admins and platform admins can manage memberships
CREATE POLICY "admins_manage_memberships" ON team_memberships
    FOR ALL USING (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = (SELECT department_id FROM teams WHERE id = team_id)
            AND dr.role IN ('dept_admin')
        )
    );

-- ============================================================
-- ROSTER
-- ============================================================
-- Users can see roster for teams in their departments
CREATE POLICY "members_read_own_roster" ON roster
    FOR SELECT USING (
        is_platform_admin()
        OR has_department_access((SELECT department_id FROM teams WHERE id = team_id))
    );

-- Dept admins, dept leads, team leads can insert/update
CREATE POLICY "leads_manage_roster" ON roster
    FOR INSERT WITH CHECK (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = (SELECT department_id FROM teams WHERE id = team_id)
        )
        OR EXISTS (
            SELECT 1 FROM team_memberships tm
            WHERE tm.member_id = auth_member_id()
            AND tm.team_id = team_id
            AND tm.role = 'lead'
        )
    );

CREATE POLICY "leads_update_roster" ON roster
    FOR UPDATE USING (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = (SELECT department_id FROM teams WHERE id = team_id)
        )
        OR EXISTS (
            SELECT 1 FROM team_memberships tm
            WHERE tm.member_id = auth_member_id()
            AND tm.team_id = team_id
            AND tm.role = 'lead'
        )
    );

CREATE POLICY "admins_delete_roster" ON roster
    FOR DELETE USING (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = (SELECT department_id FROM teams WHERE id = team_id)
            AND dr.role IN ('dept_admin', 'dept_lead')
        )
    );

-- ============================================================
-- DEPARTMENT ROLES
-- ============================================================
-- Users can see roles for their departments
CREATE POLICY "members_read_own_dept_roles" ON department_roles
    FOR SELECT USING (has_department_access(department_id));

-- Only platform admins and dept admins can manage roles
CREATE POLICY "admins_manage_dept_roles" ON department_roles
    FOR ALL USING (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = department_id
            AND dr.role = 'dept_admin'
        )
    );

-- ============================================================
-- PLATFORM ADMINS
-- ============================================================
-- Anyone authenticated can check (needed for UI)
CREATE POLICY "authenticated_read_platform_admins" ON platform_admins
    FOR SELECT USING (true);

-- Only platform admins can manage platform admins
CREATE POLICY "platform_admins_manage_self" ON platform_admins
    FOR ALL USING (is_platform_admin())
    WITH CHECK (is_platform_admin());

-- ============================================================
-- LEAVE REQUESTS
-- ============================================================
-- Users can see their own requests + admins can see all in their dept
CREATE POLICY "members_read_own_requests" ON leave_requests
    FOR SELECT USING (
        requester_id = auth_member_id()
        OR is_platform_admin()
        OR has_department_access((SELECT department_id FROM teams WHERE id = team_id))
    );

-- Any member can create requests
CREATE POLICY "members_create_requests" ON leave_requests
    FOR INSERT WITH CHECK (requester_id = auth_member_id());

-- Only admins/leads can update (review)
CREATE POLICY "admins_review_requests" ON leave_requests
    FOR UPDATE USING (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = (SELECT department_id FROM teams WHERE id = team_id)
        )
        OR EXISTS (
            SELECT 1 FROM team_memberships tm
            WHERE tm.member_id = auth_member_id()
            AND tm.team_id = team_id
            AND tm.role = 'lead'
        )
    );

-- ============================================================
-- SHIFT CONFIGURATIONS
-- ============================================================
CREATE POLICY "members_read_own_shifts" ON shift_configurations
    FOR SELECT USING (
        has_department_access((SELECT department_id FROM teams WHERE id = team_id))
    );

CREATE POLICY "admins_manage_shifts" ON shift_configurations
    FOR ALL USING (
        is_platform_admin()
        OR EXISTS (
            SELECT 1 FROM department_roles dr
            WHERE dr.member_id = auth_member_id()
            AND dr.department_id = (SELECT department_id FROM teams WHERE id = team_id)
        )
    );

-- ============================================================
-- AUDIT LOG
-- ============================================================
-- Read-only for admins
CREATE POLICY "admins_read_audit" ON audit_log
    FOR SELECT USING (is_platform_admin());

-- Anyone authenticated can insert (API writes audit entries)
CREATE POLICY "authenticated_insert_audit" ON audit_log
    FOR INSERT WITH CHECK (true);
