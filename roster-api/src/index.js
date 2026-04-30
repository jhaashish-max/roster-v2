import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { getSupabaseAdmin, getSupabaseAuth } from './supabase.js';
import { verifyAuth, unauthorized, canEditDepartment, canEditAny, hasDepartmentAccess } from './auth.js';
import { departmentContext } from './middleware/department.js';

const app = new Hono();

// Global CORS Middleware
app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Department-Id', 'x-custom-header'],
}));

// Supabase reverse proxy — lets browser reach Supabase via same origin
// so a single tunnel URL covers both the app and Supabase auth
app.all('/supabase/*', async (c) => {
    try {
        const supabaseBase = c.env.SUPABASE_URL || 'http://127.0.0.1:54321';
        const targetPath = c.req.path.replace('/supabase', '');
        const url = new URL(c.req.url);
        const targetUrl = `${supabaseBase}${targetPath}${url.search}`;

        const headers = new Headers(c.req.raw.headers);
        const supabaseHost = new URL(supabaseBase).host;
        headers.set('host', supabaseHost);
        // Strip headers that confuse GoTrue / Cloudflare
        headers.delete('cf-connecting-ip');
        headers.delete('cf-ipcountry');
        headers.delete('cf-ray');
        headers.delete('cf-visitor');
        headers.delete('x-forwarded-for');
        headers.delete('x-forwarded-proto');
        headers.delete('x-real-ip');

        const res = await fetch(targetUrl, {
            method: c.req.method,
            headers,
            body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : c.req.raw.body,
            redirect: 'manual',
        });

        // Build clean response headers (skip hop-by-hop headers)
        const respHeaders = new Headers();
        res.headers.forEach((v, k) => {
            const kl = k.toLowerCase();
            if (!['transfer-encoding', 'connection', 'keep-alive'].includes(kl)) {
                respHeaders.set(k, v);
            }
        });

        return new Response(res.body, {
            status: res.status,
            headers: respHeaders,
        });
    } catch (err) {
        return c.json({ error: 'Proxy error', details: err.message }, 502);
    }
});

// Auth middleware — resolves user context on every request
app.use('/api/*', async (c, next) => {
    // Skip auth-only endpoints
    if (c.req.path === '/api/auth') {
        return next();
    }
    // Service key bypass for n8n/server-side calls
    const serviceKey = c.req.header('X-Service-Key') || c.req.query('service_key');
    if (serviceKey && serviceKey === c.env.SERVICE_KEY) {
        // Grant platform admin context for service calls
        c.set('auth', {
            user: null,
            memberId: null,
            memberName: 'service',
            memberEmail: 'service@internal',
            isPlatformAdmin: true,
            isOnboarded: true,
            roles: [],
            departments: [],
            allDepartmentIds: []
        });
        await next();
        return;
    }
    const auth = await verifyAuth(c);
    c.set('auth', auth);
    await next();
});

// Department context middleware on data endpoints
app.use('/api/roster/*', departmentContext);
app.use('/api/teams/*', departmentContext);
app.use('/api/departments/*', departmentContext);
app.use('/api/requests/*', departmentContext);
app.use('/api/admin/*', departmentContext);
app.use('/api/shift-configs/*', departmentContext);

// ============================================================
// HELPER: Resolve name→member_id and team_name→team_id
// For backward compat (n8n sends TEXT names, frontend sends UUIDs)
// ============================================================
async function resolveMemberId(supabaseAdmin, nameOrId) {
    if (!nameOrId) return null;
    // If it looks like a UUID, return as-is
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)) {
        return nameOrId;
    }
    // Otherwise look up by name
    const { data } = await supabaseAdmin
        .from('members')
        .select('id')
        .or(`full_name.ilike.${nameOrId},display_name.ilike.${nameOrId}`)
        .eq('is_active', true)
        .limit(1);
    return data?.[0]?.id || null;
}

async function resolveTeamId(supabaseAdmin, nameOrId, departmentId) {
    if (!nameOrId) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)) {
        return nameOrId;
    }
    let query = supabaseAdmin.from('teams').select('id').eq('name', nameOrId);
    if (departmentId) query = query.eq('department_id', departmentId);
    const { data } = await query.limit(1);
    return data?.[0]?.id || null;
}

// ============================================================
// DEPARTMENTS ROUTES
// ============================================================

