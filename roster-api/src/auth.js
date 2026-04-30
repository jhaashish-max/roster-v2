import { getSupabaseAuth, getSupabaseAdmin } from './supabase.js';

/**
 * Verify JWT token and resolve member context (id, roles, departments).
 * Auto-creates member record if user is authenticated but not in members table.
 * Returns enriched auth context or null.
 */
export async function verifyAuth(c) {
    const authHeader = c.req.header('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

    const token = authHeader.replace('Bearer ', '');
    const supabaseAuth = getSupabaseAuth(c.env);

    try {
        const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
        if (error || !user) return null;

        const supabaseAdmin = getSupabaseAdmin(c.env);
        const email = user.email.toLowerCase();

        // Resolve member_id from email
        let { data: member, error: memberError } = await supabaseAdmin
            .from('members')
            .select('id, email, full_name, display_name, is_active')
            .eq('email', email)
            .single();

        // If member doesn't exist yet, auto-create from auth user
        if (memberError || !member) {
            const displayName = email.split('@')[0];
            const { data: newMember, error: createError } = await supabaseAdmin
                .from('members')
                .insert({
                    email,
                    full_name: user.user_metadata?.full_name || user.user_metadata?.name || displayName,
                    display_name: user.user_metadata?.name || displayName,
                    is_active: true
                })
                .select('id, email, full_name, display_name, is_active')
                .single();

            if (createError) {
                console.error('Failed to auto-create member:', createError.message);
                // Return minimal auth so user can at least browse
                return {
                    user,
                    memberId: null,
                    memberName: displayName,
                    memberEmail: email,
                    isPlatformAdmin: false,
                    isOnboarded: false,
                    roles: [],
                    departments: [],
                    allDepartmentIds: []
                };
            }
            member = newMember;
        }

        if (!member.is_active) {
            return { user, memberId: null, memberName: email, memberEmail: email, isPlatformAdmin: false, isOnboarded: false, roles: [], departments: [], allDepartmentIds: [] };
        }

        // Check platform admin
        const { data: platformAdmin } = await supabaseAdmin
            .from('platform_admins')
            .select('id')
            .eq('member_id', member.id)
            .single();

        // Get department roles
        const { data: deptRoles } = await supabaseAdmin
            .from('department_roles')
            .select('department_id, role')
            .eq('member_id', member.id);

        // Get team memberships (for department access)
        const { data: memberships } = await supabaseAdmin
            .from('team_memberships')
            .select('team_id, role, teams(department_id)')
            .eq('member_id', member.id);

        // Build unique department list
        const departmentSet = new Map();
        if (deptRoles) {
            deptRoles.forEach(dr => departmentSet.set(dr.department_id, dr.role));
        }
        if (memberships) {
            memberships.forEach(m => {
                const deptId = m.teams?.department_id;
                if (deptId && !departmentSet.has(deptId)) {
                    departmentSet.set(deptId, 'member');
                }
            });
        }

        const isPlatformAdmin = !!platformAdmin;
        const isOnboarded = departmentSet.size > 0 || isPlatformAdmin;

        return {
            user,
            memberId: member.id,
            memberName: member.full_name,
            memberEmail: member.email,
            isPlatformAdmin,
            isOnboarded,
            roles: deptRoles || [],
            departments: Array.from(departmentSet.entries()).map(([id, role]) => ({
                id,
                role
            })),
            allDepartmentIds: Array.from(departmentSet.keys())
        };
    } catch (err) {
        console.error('Auth verification error:', err);
        return null;
    }
}

export function unauthorized(c) {
    return c.json({ error: 'Unauthorized' }, 401);
}

/**
 * Check if auth context has edit access for a given department
 */
export function canEditDepartment(auth, departmentId) {
    if (!auth) return false;
    if (auth.isPlatformAdmin) return true;
    if (!auth.memberId) return false;
    return auth.roles.some(r =>
        r.department_id === departmentId &&
        ['dept_admin', 'dept_lead'].includes(r.role)
    );
}

export function canEditAny(auth) {
    if (!auth) return false;
    if (auth.isPlatformAdmin) return true;
    if (!auth.memberId) return false;
    return auth.roles.some(r => ['dept_admin', 'dept_lead'].includes(r.role));
}

export function hasDepartmentAccess(auth, departmentId) {
    if (!auth) return false;
    if (auth.isPlatformAdmin) return true;
    if (!auth.memberId) return false;
    return auth.allDepartmentIds.includes(departmentId);
}
