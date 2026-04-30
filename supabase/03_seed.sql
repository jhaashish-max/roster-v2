-- ============================================================
-- ROSTER V2 — Seed Data
-- Run AFTER 01_schema.sql and 02_rls_policies.sql
--
-- UPDATE: Replace placeholder emails with real ones before running
-- ============================================================

-- ============================================================
-- 1. Create default department
-- ============================================================
INSERT INTO departments (name, slug) VALUES
    ('Enterprise-VAS', 'enterprise-vas')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- 2. Create members
-- !! UPDATE emails to match real Razorpay addresses !!
-- ============================================================
INSERT INTO members (email, full_name, display_name) VALUES
    ('aswin.a@razorpay.com', 'Aswin A', 'Aswin A'),
    ('manoj@razorpay.com', 'Manoj', 'Manoj'),
    ('shophiya.s@razorpay.com', 'Shophiya S', 'Shophiya S'),
    ('panthi.patel@razorpay.com', 'Panthi Kishorbhai Patel', 'Panthi'),
    ('jha.ashish@razorpay.com', 'Ashish', 'Ashish'),
    ('ayush.s@razorpay.com', 'Ayush S', 'Ayush S'),
    ('raj.vardhan@razorpay.com', 'Raj Vardhan', 'Raj Vardhan'),
    ('shehjaar.manwati@razorpay.com', 'Shehjaar Manwati', 'Shehjaar'),
    ('aryan@razorpay.com', 'Aryan', 'Aryan'),
    ('anirudh@razorpay.com', 'Anirudh', 'Anirudh'),
    ('ayush.r@razorpay.com', 'Ayush R', 'Ayush R'),
    ('rishab@razorpay.com', 'Rishab', 'Rishab'),
    ('sanket@razorpay.com', 'Sanket', 'Sanket'),
    ('ishan@razorpay.com', 'Ishan', 'Ishan')
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- 3. Create default team under the department
-- ============================================================
INSERT INTO teams (department_id, name, custom_prompt)
SELECT d.id, 'Enterprise-VAS', NULL
FROM departments d
WHERE d.slug = 'enterprise-vas'
ON CONFLICT (department_id, name) DO NOTHING;

-- ============================================================
-- 4. Create team memberships (all members → default team)
-- ============================================================
INSERT INTO team_memberships (team_id, member_id, role)
SELECT
    t.id,
    m.id,
    CASE
        WHEN m.email = 'jha.ashish@razorpay.com' THEN 'lead'
        ELSE 'member'
    END
FROM teams t
JOIN departments d ON d.id = t.department_id
CROSS JOIN members m
WHERE d.slug = 'enterprise-vas'
  AND t.name = 'Enterprise-VAS'
  AND m.is_active = TRUE
ON CONFLICT (team_id, member_id) DO NOTHING;

-- ============================================================
-- 5. Promote Ashish as platform_admin + dept_admin
-- ============================================================
INSERT INTO platform_admins (member_id, granted_by)
SELECT m.id, m.id
FROM members m
WHERE m.email = 'jha.ashish@razorpay.com'
ON CONFLICT (member_id) DO NOTHING;

INSERT INTO department_roles (member_id, department_id, role, granted_by)
SELECT m.id, d.id, 'dept_admin', m.id
FROM members m
CROSS JOIN departments d
WHERE m.email = 'jha.ashish@razorpay.com'
  AND d.slug = 'enterprise-vas'
ON CONFLICT (member_id, department_id, role) DO NOTHING;

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
-- SELECT * FROM departments;
-- SELECT t.name, d.name as department FROM teams t JOIN departments d ON d.id = t.department_id;
-- SELECT m.full_name, m.email, tm.role, t.name as team FROM members m JOIN team_memberships tm ON tm.member_id = m.id JOIN teams t ON t.id = tm.team_id;
-- SELECT m.full_name, dr.role, d.name as department FROM members m JOIN department_roles dr ON dr.member_id = m.id JOIN departments d ON d.id = dr.department_id;
-- SELECT m.full_name FROM members m JOIN platform_admins pa ON pa.member_id = m.id;