app.get('/api/departments', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        if (auth.isPlatformAdmin) {
            // Platform admins see all departments
            const { data, error } = await supabaseAdmin
                .from('departments')
                .select('*')
                .order('name');
            if (error) return c.json({ error: error.message }, 500);
            return c.json(data);
        }

        // Regular users see only their departments
        if (auth.allDepartmentIds.length === 0) {
            return c.json([]);
        }

        const { data, error } = await supabaseAdmin
            .from('departments')
            .select('*')
            .in('id', auth.allDepartmentIds)
            .order('name');
        if (error) return c.json({ error: error.message }, 500);

        // Enrich with role info
        const enriched = data.map(d => {
            const deptRole = auth.departments.find(dep => dep.id === d.id);
            return { ...d, user_role: deptRole?.role || 'member' };
        });

        return c.json(enriched);
    } catch (err) {
        console.error('List departments error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.post('/api/departments', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);
    if (!auth.isPlatformAdmin) return c.json({ error: 'Platform admin required' }, 403);

    const { name, slug } = await c.req.json();
    if (!name || !slug) return c.json({ error: 'name and slug required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    try {
        const { data, error } = await supabaseAdmin
            .from('departments')
            .insert({ name, slug })
            .select()
            .single();
        if (error) return c.json({ error: error.message }, 500);
        return c.json(data);
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.put('/api/departments', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);
    if (!auth.isPlatformAdmin) return c.json({ error: 'Platform admin required' }, 403);

    const { id, name, slug } = await c.req.json();
    if (!id) return c.json({ error: 'id required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    const updates = {};
    if (name) updates.name = name;
    if (slug) updates.slug = slug;
    if (Object.keys(updates).length === 0) return c.json({ error: 'name or slug required' }, 400);

    try {
        const { data, error } = await supabaseAdmin
            .from('departments')
            .update(updates)
            .eq('id', id)
            .select()
            .single();
        if (error) return c.json({ error: error.message }, 500);
        return c.json(data);
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.delete('/api/departments', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);
    if (!auth.isPlatformAdmin) return c.json({ error: 'Platform admin required' }, 403);

    const id = c.req.query('id');
    if (!id) return c.json({ error: 'id required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    try {
        // Delete department roles, teams (and their memberships), then department
        await supabaseAdmin.from('department_roles').delete().eq('department_id', id);
        const { data: deptTeams } = await supabaseAdmin.from('teams').select('id').eq('department_id', id);
        if (deptTeams?.length) {
            const teamIds = deptTeams.map(t => t.id);
            await supabaseAdmin.from('team_memberships').delete().in('team_id', teamIds);
            await supabaseAdmin.from('teams').delete().in('id', teamIds);
        }
        const { error } = await supabaseAdmin.from('departments').delete().eq('id', id);
        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true });
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.get('/api/departments/members', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const departmentId = c.get('departmentId');
    if (!departmentId) return c.json({ error: 'department_id required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    try {
        // Get teams in this department first
        const { data: deptTeams } = await supabaseAdmin
            .from('teams')
            .select('id, name')
            .eq('department_id', departmentId);

        if (!deptTeams || deptTeams.length === 0) {
            return c.json([]);
        }

        const teamIds = deptTeams.map(t => t.id);

        // Get memberships for those teams
        const { data, error } = await supabaseAdmin
            .from('team_memberships')
            .select('member_id, role, team_id, members(id, email, full_name, display_name, is_active)')
            .in('team_id', teamIds);

        if (error) return c.json({ error: error.message }, 500);

        // Flatten and deduplicate members
        const seen = new Set();
        const members = [];
        const teamMap = new Map(deptTeams.map(t => [t.id, t.name]));
        data.forEach(row => {
            if (row.members && !seen.has(row.members.id)) {
                seen.add(row.members.id);
                members.push({
                    ...row.members,
                    team_id: row.team_id,
                    team_name: teamMap.get(row.team_id),
                    membership_role: row.role
                });
            }
        });

        return c.json(members);
    } catch (err) {
        console.error('departments/members error:', err);
        return c.json({ error: err.message || 'Internal server error' }, 500);
    }
});

// ============================================================
// ROSTER ROUTES
// ============================================================

app.get('/api/roster/fetch', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const year = c.req.query('year');
    const month = c.req.query('month');
    const teamId = c.req.query('team_id') || c.req.query('team'); // backward compat
    const departmentId = c.get('departmentId');

    if (!year || !month) return c.json({ error: 'year and month are required' }, 400);

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        // Resolve team_id from name if needed (backward compat)
        let resolvedTeamId = teamId;
        if (teamId && !/^[0-9a-f]{8}/i.test(teamId)) {
            resolvedTeamId = await resolveTeamId(supabaseAdmin, teamId, departmentId);
        }

        let query = supabaseAdmin
            .from('roster')
            .select('date, status, shift_name, members!roster_member_id_fkey(id, full_name, display_name, email), teams!roster_team_id_fkey(id, name, department_id)')
            .gte('date', startDate)
            .lte('date', endDate)
            .order('date');

        if (resolvedTeamId) {
            if (departmentId) {
                const { data: teamCheck } = await supabaseAdmin
                    .from('teams')
                    .select('id')
                    .eq('id', resolvedTeamId)
                    .eq('department_id', departmentId)
                    .single();
                if (!teamCheck) return c.json([]); // Team is not in selected department
            }
            query = query.eq('team_id', resolvedTeamId);
        } else if (departmentId) {
            // Filter by department — get all team IDs in this department
            const { data: deptTeams } = await supabaseAdmin
                .from('teams')
                .select('id')
                .eq('department_id', departmentId);
            if (!deptTeams || deptTeams.length === 0) return c.json([]);
            query = query.in('team_id', deptTeams.map(t => t.id));
        }

        const { data, error } = await query;
        if (error) return c.json({ error: error.message }, 500);

        const result = data.map(row => ({
            Date: row.date,
            Name: row.members?.display_name || row.members?.full_name,
            MemberId: row.members?.id,
            Status: row.status,
            ShiftName: row.shift_name,
            Team: row.teams?.name,
            TeamId: row.teams?.id
        }));

        return c.json(result);
    } catch (err) {
        console.error('Fetch roster error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.get('/api/roster/fetch-all', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const year = c.req.query('year');
    const month = c.req.query('month');
    const departmentId = c.get('departmentId');

    if (!year || !month) return c.json({ error: 'year and month are required' }, 400);

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        // Determine which team IDs to query
        let teamIds = null;
        if (departmentId) {
            const { data: deptTeams } = await supabaseAdmin
                .from('teams')
                .select('id')
                .eq('department_id', departmentId);
            teamIds = deptTeams?.map(t => t.id) || [];
        } else if (!auth.isPlatformAdmin) {
            // Non-admin: only teams in their departments
            const { data: deptTeams } = await supabaseAdmin
                .from('teams')
                .select('id')
                .in('department_id', auth.allDepartmentIds);
            teamIds = deptTeams?.map(t => t.id) || [];
        }

        let query = supabaseAdmin
            .from('roster')
            .select('date, status, shift_name, members!roster_member_id_fkey(id, full_name, display_name, email), teams!roster_team_id_fkey(id, name, department_id)')
            .gte('date', startDate)
            .lte('date', endDate)
            .order('team_id')
            .order('date');

        if (teamIds !== null) {
            if (teamIds.length === 0) return c.json({}); // No teams, prevent unfiltered leak
            query = query.in('team_id', teamIds);
        }

        const { data, error } = await query.limit(20000);
        if (error) return c.json({ error: error.message }, 500);

        // Group by team name (backward compat format)
        const grouped = {};
        data.forEach(row => {
            const teamName = row.teams?.name || 'Unknown';
            if (!grouped[teamName]) grouped[teamName] = [];
            grouped[teamName].push({
                Date: row.date,
                Name: row.members?.display_name || row.members?.full_name,
                MemberId: row.members?.id,
                Status: row.status,
                ShiftName: row.shift_name,
                Team: teamName,
                TeamId: row.teams?.id
            });
        });

        return c.json(grouped);
    } catch (err) {
        console.error('Fetch-all error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.post('/api/roster/update', async (c) => {
    const auth = c.get('auth');
    if (!auth || !auth.memberId) return unauthorized(c);
    if (!canEditAny(auth)) return c.json({ error: 'Edit access required' }, 403);

    const body = await c.req.json();
    const { date, status } = body;

    if (!date || !status) return c.json({ error: 'date and status are required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    const departmentId = c.get('departmentId');

    try {
        // Resolve member_id — from body or from auth context
        const memberId = body.member_id || await resolveMemberId(supabaseAdmin, body.name || auth.memberName);
        if (!memberId) return c.json({ error: 'Could not resolve member' }, 400);

        // Resolve team_id — from body or from member's team
        const teamId = body.team_id || await resolveTeamId(supabaseAdmin, body.team, departmentId);
        if (!teamId) return c.json({ error: 'Could not resolve team' }, 400);

        // Verify department access
        const { data: team } = await supabaseAdmin
            .from('teams')
            .select('department_id')
            .eq('id', teamId)
            .single();

        if (!team || !hasDepartmentAccess(auth, team.department_id)) {
            return c.json({ error: 'No access to this team' }, 403);
        }

        const { error } = await supabaseAdmin
            .from('roster')
            .upsert({
                date,
                member_id: memberId,
                team_id: teamId,
                status,
                shift_name: body.shift_name || null,
                updated_by: auth.memberId
            }, { onConflict: 'date,member_id,team_id' });

        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true });
    } catch (err) {
        console.error('Update roster error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.post('/api/roster/bulk-update', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);
    if (!auth.isPlatformAdmin && !auth.memberId) return unauthorized(c);
    if (!canEditAny(auth)) return c.json({ error: 'Edit access required' }, 403);

    const { entries } = await c.req.json();
    if (!entries || !Array.isArray(entries)) return c.json({ error: 'entries array required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    const departmentId = c.get('departmentId');

    try {
        // Batch-resolve all names to UUIDs upfront (2 queries instead of N*2)
        const memberNames = [...new Set(entries.map(e => e.name).filter(n => n && !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(n)))];
        const teamNames = [...new Set(entries.map(e => e.team).filter(t => t && !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(t)))];

        const memberMap = new Map();
        const teamMap = new Map();

        if (memberNames.length > 0) {
            const { data: members } = await supabaseAdmin
                .from('members')
                .select('id, full_name, display_name')
                .eq('is_active', true);
            if (members) {
                for (const m of members) {
                    if (m.full_name) memberMap.set(m.full_name.toLowerCase(), m.id);
                    if (m.display_name) memberMap.set(m.display_name.toLowerCase(), m.id);
                }
            }
        }

        if (teamNames.length > 0) {
            let teamQuery = supabaseAdmin.from('teams').select('id, name');
            if (departmentId) teamQuery = teamQuery.eq('department_id', departmentId);
            const { data: teams } = await teamQuery;
            if (teams) {
                for (const t of teams) teamMap.set(t.name, t.id);
            }
        }

        const enriched = [];
        for (const item of entries) {
            let memberId = item.member_id || null;
            if (!memberId && item.name) {
                if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(item.name)) {
                    memberId = item.name;
                } else {
                    memberId = memberMap.get(item.name.toLowerCase()) || null;
                }
            }
            let teamId = item.team_id || null;
            if (!teamId && item.team) {
                if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(item.team)) {
                    teamId = item.team;
                } else {
                    teamId = teamMap.get(item.team) || null;
                }
            }
            if (!memberId || !teamId) continue;

            enriched.push({
                date: item.date,
                member_id: memberId,
                team_id: teamId,
                status: item.status,
                shift_name: item.shift_name || null,
                updated_by: auth.memberId
            });
        }

        if (enriched.length === 0) return c.json({ error: 'No valid entries to upsert' }, 400);

        const { error } = await supabaseAdmin
            .from('roster')
            .upsert(enriched, { onConflict: 'date,member_id,team_id' });

        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true, count: enriched.length });
    } catch (err) {
        console.error('Bulk update error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.delete('/api/roster/delete', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);
    if (!auth.isPlatformAdmin && !auth.memberId) return unauthorized(c);

    const year = c.req.query('year');
    const month = c.req.query('month');
    const teamIdParam = c.req.query('team_id') || c.req.query('team');
    const departmentId = c.get('departmentId');

    if (!year || !month || !teamIdParam) return c.json({ error: 'year, month, and team_id required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        const teamId = await resolveTeamId(supabaseAdmin, teamIdParam, departmentId);
        if (!teamId) return c.json({ error: 'Team not found' }, 404);

        // Verify access
        const { data: team } = await supabaseAdmin
            .from('teams')
            .select('department_id')
            .eq('id', teamId)
            .single();

        if (!team || !hasDepartmentAccess(auth, team.department_id)) {
            return c.json({ error: 'No access to this team' }, 403);
        }
        if (!canEditDepartment(auth, team.department_id) && !auth.isPlatformAdmin) {
            return c.json({ error: 'Edit access required' }, 403);
        }

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
        const endDate = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

        const { error } = await supabaseAdmin
            .from('roster')
            .delete()
            .eq('team_id', teamId)
            .gte('date', startDate)
            .lte('date', endDate);

        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true });
    } catch (err) {
        console.error('Delete roster error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.get('/api/roster/exists', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const year = c.req.query('year');
    const month = c.req.query('month');
    const teamIdParam = c.req.query('team_id') || c.req.query('team');
    const departmentId = c.get('departmentId');

    if (!year || !month || !teamIdParam) return c.json({ error: 'year, month, and team_id required' }, 400);

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        const teamId = await resolveTeamId(supabaseAdmin, teamIdParam, departmentId);
        if (!teamId) return c.json({ exists: false });

        const { data, error } = await supabaseAdmin
            .from('roster')
            .select('id')
            .eq('team_id', teamId)
            .gte('date', startDate)
            .limit(1);

        if (error) return c.json({ error: error.message }, 500);
        return c.json({ exists: data.length > 0 });
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

// ============================================================
// TEAMS ROUTES
// ============================================================

app.get('/api/teams/list', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const departmentId = c.get('departmentId');
    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        let query = supabaseAdmin
            .from('teams')
            .select('id, name, department_id, custom_prompt, created_at, departments(name)')
            .order('name');

        if (departmentId) {
            query = query.eq('department_id', departmentId);
        } else if (!auth.isPlatformAdmin && auth.allDepartmentIds.length > 0) {
            query = query.in('department_id', auth.allDepartmentIds);
        } else if (!auth.isPlatformAdmin) {
            return c.json([]);
        }

        const { data, error } = await query;
        if (error) return c.json({ error: error.message }, 500);

        // For each team, get member count and member list
        const teamsWithMembers = await Promise.all((data || []).map(async (team) => {
            const { data: memberships } = await supabaseAdmin
                .from('team_memberships')
                .select('member_id, role, members(id, full_name, display_name, email)')
                .eq('team_id', team.id);

            const members = (memberships || []).map(m => ({
                id: m.members?.id,
                full_name: m.members?.full_name,
                display_name: m.members?.display_name,
                email: m.members?.email,
                role: m.role
            }));

            return {
                ...team,
                department_name: team.departments?.name,
                members: members.map(m => m.display_name || m.full_name),
                member_details: members,
                member_names: members.map(m => m.display_name || m.full_name)
            };
        }));

        return c.json(teamsWithMembers);
    } catch (err) {
        console.error('List teams error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.post('/api/teams/create', async (c) => {
    const auth = c.get('auth');
    if (!auth || !auth.memberId) return unauthorized(c);

    const { name, department_id, members: memberInputs, custom_prompt } = await c.req.json();
    if (!name) return c.json({ error: 'name required' }, 400);

    // Auto-resolve department: explicit param > context > user's single department
    let deptId = department_id || c.get('departmentId');
    if (!deptId && auth.departments.length === 1) {
        deptId = auth.departments[0].id;
    }
    if (!deptId) return c.json({ error: 'department_id required — select a department first' }, 400);
    if (!canEditDepartment(auth, deptId) && !auth.isPlatformAdmin) {
        return c.json({ error: 'Edit access required for this department' }, 403);
    }

    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        const { data: team, error } = await supabaseAdmin
            .from('teams')
            .insert({ name, department_id: deptId, custom_prompt: custom_prompt || null })
            .select()
            .single();

        if (error) return c.json({ error: error.message }, 500);

        // Create member records and team memberships
        if (memberInputs && Array.isArray(memberInputs) && memberInputs.length > 0) {
            for (const input of memberInputs) {
                // input can be a name string, or { name, email } object
                const memberName = typeof input === 'string' ? input : input.name;
                const memberEmail = typeof input === 'object' ? input.email : null;

                // Try to find existing member
                let memberId;
                if (memberEmail) {
                    const { data: existing } = await supabaseAdmin
                        .from('members')
                        .select('id')
                        .eq('email', memberEmail.toLowerCase())
                        .single();
                    memberId = existing?.id;

                    if (!memberId) {
                        const { data: newMember } = await supabaseAdmin
                            .from('members')
                            .insert({ email: memberEmail.toLowerCase(), full_name: memberName, display_name: memberName })
                            .select()
                            .single();
                        memberId = newMember?.id;
                    }
                } else {
                    // Find by name
                    const { data: existing } = await supabaseAdmin
                        .from('members')
                        .select('id')
                        .eq('full_name', memberName)
                        .limit(1);
                    memberId = existing?.[0]?.id;
                }

                if (memberId) {
                    await supabaseAdmin
                        .from('team_memberships')
                        .upsert({ team_id: team.id, member_id: memberId, role: 'member' }, { onConflict: 'team_id,member_id' });
                }
            }
        }

        return c.json(team);
    } catch (err) {
        console.error('Create team error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.put('/api/teams/update', async (c) => {
    const auth = c.get('auth');
    if (!auth || !auth.memberId) return unauthorized(c);

    const id = c.req.query('id');
    if (!id) return c.json({ error: 'Team id required' }, 400);

    const { name, members: memberInputs, custom_prompt } = await c.req.json();

    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        // Get team and verify access
        const { data: team } = await supabaseAdmin
            .from('teams')
            .select('department_id')
            .eq('id', id)
            .single();

        if (!team) return c.json({ error: 'Team not found' }, 404);
        if (!canEditDepartment(auth, team.department_id) && !auth.isPlatformAdmin) {
            return c.json({ error: 'Edit access required' }, 403);
        }

        // Update team fields
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (custom_prompt !== undefined) updates.custom_prompt = custom_prompt;

        if (Object.keys(updates).length > 0) {
            const { error } = await supabaseAdmin
                .from('teams')
                .update(updates)
                .eq('id', id);
            if (error) return c.json({ error: error.message }, 500);
        }

        // Update memberships if provided
        if (memberInputs !== undefined && Array.isArray(memberInputs)) {
            // Remove existing memberships
            await supabaseAdmin
                .from('team_memberships')
                .delete()
                .eq('team_id', id);

            // Re-add members
            for (const input of memberInputs) {
                const memberName = typeof input === 'string' ? input : input.name;
                const memberEmail = typeof input === 'object' ? input.email : null;

                let memberId;
                if (memberEmail) {
                    const { data: existing } = await supabaseAdmin
                        .from('members')
                        .select('id')
                        .eq('email', memberEmail.toLowerCase())
                        .single();
                    memberId = existing?.id;

                    if (!memberId) {
                        const { data: newMember } = await supabaseAdmin
                            .from('members')
                            .insert({ email: memberEmail.toLowerCase(), full_name: memberName, display_name: memberName })
                            .select()
                            .single();
                        memberId = newMember?.id;
                    }
                } else {
                    const { data: existing } = await supabaseAdmin
                        .from('members')
                        .select('id')
                        .eq('full_name', memberName)
                        .limit(1);
                    memberId = existing?.[0]?.id;
                }

                if (memberId) {
                    await supabaseAdmin
                        .from('team_memberships')
                        .upsert({ team_id: id, member_id: memberId, role: 'member' }, { onConflict: 'team_id,member_id' });
                }
            }
        }

        const { data: updated } = await supabaseAdmin
            .from('teams')
            .select('*')
            .eq('id', id)
            .single();

        return c.json(updated);
    } catch (err) {
        console.error('Update team error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.delete('/api/teams/delete', async (c) => {
    const auth = c.get('auth');
    if (!auth || !auth.memberId) return unauthorized(c);

    const id = c.req.query('id');
    if (!id) return c.json({ error: 'Team id required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        const { data: team } = await supabaseAdmin
            .from('teams')
            .select('department_id')
            .eq('id', id)
            .single();

        if (!team) return c.json({ error: 'Team not found' }, 404);
        if (!canEditDepartment(auth, team.department_id) && !auth.isPlatformAdmin) {
            return c.json({ error: 'Edit access required' }, 403);
        }

        const { error } = await supabaseAdmin
            .from('teams')
            .delete()
            .eq('id', id);

        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true });
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

// ============================================================
// MEMBER EMAILS ROUTES (backward compat)
// ============================================================

app.get('/api/teams/emails', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    try {
        const departmentId = c.get('departmentId');

        // No department filter — return all active members
        if (!departmentId) {
            const { data, error } = await supabaseAdmin
                .from('members')
                .select('id, name:full_name, email, display_name, is_active')
                .eq('is_active', true);
            if (error) return c.json({ error: error.message }, 500);
            return c.json(data);
        }

        // With department filter — get teams in department first, then their members
        const { data: deptTeams } = await supabaseAdmin
            .from('teams')
            .select('id')
            .eq('department_id', departmentId);

        if (!deptTeams || deptTeams.length === 0) {
            return c.json([]);
        }

        const teamIds = deptTeams.map(t => t.id);

        const { data: memberships } = await supabaseAdmin
            .from('team_memberships')
            .select('member_id')
            .in('team_id', teamIds);

        if (!memberships || memberships.length === 0) {
            return c.json([]);
        }

        const memberIds = [...new Set(memberships.map(m => m.member_id))];

        const { data, error } = await supabaseAdmin
            .from('members')
            .select('id, name:full_name, email, display_name, is_active')
            .eq('is_active', true)
            .in('id', memberIds);

        if (error) return c.json({ error: error.message }, 500);
        return c.json(data);
    } catch (err) {
        console.error('teams/emails error:', err);
        return c.json({ error: err.message || 'Internal server error' }, 500);
    }
});

app.post('/api/teams/emails', async (c) => {
    const auth = c.get('auth');
    if (!auth || !auth.memberId) return unauthorized(c);

    const { emails } = await c.req.json();
    if (!Array.isArray(emails)) return c.json({ error: 'emails array required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    try {
        const members = emails.map(e => ({
            email: (e.email || '').toLowerCase(),
            full_name: e.name,
            display_name: e.name,
            is_active: true
        })).filter(m => m.email && m.full_name);

        const { error } = await supabaseAdmin
            .from('members')
            .upsert(members, { onConflict: 'email', ignoreDuplicates: false });

        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true });
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

// ============================================================
// SHIFT CONFIGURATIONS ROUTES
// ============================================================

app.get('/api/teams/shift-configs', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const departmentId = c.get('departmentId');
    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        let query = supabaseAdmin.from('shift_configurations').select('*');
        if (departmentId) {
            const { data: deptTeams } = await supabaseAdmin
                .from('teams')
                .select('id')
                .eq('department_id', departmentId);
            if (deptTeams && deptTeams.length > 0) {
                query = query.in('team_id', deptTeams.map(t => t.id));
            }
        }

        const { data, error } = await query;
        if (error) return c.json({ error: error.message }, 500);
        return c.json(data);
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.post('/api/teams/shift-configs', async (c) => {
    const auth = c.get('auth');
    if (!auth || !auth.memberId) return unauthorized(c);

    const { configs } = await c.req.json();
    if (!Array.isArray(configs)) return c.json({ error: 'configs array required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    try {
        const { error } = await supabaseAdmin
            .from('shift_configurations')
            .upsert(configs, { onConflict: 'team_id,shift_name' });

        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true });
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.delete('/api/teams/shift-configs', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const id = c.req.query('id');
    if (!id) return c.json({ error: 'Config id required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    try {
        const { error } = await supabaseAdmin
            .from('shift_configurations')
            .delete()
            .eq('id', id);
        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true });
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

// ============================================================
// SHIFT LEGENDS (per-department, admin-configurable status styles)
// ============================================================

app.get('/api/shift-legends', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const departmentId = c.req.query('department_id') || c.get('departmentId');
    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        let query = supabaseAdmin
            .from('shift_legends')
            .select('*')
            .order('sort_order')
            .order('label');

        if (departmentId) {
            query = query.eq('department_id', departmentId);
        } else if (!auth.isPlatformAdmin && auth.allDepartmentIds?.length > 0) {
            query = query.in('department_id', auth.allDepartmentIds);
        }

        const { data, error } = await query;
        if (error) return c.json({ error: error.message }, 500);
        return c.json(data || []);
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.post('/api/shift-legends', async (c) => {
    const auth = c.get('auth');
    if (!auth || !canEditAny(auth)) return unauthorized(c);

    const departmentId = c.get('departmentId') || c.req.query('department_id');
    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        const { legends } = await c.req.json();
        if (!Array.isArray(legends)) return c.json({ error: 'legends array required' }, 400);

        // Delete all existing legends for this department, then re-insert
        if (departmentId) {
            await supabaseAdmin.from('shift_legends').delete().eq('department_id', departmentId);
        }

        const rows = legends.map((l, i) => ({
            department_id: departmentId || null,
            status_code: l.status_code,
            label: l.label,
            color: l.color || '#888888',
            text_color: l.text_color || '#ffffff',
            is_holiday: l.is_holiday || false,
            is_off: l.is_off || false,
            sort_order: i
        }));

        const { data, error } = await supabaseAdmin.from('shift_legends').insert(rows).select();
        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true, data });
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.delete('/api/shift-legends', async (c) => {
    const auth = c.get('auth');
    if (!auth || !canEditAny(auth)) return unauthorized(c);

    const id = c.req.query('id');
    if (!id) return c.json({ error: 'id required' }, 400);

    const supabaseAdmin = getSupabaseAdmin(c.env);
    try {
        const { error } = await supabaseAdmin.from('shift_legends').delete().eq('id', id);
        if (error) return c.json({ error: error.message }, 500);
        return c.json({ success: true });
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

// ============================================================
// ADMIN ROUTES (role-aware)
// ============================================================

app.get('/api/admin', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const action = c.req.query('action');

    try {
        if (action === 'check') {
            return c.json({
                isPlatformAdmin: auth.isPlatformAdmin,
                isOnboarded: auth.isOnboarded,
                memberId: auth.memberId,
                memberName: auth.memberName,
                roles: auth.roles,
                departments: auth.departments,
                canEdit: canEditAny(auth)
            });
        }

        if (action === 'list') {
            // Platform admins can see all; dept_admins can see their dept
            if (!auth.isPlatformAdmin && !canEditAny(auth)) {
                return c.json({ error: 'Admin access required' }, 403);
            }

            const supabaseAdmin = getSupabaseAdmin(c.env);

            if (auth.isPlatformAdmin) {
                // Platform admins see both platform_admins and all department_roles
                const { data: platAdmins, error: err1 } = await supabaseAdmin
                    .from('platform_admins')
                    .select('*, members!platform_admins_member_id_fkey(full_name, email)')
                    .order('created_at', { ascending: true });

                const { data: deptRoles, error: err2 } = await supabaseAdmin
                    .from('department_roles')
                    .select('*, members!department_roles_member_id_fkey(full_name, email), departments(name)')
                    .order('created_at', { ascending: true });

                if (err1) return c.json({ error: err1.message }, 500);
                if (err2) return c.json({ error: err2.message }, 500);

                const platWithRole = (platAdmins || []).map(a => ({ ...a, role: 'platform_admin' }));
                return c.json({ admins: [...platWithRole, ...(deptRoles || [])] });
            }

            // For dept_admins: return their department roles
            const { data, error } = await supabaseAdmin
                .from('department_roles')
                .select('*, members!department_roles_member_id_fkey(full_name, email), departments(name)')
                .in('department_id', auth.allDepartmentIds)
                .order('created_at', { ascending: true });

            if (error) return c.json({ error: error.message }, 500);
            return c.json({ admins: data });
        }

        if (action === 'dept-admins') {
            // List department admins for a department
            const departmentId = c.get('departmentId');
            if (!departmentId) return c.json({ error: 'department_id required' }, 400);

            const supabaseAdmin = getSupabaseAdmin(c.env);
            const { data, error } = await supabaseAdmin
                .from('department_roles')
                .select('*, members!department_roles_member_id_fkey(full_name, email)')
                .eq('department_id', departmentId);

            if (error) return c.json({ error: error.message }, 500);
            return c.json({ roles: data });
        }

        return c.json({ error: 'Action not found' }, 404);
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.post('/api/admin', async (c) => {
    const auth = c.get('auth');
    if (!auth || !auth.memberId) return unauthorized(c);

    const action = c.req.query('action');
    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        if (action === 'add' || action === 'remove') {
            const { email, role, department_id } = await c.req.json();
            if (!email) return c.json({ error: 'Email required' }, 400);

            // Resolve target member
            let targetMemberId;
            const cleanEmail = email.toLowerCase().trim();
            const { data: targetMember } = await supabaseAdmin
                .from('members')
                .select('id, email')
                .eq('email', cleanEmail)
                .single();

            if (!targetMember) {
                if (action === 'remove') return c.json({ error: 'Member not found' }, 404);

                // Pre-register unseen user exclusively for admin assignments
                const namePrefix = cleanEmail.split('@')[0];
                const { data: newMember, error: insertError } = await supabaseAdmin
                    .from('members')
                    .insert({
                        email: cleanEmail,
                        full_name: namePrefix,
                        display_name: namePrefix
                    })
                    .select('id')
                    .single();

                if (insertError) return c.json({ error: 'Failed to pre-register member' }, 500);
                targetMemberId = newMember.id;
            } else {
                targetMemberId = targetMember.id;
            }

            if (role === 'platform_admin') {
                // Only platform admins can manage platform admins
                if (!auth.isPlatformAdmin) return c.json({ error: 'Platform admin required' }, 403);

                if (action === 'add') {
                    const { error } = await supabaseAdmin
                        .from('platform_admins')
                        .insert({ member_id: targetMemberId, granted_by: auth.memberId });
                    if (error) return c.json({ error: error.code === '23505' ? 'Already a platform admin' : error.message }, error.code === '23505' ? 409 : 500);
                } else {
                    if (targetMemberId === auth.memberId) return c.json({ error: 'Cannot remove yourself' }, 400);
                    await supabaseAdmin.from('platform_admins').delete().eq('member_id', targetMemberId);
                }
            } else if (role === 'dept_admin' || role === 'dept_lead') {
                // Department-scoped role management
                if (!department_id) return c.json({ error: 'department_id required for dept roles' }, 400);
                if (!canEditDepartment(auth, department_id) && !auth.isPlatformAdmin) {
                    return c.json({ error: 'Dept admin access required' }, 403);
                }

                if (action === 'add') {
                    const { error } = await supabaseAdmin
                        .from('department_roles')
                        .insert({ member_id: targetMemberId, department_id, role, granted_by: auth.memberId });
                    if (error) return c.json({ error: error.message }, 500);
                } else {
                    await supabaseAdmin
                        .from('department_roles')
                        .delete()
                        .eq('member_id', targetMemberId)
                        .eq('department_id', department_id)
                        .eq('role', role);
                }
            } else {
                return c.json({ error: 'Invalid role. Use: platform_admin, dept_admin, dept_lead' }, 400);
            }

            return c.json({ success: true });
        }

        return c.json({ error: 'Action not found' }, 404);
    } catch (err) {
        console.error('Admin action error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

// ============================================================
// REQUESTS ROUTES
// ============================================================

app.get('/api/requests', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);

    const action = c.req.query('action');
    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        if (action === 'whoami') {
            return c.json({
                name: auth.memberName,
                email: auth.memberEmail,
                memberId: auth.memberId,
                team: null,  // resolved on demand
                isPlatformAdmin: auth.isPlatformAdmin,
                roles: auth.roles,
                departments: auth.departments
            });
        }

        if (action === 'my-requests') {
            if (!auth.memberId) return c.json({ requests: [] });

            const { data, error } = await supabaseAdmin
                .from('leave_requests')
                .select('*, teams(name)')
                .eq('requester_id', auth.memberId)
                .order('created_at', { ascending: false })
                .limit(50);

            if (error) return c.json({ error: error.message }, 500);
            return c.json({ requests: data });
        }

        if (action === 'pending' || action === 'all') {
            // Dept admins and platform admins can see requests
            if (!canEditAny(auth)) return c.json({ error: 'Admin access required' }, 403);

            const departmentId = c.get('departmentId');
            let query = supabaseAdmin
                .from('leave_requests')
                .select('*, members!leave_requests_requester_id_fkey(full_name, email), teams(name, department_id)');

            if (action === 'pending') {
                query = query.eq('status', 'pending').order('created_at', { ascending: true });
            } else {
                query = query.order('created_at', { ascending: false }).limit(100);
            }

            // Filter by department access
            if (!auth.isPlatformAdmin && auth.allDepartmentIds.length > 0) {
                const { data: deptTeams } = await supabaseAdmin
                    .from('teams')
                    .select('id')
                    .in('department_id', auth.allDepartmentIds);
                if (deptTeams) {
                    query = query.in('team_id', deptTeams.map(t => t.id));
                }
            }

            const { data, error } = await query;
            if (error) return c.json({ error: error.message }, 500);
            return c.json({ requests: data });
        }

        return c.json({ error: 'Action not found' }, 404);
    } catch (err) {
        console.error('Requests error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

app.post('/api/requests', async (c) => {
    const auth = c.get('auth');
    if (!auth || !auth.memberId) return unauthorized(c);

    const action = c.req.query('action');
    const supabaseAdmin = getSupabaseAdmin(c.env);

    try {
        if (action === 'create') {
            const { request_type, dates, reason } = await c.req.json();
            if (!request_type || !dates || !dates.length) return c.json({ error: 'request_type and dates required' }, 400);
            if (!['PL', 'WL', 'WFH'].includes(request_type)) return c.json({ error: 'Invalid request_type' }, 400);

            // Find member's primary team
            const { data: membership } = await supabaseAdmin
                .from('team_memberships')
                .select('team_id')
                .eq('member_id', auth.memberId)
                .limit(1);

            const teamId = membership?.[0]?.team_id;
            if (!teamId) return c.json({ error: 'You are not in any team' }, 400);

            const { data, error } = await supabaseAdmin
                .from('leave_requests')
                .insert({
                    requester_id: auth.memberId,
                    team_id: teamId,
                    request_type,
                    dates,
                    reason: reason || null,
                    status: 'pending'
                })
                .select()
                .single();

            if (error) return c.json({ error: error.message }, 500);
            return c.json({ success: true, request: data });
        }

        if (action === 'review') {
            if (!canEditAny(auth)) return c.json({ error: 'Admin access required' }, 403);

            const { id, decision } = await c.req.json();
            if (!id || !['approved', 'declined'].includes(decision)) return c.json({ error: 'id and decision required' }, 400);

            const { data: request, error: updateError } = await supabaseAdmin
                .from('leave_requests')
                .update({
                    status: decision,
                    reviewed_by: auth.memberId,
                    reviewed_at: new Date().toISOString()
                })
                .eq('id', id)
                .select()
                .single();

            if (updateError) return c.json({ error: updateError.message }, 500);

            // Auto-populate roster on approval
            if (decision === 'approved' && request) {
                for (const date of request.dates) {
                    await supabaseAdmin
                        .from('roster')
                        .upsert({
                            date,
                            member_id: request.requester_id,
                            team_id: request.team_id,
                            status: request.request_type,
                            updated_by: auth.memberId
                        }, { onConflict: 'date,member_id,team_id' });
                }
            }

            return c.json({ success: true, request });
        }

        return c.json({ error: 'Action not found' }, 404);
    } catch (err) {
        console.error('Request action error:', err);
        return c.json({ error: 'Internal server error' }, 500);
    }
});

// ============================================================
// AI ROSTER GENERATOR (Full Gemini integration)
// ============================================================
app.post('/api/roster/generate', async (c) => {
    const auth = c.get('auth');
    if (!auth) return unauthorized(c);
    if (!canEditAny(auth)) return c.json({ error: 'Edit access required' }, 403);

    if (!c.env.GEMINI_API_KEY) {
        return c.json({ error: 'GEMINI_API_KEY is not configured.' }, 501);
    }

    try {
        const body = await c.req.json();
        const slackThread = body.slack_thread || '';
        const notes = body.notes || '';
        const month = parseInt(body.month) || new Date().getMonth() + 1;
        const year = parseInt(body.year) || new Date().getFullYear();
        const team = body.team_name || body.team;
        const teamMembers = body.team_members;
        const customPrompt = body.custom_prompt || body.prompt;

        if (!team || !teamMembers || !customPrompt) {
            return c.json({ error: "Missing required inputs: team_name, team_members, or custom_prompt." }, 400);
        }

        const supabaseAdmin = getSupabaseAdmin(c.env);
        const departmentId = c.get('departmentId');

        // Resolve team_id
        const teamId = await resolveTeamId(supabaseAdmin, team, departmentId);
        if (!teamId) return c.json({ error: 'Team not found' }, 404);

        // Date helpers
        const monthNames = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const lastDay = new Date(year, month, 0).getDate();
        const monthName = monthNames[month];
        const startDateStr = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDateStr = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
        const monthPadded = String(month).padStart(2, '0');

        // Step 1: Check existing and delete
        const { data: existingRoster } = await supabaseAdmin
            .from('roster')
            .select('id')
            .eq('team_id', teamId)
            .gte('date', startDateStr)
            .limit(1);

        if (existingRoster && existingRoster.length > 0) {
            await supabaseAdmin
                .from('roster')
                .delete()
                .eq('team_id', teamId)
                .gte('date', startDateStr)
                .lte('date', endDateStr);
        }


        let prevYear = year;
        let prevMonth = month - 1;
        if (prevMonth === 0) {
            prevMonth = 12;
            prevYear -= 1;
        }

        const { data: prevRoster } = await supabaseAdmin
            .from('roster')
            .select(`
                date, status, shift_name,
                teams!inner(name),
                members!inner(full_name, display_name)
            `)
            .eq('teams.name', team)
            .gte('date', `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`)
            .lte('date', `${prevYear}-${String(prevMonth).padStart(2, '0')}-${new Date(prevYear, prevMonth, 0).getDate()}`);

        let previousMonthData = "";
        if (prevRoster && prevRoster.length > 0) {
            const grouped = {};
            prevRoster.forEach(r => {
                const name = r.members?.display_name || r.members?.full_name || 'Unknown';
                if (!grouped[name]) grouped[name] = [];
                const day = parseInt(r.date.split('-')[2], 10);
                const status = r.status.replace(/ /g, '');
                grouped[name].push({ day, str: `${day}(${status})` });
            });

            let contextStr = "### PREVIOUS MONTH ROSTER (Format: DD(Status))\n";
            for (const [name, shifts] of Object.entries(grouped)) {
                shifts.sort((a, b) => a.day - b.day);
                contextStr += `${name}: ${shifts.map(s => s.str).join(',')}\n`;
            }

            const firstDayOfMonth = new Date(year, month - 1, 1).getDay();
            let boundaryInstruction = '';

            if (firstDayOfMonth === 0) {
                const lastDayPrevMonth = new Date(prevYear, prevMonth, 0).getDate();
                const lastDateStr = `${prevYear}-${String(prevMonth).padStart(2, '0')}-${lastDayPrevMonth}`;

                const workingOnSaturday = prevRoster
                    .filter(r => r.date === lastDateStr && r.status && !['WO', 'PL', 'OH', 'Holiday'].includes(r.status))
                    .map(r => `${r.members?.display_name || r.members?.full_name} (${r.status})`);

                if (workingOnSaturday.length > 0) {
                    boundaryInstruction = `\n\n**CRITICAL - MONTH BOUNDARY RULE:**\nThe last day of the previous month was a Saturday. The following people worked: ${workingOnSaturday.join(', ')}. Since the 1st of the new month is a Sunday, these SAME people MUST work on the 1st to maintain weekend continuity.`;
                }
            }
            previousMonthData = contextStr + boundaryInstruction;
        }

        const combinedInput = `${slackThread}\n\nMore notes:\n${notes}`;
        let finalPrompt = customPrompt
            .replace(/\{\{TEAM_NAME\}\}/g, team)
            .replace(/\{\{MONTH_NAME\}\}/g, monthName)
            .replace(/\{\{YEAR\}\}/g, year)
            .replace(/\{\{TEAM_MEMBERS\}\}/g, JSON.stringify(teamMembers))
            .replace(/\{\{SLACK_REQUESTS\}\}/g, combinedInput)
            .replace(/\{\{START_DATE\}\}/g, startDateStr)
            .replace(/\{\{END_DATE\}\}/g, endDateStr)
            .replace(/\{\{MONTH_PADDED\}\}/g, monthPadded)
            .replace(/\{\{PREVIOUS_MONTH_DATA\}\}/g, previousMonthData || '');

        return streamSSE(c, async (stream) => {
            try {
                const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${c.env.GEMINI_API_KEY}`;

                const response = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: finalPrompt + '\n\nIMPORTANT: Please "think aloud" first by explaining your scheduling logic and breaking down the month rules step-by-step. Wrap all your thoughts inside <thinking>...</thinking> tags. After you are done thinking, output the final roster EXACTLY as a JSON array wrapped in ```json fences.' }] }],
                        generationConfig: {
                            temperature: 0.4,
                            maxOutputTokens: 65536
                        }
                    })
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    console.error("Gemini Failure:", errorText);
                    await stream.writeSSE({ event: 'error', data: errorText });
                    return;
                }

                let fullContent = "";
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                // Safely proxy chunked stream
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const decoded = decoder.decode(value, { stream: true });
                    buffer += decoded;
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // Hold back partial trailing string

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const dataStr = line.slice(6).trim();
                            if (!dataStr || dataStr === '[DONE]') continue;
                            try {
                                const payload = JSON.parse(dataStr);
                                const textChunk = payload.candidates?.[0]?.content?.parts?.[0]?.text;
                                if (textChunk) {
                                    fullContent += textChunk;
                                    await stream.writeSSE({ data: JSON.stringify({ chunk: textChunk }) });
                                }
                            } catch (e) {
                                // Ignore unparseable fragmented lines
                            }
                        }
                    }
                }

                // Parse the finalized JSON buffer
                let cleanJson = fullContent.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                const startIdx = cleanJson.indexOf('[');
                const endIdx = cleanJson.lastIndexOf(']');
                if (startIdx === -1 || endIdx === -1) {
                    await stream.writeSSE({ event: 'error', data: 'No valid JSON array generated.' });
                    return;
                }

                const rosterData = JSON.parse(cleanJson.substring(startIdx, endIdx + 1));
                if (!Array.isArray(rosterData) || rosterData.length === 0) {
                    await stream.writeSSE({ event: 'error', data: 'Generated roster is empty.' });
                    return;
                }

                // Verify structure
                for (const item of rosterData) {
                    if (!item.Date || !item.Name || !item.Status) {
                        await stream.writeSSE({ event: 'error', data: 'Outputs missing required fields.' });
                        return;
                    }
                }

                // Save directly to Supabase via bulk pipeline
                const { data: members } = await supabaseAdmin.from('members').select('id, full_name, display_name').eq('is_active', true);
                const memberMap = new Map();
                if (members) {
                    members.forEach(m => {
                        if (m.full_name) memberMap.set(m.full_name.toLowerCase(), m.id);
                        if (m.display_name) memberMap.set(m.display_name.toLowerCase(), m.id);
                    });
                }
                const { data: teamsData } = await supabaseAdmin.from('teams').select('id, name');
                const teamMap = new Map();
                if (teamsData) {
                    teamsData.forEach(t => teamMap.set(t.name.toLowerCase(), t.id));
                }

                const resolvedTeamId = teamMap.get(team.toLowerCase());
                const entries = [];
                rosterData.forEach(item => {
                    const fallbackId = item.MemberId || item.Id || null;
                    const resolvedId = memberMap.get(item.Name.toLowerCase()) || fallbackId;
                    if (resolvedId && resolvedTeamId) {
                        entries.push({
                            date: item.Date,
                            member_id: resolvedId,
                            status: item.Status,
                            shift_name: item.ShiftName || null,
                            team_id: resolvedTeamId,
                            updated_by: auth.memberId
                        });
                    }
                });

                if (entries.length === 0) {
                    await stream.writeSSE({ event: 'error', data: 'Zero resolvable records against DB logic.' });
                    return;
                }

                const BATCH_SIZE = 50;
                let upsertedCount = 0;
                for (let i = 0; i < entries.length; i += BATCH_SIZE) {
                    const batch = entries.slice(i, i + BATCH_SIZE);
                    const { error: upsertErr } = await supabaseAdmin.from('roster').upsert(batch, { onConflict: 'date,member_id,team_id' });
                    if (upsertErr) {
                        await stream.writeSSE({ event: 'error', data: `Upsert failing: ${upsertErr.message}` });
                        return;
                    }
                    upsertedCount += batch.length;
                }

                await stream.writeSSE({ event: 'complete', data: JSON.stringify({ success: true, count: upsertedCount }) });
            } catch (err) {
                console.error('SSE Generator Error:', err);
                await stream.writeSSE({ event: 'error', data: err.message || 'Fatal crash streaming' });
            }
        });
    } catch (err) {
        console.error('Initial Roster error:', err);
        return c.json({ success: false, error: err.message }, 500);
    }
});

// ============================================================
// AUTH ENDPOINT
// ============================================================
app.post('/api/auth', async (c) => {
    const action = c.req.query('action');
    const supabaseAuth = getSupabaseAuth(c.env);

    try {
        if (action === 'google') {
            const { redirectTo } = await c.req.json();
            const { data, error } = await supabaseAuth.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: redirectTo || 'http://localhost:5173',
                    queryParams: { access_type: 'offline', prompt: 'consent' }
                }
            });
            if (error) return c.json({ error: error.message }, 400);
            // Rewrite Supabase auth URL to go through the proxy so browser
            // doesn't need direct access to port 54321 (needed for tunnel)
            const supabaseBase = c.env.SUPABASE_URL || 'http://127.0.0.1:54321';
            const requestHost = c.req.header('host') || 'localhost:8787';
            const requestProto = c.req.header('x-forwarded-proto') || (c.req.url.startsWith('https') ? 'https' : 'http');
            const proxyBase = `${requestProto}://${requestHost}/supabase`;
            const browserUrl = data.url.replace(supabaseBase, proxyBase);
            return c.json({ url: browserUrl });
        }

        if (action === 'refresh') {
            const { refresh_token } = await c.req.json();
            if (!refresh_token) return c.json({ error: 'refresh_token required' }, 400);

            const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });
            if (error) return c.json({ error: error.message }, 401);

            return c.json({
                access_token: data.session.access_token,
                refresh_token: data.session.refresh_token,
                expires_at: data.session.expires_at,
                user: { id: data.user.id, email: data.user.email }
            });
        }

        return c.json({ error: 'Auth endpoint not found' }, 404);
    } catch (err) {
        return c.json({ error: 'Internal server error' }, 500);
    }
});

// ============================================================
// FRESHDESK AGENT AVAILABILITY
// ============================================================
app.get('/api/freshdesk/availability', async (c) => {
    try {
        const auth = c.get('auth');
        if (!auth) return unauthorized(c);

        const email = c.req.query('email');
        if (!email) return c.json({ error: 'Email parameter required' }, 400);

        const freshdeskToken = btoa(`${c.env.FRESHDESK_AUTH_TOKEN}:X`);

        const agentLookupRes = await fetch(
            `https://razorpay-ind.freshdesk.com/api/v2/agents?email=${encodeURIComponent(email)}`,
            { headers: { 'Authorization': `Basic ${freshdeskToken}`, 'Content-Type': 'application/json' } }
        );

        if (!agentLookupRes.ok) return c.json({ error: 'Failed to lookup agent' }, agentLookupRes.status);

        const agents = await agentLookupRes.json();
        if (!agents || agents.length === 0) return c.json({ available: false, status: 'Not Found' });

        const agentId = agents[0].id;
        const availRes = await fetch(
            `https://razorpay-ind.freshdesk.com/api/v2/agents/${agentId}/availability`,
            { headers: { 'Authorization': `Basic ${freshdeskToken}`, 'Content-Type': 'application/json' } }
        );

        if (!availRes.ok) return c.json({ error: 'Failed to fetch availability' }, availRes.status);

        const availData = await availRes.json();
        if (availData?.channel_availability?.length > 0) {
            const fdChannel = availData.channel_availability.find(ch => ch.channel === 'freshdesk') || availData.channel_availability[0];
            const isAvailable = fdChannel.status_id === 59601 || fdChannel.available === true;
            return c.json({ available: isAvailable, agent_id: agentId });
        }

        return c.json({ available: false, agent_id: agentId });
    } catch (err) {
        return c.json({ error: err.message }, 500);
    }
});

app.post('/api/freshdesk/availability/toggle', async (c) => {
    try {
        const auth = c.get('auth');
        if (!auth) return unauthorized(c);

        const { email, action } = await c.req.json();
        if (!email || !action) return c.json({ error: 'Email and action required' }, 400);
        if (action !== 'enable' && action !== 'disable') return c.json({ error: 'Action must be enable/disable' }, 400);

        const freshdeskToken = btoa(`${c.env.FRESHDESK_AUTH_TOKEN}:X`);

        const agentLookupRes = await fetch(
            `https://razorpay-ind.freshdesk.com/api/v2/agents?email=${encodeURIComponent(email)}`,
            { headers: { 'Authorization': `Basic ${freshdeskToken}`, 'Content-Type': 'application/json' } }
        );

        if (!agentLookupRes.ok) return c.json({ error: 'Failed to lookup agent' }, agentLookupRes.status);

        const agents = await agentLookupRes.json();
        if (!agents || agents.length === 0) return c.json({ error: 'Agent not found' }, 404);

        const agentId = agents[0].id;
        const statusId = action === 'enable' ? 59601 : 59602;

        const updateRes = await fetch(
            `https://razorpay-ind.freshdesk.com/api/v2/agents/${agentId}/availability`,
            {
                method: 'PATCH',
                headers: { 'Authorization': `Basic ${freshdeskToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ channel_availability: [{ channel: 'freshdesk', status_id: statusId }] })
            }
        );

        if (!updateRes.ok) return c.json({ error: `Failed to ${action} agent` }, updateRes.status);
        return c.json({ success: true, message: `Agent availability updated to ${action}` });
    } catch (err) {
        return c.json({ error: err.message }, 500);
    }
});

export default app;
