const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://roster-api-v2.jha-ashish.workers.dev';

let _useSheetsMode = false;
let _sheetsApi = null;

async function getSheetsApi() {
  if (!_sheetsApi) _sheetsApi = await import('./sheetsApi');
  return _sheetsApi;
}

export function setDataLayerMode(useSheets) { _useSheetsMode = useSheets; }
export function getDataLayerMode() { return _useSheetsMode; }

// ==================== AUTH HELPERS ====================

export function getToken() {
    const session = getSession();
    return session?.access_token || null;
}

export async function signInWithGoogle() {
    const res = await fetch(`${API_BASE}/api/auth?action=google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirectTo: window.location.origin + import.meta.env.BASE_URL })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to initialize Google Login');
    window.location.href = data.url;
}

export function handleAuthCallback() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token=')) return null;

    try {
        const params = new URLSearchParams(hash.substring(1));
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        const expires_in = params.get('expires_in');

        if (access_token) {
            let userEmail = 'unknown@razorpay.com';
            try {
                const payload = JSON.parse(atob(access_token.split('.')[1]));
                userEmail = payload.email || userEmail;
            } catch (e) { /* fallback */ }

            const sessionData = {
                access_token,
                refresh_token,
                expires_at: Math.floor(Date.now() / 1000) + parseInt(expires_in || '3600'),
                user: { email: userEmail }
            };
            localStorage.setItem('roster_session', JSON.stringify(sessionData));
            window.history.replaceState(null, '', window.location.pathname + window.location.search);
            return sessionData;
        }
    } catch (err) {
        console.error("Error processing auth callback", err);
    }
    return null;
}

export function getSession() {
    const session = localStorage.getItem('roster_session');
    if (!session) return null;
    try { return JSON.parse(session); } catch { return null; }
}

export function isLoggedIn() { return !!getToken(); }
export function getUserEmail() { const s = getSession(); return s?.user?.email || null; }
export function logout() { localStorage.removeItem('roster_session'); }

let isRefreshing = false;
let refreshPromise = null;

async function doTokenRefresh(refreshToken) {
    try {
        const res = await fetch(`${API_BASE}/api/auth?action=refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Refresh failed');
        localStorage.setItem('roster_session', JSON.stringify(data));
        return data.access_token;
    } catch (err) {
        logout();
        window.location.reload();
        throw err;
    }
}

async function authFetch(path, options = {}) {
    let session = getSession();
    if (!session?.access_token) throw new Error('Not authenticated');

    const expiresAt = session.expires_at ? session.expires_at * 1000 : 0;
    const isExpiringSoon = expiresAt > 0 && (expiresAt - Date.now() < 5 * 60 * 1000);

    if (isExpiringSoon && session.refresh_token) {
        if (!isRefreshing) {
            isRefreshing = true;
            refreshPromise = doTokenRefresh(session.refresh_token).finally(() => {
                isRefreshing = false;
                refreshPromise = null;
            });
        }
        try {
            await refreshPromise;
            session = getSession();
        } catch (e) {
            console.error('Auto token refresh failed', e);
        }
    }

    const token = session?.access_token;
    if (!token) throw new Error('Not authenticated');

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...options.headers
    };

    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

    if (res.status === 401) {
        logout();
        window.location.reload();
        throw new Error('Session expired');
    }

    return res;
}

// ==================== DEPARTMENT FUNCTIONS ====================

export async function getDepartments() {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.getDepartments(); }
    const res = await authFetch('/api/departments');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function createDriveSheetForDept(departmentId, departmentName, tabConfigs) {
    const s = await getSheetsApi();
    return s.createDriveSheetForDept(departmentId, departmentName, tabConfigs);
}

export async function importFromGoogleSheet(sheetUrl) {
    const s = await getSheetsApi();
    return s.importFromGoogleSheet(sheetUrl);
}

