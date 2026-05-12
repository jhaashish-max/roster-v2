import { getGoogleToken, googleLogout } from './googleAuth';

const MASTER_SHEET_ID = import.meta.env.VITE_GOOGLE_SHEETS_MASTER_SPREADSHEET_ID;
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';

const deptSheetCache = {};

// ==================== INTERNAL HELPERS ====================

async function sheetsFetch(url, options = {}) {
  const token = getGoogleToken();
  if (!token) throw new Error('Not authenticated with Google');
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (res.status === 401) {
    googleLogout();
    window.location.reload();
    throw new Error('Google session expired');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Sheets API error: ${res.status}`);
  }
  return res;
}

async function readRange(spreadsheetId, range) {
  const encoded = encodeURIComponent(range);
  const res = await sheetsFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encoded}?valueRenderOption=UNFORMATTED_VALUE`
  );
  const data = await res.json();
  return data.values || [];
}

async function writeRange(spreadsheetId, range, values) {
  const encoded = encodeURIComponent(range);
  await sheetsFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encoded}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values }) }
  );
}

async function appendRange(spreadsheetId, range, values) {
  const encoded = encodeURIComponent(range);
  await sheetsFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) }
  );
}

async function batchUpdate(spreadsheetId, requests) {
  await sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}

async function getSheetMetadata(spreadsheetId) {
  const res = await sheetsFetch(`${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`);
  return res.json();
}

function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i] !== undefined ? row[i] : '';
    });
    return obj;
  });
}

function objectsToRows(objects, headers) {
  return objects.map(obj => headers.map(h => obj[h] !== undefined ? obj[h] : ''));
}

// ==================== DEPT SPREADSHEET LOOKUP ====================

async function getDeptSpreadsheetId(departmentId) {
  if (deptSheetCache[departmentId]) return deptSheetCache[departmentId];
  const rows = await readRange(MASTER_SHEET_ID, 'departments!A:D');
  const depts = rowsToObjects(rows);
  const dept = depts.find(d => d.department_id === departmentId);
  if (!dept?.spreadsheet_id) throw new Error(`No spreadsheet configured for department ${departmentId}`);
  deptSheetCache[departmentId] = dept.spreadsheet_id;
  return dept.spreadsheet_id;
}

async function tabExists(spreadsheetId, tabName) {
  const meta = await getSheetMetadata(spreadsheetId);
  return meta.sheets?.some(s => s.properties?.title === tabName) || false;
}

async function ensureTab(spreadsheetId, tabName, headers) {
  if (await tabExists(spreadsheetId, tabName)) return;
  await batchUpdate(spreadsheetId, [{ addSheet: { properties: { title: tabName } } }]);
  if (headers) {
    await writeRange(spreadsheetId, `${tabName}!A1`, [headers]);
  }
}

async function ensureRosterTab(spreadsheetId, year, month) {
  const tabName = `roster_${year}_${String(month).padStart(2, '0')}`;
  await ensureTab(spreadsheetId, tabName, ['date', 'member_id', 'status', 'team_id']);
  return tabName;
}

function generateId() {
  return crypto.randomUUID();
}

// ==================== IMPORT HELPERS ====================

