import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  Calendar,
  Users,
  Settings,
  PlusCircle,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  LayoutGrid,
  Menu,
  Shield,
  ShieldCheck,
  Table as TableIcon,
  Wand2,
  Clock,
  UserX,
  Briefcase,
  Trash2,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  Loader2,
  X,
  Edit,
  Plus,
  Save,
  Maximize2,
  Minimize2,
  PieChart,
  CalendarDays,
  Sun,
  Moon,
  LogOut,
  FileText,
  CheckSquare,
  SunMedium,
  HelpCircle,
  Phone,
  Building2,
  Palette,
  MessageSquare,
  Hash
} from 'lucide-react';
import CellEditor from './components/CellEditor';
import Summary from './components/Summary';
import CommandPalette from './components/CommandPalette';
import LoginPage from './components/LoginPage';
import Logo from './components/Logo';
import ShiftConfigModal from './components/ShiftConfigModal';
import AgentAvailability from './components/AgentAvailability';
import MiscSettings from './components/MiscSettings';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, addMonths, subMonths, isWeekend, isAfter, isBefore, parseISO, startOfDay, isSameDay } from 'date-fns';
import { fetchRoster, fetchAllTeamsRoster, checkRosterExists, deleteRoster, updateRosterEntry, getTeams, createTeam, updateTeam, deleteTeam, isLoggedIn, getUserEmail, logout as authLogout, handleAuthCallback, checkAdmin, listAdmins, addAdmin, removeAdmin, whoAmI, createLeaveRequest, getMyRequests, getPendingRequests, reviewRequest, getTeamEmails, updateTeamEmails, getShiftConfigs, saveShiftConfigs, deleteShiftConfig, getDepartments, createDepartment, getDepartmentMembers, getShiftLegends, saveShiftLegends, updateDepartment, setDataLayerMode, createDriveSheetForDept, importFromGoogleSheet } from './lib/api';
import { isGoogleLoggedIn, googleLogout, getGoogleUserEmail } from './lib/googleAuth';
import { getAvatarColor } from './lib/utils';

// N8n Webhook URL - Using Vite proxy to bypass CORS in Dev, Direct URL in Prod
const IS_DEV = import.meta.env.DEV;
const BASE_URL = IS_DEV ? '/api/n8n' : 'https://n8n-conc.razorpay.com';

const N8N_WEBHOOK_URL = `${BASE_URL}/webhook/Roster-gen-v2`;

// DevRev config
const DEVREV_TOKEN = import.meta.env.VITE_DEVREV_TOKEN || '';
const DEVREV_SPRINT_ID = import.meta.env.VITE_DEVREV_SPRINT_ID || 'don:core:dvrv-in-1:devo/2sRI6Hepzz:vista/2908:vista_group_item/7226';
const DEVREV_ORG = import.meta.env.VITE_DEVREV_ORG || 'razorpay';

// Slack config
const SLACK_BOT_TOKEN = import.meta.env.VITE_SLACK_BOT_TOKEN || '';
const SLACK_SEARCH_HANDLE = import.meta.env.VITE_SLACK_SEARCH_HANDLE || 'ps-pos-tech-oncall';
const SLACK_WORKSPACE = import.meta.env.VITE_SLACK_WORKSPACE || 'razorpay';
// Optional: pre-set the subteam ID to avoid needing usergroups:read scope
// Slack encodes @handle mentions as <!subteam^ID> — no handle name — so we must match by ID
const SLACK_SUBTEAM_ID = import.meta.env.VITE_SLACK_SUBTEAM_ID || '';
// Comma-separated Slack channel IDs to scan e.g. C12345,C67890
const SLACK_CHANNEL_IDS = (import.meta.env.VITE_SLACK_CHANNEL_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
// In dev: Vite proxies /api/slack → https://slack.com/api (bypasses CORS)
// In prod: Cloudflare Worker at VITE_API_BASE_URL must proxy /api/slack → https://slack.com/api
const SLACK_API_BASE = IS_DEV ? '/api/slack' : `${import.meta.env.VITE_API_BASE_URL}/api/slack`;

// Default prompt template for roster generation
const DEFAULT_PROMPT = `You are a Roster Manager. Generate a JSON schedule for the '{{TEAM_NAME}}' team for {{MONTH_NAME}} {{YEAR}}.

### INPUT DATA
**Team List:** {{TEAM_MEMBERS}}
**Slack Requests:** """{{SLACK_REQUESTS}}"""

{{PREVIOUS_MONTH_DATA}}

### RULES (Strict Logic)
1. **Mapping:** Fuzzy match names from Slack to the Team List. 
   - "Sheesh" -> "Ashish"
   - "Bala" -> "Jetty Bala" (if in list)
2. **Codes:** - PL (Planned Leave)
   - OH (Optional Holiday)
   - WO (Week Off)
3. **Weekend Rules (Sat/Sun):** - REQUIRES exactly 3 people working per day.
   - Shifts: Two people on "10:00 - 19:00", One person on "18:00 - 03:00".
   - The *same* 3 people must work both Saturday and Sunday of that specific weekend.
   - These 3 people MUST get 2 compensatory WOs (one in the week before, one in the week after).
   - **MONTH BOUNDARY RULE:** If the 1st of the month is a Sunday, check the PREVIOUS MONTH DATA above and assign the same people who worked on the Saturday (last day of previous month).
4. **Weekday Rules (Mon-Fri):**
   - **CONSISTENCY RULE:** Each person must be assigned ONE primary shift type (either "09:00 - 18:00" or "11:00 - 20:00") for the entire month, UNLESS they are on the Night Shift rotation. Do not switch shifts between days for the same person unless explicitly requested.
   - **Team Split:** Assign approximately 50% of the team to the Morning shift ("09:00 - 18:00") and 50% to the Afternoon shift ("11:00 - 20:00").
   - Maximize availability: Ensure WOs are spread out; do not give everyone WO on the same day.
5. **Night Shift Rule ("18:00 - 03:00"):**
   - **Requirement:** Assign exactly ONE person to the Night Shift for the first 2 weeks (Days 1-14).
   - **Rotation:** Assign a DIFFERENT person to the Night Shift for the remainder of the month (Days 15-End).
   - **EXCLUSIONS:** The following people CANNOT do night shift: Aswin A, Ashish, Manoj, Panthi Kishorbhai Patel, Ayush S, Raj Vardhan, Shehjaar Manwati.
6. **Timeline:** Generate roster from {{START_DATE}} to {{END_DATE}}.

### OUTPUT FORMAT (JSON ONLY)
Return a flat array of objects. Do not use Markdown, do not include comments.
[
    { "Date": "{{YEAR}}-{{MONTH_PADDED}}-01", "Name": "Ayush S", "Status": "09:00 - 18:00" },
    { "Date": "{{YEAR}}-{{MONTH_PADDED}}-01", "Name": "Manoj", "Status": "PL" },
    ...
]`;

// --- COMPONENTS ---

// Toast Notification
const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 4000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className={`toast toast-${type}`}>
      {type === 'success' && <CheckCircle size={18} />}
      {type === 'error' && <AlertCircle size={18} />}
      {type === 'loading' && <Loader2 size={18} className="spin" />}
      {message}
    </div>
  );
};

// Live Clock Component
const LiveClock = () => {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="live-clock">
      <div className="clock-date">{format(now, 'EEEE, MMMM d, yyyy')}</div>
      <div className="clock-time">{format(now, 'HH:mm:ss')}</div>
    </div>
  );
};