export async function createDepartment(name, slug) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.createDepartment(name, slug); }
    const res = await authFetch('/api/departments', {
        method: 'POST',
        body: JSON.stringify({ name, slug })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function updateDepartment(id, updates) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.updateDepartment(id, updates); }
    const res = await authFetch('/api/departments', {
        method: 'PUT',
        body: JSON.stringify({ id, ...updates })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function getDepartmentMembers(departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.getDepartmentMembers(departmentId); }
    const res = await authFetch(`/api/departments/members?department_id=${departmentId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

// ==================== ROSTER FUNCTIONS ====================

export async function fetchRoster(year, month, teamId, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.fetchRoster(year, month, teamId, departmentId); }
    const params = new URLSearchParams({ year, month });
    if (teamId) params.set('team_id', teamId);
    if (departmentId) params.set('department_id', departmentId);

    const res = await authFetch(`/api/roster/fetch?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function fetchAllTeamsRoster(year, month, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.fetchAllTeamsRoster(year, month, departmentId); }
    const params = new URLSearchParams({ year, month });
    if (departmentId) params.set('department_id', departmentId);

    const res = await authFetch(`/api/roster/fetch-all?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function checkRosterExists(year, month, teamId, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.checkRosterExists(year, month, teamId, departmentId); }
    const params = new URLSearchParams({ year, month, team_id: teamId });
    if (departmentId) params.set('department_id', departmentId);

    const res = await authFetch(`/api/roster/exists?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.exists;
}

export async function deleteRoster(year, month, teamId, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.deleteRoster(year, month, teamId, departmentId); }
    const params = new URLSearchParams({ year, month, team_id: teamId });
    if (departmentId) params.set('department_id', departmentId);

    const res = await authFetch(`/api/roster/delete?${params}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.success;
}

export async function updateRosterEntry(date, memberId, status, teamId, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.updateRosterEntry(date, memberId, status, teamId, departmentId); }
    const headers = {};
    if (departmentId) headers['X-Department-Id'] = departmentId;

    const res = await authFetch('/api/roster/update', {
        method: 'POST',
        headers,
        body: JSON.stringify({ date, member_id: memberId, status, team_id: teamId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.success;
}

export async function bulkUpdateRosterEntries(entries, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.bulkUpdateRosterEntries(entries, departmentId); }
    const headers = {};
    if (departmentId) headers['X-Department-Id'] = departmentId;

    const res = await authFetch('/api/roster/bulk-update', {
        method: 'POST',
        headers,
        body: JSON.stringify({ entries })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

// ==================== TEAM FUNCTIONS ====================

export async function getTeams(departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.getTeams(departmentId); }
    const params = new URLSearchParams();
    if (departmentId) params.set('department_id', departmentId);

    const res = await authFetch(`/api/teams/list${params.toString() ? '?' + params : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function createTeam(name, members, customPrompt, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.createTeam(name, members, customPrompt, departmentId); }
    const headers = {};
    if (departmentId) headers['X-Department-Id'] = departmentId;

    const res = await authFetch('/api/teams/create', {
        method: 'POST',
        headers,
        body: JSON.stringify({
            name,
            members,
            custom_prompt: customPrompt || null,
            department_id: departmentId
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function updateTeam(id, updates, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.updateTeam(id, updates, departmentId); }
    const headers = {};
    if (departmentId) headers['X-Department-Id'] = departmentId;

    const res = await authFetch(`/api/teams/update?id=${id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
            name: updates.name,
            members: updates.members,
            custom_prompt: updates.customPrompt !== undefined ? updates.customPrompt : updates.custom_prompt
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function deleteTeam(id, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.deleteTeam(id, departmentId); }
    const headers = {};
    if (departmentId) headers['X-Department-Id'] = departmentId;

    const res = await authFetch(`/api/teams/delete?id=${id}`, {
        method: 'DELETE',
        headers
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.success;
}

// ==================== ADMIN FUNCTIONS ====================

export async function checkAdmin() {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.checkAdmin(); }
    const res = await authFetch('/api/admin?action=check');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;  // Returns { isPlatformAdmin, canEdit, roles, departments }
}

export async function listAdmins() {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.listAdmins(); }
    const res = await authFetch('/api/admin?action=list');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.admins;
}

export async function listDeptAdmins(departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.listDeptAdmins(departmentId); }
    const res = await authFetch(`/api/admin?action=dept-admins&department_id=${departmentId}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.roles;
}

export async function addAdmin(email, role = 'platform_admin', departmentId = null) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.addAdmin(email, role, departmentId); }
    const res = await authFetch('/api/admin?action=add', {
        method: 'POST',
        body: JSON.stringify({ email, role, department_id: departmentId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function removeAdmin(email, role = 'platform_admin', departmentId = null) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.removeAdmin(email, role, departmentId); }
    const res = await authFetch('/api/admin?action=remove', {
        method: 'POST',
        body: JSON.stringify({ email, role, department_id: departmentId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

// ==================== LEAVE REQUEST FUNCTIONS ====================

export async function whoAmI() {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.whoAmI(); }
    const res = await authFetch('/api/requests?action=whoami');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function createLeaveRequest({ request_type, dates, reason }) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.createLeaveRequest({ request_type, dates, reason }); }
    const res = await authFetch('/api/requests?action=create', {
        method: 'POST',
        body: JSON.stringify({ request_type, dates, reason })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function getMyRequests() {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.getMyRequests(); }
    const res = await authFetch('/api/requests?action=my-requests');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.requests;
}

export async function getPendingRequests(departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.getPendingRequests(departmentId); }
    const params = new URLSearchParams({ action: 'pending' });
    if (departmentId) params.set('department_id', departmentId);

    const res = await authFetch(`/api/requests?${params}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data.requests;
}

export async function reviewRequest(id, decision) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.reviewRequest(id, decision); }
    const res = await authFetch('/api/requests?action=review', {
        method: 'POST',
        body: JSON.stringify({ id, decision })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

// ==================== MEMBER EMAILS FUNCTIONS ====================

export async function getTeamEmails(departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.getTeamEmails(departmentId); }
    const params = new URLSearchParams();
    if (departmentId) params.set('department_id', departmentId);
    const res = await authFetch(`/api/teams/emails${params.toString() ? '?' + params : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function updateTeamEmails(emails) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.updateTeamEmails(emails); }
    const res = await authFetch('/api/teams/emails', {
        method: 'POST',
        body: JSON.stringify({ emails })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

// ==================== SHIFT CONFIGURATIONS ====================

export async function getShiftConfigs(departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.getShiftConfigs(departmentId); }
    const params = new URLSearchParams();
    if (departmentId) params.set('department_id', departmentId);

    const res = await authFetch(`/api/teams/shift-configs${params.toString() ? '?' + params : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function saveShiftConfigs(configs) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.saveShiftConfigs(configs); }
    const res = await authFetch('/api/teams/shift-configs', {
        method: 'POST',
        body: JSON.stringify({ configs })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function deleteShiftConfig(id) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.deleteShiftConfig(id); }
    const res = await authFetch(`/api/teams/shift-configs?id=${id}`, {
        method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

// ==================== SHIFT LEGENDS ====================

export async function getShiftLegends(departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.getShiftLegends(departmentId); }
    const params = new URLSearchParams();
    if (departmentId) params.set('department_id', departmentId);

    const res = await authFetch(`/api/shift-legends${params.toString() ? '?' + params : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function saveShiftLegends(legends, departmentId) {
    if (_useSheetsMode) { const s = await getSheetsApi(); return s.saveShiftLegends(legends, departmentId); }
    const params = departmentId ? `?department_id=${departmentId}` : '';
    const res = await authFetch(`/api/shift-legends${params}`, {
        method: 'POST',
        body: JSON.stringify({ legends })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    return data;
}

export async function getSEBandwidth(departmentId) {
    // SE Bandwidth always reads from Google Sheets regardless of the data layer mode
    const s = await getSheetsApi();
    return s.getSEBandwidth(departmentId);
}