export function extractSpreadsheetId(url) {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export async function importFromGoogleSheet(sheetUrl) {
  const id = extractSpreadsheetId(sheetUrl);
  if (!id) throw new Error('Invalid Google Sheets URL');
  const meta = await getSheetMetadata(id);
  const tabNames = meta.sheets.map(s => s.properties.title);
  const result = [];
  for (const tab of tabNames) {
    const rows = await readRange(id, `${tab}!A:Z`);
    result.push({
      name: tab,
      headers: rows.length > 0 ? rows[0] : [],
      data: rows.length > 1 ? rows.slice(1) : [],
    });
  }
  return result;
}

// ==================== DEPARTMENT FUNCTIONS ====================

export async function getDepartments() {
  const rows = await readRange(MASTER_SHEET_ID, 'departments!A:E');
  const raw = rowsToObjects(rows);
  return raw.map(d => ({
    id: d.department_id,
    name: d.department_name,
    slug: (d.department_name || '').toLowerCase().replace(/\s+/g, '-'),
    spreadsheet_id: d.spreadsheet_id,
    features: d.features ? d.features.split(',').map(f => f.trim()).filter(Boolean) : [],
    created_at: d.created_at || new Date().toISOString(),
  }));
}

export async function createDepartment(name, slug) {
  const id = generateId();
  try {
    await appendRange(MASTER_SHEET_ID, 'departments!A1', [
      [name, id, MASTER_SHEET_ID, '']
    ]);
  } catch (err) {
    console.error('createDepartment failed:', err);
    throw err;
  }
  return { id, name, slug, spreadsheet_id: MASTER_SHEET_ID, created_at: new Date().toISOString() };
}

export async function createDriveSheetForDept(departmentId, departmentName, tabConfigs) {
  const sheetName = `${departmentName} Roster Db`;

  const res = await sheetsFetch(DRIVE_BASE, {
    method: 'POST',
    body: JSON.stringify({
      name: sheetName,
      mimeType: 'application/vnd.google-apps.spreadsheet',
    }),
  });
  const spreadsheetData = await res.json();
  const spreadsheetId = spreadsheetData.id;

  if (tabConfigs && tabConfigs.length > 0) {
    const addSheetRequests = tabConfigs.map(t => ({ addSheet: { properties: { title: t.name } } }));
    await batchUpdate(spreadsheetId, addSheetRequests);
    for (const tab of tabConfigs) {
      if (tab.headers && tab.headers.length > 0) {
        await writeRange(spreadsheetId, `${tab.name}!A1`, [tab.headers]);
      }
      if (tab.data && tab.data.length > 0) {
        await appendRange(spreadsheetId, `${tab.name}!A1`, tab.data);
      }
    }
  }

  const rows = await readRange(MASTER_SHEET_ID, 'departments!A:E');
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[1] === departmentId);
  if (rowIndex >= 0) {
    const row = rows[rowIndex];
    while (row.length < 5) row.push('');
    row[2] = spreadsheetId;
    await writeRange(MASTER_SHEET_ID, `departments!A${rowIndex + 1}:E${rowIndex + 1}`, [row]);
  }

  deptSheetCache[departmentId] = spreadsheetId;
  return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` };
}

export async function updateDepartment(id, updates) {
  const rows = await readRange(MASTER_SHEET_ID, 'departments!A:E');
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[1] === id);
  if (rowIndex < 0) throw new Error('Department not found');

  const row = rows[rowIndex];
  while (row.length < 5) row.push('');
  if (updates.name !== undefined) row[0] = updates.name;
  if (updates.features !== undefined) {
    row[3] = Array.isArray(updates.features) ? updates.features.join(',') : updates.features;
  }
  await writeRange(MASTER_SHEET_ID, `departments!A${rowIndex + 1}:E${rowIndex + 1}`, [row]);
  return { success: true };
}

export async function getDepartmentMembers(departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'member_emails!A:C');
  return rowsToObjects(rows);
}

// ==================== TEAM FUNCTIONS ====================

export async function getTeams(departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'teams!A:E');
  const teams = rowsToObjects(rows);
  return teams.map(t => ({
    ...t,
    members: typeof t.members === 'string' ? JSON.parse(t.members || '[]') : t.members,
  }));
}

export async function createTeam(name, members, customPrompt, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const id = generateId();
  await appendRange(spreadsheetId, 'teams!A:E', [
    [id, name, JSON.stringify(members), customPrompt || '', departmentId]
  ]);
  return { id, name, members, custom_prompt: customPrompt, department_id: departmentId };
}

export async function updateTeam(id, updates, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'teams!A:E');
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === id);
  if (rowIndex < 0) throw new Error('Team not found');

  const row = rows[rowIndex];
  if (updates.name !== undefined) row[1] = updates.name;
  if (updates.members !== undefined) row[2] = JSON.stringify(updates.members);
  if (updates.customPrompt !== undefined || updates.custom_prompt !== undefined) {
    row[3] = updates.customPrompt || updates.custom_prompt || '';
  }
  await writeRange(spreadsheetId, `teams!A${rowIndex + 1}:E${rowIndex + 1}`, [row]);
  return { success: true };
}

export async function deleteTeam(id, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'teams!A:E');
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === id);
  if (rowIndex < 0) throw new Error('Team not found');

  const meta = await getSheetMetadata(spreadsheetId);
  const sheet = meta.sheets.find(s => s.properties.title === 'teams');
  if (sheet) {
    await batchUpdate(spreadsheetId, [{
      deleteDimension: {
        range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 }
      }
    }]);
  }
  return true;
}

// ==================== ROSTER FUNCTIONS ====================

export async function fetchRoster(year, month, teamId, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const tabName = `roster_${year}_${String(month).padStart(2, '0')}`;
  if (!(await tabExists(spreadsheetId, tabName))) return [];

  const rows = await readRange(spreadsheetId, `${tabName}!A:D`);
  const data = rowsToObjects(rows);
  if (teamId) return data.filter(d => d.team_id === teamId);
  return data;
}

export async function fetchAllTeamsRoster(year, month, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const tabName = `roster_${year}_${String(month).padStart(2, '0')}`;
  if (!(await tabExists(spreadsheetId, tabName))) return [];

  const rows = await readRange(spreadsheetId, `${tabName}!A:D`);
  const data = rowsToObjects(rows);
  return data.map(d => ({
    Date: d.date,
    Name: d.member_id,
    Status: d.status,
    Team: d.team_id,
  }));
}

export async function checkRosterExists(year, month, teamId, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const tabName = `roster_${year}_${String(month).padStart(2, '0')}`;
  return tabExists(spreadsheetId, tabName);
}

export async function deleteRoster(year, month, teamId, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const tabName = `roster_${year}_${String(month).padStart(2, '0')}`;
  const meta = await getSheetMetadata(spreadsheetId);
  const sheet = meta.sheets.find(s => s.properties.title === tabName);
  if (sheet) {
    await batchUpdate(spreadsheetId, [{ deleteSheet: { sheetId: sheet.properties.sheetId } }]);
  }
  return true;
}

export async function updateRosterEntry(date, memberId, status, teamId, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const year = date.substring(0, 4);
  const month = date.substring(5, 7);
  const tabName = await ensureRosterTab(spreadsheetId, year, parseInt(month));

  const rows = await readRange(spreadsheetId, `${tabName}!A:D`);
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === date && r[1] === memberId);

  if (rowIndex >= 0) {
    await writeRange(spreadsheetId, `${tabName}!A${rowIndex + 1}:D${rowIndex + 1}`, [
      [date, memberId, status, teamId]
    ]);
  } else {
    await appendRange(spreadsheetId, `${tabName}!A:D`, [[date, memberId, status, teamId]]);
  }
  return { success: true };
}

export async function bulkUpdateRosterEntries(entries, departmentId) {
  if (!entries.length) return { success: true };

  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const first = entries[0];
  const year = first.date.substring(0, 4);
  const month = first.date.substring(5, 7);
  const tabName = await ensureRosterTab(spreadsheetId, year, parseInt(month));

  const existingRows = await readRange(spreadsheetId, `${tabName}!A:D`);
  const updates = [];
  const appends = [];

  for (const entry of entries) {
    const rowIndex = existingRows.findIndex((r, i) => i > 0 && r[0] === entry.date && r[1] === entry.member_id);
    if (rowIndex >= 0) {
      updates.push({ rowIndex, values: [entry.date, entry.member_id, entry.status, entry.team_id] });
    } else {
      appends.push([entry.date, entry.member_id, entry.status, entry.team_id]);
    }
  }

  for (const u of updates) {
    await writeRange(spreadsheetId, `${tabName}!A${u.rowIndex + 1}:D${u.rowIndex + 1}`, [u.values]);
  }
  if (appends.length) {
    await appendRange(spreadsheetId, `${tabName}!A:D`, appends);
  }
  return { success: true };
}

// ==================== ADMIN FUNCTIONS ====================

async function deptNameToId(deptName) {
  if (!deptName) return '';
  const depts = await getDepartments();
  const dept = depts.find(d => d.name === deptName);
  return dept?.id || '';
}

async function deptIdToName(departmentId) {
  if (!departmentId) return '';
  const depts = await getDepartments();
  const dept = depts.find(d => d.id === departmentId);
  return dept?.name || '';
}

export async function checkAdmin() {
  const rows = await readRange(MASTER_SHEET_ID, 'admins!A:C');
  const admins = rowsToObjects(rows);
  const { getGoogleUserEmail } = await import('./googleAuth');
  const email = getGoogleUserEmail();
  if (!email) return { isPlatformAdmin: false, canEdit: false, isOnboarded: false, roles: [], departments: [] };

  const userAdmins = admins.filter(a => a.email === email);

  const depts = await getDepartments();
  const userDepts = userAdmins
    .filter(a => a.department_name)
    .map(a => {
      const dept = depts.find(d => d.name === a.department_name);
      return dept ? { id: dept.id } : null;
    })
    .filter(Boolean);

  return {
    isPlatformAdmin: userAdmins.some(a => a.role === 'platform_admin'),
    canEdit: userAdmins.length > 0,
    isOnboarded: userAdmins.length > 0,
    roles: userAdmins.map(a => a.role),
    departments: userDepts,
  };
}

export async function listAdmins() {
  const rows = await readRange(MASTER_SHEET_ID, 'admins!A:C');
  return rowsToObjects(rows);
}

export async function listDeptAdmins(departmentId) {
  const deptName = await deptIdToName(departmentId);
  const rows = await readRange(MASTER_SHEET_ID, 'admins!A:C');
  const admins = rowsToObjects(rows);
  return admins.filter(a => a.department_name === deptName);
}

export async function addAdmin(email, role, departmentId) {
  const deptName = await deptIdToName(departmentId);
  await appendRange(MASTER_SHEET_ID, 'admins!A1', [[email, role, deptName]]);
  return { success: true };
}

export async function removeAdmin(email, role, departmentId) {
  const deptName = await deptIdToName(departmentId);
  const rows = await readRange(MASTER_SHEET_ID, 'admins!A:C');
  const rowIndex = rows.findIndex((r, i) =>
    i > 0 && r[0] === email && r[1] === role && (r[2] || '') === deptName
  );
  if (rowIndex < 0) throw new Error('Admin not found');

  const meta = await getSheetMetadata(MASTER_SHEET_ID);
  const sheet = meta.sheets.find(s => s.properties.title === 'admins');
  if (sheet) {
    await batchUpdate(MASTER_SHEET_ID, [{
      deleteDimension: {
        range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 }
      }
    }]);
  }
  return { success: true };
}

// ==================== LEAVE REQUEST FUNCTIONS ====================

export async function whoAmI() {
  const token = getGoogleToken();
  if (!token) return null;
  try {
    const res = await sheetsFetch('https://www.googleapis.com/oauth2/v3/userinfo');
    return res.json();
  } catch {
    return null;
  }
}

export async function createLeaveRequest({ request_type, dates, reason }, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const user = await whoAmI();
  const id = generateId();
  const now = new Date().toISOString();
  await appendRange(spreadsheetId, 'requests!A:I', [
    [id, user?.email || '', request_type, JSON.stringify(dates), reason || '', 'pending', '', now, now]
  ]);
  return { id, status: 'pending' };
}

export async function getMyRequests(departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'requests!A:I');
  const requests = rowsToObjects(rows);
  const user = await whoAmI();
  return requests
    .filter(r => r.requester_email === user?.email)
    .map(r => ({ ...r, dates: typeof r.dates === 'string' ? JSON.parse(r.dates || '[]') : r.dates }));
}

export async function getPendingRequests(departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'requests!A:I');
  const requests = rowsToObjects(rows);
  return requests
    .filter(r => r.status === 'pending')
    .map(r => ({ ...r, dates: typeof r.dates === 'string' ? JSON.parse(r.dates || '[]') : r.dates }));
}

export async function reviewRequest(id, decision, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'requests!A:I');
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === id);
  if (rowIndex < 0) throw new Error('Request not found');

  const row = rows[rowIndex];
  row[5] = decision;
  const user = await whoAmI();
  row[6] = user?.email || '';
  row[8] = new Date().toISOString();
  await writeRange(spreadsheetId, `requests!A${rowIndex + 1}:I${rowIndex + 1}`, [row]);
  return { success: true };
}

// ==================== EMAIL & SHIFT CONFIG FUNCTIONS ====================

export async function getTeamEmails(departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'member_emails!A:C');
  return rowsToObjects(rows);
}

export async function updateTeamEmails(emails, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const headers = ['member_name', 'email', 'team_id'];
  const values = [headers, ...emails.map(e => [e.member_name, e.email, e.team_id || ''])];
  await writeRange(spreadsheetId, 'member_emails!A1', values);
  return { success: true };
}

export async function getShiftConfigs(departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'shift_configs!A:G');
  return rowsToObjects(rows);
}

export async function saveShiftConfigs(configs, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const headers = ['id', 'team_id', 'shift_name', 'start_time', 'end_time', 'start_buffer', 'end_buffer'];
  const values = [headers, ...configs.map(c => [
    c.id || generateId(), c.team_id, c.shift_name, c.start_time, c.end_time, c.start_buffer || 0, c.end_buffer || 0
  ])];
  await writeRange(spreadsheetId, 'shift_configs!A1', values);
  return { success: true };
}

export async function deleteShiftConfig(id, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'shift_configs!A:G');
  const rowIndex = rows.findIndex((r, i) => i > 0 && r[0] === id);
  if (rowIndex < 0) throw new Error('Shift config not found');

  const meta = await getSheetMetadata(spreadsheetId);
  const sheet = meta.sheets.find(s => s.properties.title === 'shift_configs');
  if (sheet) {
    await batchUpdate(spreadsheetId, [{
      deleteDimension: {
        range: { sheetId: sheet.properties.sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 }
      }
    }]);
  }
  return { success: true };
}

// ==================== SE BANDWIDTH FUNCTIONS ====================

export async function getSEBandwidth(departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'se_bandwidth!A:K');
  return rowsToObjects(rows);
}

// ==================== SHIFT LEGEND FUNCTIONS ====================

export async function getShiftLegends(departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const rows = await readRange(spreadsheetId, 'shift_legends!A:F');
  return rowsToObjects(rows);
}

export async function saveShiftLegends(legends, departmentId) {
  const spreadsheetId = await getDeptSpreadsheetId(departmentId);
  const headers = ['id', 'status_code', 'label', 'color', 'text_color', 'is_holiday'];
  const values = [headers, ...legends.map(l => [
    l.id || generateId(), l.status_code, l.label, l.color, l.text_color || '', l.is_holiday || false
  ])];
  await writeRange(spreadsheetId, 'shift_legends!A1', values);
  return { success: true };
}