// Multi-select Team Selector Component
const TeamSelector = ({ teams, selectedTeams, setSelectedTeams }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef(null);

  React.useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const allSelected = selectedTeams.length === 0;

  const isTeamChecked = (id) => allSelected || selectedTeams.includes(id);

  const toggleTeam = (id) => {
    if (allSelected) {
      setSelectedTeams(teams.map(t => t.id).filter(tid => tid !== id));
    } else {
      setSelectedTeams(prev => {
        const next = prev.includes(id)
          ? prev.filter(tid => tid !== id)
          : [...prev, id];
        return next.length === teams.length ? [] : next;
      });
    }
  };

  // Find display name for selected team (for label)
  const getTeamName = (id) => teams.find(t => t.id === id)?.name || id;

  const label = allSelected
    ? 'All Groups'
    : selectedTeams.length === 1
      ? getTeamName(selectedTeams[0])
      : `${selectedTeams.length} Teams`;

  return (
    <div className="team-selector-inline" ref={ref} style={{ position: 'relative' }}>
      <label>TEAM:</label>
      <div className="multi-team-btn" onClick={() => setOpen(o => !o)} title={selectedTeams.map(getTeamName).join(', ') || 'All Groups'}>
        {label} <span style={{ fontSize: '0.6rem', marginLeft: 4, color: 'var(--text-muted)' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="multi-team-dropdown">
          <div className="multi-team-selectall" onClick={() => {
            if (allSelected) {
              setSelectedTeams(teams.length > 0 ? [teams[0].id] : []);
            } else {
              setSelectedTeams([]);
            }
          }}>
            {allSelected ? 'Clear all' : 'Select all'}
          </div>
          <div style={{ height: '1px', background: 'var(--border-color)', margin: '0.25rem 0' }} />
          {teams.map(t => (
            <label key={t.id} className="multi-team-option">
              <input
                type="checkbox"
                checked={isTeamChecked(t.id)}
                onChange={() => toggleTeam(t.id)}
              />
              <span>{t.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

// 1. DASHBOARD
// Helper for status classes
// Helper for status classes
const getStatusClass = (status, dateObj) => {
  if (!status || status === '-') return 'cell-empty';
  const s = status.toUpperCase();

  if (s === 'WO') return 'cell-wo';
  if (s === 'PL' || s === 'SL') return 'cell-leave';
  if (s === 'WL') return 'cell-wl';

  // Explicit string matches first
  if (s.includes('10:00 - 22:00') || s.includes('ON CALL') || s.includes('ONCALL')) return 'cell-oncall';
  if (s.includes('HOLIDAY') || s === 'HL' || s === 'AVAILABLE') return 'cell-holiday';
  if (s === 'WFH') return 'cell-wfh';

  // Parse time for Morning, Afternoon, Night by finding the first hour digits
  const timeMatch = s.match(/(\d{1,2}):/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);

    // Any shift from 7 to 10:59 is Morning
    if (hour >= 7 && hour < 11) {
      if (hour === 7 && dateObj && isWeekend(dateObj)) {
        return 'cell-oncall';
      }
      return 'cell-morning';
    }

    // Any shift from 11 to 17:59 is Afternoon
    if (hour >= 11 && hour < 18) {
      return 'cell-afternoon';
    }

    // Any shift 18 or beyond is Night
    if (hour >= 18) {
      return 'cell-night';
    }
  }

  // Fallback for non-standard formats like "11-8" or "9 - 6"
  if (s.includes('9 - 6')) return 'cell-morning';
  if (s.includes('11-8') || s.includes('11 - 8')) return 'cell-afternoon';
  if (s.includes('NIGHT')) return 'cell-night';

  // Holiday / Available
  if (s.includes('HOLIDAY') || s === 'HL' || s === 'AVAILABLE') return 'cell-holiday';

  if (s === 'WFH') return 'cell-wfh';
  return 'cell-other';
};

const Dashboard = ({ rosterData, currentDate, onChangeDate, loading, headerAction }) => {
  const [viewDate, setViewDate] = useState(new Date());
  const isViewingToday = format(viewDate, 'yyyy-MM-dd') === format(new Date(), 'yyyy-MM-dd');

  const goToPrevDay = () => setViewDate(prev => {
    const d = new Date(prev);
    d.setDate(d.getDate() - 1);
    return d;
  });
  const goToNextDay = () => setViewDate(prev => {
    const d = new Date(prev);
    d.setDate(d.getDate() + 1);
    return d;
  });
  const goToToday = () => setViewDate(new Date());

  const todayStr = format(viewDate, 'yyyy-MM-dd');
  const todayData = rosterData.filter(d => d.Date === todayStr);

  const stats = useMemo(() => {
    const working = todayData.filter(d => d.Status.includes(':') && d.Status !== 'WO');
    return {
      total: todayData.length,
      working: working.length,
      morning: todayData.filter(d => {
        const m = d.Status.match(/(\d{1,2}):/);
        if (!m) return false;
        const h = parseInt(m[1], 10);
        return h >= 7 && h <= 10;
      }).length,
      afternoon: todayData.filter(d => {
        const m = d.Status.match(/(\d{1,2}):/);
        if (!m) return false;
        const h = parseInt(m[1], 10);
        return h >= 11 && h <= 17;
      }).length,
      night: todayData.filter(d => {
        const m = d.Status.match(/(\d{1,2}):/);
        if (!m) return false;
        const h = parseInt(m[1], 10);
        return h >= 18;
      }).length,
      leave: todayData.filter(d => d.Status === 'PL' || d.Status === 'SL' || d.Status === 'WFH').length,
      wo: todayData.filter(d => d.Status === 'WO').length,
      wl: todayData.filter(d => d.Status === 'WL').length,
    };
  }, [todayData]);

  const onLeave = todayData.filter(d => ['PL', 'SL', 'WO', 'WFH', 'WL'].includes(d.Status));
  const workingAgents = todayData.filter(d => d.Status.includes(':'));

  const upcomingLeaves = useMemo(() => {
    const today = startOfDay(new Date());
    const viewMonthEnd = endOfMonth(currentDate);

    return rosterData.filter(d => {
      // Construct Date in local timezone scope to prevent UTC translation
      const [year, month, day] = d.Date.split('-');
      const dDate = new Date(year, month - 1, day);
      if (isBefore(dDate, today) || isSameDay(dDate, today)) return false;
      if (isAfter(dDate, viewMonthEnd)) return false;

      if (d.Status.includes(':')) return false;
      if (d.Status === 'WO' && isWeekend(dDate)) return false;
      return true;
    }).sort((a, b) => a.Date.localeCompare(b.Date));
  }, [rosterData, currentDate]);

  const groupedLeaves = useMemo(() => {
    return upcomingLeaves.reduce((acc, curr) => {
      if (!acc[curr.Date]) acc[curr.Date] = [];
      acc[curr.Date].push(curr);
      return acc;
    }, {});
  }, [upcomingLeaves]);

  return (
    <div className="dashboard-container">
      <div className="dashboard-header">
        <div className="dashboard-header-left">
          <LiveClock />
          <div className="dash-date-nav">
            <button className="dash-date-nav-btn" onClick={goToPrevDay} title="Previous day">
              <ChevronLeft size={16} />
            </button>
            <button
              className={`dash-date-chip${isViewingToday ? ' dash-date-chip-today' : ''}`}
              onClick={goToToday}
              title={isViewingToday ? 'Viewing today' : 'Back to today'}
            >
              <CalendarDays size={13} />
              {format(viewDate, 'EEE, MMM d')}
            </button>
            <button className="dash-date-nav-btn" onClick={goToNextDay} title="Next day">
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        {headerAction}
      </div>

      {loading ? (
        <div className="loading-state">
          <Loader2 size={32} className="spin" />
          <p>Loading roster data...</p>
        </div>
      ) : rosterData.length === 0 ? (
        <div className="empty-state-large" style={{ background: 'var(--bg-card)', border: '1px dashed var(--border-color)', borderRadius: '12px', padding: '3rem' }}>
          <Calendar size={32} style={{ color: 'var(--text-muted)' }} />
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>No Roster Found</h3>
          <p style={{ fontSize: '0.85rem' }}>Generate a new roster for {format(currentDate, 'MMMM yyyy')}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="stats-hero-grid">
            <div className="stat-card hero-working">
              <span className="hero-icon">👨‍💻</span>
              <h3>Working</h3>
              <div className="stat-value">{stats.working}</div>
            </div>
            <div className="stat-card hero-morning">
              <span className="hero-icon">☀️</span>
              <h3>Morning Shift</h3>
              <div className="stat-value">{stats.morning}</div>
            </div>
            <div className="stat-card hero-afternoon">
              <span className="hero-icon">⛅</span>
              <h3>Afternoon Shift</h3>
              <div className="stat-value">{stats.afternoon}</div>
            </div>
            <div className="stat-card hero-night">
              <span className="hero-icon">🌙</span>
              <h3>Night Shift</h3>
              <div className="stat-value">{stats.night}</div>
            </div>
            <div className="stat-card hero-leave">
              <span className="hero-icon">🧳</span>
              <h3>Leave</h3>
              <div className="stat-value">{stats.leave}</div>
            </div>
            <div className="stat-card hero-wo">
              <span className="hero-icon">🏖️</span>
              <h3>Weekly Off</h3>
              <div className="stat-value">{stats.wo}</div>
            </div>
            {stats.wl > 0 && (
              <div className="stat-card hero-wl">
                <span className="hero-icon">🤒</span>
                <h3>Wellness Leave</h3>
                <div className="stat-value">{stats.wl}</div>
              </div>
            )}
          </div>

          <div className="panel-grid">
            <div className="panel" style={{ padding: '1.5rem 2rem' }}>
              <div className="panel-header" style={{ marginBottom: '1.5rem' }}>
                <Briefcase size={20} style={{ color: 'var(--accent-primary)' }} />
                <h3 style={{ fontSize: '1.1rem' }}>{isViewingToday ? "Today's Schedule" : `Schedule — ${format(viewDate, 'MMM d')}`}</h3>
              </div>
              <div className="segmented-schedule">
                {/* Morning Block */}
                <div className="schedule-block block-morning">
                  <div className="block-header">
                    <Sun size={16} /> <span>Morning Shift</span>
                  </div>
                  <div className="block-list">
                    {workingAgents.filter(a => getShiftClass(a.Status) === 'shift-morning').length > 0 ? (
                      workingAgents.filter(a => getShiftClass(a.Status) === 'shift-morning').map((a, i) => (
                        <div key={i} className="shift-card">
                          <div className="agent-avatar" style={{ background: getAvatarColor(a.Name) }}>{a.Name.charAt(0)}</div>
                          <div className="agent-info">
                            <div className="agent-name-row">
                              <div className="agent-name">{a.Name}</div>
                              {a.Team && <span className="team-tag">{a.Team}</span>}
                            </div>
                            <div className="shift-time">{a.Status}</div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="empty-slot">No agents scheduled for Morning.</div>
                    )}
                  </div>
                </div>

                {/* Afternoon Block */}
                <div className="schedule-block block-afternoon">
                  <div className="block-header">
                    <SunMedium size={16} /> <span>Afternoon Shift</span>
                  </div>
                  <div className="block-list">
                    {workingAgents.filter(a => getShiftClass(a.Status) === 'shift-afternoon').length > 0 ? (
                      workingAgents.filter(a => getShiftClass(a.Status) === 'shift-afternoon').map((a, i) => (
                        <div key={i} className="shift-card">
                          <div className="agent-avatar" style={{ background: getAvatarColor(a.Name) }}>{a.Name.charAt(0)}</div>
                          <div className="agent-info">
                            <div className="agent-name-row">
                              <div className="agent-name">{a.Name}</div>
                              {a.Team && <span className="team-tag">{a.Team}</span>}
                            </div>
                            <div className="shift-time">{a.Status}</div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="empty-slot">No agents scheduled for Afternoon.</div>
                    )}
                  </div>
                </div>

                {/* Night Block */}
                <div className="schedule-block block-night">
                  <div className="block-header">
                    <Moon size={16} /> <span>Night Shift</span>
                  </div>
                  <div className="block-list">
                    {workingAgents.filter(a => getShiftClass(a.Status) === 'shift-night').length > 0 ? (
                      workingAgents.filter(a => getShiftClass(a.Status) === 'shift-night').map((a, i) => (
                        <div key={i} className="shift-card">
                          <div className="agent-avatar" style={{ background: getAvatarColor(a.Name) }}>{a.Name.charAt(0)}</div>
                          <div className="agent-info">
                            <div className="agent-name-row">
                              <div className="agent-name">{a.Name}</div>
                              {a.Team && <span className="team-tag">{a.Team}</span>}
                            </div>
                            <div className="shift-time">{a.Status}</div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="empty-slot">No agents scheduled for Night.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="right-column-stack" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div className="panel" style={{ padding: '1.5rem 2rem' }}>
                <div className="panel-header" style={{ marginBottom: '1.5rem' }}>
                  <UserX size={20} style={{ color: 'var(--accent-danger)' }} />
                  <h3 style={{ fontSize: '1.1rem' }}>Not Available ({onLeave.length})</h3>
                </div>
                {onLeave.length > 0 ? (
                  <div className="leave-list">
                    {onLeave.map((p, i) => (
                      <div key={i} className="leave-item">
                        <div className="agent-avatar" style={{ background: getAvatarColor(p.Name) }}>{p.Name.charAt(0)}</div>
                        <div className="agent-info">
                          <div className="agent-name-row">
                            <div className="agent-name">{p.Name}</div>
                            {p.Team && <span className="team-tag">{p.Team}</span>}
                          </div>
                          <div className={`shift-time ${getShiftClass(p.Status)}`}>{p.Status}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <p className="empty-state">Everyone is available today.</p>}
              </div>

              <div className="panel" style={{ flex: 1, padding: '1.5rem 2rem' }}>
                <div className="panel-header" style={{ marginBottom: '1.5rem' }}>
                  <CalendarDays size={20} style={{ color: 'var(--text-secondary)' }} />
                  <h3 style={{ fontSize: '1.1rem' }}>Upcoming Leaves</h3>
                </div>
                {upcomingLeaves.length > 0 ? (
                  <div className="upcoming-list">
                    {Object.entries(groupedLeaves).map(([date, leaves]) => (
                      <div key={date} className="date-group">
                        <div className="date-header">{format(parseISO(date), 'EEE, MMM d')}</div>
                        <div className="date-leaves">
                          {leaves.map((l, i) => (
                            <div key={i} className="mini-leave-item">
                              <div className="mini-avatar" style={{ background: getAvatarColor(l.Name) }}>{l.Name.charAt(0)}</div>
                              <span className="mini-name">{l.Name}</span>
                              {l.Team && <span className="team-tag">{l.Team}</span>}
                              <span className={`mini-status ${getStatusClass(l.Status)}`}>{l.Status}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : <p className="empty-state">No upcoming leaves this month.</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const getShiftClass = (status) => {
  const timeMatch = status.match(/(\d{1,2}):/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1], 10);
    if (hour >= 7 && hour < 11) return 'shift-morning';
    if (hour >= 11 && hour < 18) return 'shift-afternoon';
    if (hour >= 18) return 'shift-night';
  }
  return '';
};

// 2. ROSTER TABLE
const RosterTable = ({ rosterData, currentDate, onChangeDate, isAdmin, loading, onCellUpdate, headerAction, viewMode, allTeamsData, currentUser, teams = [] }) => {
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth() + 1;
  const startDate = new Date(year, month - 1, 1);
  const endDate = endOfMonth(startDate);
  const days = eachDayOfInterval({ start: startDate, end: endDate });

  // Zoom state persisted in localStorage
  const [zoom, setZoom] = useState(() => {
    const saved = localStorage.getItem('roster_zoom');
    return saved ? parseFloat(saved) : 1;
  });

  const handleZoom = (delta) => {
    setZoom(prev => {
      const next = Math.max(0.4, Math.min(1.5, +(prev + delta).toFixed(2)));
      localStorage.setItem('roster_zoom', next);
      return next;
    });
  };

  const handleZoomAbsolute = (val) => {
    setZoom(val);
    localStorage.setItem('roster_zoom', val);
  };

  // Determine which data to render
  const displayData = viewMode === 'all' && allTeamsData ? allTeamsData : rosterData;

  // Group data by team for "all" mode, or use flat list for single
  const teamGroups = useMemo(() => {
    if (viewMode !== 'all') {
      const agents = [...new Set(displayData.map(d => d.Name))];
      const map = {};
      displayData.forEach(d => {
        if (!map[d.Name]) map[d.Name] = {};
        map[d.Name][d.Date] = d.Status;
      });
      return [{ team: null, agents, unrostered: [], map }];
    }

    // Group by Team field
    const teamMap = {};
    displayData.forEach(d => {
      const team = d.Team || 'Unknown';
      if (!teamMap[team]) teamMap[team] = [];
      teamMap[team].push(d);
    });

    return Object.keys(teamMap).sort().map(team => {
      const items = teamMap[team];
      const agents = [...new Set(items.map(d => d.Name))];
      const map = {};
      items.forEach(d => {
        if (!map[d.Name]) map[d.Name] = {};
        map[d.Name][d.Date] = d.Status;
      });

      // Find team members with no roster entries this month
      const teamDef = teams.find(t => t.name === team);
      const unrostered = teamDef
        ? (teamDef.members || []).filter(m => !agents.includes(m))
        : [];

      return { team, agents, unrostered, map };
    });
  }, [displayData, viewMode, teams]);

  // Selection state
  const [selection, setSelection] = useState(null);

  const handleCellBlur = async (agent, dateStr, newValue) => {
    if (onCellUpdate) {
      onCellUpdate(dateStr, agent, newValue);
    }
  };

  const handleCellClick = (agent, dateStr, e) => {
    e.stopPropagation();
    setSelection({ type: 'cell', row: agent, col: dateStr });
  };

  const handleRowClick = (agent, e) => {
    e.stopPropagation();
    setSelection({ type: 'row', row: agent, col: null });
  };

  const handleColumnClick = (dateStr, e) => {
    e.stopPropagation();
    setSelection({ type: 'column', row: null, col: dateStr });
  };

  const clearSelection = () => setSelection(null);

  const isCellSelected = (agent, dateStr) => {
    if (!selection) return false;
    if (selection.type === 'cell') return selection.row === agent && selection.col === dateStr;
    if (selection.type === 'row') return selection.row === agent;
    if (selection.type === 'column') return selection.col === dateStr;
    return false;
  };

  const isRowSelected = (agent) => selection?.type === 'row' && selection.row === agent;
  const isColumnSelected = (dateStr) => selection?.type === 'column' && selection.col === dateStr;

  return (
    <div className="roster-page" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      {/* Controls Card */}
      <div className="roster-controls-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-card)', padding: '0.75rem 1.5rem', borderRadius: '8px', border: '1px solid var(--border-color)', flexWrap: 'wrap', gap: '1rem' }}>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1, minWidth: 'min-content' }}>
          {headerAction}
        </div>

        <div className="date-nav" style={{ flex: 1, display: 'flex', justifyContent: 'center', minWidth: '250px' }}>
          <button className="date-nav-btn" onClick={() => onChangeDate(subMonths(currentDate, 1))} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <ChevronLeft size={20} />
          </button>
          <div className="date-display" style={{ display: 'flex', alignItems: 'center', fontSize: '1.1rem', fontWeight: 600, minWidth: '160px', justifyContent: 'center', color: 'var(--text-primary)' }}>
            <Calendar size={18} style={{ marginRight: '8px' }} />
            {format(currentDate, 'MMMM yyyy')}
          </div>
          <button className="date-nav-btn" onClick={() => onChangeDate(addMonths(currentDate, 1))} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
            <ChevronRight size={20} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1, justifyContent: 'flex-end', minWidth: 'min-content' }}>
          <div className="zoom-slider-container" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'var(--bg-secondary)', padding: '0.35rem 0.5rem', borderRadius: '20px', border: '1px solid var(--border-color)', boxShadow: 'var(--shadow-sm)', flexShrink: 0 }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>50%</span>
            <input
              type="range"
              min="0.5"
              max="1.5"
              step="0.05"
              value={zoom}
              onChange={(e) => handleZoomAbsolute(parseFloat(e.target.value))}
              style={{ width: '60px', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-primary)', minWidth: '35px', textAlign: 'center' }}>{Math.round(zoom * 100)}%</span>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>150%</span>
          </div>
        </div>
      </div>

      {/* Legend Card */}
      <div className="roster-legend-card" style={{ background: 'var(--bg-card)', padding: '1rem 1.5rem', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>Shift Legend</h3>
        <div className="legend-chips" style={{ marginBottom: 0 }}>
          <span className="legend-chip chip-morning">Morning</span>
          <span className="legend-chip chip-afternoon">Afternoon</span>
          <span className="legend-chip chip-oncall">On Call</span>
          <span className="legend-chip chip-night" style={{ background: '#000000', color: '#fff' }}>Night</span>
          <span className="legend-chip chip-leave">PL</span>
          <span className="legend-chip chip-wo">WO</span>
          <span className="legend-chip chip-wl">WL</span>
          <span className="legend-chip chip-holiday">Holiday</span>
          <span className="legend-chip chip-wfh">WFH</span>
        </div>
      </div>

      {loading ? (
        <div className="loading-state" style={{ textAlign: 'center', padding: '3rem' }}>
          <Loader2 size={32} className="spin" style={{ margin: '0 auto', color: 'var(--accent-primary)' }} />
          <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>Loading roster data...</p>
        </div>
      ) : displayData.length === 0 ? (
        <div className="empty-state-large" style={{ padding: '4rem 2rem', background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border-color)', textAlign: 'center' }}>
          <TableIcon size={32} style={{ color: 'var(--text-muted)', margin: '0 auto 1rem' }} />
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>No Roster Found</h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Generate a new roster for {format(currentDate, 'MMMM yyyy')}</p>
        </div>
      ) : (
        <div className="roster-all-groups" onClick={clearSelection} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {teamGroups.map((group) => (
            <div key={group.team || 'single'} className="roster-team-card" style={{ background: 'var(--bg-card)', borderRadius: '8px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
              {group.team && (
                <div className="team-section-header" style={{ background: 'transparent', padding: '1rem 1.5rem', borderBottom: '1px solid var(--border-color)', fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                  {group.team}
                </div>
              )}
              <div className="roster-table-wrapper" style={{ border: 'none', borderRadius: 0, overflowX: 'auto' }}>
                <table className="roster-table" style={{ zoom: zoom, width: '100%', borderCollapse: 'collapse', border: 'none' }}>
                  <thead>
                    <tr>
                      <th className="sticky-col corner-cell">Agent</th>
                      {days.map(day => {
                        const dateStr = format(day, 'yyyy-MM-dd');
                        const todayStr = format(new Date(), 'yyyy-MM-dd');
                        const isToday = dateStr === todayStr;
                        return (
                          <th
                            key={day.toString()}
                            className={`${isWeekend(day) ? 'weekend-header' : ''} ${isColumnSelected(dateStr) ? 'selected-header' : ''} ${isToday ? 'today-col' : ''}`}
                            onClick={(e) => handleColumnClick(dateStr, e)}
                          >
                            <div className="day-num">{format(day, 'd')}</div>
                            <div className="day-name">{format(day, 'EEE')}</div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {group.agents.map(agent => (
                      <tr key={`${group.team}-${agent}`} className={isRowSelected(agent) ? 'selected-row' : ''}>
                        <td
                          className={`sticky-col agent-cell ${isRowSelected(agent) ? 'selected-header' : ''}`}
                          onClick={(e) => handleRowClick(agent, e)}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                            {agent}
                          </div>
                        </td>
                        {days.map(day => {
                          const dateStr = format(day, 'yyyy-MM-dd');
                          const status = group.map[agent]?.[dateStr] || '-';
                          const cellClass = getStatusClass(status, day);
                          const isSelected = isCellSelected(agent, dateStr);
                          return (
                            <td
                              key={dateStr}
                              className={`roster-cell ${cellClass} ${isWeekend(day) ? 'weekend-cell' : ''} ${isSelected ? 'selected-cell' : ''}`}
                              onClick={(e) => handleCellClick(agent, dateStr, e)}
                            >
                              {isAdmin ? (
                                <CellEditor
                                  value={status}
                                  onFinish={(newVal) => handleCellBlur(agent, dateStr, newVal)}
                                />
                              ) : (
                                <span className="cell-text">{status}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {group.unrostered.map(agent => (
                      <tr key={`${group.team}-unrostered-${agent}`} style={{ opacity: 0.6 }}>
                        <td
                          className="sticky-col agent-cell"
                          style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {agent}
                            <span style={{ fontSize: '0.65rem', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '1px 5px', color: 'var(--text-muted)', fontStyle: 'normal' }}>Not set</span>
                          </div>
                        </td>
                        {days.map(day => {
                          const dateStr = format(day, 'yyyy-MM-dd');
                          const isSelected = isCellSelected(agent, dateStr);
                          return (
                            <td
                              key={dateStr}
                              className={`roster-cell ${isWeekend(day) ? 'weekend-cell' : ''} ${isSelected ? 'selected-cell' : ''}`}
                              onClick={(e) => handleCellClick(agent, dateStr, e)}
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {isAdmin ? (
                                <CellEditor
                                  value="-"
                                  onFinish={(newVal) => handleCellBlur(agent, dateStr, newVal)}
                                />
                              ) : (
                                <span className="cell-text">-</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── DEVREV TICKETS MODAL ──────────────────────────────────
const DEVREV_STATUS_STYLES = {
  triage:      { bg: '#f3f4f6', color: '#6b7280', label: 'Triage' },
  open:        { bg: '#dbeafe', color: '#1d4ed8', label: 'Open' },
  in_progress: { bg: '#fef3c7', color: '#d97706', label: 'In Progress' },
  in_review:   { bg: '#ede9fe', color: '#7c3aed', label: 'In Review' },
  completed:   { bg: '#d1fae5', color: '#059669', label: 'Done' },
  done:        { bg: '#d1fae5', color: '#059669', label: 'Done' },
  wont_fix:    { bg: '#f3f4f6', color: '#6b7280', label: "Won't Fix" },
  archived:    { bg: '#f3f4f6', color: '#6b7280', label: 'Archived' },
};

const DEVREV_PRIORITY_STYLES = {
  p0: { bg: '#fef2f2', color: '#dc2626', label: 'P0' },
  p1: { bg: '#fff7ed', color: '#ea580c', label: 'P1' },
  p2: { bg: '#fefce8', color: '#ca8a04', label: 'P2' },
  p3: { bg: '#eff6ff', color: '#2563eb', label: 'P3' },
  p4: { bg: '#f9fafb', color: '#6b7280', label: 'P4' },
};

const DEVREV_PS_ENTERPRISE_PARTS = [
  'don:core:dvrv-in-1:devo/2sRI6Hepzz:feature/253',
];

const DevRevTicketsModal = ({ onClose }) => {
  const [activeTeam, setActiveTeam] = useState('ps-pos'); // 'ps-pos' | 'ps-enterprise'

  // PS-POS state
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [posSelectedOwner, setPosSelectedOwner] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [memberEpics, setMemberEpics] = useState([]);
  const [epicsLoading, setEpicsLoading] = useState(false);
  const [collapsedEpicGroups, setCollapsedEpicGroups] = useState({});

  // PS-Enterprise state
  const [entLoading, setEntLoading] = useState(false);
  const [entError, setEntError] = useState('');
  const [entGroups, setEntGroups] = useState([]); // [{runnableId, runnableName, issues[]}]
  const [collapsedEntGroups, setCollapsedEntGroups] = useState({});
  const [entSearch, setEntSearch] = useState('');
  const [entSelectedOwner, setEntSelectedOwner] = useState(null);

  const fetchEnterpriseIssues = useCallback(async () => {
    setEntLoading(true);
    setEntError('');
    try {
      const allByPart = {};
      await Promise.all(
        DEVREV_PS_ENTERPRISE_PARTS.map(async (partId) => {
          let allWorks = [];
          let cursor = null;
          do {
            const params = new URLSearchParams({ type: 'issue', applies_to_part: partId, limit: '100' });
            if (cursor) params.append('cursor', cursor);
            const res = await fetch(`https://api.devrev.ai/works.list?${params.toString()}`, {
              headers: { Authorization: `Bearer ${DEVREV_TOKEN}` },
            });
            if (!res.ok) break;
            const data = await res.json();
            allWorks = allWorks.concat(data.works || []);
            cursor = data.next_cursor || null;
            if (allWorks.length >= 500) break;
          } while (cursor);
          if (allWorks.length > 0) {
            const part = allWorks[0]?.applies_to_part || {};
            allByPart[partId] = {
              runnableId: part.display_id || partId,
              runnableName: part.name || partId,
              issues: allWorks,
            };
          }
        })
      );
      setEntGroups(Object.values(allByPart).sort((a, b) => b.issues.length - a.issues.length));
    } catch (e) {
      setEntError(e.message);
    } finally {
      setEntLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTeam === 'ps-enterprise' && entGroups.length === 0 && !entLoading) {
      fetchEnterpriseIssues();
    }
  }, [activeTeam, entGroups.length, entLoading, fetchEnterpriseIssues]);

  const fetchMemberEpics = useCallback(async (assignees) => {
    if (!assignees.length) return;
    setEpicsLoading(true);
    try {
      const results = await Promise.all(
        assignees.map(async ({ id, name }) => {
          let allIssues = [];
          let cursor = null;
          do {
            const params = new URLSearchParams({ type: 'issue', limit: '100' });
            params.append('owned_by', id);
            if (cursor) params.append('cursor', cursor);
            const res = await fetch(`https://api.devrev.ai/works.list?${params.toString()}`, {
              headers: { Authorization: `Bearer ${DEVREV_TOKEN}` },
            });
            if (!res.ok) break;
            const data = await res.json();
            allIssues = allIssues.concat(data.works || []);
            cursor = data.next_cursor || null;
            if (allIssues.length >= 500) break;
          } while (cursor);

          const epicMap = {};
          for (const issue of allIssues) {
            const part = issue.applies_to_part;
            if (!part) continue;
            const key = part.display_id || part.id;
            if (!epicMap[key]) epicMap[key] = { id: part.display_id || '', name: part.name || 'Unknown', count: 0 };
            epicMap[key].count++;
          }
          return {
            memberId: id,
            memberName: name,
            totalIssues: allIssues.length,
            epics: Object.values(epicMap).sort((a, b) => b.count - a.count),
          };
        })
      );
      setMemberEpics(results.filter(r => r.epics.length > 0));
    } catch (_) {
      // silently fail epics
    } finally {
      setEpicsLoading(false);
    }
  }, []);

  const fetchAllTickets = useCallback(async () => {
    setLoading(true);
    setError('');
    setMemberEpics([]);
    try {
      let allWorks = [];
      let cursor = null;
      do {
        const params = new URLSearchParams();
        params.append('type', 'issue');
        params.append('issue.sprint', DEVREV_SPRINT_ID);
        params.append('limit', '100');
        if (cursor) params.append('cursor', cursor);

        const res = await fetch(`https://api.devrev.ai/works.list?${params.toString()}`, {
          headers: { 'Authorization': `Bearer ${DEVREV_TOKEN}` },
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.message || `DevRev API error ${res.status}`);
        }
        const data = await res.json();
        allWorks = allWorks.concat(data.works || []);
        cursor = data.next_cursor || null;
        if (allWorks.length >= 500) break;
      } while (cursor);
      setTickets(allWorks);

      // extract unique real assignees then load their epics
      const seenIds = new Set();
      const assignees = [];
      for (const work of allWorks) {
        for (const owner of (work.owned_by || [])) {
          if (owner.type === 'dev_user' && !seenIds.has(owner.id)) {
            seenIds.add(owner.id);
            assignees.push({ id: owner.id, name: owner.display_name || owner.full_name || 'Unknown' });
          }
        }
      }
      fetchMemberEpics(assignees);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [fetchMemberEpics]);

  useEffect(() => { fetchAllTickets(); }, [fetchAllTickets]);

  const posOwners = useMemo(() => {
    const seen = new Set();
    const list = [];
    tickets.forEach(t => {
      (t.owned_by || []).forEach(o => {
        if (o.type === 'dev_user' && !seen.has(o.display_name)) {
          seen.add(o.display_name);
          list.push(o.display_name);
        }
      });
    });
    return list.sort();
  }, [tickets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tickets.filter(t => {
      const matchesSearch = !q || t.title?.toLowerCase().includes(q) || t.display_id?.toLowerCase().includes(q);
      const matchesOwner = !posSelectedOwner || (t.owned_by || []).some(o => o.display_name === posSelectedOwner);
      return matchesSearch && matchesOwner;
    });
  }, [tickets, search, posSelectedOwner]);

  const filteredMemberEpics = useMemo(() => {
    if (!posSelectedOwner) return memberEpics;
    return memberEpics.filter(m => m.memberName === posSelectedOwner);
  }, [memberEpics, posSelectedOwner]);

  const grouped = useMemo(() => {
    const map = {};
    filtered.forEach(t => {
      const owners = t.owned_by?.length
        ? t.owned_by
        : [{ id: '__unassigned__', display_name: 'Unassigned' }];
      owners.forEach(owner => {
        const key = owner.id || '__unassigned__';
        if (!map[key]) map[key] = { name: owner.display_name || owner.full_name || 'Unassigned', items: [] };
        map[key].items.push(t);
      });
    });
    return Object.entries(map).sort(([, a], [, b]) => b.items.length - a.items.length);
  }, [filtered]);

  const toggleGroup = (key) =>
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }));

  const toggleEpicGroup = (key) =>
    setCollapsedEpicGroups(prev => ({ ...prev, [key]: !prev[key] }));

  const toggleEntGroup = (key) =>
    setCollapsedEntGroups(prev => ({ ...prev, [key]: !prev[key] }));

  const ticketUrl = (displayId) =>
    `https://app.devrev.ai/${DEVREV_ORG}/works/${displayId}`;

  const entOwners = useMemo(() => {
    const seen = new Set();
    const list = [];
    entGroups.forEach(g => g.issues.forEach(i => {
      (i.owned_by || []).forEach(o => {
        if (!seen.has(o.display_name)) { seen.add(o.display_name); list.push(o.display_name); }
      });
    }));
    return list.sort();
  }, [entGroups]);

  const filteredEntGroups = useMemo(() => {
    const q = entSearch.trim().toLowerCase();
    return entGroups.map(g => ({
      ...g,
      issues: g.issues.filter(i => {
        const matchesSearch = !q || i.title?.toLowerCase().includes(q) || i.display_id?.toLowerCase().includes(q);
        const matchesOwner = !entSelectedOwner || (i.owned_by || []).some(o => o.display_name === entSelectedOwner);
        return matchesSearch && matchesOwner;
      }),
    })).filter(g => g.issues.length > 0);
  }, [entGroups, entSearch, entSelectedOwner]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '820px', width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: 0 }}
      >
        {/* Header */}
        <div className="modal-header" style={{ padding: '0.75rem 1.25rem', flexShrink: 0 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Briefcase size={18} />
            DevRev Tickets
          </h2>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <button
              onClick={activeTeam === 'ps-pos' ? fetchAllTickets : fetchEnterpriseIssues}
              title="Refresh"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}
            >
              <RefreshCw size={15} className={(loading || entLoading) ? 'spin' : ''} />
            </button>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Team Tabs */}
        <div style={{ display: 'flex', gap: '0.4rem', padding: '0 1.25rem 0.75rem', flexShrink: 0, borderBottom: '1px solid var(--border-color)' }}>
          {[
            { id: 'ps-pos', label: 'PS-POS' },
            { id: 'ps-enterprise', label: 'PS-Enterprise' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTeam(tab.id)}
              style={{
                padding: '0.3rem 0.85rem',
                borderRadius: '20px',
                border: activeTeam === tab.id ? 'none' : '1px solid var(--border-color)',
                background: activeTeam === tab.id ? 'var(--accent-primary)' : 'transparent',
                color: activeTeam === tab.id ? '#fff' : 'var(--text-secondary)',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Errors */}
        {activeTeam === 'ps-pos' && error && (
          <div style={{ margin: '0.5rem 1.25rem 0', padding: '0.5rem 0.75rem', background: '#fef2f2', color: '#dc2626', borderRadius: '6px', fontSize: '0.8rem', flexShrink: 0 }}>
            <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> {error}
          </div>
        )}
        {activeTeam === 'ps-enterprise' && entError && (
          <div style={{ margin: '0.5rem 1.25rem 0', padding: '0.5rem 0.75rem', background: '#fef2f2', color: '#dc2626', borderRadius: '6px', fontSize: '0.8rem', flexShrink: 0 }}>
            <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> {entError}
          </div>
        )}

        {/* Body */}
        <div style={{ overflow: 'auto', flex: 1, padding: '0 1.25rem 1.25rem' }}>
          {/* ── PS-ENTERPRISE TAB ── */}
          {activeTeam === 'ps-enterprise' && (
            entLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                <Loader2 size={24} className="spin" />
              </div>
            ) : (
              <>
                <div style={{ paddingTop: '0.75rem', marginBottom: '0.5rem' }}>
                  <input
                    className="form-input"
                    value={entSearch}
                    onChange={e => setEntSearch(e.target.value)}
                    placeholder="Search by title or ID…"
                    style={{ width: '100%', fontSize: '0.85rem' }}
                  />
                </div>
                {entOwners.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.75rem' }}>
                    <button
                      onClick={() => setEntSelectedOwner(null)}
                      style={{
                        padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                        border: entSelectedOwner === null ? 'none' : '1px solid var(--border-color)',
                        background: entSelectedOwner === null ? 'var(--accent-primary)' : 'transparent',
                        color: entSelectedOwner === null ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      All
                    </button>
                    {entOwners.map(name => (
                      <button
                        key={name}
                        onClick={() => setEntSelectedOwner(entSelectedOwner === name ? null : name)}
                        style={{
                          padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer',
                          border: entSelectedOwner === name ? 'none' : '1px solid var(--border-color)',
                          background: entSelectedOwner === name ? 'var(--accent-primary)' : 'transparent',
                          color: entSelectedOwner === name ? '#fff' : 'var(--text-secondary)',
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                )}
                {filteredEntGroups.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>No issues found</div>
                ) : (
                  filteredEntGroups.map(({ runnableId, runnableName, issues }) => (
                    <div key={runnableId} style={{ marginBottom: '0.75rem' }}>
                      <button
                        onClick={() => toggleEntGroup(runnableId)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.5rem',
                          width: '100%', padding: '0.5rem 0.6rem',
                          background: 'var(--bg-hover)', border: 'none', borderRadius: '6px',
                          cursor: 'pointer', textAlign: 'left',
                          color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.88rem',
                        }}
                      >
                        {collapsedEntGroups[runnableId] ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                        <span style={{ flex: 1 }}>{runnableName}</span>
                        <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'var(--text-muted)', marginRight: '0.4rem' }}>{runnableId}</span>
                        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-secondary)', padding: '0.1rem 0.45rem', borderRadius: '10px' }}>
                          {issues.length}
                        </span>
                      </button>
                      {!collapsedEntGroups[runnableId] && (
                        <div style={{ borderLeft: '2px solid var(--border-color)', marginLeft: '0.6rem' }}>
                          {issues.map(issue => {
                            const stageKey = (issue.stage?.name || '').toLowerCase().replace(/ /g, '_');
                            const priority = (issue.priority || 'p4').toLowerCase();
                            const statusStyle = DEVREV_STATUS_STYLES[stageKey] || DEVREV_STATUS_STYLES.open;
                            const priorityStyle = DEVREV_PRIORITY_STYLES[priority] || DEVREV_PRIORITY_STYLES.p4;
                            const owners = (issue.owned_by || []).map(o => o.display_name).join(', ') || 'Unassigned';
                            return (
                              <div key={issue.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.55rem 0.75rem', borderBottom: '1px solid var(--border-color)' }}>
                                <a
                                  href={ticketUrl(issue.display_id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontFamily: 'monospace', flexShrink: 0, textDecoration: 'none', whiteSpace: 'nowrap' }}
                                >
                                  {issue.display_id}
                                </a>
                                <a
                                  href={ticketUrl(issue.display_id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ flex: 1, color: 'var(--text-primary)', fontSize: '0.83rem', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  title={issue.title}
                                >
                                  {issue.title}
                                </a>
                                <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0, alignItems: 'center' }}>
                                  <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{owners}</span>
                                  <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 700, background: priorityStyle.bg, color: priorityStyle.color }}>
                                    {priorityStyle.label}
                                  </span>
                                  <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 500, background: statusStyle.bg, color: statusStyle.color }}>
                                    {statusStyle.label}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </>
            )
          )}

          {/* ── PS-POS TAB ── */}
          {activeTeam === 'ps-pos' && loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
              <Loader2 size={24} className="spin" />
            </div>
          ) : activeTeam === 'ps-pos' && (
            <>
              {/* ── NAME FILTER ── */}
              <div style={{ paddingTop: '0.75rem', marginBottom: '0.5rem' }}>
                <input
                  className="form-input"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search by title or ID…"
                  style={{ width: '100%', fontSize: '0.85rem' }}
                />
              </div>
              {posOwners.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '1rem' }}>
                  <button
                    onClick={() => setPosSelectedOwner(null)}
                    style={{
                      padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                      border: posSelectedOwner === null ? 'none' : '1px solid var(--border-color)',
                      background: posSelectedOwner === null ? 'var(--accent-primary)' : 'transparent',
                      color: posSelectedOwner === null ? '#fff' : 'var(--text-secondary)',
                    }}
                  >
                    All
                  </button>
                  {posOwners.map(name => (
                    <button
                      key={name}
                      onClick={() => setPosSelectedOwner(posSelectedOwner === name ? null : name)}
                      style={{
                        padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer',
                        border: posSelectedOwner === name ? 'none' : '1px solid var(--border-color)',
                        background: posSelectedOwner === name ? 'var(--accent-primary)' : 'transparent',
                        color: posSelectedOwner === name ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}

              {/* ── MEMBER EPICS SECTION ── */}
              <div style={{ marginBottom: '1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', paddingBottom: '0.4rem', borderBottom: '2px solid var(--border-color)' }}>
                  <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Member Epics
                  </h3>
                  {epicsLoading
                    ? <Loader2 size={12} className="spin" style={{ color: 'var(--text-muted)' }} />
                    : <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{filteredMemberEpics.length} members</span>
                  }
                </div>

                {epicsLoading && memberEpics.length === 0 ? (
                  <div style={{ padding: '1rem', color: 'var(--text-muted)', fontSize: '0.82rem', textAlign: 'center' }}>
                    <Loader2 size={14} className="spin" style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                    Loading member epics…
                  </div>
                ) : filteredMemberEpics.length === 0 ? (
                  <div style={{ padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>No epic data found.</div>
                ) : (
                  filteredMemberEpics.map(({ memberId, memberName, totalIssues, epics }) => (
                    <div key={memberId} style={{ marginBottom: '0.4rem' }}>
                      <button
                        onClick={() => toggleEpicGroup(memberId)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.5rem',
                          width: '100%', padding: '0.45rem 0.6rem',
                          background: 'var(--bg-hover)', border: 'none', borderRadius: '6px',
                          cursor: 'pointer', textAlign: 'left',
                          color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.85rem',
                        }}
                      >
                        {collapsedEpicGroups[memberId] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        <span style={{ flex: 1 }}>{memberName}</span>
                        <span style={{ fontSize: '0.7rem', fontWeight: 500, color: 'var(--text-muted)', background: 'var(--bg-secondary)', padding: '0.1rem 0.4rem', borderRadius: '10px' }}>
                          {totalIssues} issues · {epics.length} epics
                        </span>
                      </button>
                      {!collapsedEpicGroups[memberId] && (
                        <div style={{ borderLeft: '2px solid var(--border-color)', marginLeft: '0.6rem', marginTop: '0.2rem' }}>
                          {epics.map(epic => (
                            <div key={epic.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.3rem 0.6rem', borderBottom: '1px solid var(--border-color)' }}>
                              <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', fontFamily: 'monospace', flexShrink: 0 }}>
                                {epic.id}
                              </span>
                              <span style={{ flex: 1, fontSize: '0.82rem', color: 'var(--text-primary)' }}>{epic.name}</span>
                              <span style={{ fontSize: '0.68rem', fontWeight: 600, background: '#dbeafe', color: '#1d4ed8', padding: '0.1rem 0.4rem', borderRadius: '10px', flexShrink: 0 }}>
                                {epic.count}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* ── CURRENT SPRINT SECTION ── */}
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', paddingBottom: '0.4rem', borderBottom: '2px solid var(--border-color)' }}>
                  <h3 style={{ margin: 0, fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    Current Sprint
                  </h3>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{filtered.length} issues</span>
                </div>
                {grouped.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                    No tickets found
                  </div>
                ) : (
                  grouped.map(([key, group]) => (
                    <div key={key} style={{ marginBottom: '0.75rem' }}>
                      <button
                        onClick={() => toggleGroup(key)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '0.5rem',
                          width: '100%', padding: '0.5rem 0.6rem',
                          background: 'var(--bg-hover)', border: 'none', borderRadius: '6px',
                          cursor: 'pointer', textAlign: 'left',
                          color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.88rem',
                        }}
                      >
                        {collapsedGroups[key] ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                        <span style={{ flex: 1 }}>{group.name}</span>
                        <span style={{
                          fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)',
                          background: 'var(--bg-secondary)', padding: '0.1rem 0.45rem', borderRadius: '10px',
                        }}>
                          {group.items.length}
                        </span>
                      </button>

                      {!collapsedGroups[key] && (
                        <div style={{ borderLeft: '2px solid var(--border-color)', marginLeft: '0.6rem' }}>
                          {group.items.map(ticket => {
                            const stageKey = (ticket.stage?.name || '')
                              .toLowerCase().replace(/ /g, '_');
                            const priority = (ticket.priority || 'p4').toLowerCase();
                            const statusStyle = DEVREV_STATUS_STYLES[stageKey] || DEVREV_STATUS_STYLES.open;
                            const priorityStyle = DEVREV_PRIORITY_STYLES[priority] || DEVREV_PRIORITY_STYLES.p4;
                            const epicName = ticket.applies_to_part?.name;

                            return (
                              <div
                                key={ticket.id}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: '0.75rem',
                                  padding: '0.55rem 0.75rem',
                                  borderBottom: '1px solid var(--border-color)',
                                }}
                              >
                                <a
                                  href={ticketUrl(ticket.display_id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontFamily: 'monospace', flexShrink: 0, textDecoration: 'none', whiteSpace: 'nowrap' }}
                                >
                                  {ticket.display_id}
                                </a>
                                <a
                                  href={ticketUrl(ticket.display_id)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ flex: 1, color: 'var(--text-primary)', fontSize: '0.83rem', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                  title={ticket.title}
                                >
                                  {ticket.title}
                                </a>
                                <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0, alignItems: 'center' }}>
                                  {epicName && (
                                    <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.65rem', fontWeight: 500, background: '#f3e8ff', color: '#7c3aed', maxWidth: '90px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={epicName}>
                                      {epicName}
                                    </span>
                                  )}
                                  <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 700, background: priorityStyle.bg, color: priorityStyle.color }}>
                                    {priorityStyle.label}
                                  </span>
                                  <span style={{ padding: '0.12rem 0.4rem', borderRadius: '4px', fontSize: '0.68rem', fontWeight: 500, background: statusStyle.bg, color: statusStyle.color }}>
                                    {statusStyle.label}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── SLACK THREADS MODAL ──────────────────────────────────
function slackStripMarkup(text) {
  return (text || '')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
    .replace(/<@[A-Z0-9]+>/g, '@user')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\n+/g, ' ')
    .trim();
}

// Module-level fetch with auto-retry on rate limit
async function slackGet(endpoint, params = {}, attempt = 0) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${SLACK_API_BASE}/${endpoint}?${qs}`, {
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
  });
  if (res.status === 429) {
    if (attempt >= 3) throw new Error('ratelimited after retries');
    const wait = parseInt(res.headers.get('Retry-After') || '5', 10);
    await new Promise(r => setTimeout(r, (wait + 1) * 1000));
    return slackGet(endpoint, params, attempt + 1);
  }
  const data = await res.json();
  if (!data.ok && data.error === 'ratelimited') {
    if (attempt >= 3) throw new Error('ratelimited after retries');
    await new Promise(r => setTimeout(r, 5000));
    return slackGet(endpoint, params, attempt + 1);
  }
  if (!data.ok) throw new Error(data.error || `Slack error: ${endpoint}`);
  return data;
}

const SlackThreadsModal = ({ onClose }) => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('Fetching channel list…');
  const [errors, setErrors] = useState([]);
  const [search, setSearch] = useState('');

  const scanChannels = useCallback(async () => {
    setLoading(true);
    setErrors([]);
    setMessages([]);

    if (SLACK_CHANNEL_IDS.length === 0) {
      setErrors(['No channels configured. Add VITE_SLACK_CHANNEL_IDS to your .env file.']);
      setLoading(false);
      return;
    }

    setStatus(`Resolving @${SLACK_SEARCH_HANDLE}…`);
    try {
      // 0. Resolve subteam ID — Slack API encodes mentions as <!subteam^ID> with no handle name
      let subteamId = SLACK_SUBTEAM_ID;
      if (!subteamId) {
        try {
          const ugData = await slackGet('usergroups.list');
          const group = (ugData.usergroups || []).find(g => g.handle === SLACK_SEARCH_HANDLE);
          subteamId = group?.id || '';
        } catch { /* usergroups:read scope may be missing — will fall back to handle name */ }
      }
      // Match either by subteam ID tag or by handle name (fallback)
      const mentionsHandle = (text) => {
        if (!text) return false;
        if (subteamId && text.includes(`<!subteam^${subteamId}>`)) return true;
        return text.includes(SLACK_SEARCH_HANDLE);
      };

      // 1. Resolve channel IDs → names
      setStatus(`Fetching info for ${SLACK_CHANNEL_IDS.length} channel(s)…`);
      const channels = await Promise.all(SLACK_CHANNEL_IDS.map(async (id) => {
        try {
          const data = await slackGet('conversations.info', { channel: id });
          return data.channel;
        } catch {
          return { id, name: id, is_private: false };
        }
      }));

      // 2. Scan each channel — paginate history, then check thread replies
      const oldest = String(Math.floor(Date.now() / 1000) - 30 * 24 * 3600);
      const allMatches = [];
      const scanErrors = [];

      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        try {
          let cursor;
          let page = 0;
          do {
            page++;
            setStatus(`Scanning #${ch.name} (${i + 1}/${channels.length})${page > 1 ? ` p${page}` : ''}…`);
            const params = { channel: ch.id, oldest, limit: '200' };
            if (cursor) params.cursor = cursor;
            const data = await slackGet('conversations.history', params);
            const topLevel = data.messages || [];
            console.log(`[Slack] #${ch.name} p${page}: ${topLevel.length} msgs`);

            // Top-level mentions
            topLevel
              .filter(m => mentionsHandle(m.text) && m.type === 'message' && !m.subtype)
              .forEach(m => allMatches.push({ ...m, _channel: ch, _inThread: false }));

            // Check thread replies for any message that has replies
            const threaded = topLevel.filter(m => (m.reply_count || 0) > 0);
            console.log(`[Slack] #${ch.name} p${page}: ${threaded.length} threaded msgs`);
            for (const parent of threaded) {
              try {
                // No oldest filter here — fetch all replies in the thread
                const rd = await slackGet('conversations.replies', { channel: ch.id, ts: parent.ts, limit: '200' });
                // replies[0] is the parent itself — skip it
                const replies = (rd.messages || []).slice(1);
                const matchCount = replies.filter(m => mentionsHandle(m.text)).length;
                console.log(`[Slack] #${ch.name} thread ts=${parent.ts}: ${replies.length} replies, matches=${matchCount}`);
                replies
                  .filter(m => mentionsHandle(m.text))
                  .forEach(m => allMatches.push({ ...m, _channel: ch, _inThread: true, _parentTs: parent.ts }));
              } catch (e) {
                scanErrors.push(`#${ch.name} thread ${parent.ts}: ${e.message}`);
                console.warn(`[Slack] thread error #${ch.name} ts=${parent.ts}:`, e.message);
              }
            }

            setMessages([...allMatches].sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts)));
            cursor = data.response_metadata?.next_cursor;
          } while (cursor);
        } catch (e) {
          scanErrors.push(`#${ch.name}: ${e.message}`);
        }
      }

      setErrors(scanErrors);
      setMessages([...allMatches].sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts)));
    } catch (err) {
      setErrors([err.message]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { scanChannels(); }, [scanChannels]);

  const filtered = useMemo(() => {
    if (!search.trim()) return messages;
    const q = search.toLowerCase();
    return messages.filter(m =>
      slackStripMarkup(m.text).toLowerCase().includes(q) ||
      m._channel?.name?.toLowerCase().includes(q)
    );
  }, [messages, search]);

  const formatTs = (ts) => {
    try { return format(new Date(parseFloat(ts) * 1000), 'MMM d, h:mm a'); }
    catch { return ''; }
  };

  const permalink = (ch, ts, parentTs) => {
    const p = ts.replace('.', '');
    const base = `https://${SLACK_WORKSPACE}.slack.com/archives/${ch.id}/p${p}`;
    // Thread replies need ?thread_ts= to open directly in the thread
    if (parentTs) return `${base}?thread_ts=${parentTs}&cid=${ch.id}`;
    return base;
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: '820px', width: '95vw', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: 0 }}
      >
        {/* Header */}
        <div className="modal-header" style={{ padding: '1rem 1.25rem', flexShrink: 0 }}>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <MessageSquare size={18} />
            @{SLACK_SEARCH_HANDLE}
            {messages.length > 0 && (
              <span style={{ fontSize: '0.78rem', fontWeight: 400, color: 'var(--text-muted)' }}>
                {messages.length} mention{messages.length !== 1 ? 's' : ''}{loading ? '…' : ' · last 30 days'}
              </span>
            )}
          </h2>
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <button onClick={scanChannels} title="Refresh"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} />
            </button>
            <button onClick={onClose}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Errors */}
        {errors.length > 0 && (
          <div style={{ margin: '0 1.25rem 0.5rem', padding: '0.5rem 0.75rem', background: '#fef2f2', color: '#dc2626', borderRadius: '6px', fontSize: '0.78rem', flexShrink: 0 }}>
            <AlertCircle size={13} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            {errors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}

        {/* Search */}
        <div style={{ padding: '0 1.25rem 0.75rem', flexShrink: 0 }}>
          <input
            className="form-input"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by message or channel…"
            style={{ width: '100%', fontSize: '0.85rem' }}
          />
        </div>

        {/* Body */}
        <div style={{ overflow: 'auto', flex: 1, padding: '0 1.25rem 1.25rem' }}>
          {/* Status bar shown while scanning */}
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0', marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
              <Loader2 size={14} className="spin" />
              <span>{status}</span>
            </div>
          )}
          {/* Empty state only when done scanning and nothing found */}
          {!loading && filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              No mentions found in the last 30 days
            </div>
          ) : filtered.length > 0 ? (
            filtered.map((msg, idx) => {
              const ch = msg._channel;
              const preview = slackStripMarkup(msg.text);
              const time = formatTs(msg.ts);
              const link = permalink(ch, msg.ts, msg._parentTs);

              return (
                <div key={`${msg.ts}-${idx}`} style={{
                  padding: '0.75rem 0',
                  borderBottom: '1px solid var(--border-color)',
                  display: 'flex', flexDirection: 'column', gap: '0.35rem',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
                      padding: '0.1rem 0.45rem', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 600,
                      background: ch?.is_private ? '#fef3c7' : '#eff6ff',
                      color: ch?.is_private ? '#b45309' : '#1d4ed8',
                    }}>
                      {ch?.is_private ? <Shield size={10} /> : <Hash size={10} />}
                      {ch?.name || ch?.id}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', flex: 1 }}>
                      {time}
                      {msg._inThread && (
                        <span style={{ marginLeft: '0.4rem', background: 'var(--bg-hover)', padding: '0.1rem 0.35rem', borderRadius: '3px' }}>
                          thread reply
                        </span>
                      )}
                    </span>
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        fontSize: '0.75rem', fontWeight: 600,
                        color: 'var(--accent-primary)', textDecoration: 'none',
                        padding: '0.2rem 0.5rem', borderRadius: '4px',
                        border: '1px solid var(--accent-primary)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      Open Thread
                    </a>
                  </div>
                  <p style={{
                    margin: 0, fontSize: '0.83rem', color: 'var(--text-secondary)',
                    overflow: 'hidden', display: '-webkit-box',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  }}>
                    {preview}
                  </p>
                </div>
              );
            })
          ) : null}
        </div>
      </div>
    </div>
  );
};

// ─── DRIVE SHEET MODAL ──────────────────────────────────
const DriveSheetModal = ({ deptName, deptId, onClose, onCreated }) => {
  const [tabs, setTabs] = useState([{ name: '', source: 'manual', headers: '', data: '', url: '', importing: false, imported: false }]);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const addTab = () => setTabs(prev => [...prev, { name: '', source: 'manual', headers: '', data: '', url: '', importing: false, imported: false }]);
  const removeTab = (idx) => setTabs(prev => prev.filter((_, i) => i !== idx));
  const updateTab = (idx, field, value) => setTabs(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));

  const handleImportGoogleSheet = async (idx) => {
    const tab = tabs[idx];
    if (!tab.url.trim()) return;
    updateTab(idx, 'importing', true);
    try {
      const imported = await importFromGoogleSheet(tab.url.trim());
      if (imported.length > 0) {
        const first = imported[0];
        updateTab(idx, 'name', tab.name || first.name);
        updateTab(idx, 'headers', first.headers.join(', '));
        updateTab(idx, 'data', first.data.map(r => r.join(', ')).join('\n'));
        updateTab(idx, 'imported', true);
        if (imported.length > 1) {
          const newTabs = imported.slice(1).map(t => ({
            name: t.name,
            source: 'google_sheet',
            headers: t.headers.join(', '),
            data: t.data.map(r => r.join(', ')).join('\n'),
            url: tab.url,
            importing: false,
            imported: true,
          }));
          setTabs(prev => [...prev, ...newTabs]);
        }
      }
    } catch (err) {
      setError(`Import failed: ${err.message}`);
    } finally {
      updateTab(idx, 'importing', false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError('');
    try {
      const tabConfigs = tabs
        .filter(t => t.name.trim())
        .map(t => ({
          name: t.name.trim(),
          headers: t.headers ? t.headers.split(',').map(h => h.trim()).filter(Boolean) : [],
          data: t.data ? t.data.split('\n').filter(r => r.trim()).map(row => row.split(',').map(cell => cell.trim())) : [],
        }));
      const result = await createDriveSheetForDept(deptId, deptName, tabConfigs);
      onCreated(result);
    } catch (err) {
      setError(err.message || 'Failed to create drive sheet');
    } finally {
      setCreating(false);
    }
  };

  const DATA_SOURCES = [
    { value: 'manual', label: 'Manual Input' },
    { value: 'google_sheet', label: 'Google Sheet' },
    { value: 'devrev', label: 'DevRev' },
    { value: 'jira', label: 'Jira' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '640px', maxHeight: '85vh', overflow: 'auto' }}>
        <div className="modal-header">
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>
            <TableIcon size={18} style={{ verticalAlign: 'middle', marginRight: '0.5rem' }} />
            Create Drive Sheet — {deptName} Roster Db
          </h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
            <X size={20} />
          </button>
        </div>

        {error && (
          <div style={{ padding: '0.5rem 0.75rem', background: '#fef2f2', color: '#dc2626', borderRadius: '6px', fontSize: '0.8rem', margin: '0.5rem 0' }}>
            <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} /> {error}
          </div>
        )}

        <div style={{ marginTop: '1rem' }}>
          <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: '0.3rem' }}>
            Describe what this sheet should contain (optional)
          </label>
          <textarea
            className="form-textarea"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="E.g., Track projects, bandwidth allocation, tickets, and issues for the PS-POS team..."
            rows={2}
            style={{ width: '100%', fontSize: '0.85rem' }}
          />
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Sheet Tabs</label>
            <button onClick={addTab} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-primary)', fontSize: '0.8rem', fontWeight: 600 }}>
              <Plus size={14} style={{ verticalAlign: 'middle' }} /> Add Tab
            </button>
          </div>

          {tabs.map((tab, idx) => (
            <div key={idx} style={{ background: 'var(--bg-hover)', borderRadius: '8px', padding: '0.75rem', marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                <input
                  className="form-input"
                  value={tab.name}
                  onChange={e => updateTab(idx, 'name', e.target.value)}
                  placeholder="Tab name (e.g., Projects, Tickets)"
                  style={{ flex: 1, fontSize: '0.85rem' }}
                />
                {tabs.length > 1 && (
                  <button onClick={() => removeTab(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-danger)' }}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              {/* Data Source Selector */}
              <div style={{ marginBottom: '0.5rem' }}>
                <label style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>Tab Data Source</label>
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  {DATA_SOURCES.map(src => (
                    <button
                      key={src.value}
                      onClick={() => updateTab(idx, 'source', src.value)}
                      style={{
                        padding: '0.3rem 0.6rem',
                        borderRadius: '6px',
                        border: '1px solid',
                        borderColor: tab.source === src.value ? 'var(--accent-primary)' : 'var(--border-color)',
                        background: tab.source === src.value ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                        color: tab.source === src.value ? '#fff' : 'var(--text-primary)',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        cursor: 'pointer',
                        transition: 'all 0.15s',
                      }}
                    >
                      {src.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Manual Input */}
              {tab.source === 'manual' && (
                <>
                  <input
                    className="form-input"
                    value={tab.headers}
                    onChange={e => updateTab(idx, 'headers', e.target.value)}
                    placeholder="Column headers (comma-separated, e.g., Project, Assignee, Status)"
                    style={{ width: '100%', fontSize: '0.8rem', marginBottom: '0.4rem' }}
                  />
                  <textarea
                    className="form-textarea"
                    value={tab.data}
                    onChange={e => updateTab(idx, 'data', e.target.value)}
                    placeholder="Paste data rows (one row per line, comma-separated)"
                    rows={3}
                    style={{ width: '100%', fontSize: '0.8rem' }}
                  />
                </>
              )}

              {/* Google Sheet Import */}
              {tab.source === 'google_sheet' && (
                <>
                  <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.4rem' }}>
                    <input
                      className="form-input"
                      value={tab.url}
                      onChange={e => updateTab(idx, 'url', e.target.value)}
                      placeholder="Paste Google Sheets URL..."
                      style={{ flex: 1, fontSize: '0.8rem' }}
                    />
                    <button
                      className="btn btn-primary"
                      onClick={() => handleImportGoogleSheet(idx)}
                      disabled={tab.importing || !tab.url.trim()}
                      style={{ fontSize: '0.75rem', padding: '0.3rem 0.7rem', whiteSpace: 'nowrap' }}
                    >
                      {tab.importing ? <Loader2 size={12} className="spin" /> : 'Import'}
                    </button>
                  </div>
                  {tab.imported && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--accent-success)', marginBottom: '0.3rem' }}>
                      <CheckCircle size={12} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                      Imported {tab.headers ? tab.headers.split(',').length : 0} columns, {tab.data ? tab.data.split('\n').filter(r => r.trim()).length : 0} rows
                    </div>
                  )}
                  <input
                    className="form-input"
                    value={tab.headers}
                    onChange={e => updateTab(idx, 'headers', e.target.value)}
                    placeholder="Column headers (auto-filled on import)"
                    style={{ width: '100%', fontSize: '0.8rem', marginBottom: '0.4rem' }}
                  />
                  <textarea
                    className="form-textarea"
                    value={tab.data}
                    onChange={e => updateTab(idx, 'data', e.target.value)}
                    placeholder="Data will appear here after import"
                    rows={3}
                    style={{ width: '100%', fontSize: '0.8rem' }}
                  />
                </>
              )}

              {/* DevRev */}
              {tab.source === 'devrev' && (
                <div>
                  <input
                    className="form-input"
                    value={tab.url}
                    onChange={e => updateTab(idx, 'url', e.target.value)}
                    placeholder="Paste DevRev work item IDs (comma-separated) or project URL..."
                    style={{ width: '100%', fontSize: '0.8rem', marginBottom: '0.4rem' }}
                  />
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
                    DevRev integration coming soon. For now, export from DevRev and use Google Sheet or Manual import.
                  </p>
                </div>
              )}

              {/* Jira */}
              {tab.source === 'jira' && (
                <div>
                  <input
                    className="form-input"
                    value={tab.url}
                    onChange={e => updateTab(idx, 'url', e.target.value)}
                    placeholder="Paste Jira project URL or JQL filter..."
                    style={{ width: '100%', fontSize: '0.8rem', marginBottom: '0.4rem' }}
                  />
                  <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
                    Jira integration coming soon. For now, export from Jira and use Google Sheet or Manual import.
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.25rem' }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            onClick={handleCreate}
            disabled={creating || !tabs.some(t => t.name.trim())}
          >
            {creating ? <><Loader2 size={14} className="spin" /> Creating...</> : <><PlusCircle size={14} /> Create Sheet</>}
          </button>
        </div>
      </div>
    </div>
  );
};

// 3. GENERATOR
const Generator = ({ onClose, onGenerate, currentDate, teams = [] }) => {
  const [slackThread, setSlackThread] = useState('');
  const [notes, setNotes] = useState('');
  const [generating, setGenerating] = useState(false);
  const [selectedMonth, setSelectedMonth] = useState(currentDate.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(currentDate.getFullYear());
  const [selectedTeam, setSelectedTeam] = useState(teams[0]?.id || '');

  // Update selected team when teams load
  useEffect(() => {
    if (teams.length > 0 && !selectedTeam) {
      setSelectedTeam(teams[0].id);
    }
  }, [teams]);

  const months = [
    { value: 1, label: 'January' },
    { value: 2, label: 'February' },
    { value: 3, label: 'March' },
    { value: 4, label: 'April' },
    { value: 5, label: 'May' },
    { value: 6, label: 'June' },
    { value: 7, label: 'July' },
    { value: 8, label: 'August' },
    { value: 9, label: 'September' },
    { value: 10, label: 'October' },
    { value: 11, label: 'November' },
    { value: 12, label: 'December' }
  ];

  const years = [2025, 2026, 2027, 2028];

  const handleGenerate = async () => {
    const team = teams.find(t => t.id === selectedTeam);
    if (!team) return;

    setGenerating(true);
    await onGenerate({
      slack_thread: slackThread,
      notes: notes,
      month: selectedMonth,
      year: selectedYear,
      team_name: team.name,
      team_members: team.members,
      custom_prompt: team.custom_prompt || null
    });
    setGenerating(false);
    onClose();
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content" style={{ maxWidth: '600px' }}>
        <div className="modal-header">
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Wand2 size={20} className="modal-icon" />
              Generate Roster
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.25rem 0 0 0' }}>AI-powered automated roster generation</p>
          </div>
        </div>

        {/* Team Selector */}
        <div className="form-group">
          <label>Team</label>
          <select
            value={selectedTeam}
            onChange={(e) => setSelectedTeam(e.target.value)}
            className="form-select"
          >
            {teams.length === 0 ? (
              <option value="">No teams available</option>
            ) : (
              teams.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({t.members.length} members)</option>
              ))
            )}
          </select>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Month</label>
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
              className="form-select"
            >
              {months.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Year</label>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(parseInt(e.target.value))}
              className="form-select"
            >
              {years.map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-group">
          <label>Slack Thread Content</label>
          <textarea
            rows={6}
            placeholder="Paste the Slack thread here..."
            value={slackThread}
            onChange={(e) => setSlackThread(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Special Notes / Instructions</label>
          <textarea
            rows={3}
            placeholder="E.g., Ashish is on leave Feb 5th..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="modal-actions" style={{ marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid var(--border-color)' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={generating}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleGenerate} disabled={generating || !selectedTeam}>
            {generating ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
            {generating ? 'Generating...' : 'Generate with AI'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Delete Confirmation Modal
const DeleteConfirm = ({ onClose, onConfirm, currentDate, deleting, teams = [], selectedTeam, onTeamChange }) => {
  return (
    <div className="modal-overlay">
      <div className="modal-content modal-small">
        <div className="modal-header">
          <Trash2 size={24} className="modal-icon-danger" />
          <h2>Delete Roster</h2>
        </div>

        {teams.length > 0 && (
          <div className="form-group">
            <label>Select Team to Delete</label>
            <select
              value={selectedTeam || ''}
              onChange={(e) => onTeamChange(e.target.value)}
              className="form-select"
            >
              {teams.map(t => (
                <option key={t.id} value={t.name}>{t.name}</option>
              ))}
            </select>
          </div>
        )}

        <p className="modal-text">
          Are you sure you want to delete the roster for <strong>{selectedTeam}</strong> for <strong>{format(currentDate, 'MMMM yyyy')}</strong>? This action cannot be undone.
        </p>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose} disabled={deleting}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={deleting}>
            {deleting ? <Loader2 size={16} className="spin" /> : <Trash2 size={16} />}
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Admin Manager Modal
const AdminManager = ({ onClose, departments, userRole }) => {
  const isPlatformAdmin = userRole?.isPlatformAdmin;
  const adminDeptIds = (userRole?.departments || []).map(d => d.id);
  const managedDepts = isPlatformAdmin
    ? departments
    : departments.filter(d => adminDeptIds.includes(d.id));

  const [admins, setAdmins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState('');
  const [selectedRole, setSelectedRole] = useState(isPlatformAdmin ? 'platform_admin' : 'dept_admin');
  const [selectedDept, setSelectedDept] = useState(managedDepts.length === 1 ? managedDepts[0].id : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadAdmins();
  }, []);

  const loadAdmins = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await listAdmins();
      // Normalize: if data is array of platform_admins, add role field
      setAdmins(data.map(a => ({ ...a, role: a.role || 'platform_admin' })));
    } catch (err) {
      setError(err.message || 'Failed to load admins');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!newEmail.trim()) return;
    setSaving(true);
    setError('');
    try {
      await addAdmin(newEmail.trim(), selectedRole, selectedRole !== 'platform_admin' ? selectedDept : null);
      setNewEmail('');
      await loadAdmins();
    } catch (err) {
      setError(err.message || 'Failed to add admin');
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (admin) => {
    const label = admin.role === 'platform_admin' ? 'platform admin' : `${admin.role} for ${admin.departments?.name || 'department'}`;
    if (!confirm(`Remove ${admin.members?.email || admin.email} as ${label}?`)) return;
    try {
      await removeAdmin(
        admin.members?.email || admin.email,
        admin.role,
        admin.role !== 'platform_admin' ? admin.department_id : null
      );
      await loadAdmins();
    } catch (err) {
      setError(err.message || 'Failed to remove admin');
    }
  };

  const roleLabel = (role) => {
    if (role === 'platform_admin') return 'Super Admin';
    if (role === 'dept_admin') return 'Dept Admin';
    return role;
  };

  const roleBadge = (role) => {
    const colors = {
      platform_admin: { bg: '#dbeafe', color: '#1d4ed8' },
      dept_admin: { bg: '#fef3c7', color: '#92400e' }
    };
    const c = colors[role] || { bg: 'var(--bg-hover)', color: 'var(--text-secondary)' };
    return (
      <span style={{
        fontSize: '0.7rem', fontWeight: 600, padding: '0.15rem 0.4rem',
        borderRadius: '4px', background: c.bg, color: c.color, marginLeft: '0.5rem'
      }}>
        {roleLabel(role)}
      </span>
    );
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content modal-small" style={{ maxWidth: '560px' }}>
        <div className="modal-header">
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Users size={20} className="modal-icon" />
              Manage Admins
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.25rem 0 0 0' }}>Grant or revoke administrator access</p>
          </div>
        </div>

        {error && (
          <div style={{ color: 'var(--accent-danger)', fontSize: '0.85rem', padding: '0 1.5rem', marginBottom: '0.5rem' }}>
            <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            {error}
          </div>
        )}

        <div style={{ padding: '0 1.5rem 1rem' }}>
          <form onSubmit={handleAdd} style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="email@razorpay.com"
                className="form-input"
                style={{ flex: 1 }}
                disabled={saving}
              />
              <button type="submit" className="btn btn-primary" disabled={saving || !newEmail.trim()}>
                {saving ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                Add
              </button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <select
                value={selectedRole}
                onChange={(e) => setSelectedRole(e.target.value)}
                className="form-input"
                style={{ flex: 1 }}
              >
                {isPlatformAdmin && <option value="platform_admin">Super Admin</option>}
                <option value="dept_admin">Dept Admin</option>
              </select>
              {selectedRole !== 'platform_admin' && (
                <select
                  value={selectedDept}
                  onChange={(e) => setSelectedDept(e.target.value)}
                  className="form-input"
                  style={{ flex: 1 }}
                >
                  <option value="">Select department...</option>
                  {managedDepts.map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              )}
            </div>
          </form>

          {loading ? (
            <div style={{ textAlign: 'center', padding: '1rem' }}>
              <Loader2 size={20} className="spin" />
            </div>
          ) : admins.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              No admins found
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {admins.map((admin) => (
                <div key={admin.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.6rem 0.75rem',
                  borderRadius: '8px',
                  background: 'var(--bg-hover)',
                  fontSize: '0.85rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                      {admin.members?.full_name || admin.members?.email || admin.email}
                    </span>
                    {roleBadge(admin.role)}
                    {admin.departments?.name && (
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginLeft: '0.25rem' }}>
                        ({admin.departments.name})
                      </span>
                    )}
                  </div>
                  <button
                    className="btn btn-icon"
                    onClick={() => handleRemove(admin)}
                    title="Remove"
                    style={{ padding: '0.25rem', background: 'transparent', color: 'var(--accent-danger)' }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

// 3b. DEPARTMENT MANAGER MODAL
const DepartmentManager = ({ onClose, onDepartmentCreated }) => {
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadDepartments();
  }, []);

  const loadDepartments = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getDepartments();
      setDepartments(data);
    } catch (err) {
      setError(err.message || 'Failed to load departments');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true);
    setError('');
    try {
      const slug = newSlug.trim() || newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      await createDepartment(newName.trim(), slug);
      setNewName('');
      setNewSlug('');
      await loadDepartments();
      if (onDepartmentCreated) onDepartmentCreated();
    } catch (err) {
      setError(err.message || 'Failed to create department');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content modal-small" style={{ maxWidth: '520px' }}>
        <div className="modal-header">
          <div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Building2 size={20} className="modal-icon" />
              Manage Departments
            </h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.25rem 0 0 0' }}>Create and manage departments</p>
          </div>
        </div>

        {error && (
          <div style={{ color: 'var(--accent-danger)', fontSize: '0.85rem', padding: '0 1.5rem', marginBottom: '0.5rem' }}>
            <AlertCircle size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
            {error}
          </div>
        )}

        <div style={{ padding: '0 1.5rem 1rem' }}>
          <form onSubmit={handleCreate} style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Department name"
                className="form-input"
                style={{ flex: 2 }}
                disabled={saving}
              />
              <input
                type="text"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder="slug (auto)"
                className="form-input"
                style={{ flex: 1 }}
                disabled={saving}
              />
              <button type="submit" className="btn btn-primary" disabled={saving || !newName.trim()}>
                {saving ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
                Create
              </button>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Slug is auto-generated from name if left empty. Use lowercase letters, numbers, and hyphens.
            </p>
          </form>

          {loading ? (
            <div style={{ textAlign: 'center', padding: '1rem' }}>
              <Loader2 size={20} className="spin" />
            </div>
          ) : departments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              No departments yet. Create one above.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {departments.map((dept) => (
                <div key={dept.id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.6rem 0.75rem',
                  borderRadius: '8px',
                  background: 'var(--bg-hover)',
                  fontSize: '0.85rem'
                }}>
                  <div>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{dept.name}</span>
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>
                      {dept.slug}
                    </span>
                    {dept.user_role && (
                      <span style={{
                        fontSize: '0.7rem', fontWeight: 600, padding: '0.15rem 0.4rem',
                        borderRadius: '4px', background: dept.user_role === 'dept_admin' ? '#fef3c7' : '#d1fae5',
                        color: dept.user_role === 'dept_admin' ? '#92400e' : '#065f46', marginLeft: '0.5rem'
                      }}>
                        {dept.user_role === 'dept_admin' ? 'Admin' : dept.user_role === 'dept_lead' ? 'Lead' : 'Member'}
                      </span>
                    )}
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                    {new Date(dept.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
};

// 4. TEAM SETTINGS MODAL
const TeamSettings = ({ onClose, onTeamsChange, departmentId }) => {
  const [teams, setTeams] = useState([]);
  const [memberEmails, setMemberEmails] = useState({});
  const [loading, setLoading] = useState(true);
  const [editingTeam, setEditingTeam] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isPromptFullscreen, setIsPromptFullscreen] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formMembers, setFormMembers] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  const [showPromptEditor, setShowPromptEditor] = useState(false);

  // Fetch teams on mount and when department changes
  useEffect(() => {
    loadTeams();
  }, [departmentId]);

  const loadTeams = async () => {
    setLoading(true);
    try {
      const [data, emailsData] = await Promise.all([getTeams(departmentId), getTeamEmails(departmentId)]);
      setTeams(data);

      const emailMap = {};
      if (emailsData && Array.isArray(emailsData)) {
        emailsData.forEach(e => { emailMap[e.name] = e; });
      }
      setMemberEmails(emailMap);
    } catch (err) {
      console.error('Failed to load teams or emails:', err);
    }
    setLoading(false);
  };

  const resetForm = () => {
    setFormName('');
    setFormMembers('');
    setFormPrompt('');
    setShowPromptEditor(false);
    setIsPromptFullscreen(false);
    setEditingTeam(null);
    setIsCreating(false);
  };

  const handleShowPromptChange = (checked) => {
    setShowPromptEditor(checked);
    // Load default prompt when enabling, unless there's already content
    if (checked && !formPrompt) {
      setFormPrompt(DEFAULT_PROMPT);
    }
  };

  const startCreate = () => {
    resetForm();
    setIsCreating(true);
  };

  const startEdit = (team) => {
    setFormName(team.name);
    const membersWithEmails = team.members.map(name => {
      const emailObj = memberEmails[name];
      return emailObj && emailObj.email ? `${name}, ${emailObj.email}` : name;
    });
    setFormMembers(membersWithEmails.join('\n'));
    setFormPrompt(team.custom_prompt || '');
    setShowPromptEditor(!!team.custom_prompt);
    setEditingTeam(team);
    setIsCreating(false);
  };

  const updateMemberEmailConfig = (name, field, value) => {
    setMemberEmails(prev => ({
      ...prev,
      [name]: {
        ...(prev[name] || { name, email: '' }),
        [field]: value
      }
    }));
  };

  const handleSave = async () => {
    if (!formName.trim() || !formMembers.trim()) return;

    setSaving(true);

    const membersArray = [];

    formMembers.split('\n').forEach(line => {
      const parts = line.split(',');
      if (parts.length > 0) {
        const name = parts[0].trim();
        if (name) {
          if (parts.length > 1) {
            const email = parts[1].trim();
            if (email) {
              membersArray.push({ name, email });
            } else {
              membersArray.push(name);
            }
          } else {
            membersArray.push(name);
          }
        }
      }
    });

    try {
      if (isCreating) {
        await createTeam(formName, membersArray, formPrompt || null, departmentId);
      } else if (editingTeam) {
        await updateTeam(editingTeam.id, {
          name: formName,
          members: membersArray,
          custom_prompt: formPrompt || null
        });
      }

      await loadTeams();
      resetForm();
      if (onTeamsChange) onTeamsChange();
    } catch (err) {
      console.error('Error saving team:', err);
    }
    setSaving(false);
  };

  const handleDelete = async (teamId) => {
    if (window.confirm('Are you sure you want to delete this team?')) {
      await deleteTeam(teamId);
      await loadTeams();
      if (onTeamsChange) onTeamsChange();
    }
  };

  return (
    <div className="view-container flex flex-col h-full bg-[var(--bg-primary)]" style={{ padding: '0', background: 'var(--bg-secondary)' }}>
      <div className="view-header shadow-sm z-10 sticky top-0 bg-[var(--bg-primary)] border-b border-[var(--border-color)]" style={{ padding: '1.5rem 2rem', marginBottom: 0 }}>
        <div>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0, fontSize: '1.5rem', fontWeight: 600 }}>
            <Settings size={28} style={{ color: 'var(--accent-primary)' }} />
            Team Settings
          </h2>
          <p style={{ margin: '0.25rem 0 0 0', color: 'var(--text-muted)' }}>Manage teams, members, tracking emails, and custom AI prompts</p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-8" style={{ padding: '2rem' }}>
        <div style={{ display: 'flex', gap: '2rem', height: '100%', maxWidth: '1400px', margin: '0 auto' }}>
          {/* Teams List Card */}
          <div className="teams-list" style={{
            width: '320px',
            minWidth: '320px',
            background: 'var(--bg-card)',
            borderRadius: '12px',
            border: '1px solid var(--border-color)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            <div className="teams-list-header" style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-card)' }}>
              <h3 style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Teams</h3>
              <button className="btn btn-primary" onClick={startCreate} style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
                <Plus size={14} /> New
              </button>
            </div>

            {loading ? (
              <div className="loading-small"><Loader2 size={20} className="spin" /></div>
            ) : teams.length === 0 ? (
              <p className="no-teams" style={{ fontSize: '0.85rem', color: 'var(--text-muted)', textAlign: 'center', padding: '2rem 1rem' }}>No teams created yet</p>
            ) : (
              <div className="teams-items" style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {teams.map(team => (
                  <div
                    key={team.id}
                    className={`team-item ${editingTeam?.id === team.id ? 'active' : ''}`}
                    onClick={() => startEdit(team)}
                    style={{
                      padding: '0.75rem 1rem',
                      borderRadius: '8px',
                      background: editingTeam?.id === team.id ? 'var(--bg-card)' : 'transparent',
                      border: editingTeam?.id === team.id ? '1px solid var(--accent-primary)' : '1px solid transparent',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      transition: 'all 0.2s ease',
                      boxShadow: editingTeam?.id === team.id ? 'var(--shadow-sm)' : 'none'
                    }}
                  >
                    <div className="team-item-info" style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                      <span className="team-name" style={{ fontSize: '0.9rem', fontWeight: 600, color: editingTeam?.id === team.id ? 'var(--accent-primary)' : 'var(--text-primary)' }}>{team.name}</span>
                      <span className="team-count" style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{team.members.length} members</span>
                    </div>
                    {editingTeam?.id !== team.id && (
                      <button
                        className="btn-icon btn-delete-small"
                        onClick={(e) => { e.stopPropagation(); handleDelete(team.id); }}
                        style={{ padding: '0.4rem', color: 'var(--text-muted)', opacity: 0.5, transition: 'opacity 0.2s', background: 'transparent', border: 'none', cursor: 'pointer' }}
                        onMouseEnter={(e) => { e.currentTarget.style.opacity = 1; e.currentTarget.style.color = 'var(--accent-danger)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.opacity = 0.5; e.currentTarget.style.color = 'var(--text-muted)' }}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Team Form Card */}
          <div className="team-form" style={{
            flex: 1,
            background: 'var(--bg-card)',
            borderRadius: '12px',
            border: '1px solid var(--border-color)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden'
          }}>
            <div style={{ padding: '2rem', overflowY: 'auto', flex: 1 }}>
              {(isCreating || editingTeam) ? (
                <div style={{ maxWidth: '800px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600, margin: 0 }}>{isCreating ? 'Create New Team' : 'Edit Team'}</h3>
                    {editingTeam && (
                      <button className="btn btn-secondary" onClick={() => handleDelete(editingTeam.id)} style={{ color: 'var(--accent-danger)', borderColor: 'var(--accent-danger)', padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}>
                        <Trash2 size={14} /> Delete Team
                      </button>
                    )}
                  </div>

                  <div className="form-group">
                    <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem', display: 'block' }}>Team Name</label>
                    <input
                      type="text"
                      placeholder="e.g., Enterprise-VAS"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      className="form-input"
                    />
                  </div>

                  <div className="form-group">
                    <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.2rem', display: 'block' }}>Team Members</label>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Format: Name, Email (one per line)</p>
                    <textarea
                      rows={8}
                      className="form-textarea"
                      placeholder="John Doe, john@razorpay.com&#10;Jane Smith, jane@razorpay.com&#10;..."
                      value={formMembers}
                      onChange={(e) => setFormMembers(e.target.value)}
                    />
                  </div>

                  <div className="form-group" style={{ background: 'var(--bg-hover)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border-color)', marginTop: '2rem' }}>
                    <label className="checkbox-label" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: 0, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={showPromptEditor}
                        onChange={(e) => handleShowPromptChange(e.target.checked)}
                        style={{ width: '16px', height: '16px', accentColor: 'var(--accent-primary)' }}
                      />
                      <div>
                        <span style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)', display: 'block' }}>Use Custom AI Prompt</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Override the default AI instructions for this specific team</span>
                      </div>
                    </label>
                  </div>

                  {showPromptEditor && (
                    <div className={`form-group ${isPromptFullscreen ? 'prompt-fullscreen-container' : ''}`} style={{ marginTop: '1rem' }}>
                      <div className="prompt-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                        <label style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Custom Prompt Configuration</label>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => setIsPromptFullscreen(!isPromptFullscreen)}
                          style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem' }}
                        >
                          {isPromptFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                          {isPromptFullscreen ? ' Exit Fullscreen' : ' Fullscreen'}
                        </button>
                      </div>
                      <p className="form-hint" style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem', background: 'var(--bg-secondary)', padding: '0.75rem', borderRadius: '6px', fontFamily: 'JetBrains Mono' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Available Variables:</span> {'{{TEAM_NAME}}'}, {'{{MONTH_NAME}}'}, {'{{YEAR}}'}, {'{{TEAM_MEMBERS}}'}, {'{{SLACK_REQUESTS}}'}, {'{{START_DATE}}'}, {'{{END_DATE}}'}, {'{{MONTH_PADDED}}'}, {'{{PREVIOUS_MONTH_DATA}}'}
                      </p>
                      <textarea
                        rows={isPromptFullscreen ? 30 : 12}
                        placeholder="Enter custom AI prompt instructions here..."
                        value={formPrompt}
                        onChange={(e) => setFormPrompt(e.target.value)}
                        className="form-textarea"
                        style={{ fontFamily: 'JetBrains Mono', fontSize: '0.85rem', lineHeight: 1.5 }}
                      />
                    </div>
                  )}

                  <div className="form-actions" style={{ display: 'flex', gap: '1rem', marginTop: '2.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)', justifyContent: 'flex-end' }}>
                    <button className="btn btn-secondary" onClick={resetForm} disabled={saving}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving || !formName.trim() || !formMembers.trim()} style={{ padding: '0.6rem 1.5rem' }}>
                      {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                      {saving ? 'Saving...' : 'Save Team Configuration'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="team-form-empty" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
                  <Users size={64} style={{ marginBottom: '1.5rem', opacity: 0.2 }} />
                  <h3 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>Team Management</h3>
                  <p style={{ fontSize: '0.9rem', maxWidth: '300px', textAlign: 'center', lineHeight: 1.5 }}>Select a team from the list on the left to edit its configuration, members, and AI prompts, or click 'New' to create one.</p>
                </div>
              )}
            </div>
          </div>
        </div >
      </div >
    </div >
  );
};


// --- MAIN APP ---
function App() {
  // Auth State — support both Supabase and Google direct sessions
  const [authenticated, setAuthenticated] = useState(isLoggedIn() || isGoogleLoggedIn());

  // Check for OAuth redirect hash on load
  useEffect(() => {
    const session = handleAuthCallback();
    if (session) {
      setAuthenticated(true);
    }
  }, []);

  const handleLogin = () => {
    setAuthenticated(true);
  };

  const handleLogout = () => {
    authLogout();
    googleLogout();
    setAuthenticated(false);
  };

  // Show login page if not authenticated
  if (!authenticated) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <AuthenticatedApp onLogout={handleLogout} />;
}

// ─── AUTO ENABLEMENT PAGE (Admin) ──────────────────────────────────
const AutoEnablementPage = () => {
  const [teams, setTeams] = useState([]);
  const [memberEmails, setMemberEmails] = useState({});
  const [originalMemberEmails, setOriginalMemberEmails] = useState({});
  const [shiftConfigs, setShiftConfigs] = useState([]);
  const [rosterData, setRosterData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  const [editingContact, setEditingContact] = useState(null);
  const [newMemberName, setNewMemberName] = useState('');

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => { document.removeEventListener('mousedown', handleClickOutside); };
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [teamsData, emailsData, configsData] = await Promise.all([getTeams(), getTeamEmails(), getShiftConfigs()]);
      setTeams(teamsData);
      setShiftConfigs(configsData || []);

      const emailMap = {};
      if (emailsData && Array.isArray(emailsData)) {
        emailsData.forEach(e => { emailMap[e.name] = e; });
      }
      setMemberEmails(emailMap);
      setOriginalMemberEmails(JSON.parse(JSON.stringify(emailMap)));

      if (!selectedTeamId && teamsData.length > 0) {
        setSelectedTeamId(teamsData[0].id);
      }
    } catch (err) {
      console.error(err);
      setToast({ message: 'Failed to load configuration data', type: 'error' });
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!selectedTeamId) return;
    const selectedTeam = teams.find(t => t.id === selectedTeamId);
    if (!selectedTeam) return;

    const fetchCurrentRoster = async () => {
      try {
        const currentDate = new Date();
        const data = await fetchRoster(currentDate.getFullYear(), currentDate.getMonth() + 1, selectedTeam.name, selectedDepartmentId || undefined);
        const todayStr = format(currentDate, 'yyyy-MM-dd');
        const todaysRoster = data.filter(r => r.Date === todayStr);
        setRosterData(todaysRoster);
      } catch (err) {
        console.warn('Could not load current roster for team', err);
      }
    };
    fetchCurrentRoster();
  }, [selectedTeamId, teams]);

  const updateMemberEmailConfig = (name, field, value) => {
    setMemberEmails(prev => ({
      ...prev,
      [name]: {
        ...(prev[name] || { name, email: '' }),
        [field]: value
      }
    }));
  };

  const handleAddMember = () => {
    const name = newMemberName.trim();
    if (!name || !selectedTeamId) return;

    setTeams(prevTeams => prevTeams.map(t => {
      if (t.id === selectedTeamId) {
        if (t.members.includes(name)) return t;
        return { ...t, members: [...t.members, name] };
      }
      return t;
    }));

    setMemberEmails(prev => ({
      ...prev,
      [name]: { ...(prev[name] || {}), name, email: '', auto_enable_bucket: true, contact_number: '' }
    }));

    setNewMemberName('');
    setToast({ message: `Added ${name} locally. Remember to click Save Configurations.`, type: 'success' });
  };

  const handleSave = async () => {
    const selectedTeam = teams.find(t => t.id === selectedTeamId);
    if (!selectedTeam) return;

    setSaving(true);
    const emailUpdates = [];

    selectedTeam.members.forEach(name => {
      const config = memberEmails[name] || {};
      emailUpdates.push({
        name,
        email: config.email || null,
        auto_enable_bucket: config.auto_enable_bucket ?? true,
        start_offset_mins: config.start_offset_mins !== undefined ? config.start_offset_mins : null,
        end_offset_mins: config.end_offset_mins !== undefined ? config.end_offset_mins : null,
        freshdesk_agent_id: config.freshdesk_agent_id || null,
        contact_number: config.contact_number || null
      });
    });

    try {
      if (emailUpdates.length > 0) {
        await updateTeamEmails(emailUpdates);
        setToast({ message: 'Configuration saved successfully', type: 'success' });
        await loadData();
      }
    } catch (err) {
      console.error('Save error', err);
      setToast({ message: 'Error saving configuration', type: 'error' });
    }
    setSaving(false);
  };

  const handleDeleteMember = async (memberName) => {
    if (!window.confirm(`Are you sure you want to remove ${memberName} from this team?`)) return;

    const selectedTeam = teams.find(t => t.id === selectedTeamId);
    if (!selectedTeam) return;

    try {
      const updatedMembers = selectedTeam.members.filter(m => m !== memberName);
      await updateTeam(selectedTeam.id, {
        name: selectedTeam.name,
        members: updatedMembers,
        custom_prompt: selectedTeam.custom_prompt || null
      });
      setToast({ message: `${memberName} removed from team successfully`, type: 'success' });
      await loadData();
    } catch (err) {
      console.error('Failed to remove member', err);
      setToast({ message: 'Failed to remove member. Ensure server is running.', type: 'error' });
    }
  };

  const selectedTeam = teams.find(t => t.id === selectedTeamId);

  return (
    <div className="view-container">
      <div className="view-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h2 style={{ margin: 0 }}><Clock size={20} style={{ verticalAlign: 'middle', marginRight: '8px' }} />Auto Bucket Management</h2>
          <div style={{ paddingLeft: '1.25rem', borderLeft: '1px solid var(--border-color)', position: 'relative' }}>
            <div
              ref={dropdownRef}
              className="custom-dropdown"
              style={{ position: 'relative', minWidth: '180px' }}
            >
              <button
                onClick={() => setDropdownOpen(!dropdownOpen)}
                className="btn btn-secondary"
                style={{
                  width: '100%',
                  padding: '0.45rem 1rem',
                  fontSize: '0.92rem',
                  fontWeight: 600,
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  cursor: 'pointer',
                  color: 'var(--text-primary)',
                  boxShadow: 'var(--shadow-sm)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  textAlign: 'left'
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  {selectedTeam ? selectedTeam.name : 'Select Team'}
                </span>
                <ChevronDown size={14} style={{ color: 'var(--text-muted)', transform: dropdownOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease', flexShrink: 0 }} />
              </button>

              {dropdownOpen && (
                <div style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  width: '100%',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                  zIndex: 50,
                  overflow: 'hidden',
                  maxHeight: '300px',
                  overflowY: 'auto'
                }}>
                  {teams.length === 0 ? (
                    <div style={{ padding: '0.75rem 1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No teams available</div>
                  ) : (
                    teams.map(t => (
                      <div
                        key={t.id}
                        onClick={() => {
                          setSelectedTeamId(t.id);
                          setDropdownOpen(false);
                        }}
                        style={{
                          padding: '0.75rem 1rem',
                          fontSize: '0.92rem',
                          fontWeight: selectedTeamId === t.id ? 600 : 400,
                          color: selectedTeamId === t.id ? 'var(--accent-primary)' : 'var(--text-primary)',
                          background: selectedTeamId === t.id ? 'var(--bg-hover)' : 'transparent',
                          cursor: 'pointer',
                          transition: 'background 0.15s ease',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between'
                        }}
                        onMouseEnter={(e) => {
                          if (selectedTeamId !== t.id) e.currentTarget.style.background = 'var(--bg-secondary)';
                        }}
                        onMouseLeave={(e) => {
                          if (selectedTeamId !== t.id) e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        {t.name}
                        {selectedTeamId === t.id && <CheckCircle size={14} style={{ color: 'var(--accent-primary)' }} />}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={() => setShowConfigModal(true)} disabled={loading || !selectedTeam}>
            <Settings size={16} /> Shift Configurations
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || !selectedTeam}>
            {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />} Save Configurations
          </button>
        </div>
      </div>

      {showConfigModal && (
        <ShiftConfigModal
          team={selectedTeam}
          onClose={() => setShowConfigModal(false)}
          configs={shiftConfigs}
          onConfigsUpdated={loadData}
        />
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`} style={{ margin: '0 0 1.5rem' }}>
          {toast.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {toast.message}
          <button onClick={() => setToast(null)}><X size={12} /></button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '3rem' }}><Loader2 size={24} className="spin" /></div>
      ) : teams.length === 0 ? (
        <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          <AlertCircle size={32} style={{ marginBottom: '0.75rem', opacity: 0.5 }} />
          <p>No teams available. Create a team first.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {selectedTeam && (
            <div style={{ background: 'var(--bg-card)', borderRadius: '12px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
              <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>{selectedTeam.name} Configuration</h3>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.5rem', lineHeight: 1.5 }}>
                  <strong style={{ color: 'var(--text-primary)' }}>Buffer Rules:</strong> Use negative numbers for mins <strong style={{ color: 'var(--accent-danger)' }}>before</strong> the shift, and positive for mins <strong style={{ color: 'var(--accent-success)' }}>after</strong>.<br />
                  Make sure every assigned agent has their correct Freshdesk <strong>Email</strong> set here so N8n can map their agent ID!
                </p>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.85rem' }}>
                  <thead style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
                    <tr>
                      <th style={{ padding: '1rem', fontWeight: 600 }}>Member Name</th>
                      <th style={{ padding: '1rem', fontWeight: 600 }}>Freshdesk Email</th>
                      <th style={{ padding: '1rem', fontWeight: 600, textAlign: 'center' }}>Agent Availability</th>
                      <th style={{ padding: '1rem', fontWeight: 600, textAlign: 'center' }}>Auto Enable</th>
                      <th style={{ padding: '1rem', fontWeight: 600, textAlign: 'center', whiteSpace: 'nowrap' }}>Start Buffer (M)</th>
                      <th style={{ padding: '1rem', fontWeight: 600, textAlign: 'center', whiteSpace: 'nowrap' }}>End Buffer (M)</th>
                      <th style={{ padding: '1rem', width: '40px' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedTeam.members.map(name => {
                      const config = memberEmails[name] || {};
                      const autoEnable = config.auto_enable_bucket ?? true;
                      const email = config.email || '';

                      // Today's shift resolution
                      const todayEntry = rosterData.find(r => r.Name === name);
                      const todaysShift = todayEntry ? todayEntry.Status : null;
                      const defaultConf = shiftConfigs.find(c => c.team_id === selectedTeamId && c.shift_name === todaysShift);

                      const hasStartOverride = config.start_offset_mins !== null && config.start_offset_mins !== undefined;
                      const hasEndOverride = config.end_offset_mins !== null && config.end_offset_mins !== undefined;

                      const effStart = hasStartOverride ? config.start_offset_mins : (defaultConf ? defaultConf.start_offset_mins : 0);
                      const effEnd = hasEndOverride ? config.end_offset_mins : (defaultConf ? defaultConf.end_offset_mins : 0);

                      return (
                        <tr key={name} style={{ borderTop: '1px solid var(--border-color)', background: editingContact === name ? 'var(--bg-hover)' : 'transparent' }}>
                          <td style={{ padding: '1rem', fontWeight: 500, color: 'var(--text-primary)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                              <span style={{ flex: 1 }}>{name}</span>
                              {editingContact === name ? (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--bg-primary)', padding: '2px 8px', borderRadius: '20px', border: '1px solid var(--accent-primary)' }}>
                                  <Phone size={12} style={{ color: 'var(--accent-primary)' }} />
                                  <input
                                    type="text"
                                    value={config.contact_number || ''}
                                    onChange={(e) => updateMemberEmailConfig(name, 'contact_number', e.target.value)}
                                    placeholder="Contact No."
                                    autoFocus
                                    onBlur={() => setEditingContact(null)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') setEditingContact(null); }}
                                    style={{ background: 'none', border: 'none', color: 'var(--text-primary)', fontSize: '0.75rem', width: '100px', outline: 'none', padding: '2px 0' }}
                                  />
                                  <button onClick={() => setEditingContact(null)} style={{ background: 'none', border: 'none', padding: 0, display: 'flex', cursor: 'pointer', color: 'var(--text-muted)' }}>
                                    <X size={12} />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setEditingContact(name)}
                                  style={{
                                    background: 'none', border: 'none', padding: '4px', borderRadius: '4px', cursor: 'pointer',
                                    color: config.contact_number ? 'var(--accent-primary)' : 'var(--text-muted)',
                                    opacity: config.contact_number ? 1 : 0.4,
                                    transition: 'all 0.2s', display: 'flex'
                                  }}
                                  title={config.contact_number || "Add Contact Details"}
                                >
                                  <Phone size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '0.75rem 1rem' }}>
                            <input
                              type="email"
                              value={email}
                              placeholder="agent@razorpay.com"
                              onChange={(e) => updateMemberEmailConfig(name, 'email', e.target.value)}
                              className="form-input"
                              style={{ width: '100%', minWidth: '200px', padding: '0.4rem 0.75rem', fontSize: '0.8rem' }}
                            />
                          </td>
                          <td style={{ padding: '1rem', textAlign: 'center' }}>
                            <AgentAvailability email={email} isAutoEnableOn={originalMemberEmails[name]?.auto_enable_bucket ?? true} onShowToast={setToast} />
                          </td>
                          <td style={{ padding: '1rem', textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={autoEnable}
                              onChange={(e) => updateMemberEmailConfig(name, 'auto_enable_bucket', e.target.checked)}
                              style={{ width: '16px', height: '16px', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
                            />
                          </td>
                          <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={hasStartOverride ? config.start_offset_mins : ''}
                                placeholder="Default"
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val === '' || val === '-') {
                                    updateMemberEmailConfig(name, 'start_offset_mins', null);
                                  } else {
                                    const parsed = parseInt(val);
                                    if (!isNaN(parsed)) updateMemberEmailConfig(name, 'start_offset_mins', parsed);
                                  }
                                }}
                                style={{
                                  width: '65px', padding: '0.4rem', fontSize: '0.85rem', borderRadius: '6px',
                                  border: '1px solid var(--border-color)', textAlign: 'center',
                                  background: hasStartOverride ? 'var(--bg-primary)' : 'var(--bg-hover)',
                                  color: hasStartOverride ? 'var(--text-primary)' : 'var(--text-muted)'
                                }}
                                title={hasStartOverride ? "Overridden" : `Default: ${effStart} mins (Shift: ${todaysShift || 'None'})`}
                              />
                            </div>
                          </td>
                          <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={hasEndOverride ? config.end_offset_mins : ''}
                                placeholder="Default"
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (val === '' || val === '-') {
                                    updateMemberEmailConfig(name, 'end_offset_mins', null);
                                  } else {
                                    const parsed = parseInt(val);
                                    if (!isNaN(parsed)) updateMemberEmailConfig(name, 'end_offset_mins', parsed);
                                  }
                                }}
                                style={{
                                  width: '65px', padding: '0.4rem', fontSize: '0.85rem', borderRadius: '6px',
                                  border: '1px solid var(--border-color)', textAlign: 'center',
                                  background: hasEndOverride ? 'var(--bg-primary)' : 'var(--bg-hover)',
                                  color: hasEndOverride ? 'var(--text-primary)' : 'var(--text-muted)'
                                }}
                                title={hasEndOverride ? "Overridden" : `Default: ${effEnd} mins (Shift: ${todaysShift || 'None'})`}
                              />
                            </div>
                          </td>
                          <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                              {(hasStartOverride || hasEndOverride) && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    updateMemberEmailConfig(name, 'start_offset_mins', null);
                                    updateMemberEmailConfig(name, 'end_offset_mins', null);
                                  }}
                                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', display: 'flex' }}
                                  title="Reset to Shift Default"
                                >
                                  <RefreshCw size={14} />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDeleteMember(name)}
                                style={{ background: 'none', border: 'none', color: 'var(--accent-danger)', opacity: 0.6, cursor: 'pointer', padding: '4px', display: 'flex', transition: 'opacity 0.2s' }}
                                onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
                                onMouseLeave={(e) => e.currentTarget.style.opacity = 0.6}
                                title="Remove User from Team"
                              >
                                <UserX size={15} />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Add Member Row - Below Table */}
              <div style={{
                padding: '1rem 1.5rem',
                background: 'var(--bg-hover)',
                borderTop: '1px solid var(--border-color)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '1rem'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1 }}>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    background: 'var(--bg-secondary)',
                    padding: '0.5rem 1rem',
                    borderRadius: '8px',
                    border: '1px solid var(--border-color)',
                    flex: 1,
                    maxWidth: '400px',
                    transition: 'all 0.2s'
                  }}>
                    <Plus size={16} style={{ color: 'var(--text-muted)' }} />
                    <input
                      type="text"
                      value={newMemberName}
                      onChange={(e) => setNewMemberName(e.target.value)}
                      placeholder="Add New Member Name..."
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddMember(); }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-primary)',
                        fontSize: '0.85rem',
                        outline: 'none',
                        width: '100%'
                      }}
                    />
                  </div>
                  <button
                    onClick={handleAddMember}
                    disabled={!newMemberName.trim()}
                    style={{
                      background: 'var(--accent-primary)',
                      color: 'white',
                      border: 'none',
                      padding: '0.5rem 1.25rem',
                      borderRadius: '8px',
                      fontSize: '0.85rem',
                      fontWeight: 500,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      opacity: newMemberName.trim() ? 1 : 0.5,
                      transition: 'all 0.2s',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                    }}
                  >
                    <span>Add Member</span>
                  </button>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <HelpCircle size={14} />
                  <span>Members stay in the team list even if not active in today's roster.</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── REQUESTS PAGE ───────────────────────────────────────────────
const RequestsPage = ({ userProfile }) => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [requestType, setRequestType] = useState('PL');
  const [datesList, setDatesList] = useState([]); // array of date strings
  const [dateInput, setDateInput] = useState(''); // current calendar value
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState(null);

  useEffect(() => { loadRequests(); }, []);

  const loadRequests = async () => {
    setLoading(true);
    try {
      const data = await getMyRequests();
      setRequests(data);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  const addDate = () => {
    if (dateInput && !datesList.includes(dateInput)) {
      setDatesList(prev => [...prev, dateInput].sort());
      setDateInput('');
    }
  };

  const removeDate = (d) => {
    setDatesList(prev => prev.filter(x => x !== d));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (datesList.length === 0) return;
    setSubmitting(true);
    try {
      await createLeaveRequest({ request_type: requestType, dates: datesList, reason });
      setToast({ message: 'Request submitted successfully!', type: 'success' });
      setDatesList([]);
      setReason('');
      await loadRequests();
    } catch (err) {
      setToast({ message: err.message || 'Failed to submit request', type: 'error' });
    } finally { setSubmitting(false); }
  };

  const getStatusBadge = (status) => {
    const colors = { pending: '#eab308', approved: '#22c55e', declined: '#ef4444' };
    return (
      <span style={{
        padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 600,
        background: `${colors[status]}20`, color: colors[status], textTransform: 'uppercase'
      }}>{status}</span>
    );
  };

  return (
    <div className="view-container">
      <div className="view-header">
        <h2><FileText size={20} style={{ verticalAlign: 'middle', marginRight: '8px' }} />Raise a Request</h2>
      </div>

      {toast && (
        <div className={`toast toast-${toast.type}`} style={{ margin: '0 0 1rem' }}>
          {toast.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {toast.message}
          <button onClick={() => setToast(null)}><X size={12} /></button>
        </div>
      )}

      {!userProfile?.name ? (
        <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          <AlertCircle size={24} style={{ marginBottom: '0.5rem' }} />
          <p>Your email is not mapped to a team member yet. Contact your admin to map your email.</p>
        </div>
      ) : (
        <>
          <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem', border: '1px solid var(--border-color)' }}>
            <form onSubmit={handleSubmit}>
              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem', display: 'block', color: 'var(--text-secondary)' }}>Request Type</label>
                <select value={requestType} onChange={(e) => setRequestType(e.target.value)} className="form-input" style={{ padding: '0.6rem', maxWidth: '300px' }}>
                  <option value="PL">PL — Planned Leave</option>
                  <option value="WL">WL — Wellness Leave</option>
                  <option value="WFH">WFH — Work From Home</option>
                </select>
              </div>

              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem', display: 'block', color: 'var(--text-secondary)' }}>Select Dates</label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <input
                    type="date"
                    value={dateInput}
                    onChange={(e) => setDateInput(e.target.value)}
                    className="form-input"
                    style={{ maxWidth: '200px' }}
                  />
                  <button type="button" className="btn btn-secondary" onClick={addDate} disabled={!dateInput} style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
                    <Plus size={14} /> Add Date
                  </button>
                </div>
                {datesList.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                    {datesList.map(d => (
                      <span key={d} style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                        padding: '0.25rem 0.6rem', borderRadius: '8px', fontSize: '0.8rem', fontWeight: 500,
                        background: 'rgba(0, 115, 255, 0.12)', color: 'var(--accent-primary)', border: '1px solid rgba(0, 115, 255, 0.25)'
                      }}>
                        <CalendarDays size={12} />
                        {d}
                        <button type="button" onClick={() => removeDate(d)} style={{
                          background: 'none', border: 'none', cursor: 'pointer', padding: '0', lineHeight: 1,
                          color: 'var(--accent-danger)', marginLeft: '2px'
                        }}>
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {datesList.length === 0 && (
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Pick dates from the calendar above</div>
                )}
              </div>

              <div className="form-group" style={{ marginBottom: '1rem' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem', display: 'block', color: 'var(--text-secondary)' }}>Reason <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span></label>
                <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Family function, doctor appointment, etc." className="form-input" />
              </div>
              <button type="submit" className="btn btn-primary" disabled={submitting || datesList.length === 0} style={{ minWidth: '140px' }}>
                {submitting ? <><Loader2 size={16} className="spin" /> Submitting...</> : <><Plus size={16} /> Submit Request</>}
              </button>
            </form>
          </div>

          <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: 'var(--text-primary)' }}>My Requests</h3>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '2rem' }}><Loader2 size={20} className="spin" /></div>
          ) : requests.length === 0 ? (
            <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>No requests yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {requests.map(r => (
                <div key={r.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0.75rem 1rem', borderRadius: '10px',
                  background: 'var(--bg-card)', border: '1px solid var(--border-color)'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--accent-primary)', minWidth: '40px' }}>{r.request_type}</span>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)' }}>{r.dates.join(', ')}</span>
                    {r.reason && <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>— {r.reason}</span>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {getStatusBadge(r.status)}
                    {r.reviewed_by && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>by {r.reviewed_by}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )
      }
    </div >
  );
};

// ─── REVIEW REQUESTS PAGE (Admin) ────────────────────────────────
const ReviewRequestsPage = ({ onRefreshRoster }) => {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => { loadPending(); }, []);

  const loadPending = async () => {
    setLoading(true);
    try {
      const data = await getPendingRequests();
      setRequests(data);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  const handleReview = async (id, decision) => {
    setProcessing(id);
    try {
      await reviewRequest(id, decision);
      setToast({ message: `Request ${decision}!`, type: 'success' });
      await loadPending();
      if (decision === 'approved' && onRefreshRoster) onRefreshRoster();
    } catch (err) {
      setToast({ message: err.message || 'Failed to review', type: 'error' });
    } finally { setProcessing(null); }
  };

  return (
    <div className="view-container">
      <div className="view-header">
        <h2><CheckSquare size={20} style={{ verticalAlign: 'middle', marginRight: '8px' }} />Review Requests</h2>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{requests.length} pending</span>
      </div>

      {toast && (
        <div className={`toast toast-${toast.type}`} style={{ margin: '0 0 1rem' }}>
          {toast.type === 'success' ? <CheckCircle size={14} /> : <AlertCircle size={14} />}
          {toast.message}
          <button onClick={() => setToast(null)}><X size={12} /></button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}><Loader2 size={20} className="spin" /></div>
      ) : requests.length === 0 ? (
        <div style={{ background: 'var(--bg-card)', borderRadius: '12px', padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          <CheckCircle size={32} style={{ marginBottom: '0.75rem', opacity: 0.5 }} />
          <p>All caught up! No pending requests.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {requests.map(r => (
            <div key={r.id} style={{
              padding: '1rem 1.25rem', borderRadius: '12px',
              background: 'var(--bg-card)', border: '1px solid var(--border-color)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{r.requester_name}</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginLeft: '0.5rem' }}>{r.team}</span>
                </div>
                <span style={{
                  padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 700,
                  background: 'rgba(0, 115, 255, 0.15)', color: 'var(--accent-primary)'
                }}>{r.request_type}</span>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                <CalendarDays size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                {r.dates.join(', ')}
              </div>
              {r.reason && <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem', fontStyle: 'italic' }}>"{r.reason}"</div>}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="btn btn-primary"
                  onClick={() => handleReview(r.id, 'approved')}
                  disabled={processing === r.id}
                  style={{ fontSize: '0.8rem', padding: '0.4rem 1rem' }}
                >
                  {processing === r.id ? <Loader2 size={14} className="spin" /> : <><CheckCircle size={14} /> Approve</>}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleReview(r.id, 'declined')}
                  disabled={processing === r.id}
                  style={{ fontSize: '0.8rem', padding: '0.4rem 1rem', color: 'var(--accent-danger)' }}
                >
                  <X size={14} /> Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

function AuthenticatedApp({ onLogout }) {
  const [view, setView] = useState('dashboard');
  const [isAdmin, setIsAdmin] = useState(false); // UI toggle — can user edit right now?
  const [userRole, setUserRole] = useState(null); // { isPlatformAdmin, canEdit, roles, departments }
  const [userProfile, setUserProfile] = useState(null);
  const [showGenerator, setShowGenerator] = useState(false);
  const [showDriveSheetModal, setShowDriveSheetModal] = useState(false);
  const [showDevRevModal, setShowDevRevModal] = useState(false);
  const [showSlackModal, setShowSlackModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showAdminManager, setShowAdminManager] = useState(false);
  const [showDeptManager, setShowDeptManager] = useState(false);
  const [currentDate, setCurrentDate] = useState(new Date());

  // Department state
  const [departments, setDepartments] = useState([]);
  const [selectedDepartmentId, setSelectedDepartmentId] = useState(() => {
    try { return localStorage.getItem('roster_selected_dept') || ''; } catch { return ''; }
  });

  // Command Palette State
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  // ⌘K keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(prev => !prev);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Theme State
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  useEffect(() => {
    if (theme === 'light') {
      document.body.classList.add('light-mode');
    } else {
      document.body.classList.remove('light-mode');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const [rosterData, setRosterData] = useState([]);
  const [rosterExists, setRosterExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Teams state
  const [teams, setTeams] = useState([]);
  const [selectedTeam, setSelectedTeam] = useState(''); // kept for DeleteConfirm compat
  const [viewMode, setViewMode] = useState('all'); // always 'all' for multi-team grouping
  const [selectedTeams, setSelectedTeams] = useState(() => {
    try {
      const saved = localStorage.getItem('roster_selected_teams');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }); // [] = All Groups

  useEffect(() => {
    localStorage.setItem('roster_selected_teams', JSON.stringify(selectedTeams));
  }, [selectedTeams]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebar_collapsed') === 'true');

  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      localStorage.setItem('sidebar_collapsed', !prev);
      return !prev;
    });
  };
  const [allTeamsData, setAllTeamsData] = useState([]);

  // Load teams on mount + check admin status + fetch user profile
  useEffect(() => {
    // If logged in via Google (no Supabase), enable Sheets mode before any API calls
    if (isGoogleLoggedIn() && !isLoggedIn()) {
      setDataLayerMode(true);
    }
    loadDepartments();
    checkAdmin().then(roleInfo => {
      setUserRole(roleInfo);
    }).catch((e) => { console.error('checkAdmin failed', e); setUserRole(null); });
    whoAmI().then(profile => {
      setUserProfile(profile);
    }).catch(() => setUserProfile(null));
  }, []);

  // Refresh departments when features are toggled in MiscSettings
  useEffect(() => {
    const handler = () => loadDepartments();
    window.addEventListener('departmentFeaturesUpdated', handler);
    return () => window.removeEventListener('departmentFeaturesUpdated', handler);
  }, []);

  const loadDepartments = async () => {
    try {
      const data = await getDepartments();
      setDepartments(data);
      // Auto-select first department if none selected
      if (!selectedDepartmentId && data.length > 0) {
        setSelectedDepartmentId(data[0].id);
        localStorage.setItem('roster_selected_dept', data[0].id);
      }
    } catch (e) { console.error('Failed to load departments', e); }
  };

  // Persist selected department
  useEffect(() => {
    if (selectedDepartmentId) localStorage.setItem('roster_selected_dept', selectedDepartmentId);
  }, [selectedDepartmentId]);

  // Set data layer mode — always ON for platform admins
  useEffect(() => {
    if (userRole?.isPlatformAdmin) {
      setDataLayerMode(true);
    } else {
      const dept = departments.find(d => d.id === selectedDepartmentId);
      const useSheets = dept?.features?.includes('google_sheets_enable') || false;
      setDataLayerMode(useSheets);
    }
  }, [selectedDepartmentId, departments, userRole]);

  const loadTeams = async () => {
    const data = await getTeams(selectedDepartmentId || undefined);
    setTeams(data);
    setSelectedTeam(data.length > 0 ? data[0].name : '');
  };

  // Reload teams when department changes — reset selected teams to avoid cross-dept leakage
  useEffect(() => {
    if (selectedDepartmentId) {
      setSelectedTeams([]);
      loadTeams();
    }
  }, [selectedDepartmentId]);

  // Fetch roster data when month or selected teams change
  const loadRoster = useCallback(async () => {
    setLoading(true);
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth() + 1;

    try {
      if (selectedTeams.length === 0) {
        // No filter = load ALL teams in department
        const allDataMap = await fetchAllTeamsRoster(year, month, selectedDepartmentId || undefined);
        const flatData = Object.values(allDataMap).flat();
        setAllTeamsData(flatData);
        setRosterData(flatData);
        setRosterExists(flatData.length > 0);
      } else {
        // Parallel-fetch only the selected teams, then combine
        const results = await Promise.all(
          selectedTeams.map(teamId => fetchRoster(year, month, teamId, selectedDepartmentId || undefined).catch(() => []))
        );
        const flatData = results.flat();
        setAllTeamsData(flatData);
        setRosterData(flatData);
        setRosterExists(flatData.length > 0);
      }
    } catch (error) {
      console.error('Error loading roster:', error);
      setToast({ message: 'Failed to load roster', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [currentDate, selectedTeams, selectedDepartmentId]);

  useEffect(() => {
    loadRoster();
  }, [loadRoster]);

  // Toggle Admin Mode (only available if user has edit role)
  const toggleAdminMode = () => {
    if (userRole?.canEdit) {
      setIsAdmin(prev => {
        if (!prev) setToast({ message: 'Admin Access Granted', type: 'success' });
        return !prev;
      });
    }
  };

  // Handle month change
  const handleDateChange = (newDate) => {
    setCurrentDate(newDate);
  };

  // Handle generate
  const handleGenerate = async (payload) => {
    setToast({ message: 'Generating roster...', type: 'loading' });

    try {
      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        setToast({ message: 'Roster generated successfully!', type: 'success' });
        await loadRoster();
      } else {
        throw new Error('Generation failed');
      }
    } catch (error) {
      console.error('Error generating roster:', error);
      setToast({ message: 'Failed to generate roster. Check N8n webhook.', type: 'error' });
    }
  };

  // Handle delete
  const handleDelete = async () => {
    setDeleting(true);
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth() + 1;

    try {
      const success = await deleteRoster(year, month, selectedTeam);
      if (success) {
        setToast({ message: `Roster for ${selectedTeam} deleted successfully`, type: 'success' });
        setRosterData([]);
        setRosterExists(false);
      }
    } catch (error) {
      setToast({ message: 'Failed to delete roster', type: 'error' });
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  // Handle cell update (admin mode)
  const handleCellUpdate = async (date, name, status) => {
    if (!isAdmin) return;

    // Find the agent's actual team and member ID from the data
    let team = selectedTeam;
    let teamId = null;
    let memberId = null;
    if (viewMode === 'all' && allTeamsData.length > 0) {
      const agentEntry = allTeamsData.find(d => d.Name === name && d.Date === date);
      if (agentEntry) {
        team = agentEntry.Team || team;
        teamId = agentEntry.TeamId;
        memberId = agentEntry.MemberId;
      }
    }
    if (!team && !teamId) return;

    try {
      await updateRosterEntry(date, memberId || name, status, teamId || team, selectedDepartmentId || undefined);
      // Update local state
      setRosterData(prev => prev.map(row =>
        row.Date === date && row.Name === name ? { ...row, Status: status } : row
      ));
      setAllTeamsData(prev => prev.map(row =>
        row.Date === date && row.Name === name ? { ...row, Status: status } : row
      ));
    } catch (error) {
      setToast({ message: 'Failed to update cell', type: 'error' });
    }
  };

  // Topbar Notification mock state
  const [notifications] = useState([{ id: 1, text: 'New requests pending review' }]);

  return (
    <div className="app-layout">
      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Onboarding Gate — user not assigned to any team/department */}
      {userRole && !userRole.isOnboarded && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', width: '100vw', background: 'var(--bg-primary)', padding: '2rem'
        }}>
          <div style={{
            background: 'var(--bg-card)', border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-lg)', padding: '2.5rem', maxWidth: '420px', width: '100%',
            boxShadow: 'var(--shadow-lg)', textAlign: 'center'
          }}>
            <div style={{
              width: '56px', height: '56px', borderRadius: '50%',
              background: 'var(--bg-hover)', display: 'flex', alignItems: 'center',
              justifyContent: 'center', margin: '0 auto 1.25rem'
            }}>
              <HelpCircle size={28} style={{ color: 'var(--accent-primary)' }} />
            </div>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
              You're Not Onboarded Yet
            </h2>
            <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '1.5rem' }}>
              Your account hasn't been added to any team or department yet. Ask your Lead or Manager to add you to a team.
            </p>
            <div style={{
              padding: '0.75rem', background: 'var(--bg-hover)', borderRadius: 'var(--radius-sm)',
              fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.5rem'
            }}>
              {getUserEmail()}
            </div>
            <button className="btn btn-secondary" onClick={onLogout} style={{ width: '100%' }}>
              <LogOut size={16} style={{ verticalAlign: 'middle', marginRight: '0.4rem' }} /> Logout
            </button>
          </div>
        </div>
      )}

      {/* Main App — only shown when onboarded */}
      {(!userRole || userRole.isOnboarded) && (
      <>

      {/* Command Palette */}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onNavigate={(destination) => setView(destination)}
        onAction={(action) => {
          if (action === 'toggle-theme') toggleTheme();
          if (action === 'refresh') loadRoster();
        }}
        darkMode={theme === 'dark'}
      />

      {/* Sidebar - Clean SaaS style */}
      <aside className={`sidebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <div className="sidebar-logo" style={{ display: 'flex', alignItems: 'center', justifyContent: sidebarCollapsed ? 'center' : 'flex-start', paddingLeft: sidebarCollapsed ? '0' : '16px', paddingTop: '16px', marginBottom: '8px' }}>
          <Logo collapsed={sidebarCollapsed} height="42px" />
        </div>

        <button className="sidebar-toggle" onClick={toggleSidebar} title={sidebarCollapsed ? 'Expand' : 'Collapse'}>
          {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>

        <nav className="sidebar-nav" style={{ marginTop: '1rem' }}>
          <button
            className={`nav-item ${view === 'dashboard' ? 'active' : ''}`}
            onClick={() => setView('dashboard')}
            title="Dashboard"
          >
            <LayoutGrid size={20} /> {!sidebarCollapsed && 'Overview'}
          </button>
          <button
            className={`nav-item ${view === 'roster' ? 'active' : ''}`}
            onClick={() => setView('roster')}
            title="Roster"
          >
            <Calendar size={20} /> {!sidebarCollapsed && 'Roster'}
          </button>
          <button
            className={`nav-item ${view === 'summary' ? 'active' : ''}`}
            onClick={() => setView('summary')}
            title="Reports"
          >
            <PieChart size={20} /> {!sidebarCollapsed && 'Reports'}
          </button>

          <div style={{ height: '1px', background: 'var(--border-color)', margin: '1rem 0' }} />

          <button
            className={`nav-item ${view === 'requests' ? 'active' : ''}`}
            onClick={() => setView('requests')}
            title="Requests"
          >
            <FileText size={20} /> {!sidebarCollapsed && 'Requests'}
          </button>
          {userRole?.canEdit && (
            <button
              className={`nav-item ${view === 'review' ? 'active' : ''}`}
              onClick={() => setView('review')}
              title="Review"
            >
              <CheckSquare size={20} /> {!sidebarCollapsed && 'Approvals'}
            </button>
          )}
          {isAdmin && selectedDepartmentId && (departments.find(d => d.id === selectedDepartmentId)?.features || []).includes('auto_bucket') && (
            <button
              className={`nav-item ${view === 'auto-enablement' ? 'active' : ''}`}
              onClick={() => setView('auto-enablement')}
              title="Auto Bucket Mgmt"
            >
              <Clock size={20} /> {!sidebarCollapsed && 'Auto Bucket Mgmt'}
            </button>
          )}
        </nav>

        <div className="sidebar-footer">
          {userRole?.canEdit && (
            <button
              className={`nav-item ${isAdmin ? 'active' : ''}`}
              onClick={toggleAdminMode}
              title={isAdmin ? 'Admin Mode: ON' : 'Admin Mode'}
              style={{ color: isAdmin ? 'var(--accent-primary)' : 'var(--text-secondary)' }}
            >
              <ShieldCheck size={20} /> {!sidebarCollapsed && (isAdmin ? 'Admin: ON' : 'Admin Mode')}
            </button>
          )}

          {/* Department Picker */}
          {departments.length >= 1 && !sidebarCollapsed && (
            <div style={{ padding: '0 12px', marginTop: '0.5rem' }}>
              <select
                value={selectedDepartmentId}
                onChange={(e) => {
                  setSelectedDepartmentId(e.target.value);
                  setSelectedTeams([]); // reset team selection on dept change
                }}
                style={{
                  width: '100%',
                  padding: '0.4rem 0.5rem',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  fontSize: '0.8rem',
                }}
              >
                {departments.map(d => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
          )}
          {departments.length > 1 && sidebarCollapsed && (
            <button className="nav-item" onClick={() => setSidebarCollapsed(false)} title="Switch Department">
              <Building2 size={20} />
            </button>
          )}

          {/* Google Sheets toggle — shown for non-TS departments */}
          {isAdmin && !sidebarCollapsed && selectedDepartmentId && (() => {
            const dept = departments.find(d => d.id === selectedDepartmentId);
            if (!dept || dept.name === 'TS') return null;
            const isEnabled = dept?.features?.includes('google_sheets_enable') || false;
            return (
              <div style={{ padding: '0 12px', marginTop: '0.5rem' }}>
                <button
                  onClick={async () => {
                    const newFeatures = isEnabled
                      ? (dept.features || []).filter(f => f !== 'google_sheets_enable')
                      : [...(dept.features || []), 'google_sheets_enable'];
                    try {
                      await updateDepartment(dept.id, { features: newFeatures });
                      loadDepartments();
                      window.dispatchEvent(new CustomEvent('departmentFeaturesUpdated'));
                    } catch (err) {
                      console.error('Failed to toggle Google Sheets', err);
                    }
                  }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '0.5rem 0.6rem',
                    borderRadius: 'var(--radius-sm)',
                    border: '1px solid var(--border-color)',
                    background: isEnabled ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                    color: isEnabled ? '#fff' : 'var(--text-primary)',
                    fontSize: '0.78rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                  }}
                >
                  <TableIcon size={14} />
                  Google Sheets {isEnabled ? 'ON' : 'OFF'}
                </button>
              </div>
            );
          })()}

          {isAdmin && !sidebarCollapsed && (
            <>
              {userRole?.isPlatformAdmin && (
                <button className="nav-item" onClick={() => setShowDeptManager(true)} style={{ color: 'var(--text-secondary)' }}>
                  <Building2 size={20} /> Departments
                </button>
              )}
              <button className="nav-item" onClick={() => setShowAdminManager(true)} style={{ color: 'var(--text-secondary)' }}>
                <Users size={20} /> Manage Admins
              </button>
              <button
                className={`nav-item ${view === 'team-settings' ? 'active' : ''}`}
                onClick={() => setView('team-settings')}
                style={view !== 'team-settings' ? { color: 'var(--text-secondary)' } : {}}
              >
                <Settings size={20} /> Team Settings
              </button>
              <button
                className={`nav-item ${view === 'misc' ? 'active' : ''}`}
                onClick={() => setView('misc')}
                style={view !== 'misc' ? { color: 'var(--text-secondary)' } : {}}
              >
                <Palette size={20} /> Misc
              </button>
            </>
          )}

          <button className="nav-item" onClick={onLogout} style={{ color: 'var(--accent-danger)' }}>
            <LogOut size={20} /> {!sidebarCollapsed && 'Logout'}
          </button>

          {!sidebarCollapsed && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '1rem', padding: '0.5rem', background: 'var(--bg-hover)', borderRadius: '8px' }}>
              <div style={{ width: 32, height: 32, borderRadius: 16, background: 'var(--accent-primary)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}>
                {userProfile?.name?.charAt(0) || 'U'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{userProfile?.name || 'User'}</span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{userRole?.isPlatformAdmin ? 'Super Admin' : isAdmin ? 'Admin' : 'Member'}</span>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area with Topbar */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

        {/* Main Content */}
        <main className="main-content" style={{ padding: '0', position: 'relative' }}>
          {view === 'dashboard' && (
            <Dashboard
              rosterData={allTeamsData}
              currentDate={currentDate}
              onChangeDate={handleDateChange}
              loading={loading}
              headerAction={
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                  <TeamSelector teams={teams} selectedTeams={selectedTeams} setSelectedTeams={setSelectedTeams} />
                  {isAdmin && (() => {
                    const dept = departments.find(d => d.id === selectedDepartmentId);
                    const isSheetsEnabled = dept?.features?.includes('google_sheets_enable');
                    if (isSheetsEnabled) {
                      return (
                        <>
                          <button className="btn btn-secondary" onClick={() => setShowSlackModal(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <MessageSquare size={16} /> Slack Threads
                          </button>
                          <button className="btn btn-secondary" onClick={() => setShowDevRevModal(true)} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <Briefcase size={16} /> DevRev Tickets
                          </button>
                          <button className="btn btn-primary" onClick={() => setShowDriveSheetModal(true)}>
                            <PlusCircle size={16} /> Create Drive Sheet
                          </button>
                        </>
                      );
                    }
                    return (
                      <button className="btn btn-primary" onClick={() => setShowGenerator(true)}>
                        <PlusCircle size={16} /> Generate Roster
                      </button>
                    );
                  })()}
                </div>
              }
            />
          )}
          {view === 'roster' && (
            <RosterTable
              currentUser={userProfile?.name}
              rosterData={rosterData}
              currentDate={currentDate}
              onChangeDate={handleDateChange}
              isAdmin={isAdmin}
              loading={loading}
              onCellUpdate={handleCellUpdate}
              viewMode="all"
              allTeamsData={allTeamsData}
              teams={teams}
              headerAction={
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                  <TeamSelector teams={teams} selectedTeams={selectedTeams} setSelectedTeams={setSelectedTeams} />
                  {isAdmin && (
                    <button className="btn btn-primary" onClick={() => setShowGenerator(true)}>
                      <PlusCircle size={16} /> Generate
                    </button>
                  )}
                  {isAdmin && rosterExists && (
                    <button className="btn btn-secondary" style={{ color: 'var(--accent-danger)', borderColor: 'var(--accent-danger)' }} onClick={() => setShowDeleteConfirm(true)}>
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              }
            />
          )}
          {view === 'summary' && (
            <Summary
              currentDate={currentDate}
              selectedTeam={selectedTeams.length === 1 ? selectedTeams[0] : ''}
              viewMode={selectedTeams.length === 1 ? 'single' : 'all'}
              teams={teams}
              selectedTeams={selectedTeams}
              headerAction={
                <TeamSelector teams={teams} selectedTeams={selectedTeams} setSelectedTeams={setSelectedTeams} />
              }
            />
          )}
          {view === 'requests' && (
            <RequestsPage userProfile={userProfile} />
          )}
          {view === 'review' && userRole?.canEdit && (
            <ReviewRequestsPage onRefreshRoster={loadRoster} />
          )}
          {view === 'auto-enablement' && isAdmin && (
            <AutoEnablementPage />
          )}
          {view === 'team-settings' && isAdmin && (
            <TeamSettings onTeamsChange={loadTeams} departmentId={selectedDepartmentId} />
          )}
          {view === 'misc' && isAdmin && (
            <MiscSettings
              departmentId={selectedDepartmentId}
              departmentName={departments.find(d => d.id === selectedDepartmentId)?.name}
              departments={departments}
            />
          )}
        </main>
      </div>

      {/* Modals */}
      {showGenerator && (
        <Generator
          onClose={() => setShowGenerator(false)}
          onGenerate={handleGenerate}
          currentDate={currentDate}
          teams={teams}
        />
      )}
      {showDriveSheetModal && (() => {
        const dept = departments.find(d => d.id === selectedDepartmentId);
        const deptName = dept?.name || 'Department';
        return (
          <DriveSheetModal
            deptName={deptName}
            deptId={selectedDepartmentId}
            onClose={() => setShowDriveSheetModal(false)}
            onCreated={(result) => {
              setShowDriveSheetModal(false);
              loadDepartments();
              setToast({ message: `Drive sheet "${deptName} Roster Db" created!`, type: 'success' });
            }}
          />
        );
      })()}
      {showDevRevModal && <DevRevTicketsModal onClose={() => setShowDevRevModal(false)} />}
      {showSlackModal && <SlackThreadsModal onClose={() => setShowSlackModal(false)} />}
      {showDeleteConfirm && (
        <DeleteConfirm
          onClose={() => setShowDeleteConfirm(false)}
          onConfirm={handleDelete}
          currentDate={currentDate}
          deleting={deleting}
          teams={teams}
          selectedTeam={selectedTeam}
          onTeamChange={setSelectedTeam}
        />
      )}

      {showAdminManager && (
        <AdminManager
          onClose={() => setShowAdminManager(false)}
          departments={departments}
          userRole={userRole}
        />
      )}

      {showDeptManager && (
        <DepartmentManager
          onClose={() => setShowDeptManager(false)}
          onDepartmentCreated={() => loadDepartments()}
        />
      )}

      {/* Mobile Bottom Navigation */}
      <nav className="mobile-nav">
        <button
          className={`mobile-nav-item ${view === 'dashboard' ? 'active' : ''}`}
          onClick={() => setView('dashboard')}
        >
          <LayoutGrid size={20} />
          Overview
        </button>
        <button
          className={`mobile-nav-item ${view === 'roster' ? 'active' : ''}`}
          onClick={() => setView('roster')}
        >
          <Calendar size={20} />
          Roster
        </button>
        <button
          className={`mobile-nav-item ${view === 'summary' ? 'active' : ''}`}
          onClick={() => setView('summary')}
        >
          <PieChart size={20} />
          Reports
        </button>
        <button
          className={`mobile-nav-item ${view === 'requests' ? 'active' : ''}`}
          onClick={() => setView('requests')}
        >
          <FileText size={20} />
          Requests
        </button>
        {userRole?.canEdit && (
          <button
            className={`mobile-nav-item ${view === 'review' ? 'active' : ''}`}
            onClick={() => setView('review')}
          >
            <CheckSquare size={20} />
            Approvals
          </button>
        )}
      </nav>

      </>)}
    </div>
  );
}

export default App;
