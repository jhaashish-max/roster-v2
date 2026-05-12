import React, { useState, useEffect, useMemo } from 'react';
import {
  Users, Phone, Clock, TrendingUp, Loader2, AlertCircle,
  Headphones, BarChart3, ChevronDown, Calendar, ArrowLeft,
  X, Filter
} from 'lucide-react';
import { getSEBandwidth } from '../lib/api';
import { isGoogleLoggedIn } from '../lib/googleAuth';

export default function SEBandwidth({ departmentId }) {
  const [data, setData] = useState({ loading: true, error: null, rows: [] });
  const [selectedWeek, setSelectedWeek] = useState('all');
  const [selectedConsultant, setSelectedConsultant] = useState(null);

  useEffect(() => {
    if (!departmentId) return;
    if (!isGoogleLoggedIn()) {
      setData({ loading: false, error: 'google_auth_needed', rows: [] });
      return;
    }

    const load = async () => {
      setData(d => ({ ...d, loading: true, error: null }));
      try {
        const rows = await getSEBandwidth(departmentId);
        setData({ loading: false, error: null, rows });
        const weeks = [...new Set(rows.map(r => String(r.Week || '')).filter(Boolean))].sort();
        if (weeks.length && selectedWeek === 'all') {
          setSelectedWeek(weeks[weeks.length - 1]);
        }
      } catch (err) {
        setData({ loading: false, error: err.message, rows: [] });
      }
    };

    load();
  }, [departmentId]);

  const weeks = useMemo(() => {
    return [...new Set(data.rows.map(r => String(r.Week || '')).filter(Boolean))].sort();
  }, [data.rows]);

  const filteredRows = useMemo(() => {
    if (selectedWeek === 'all') return data.rows;
    return data.rows.filter(r => String(r.Week || '') === selectedWeek);
  }, [data.rows, selectedWeek]);

  const consultants = useMemo(() => {
    const map = {};
    filteredRows.forEach(r => {
      const name = r.consultant_name || r.name || 'Unknown';
      if (!map[name]) {
        map[name] = {
          name,
          role: r.role || '',
          initials: r.initials || r.inital || '',
          shift: r.shift || '',
          hours_logged: 0,
          capacity_pct: 0,
          calls: [],
        };
      }
      map[name].calls.push({
        call_name: r.call_name || '',
        call_duration: r.call_duration || '',
        call_type: r.call_type || 'Other',
        date_time: r['Date & Time'] || r.date_time || '',
        week: r.Week || '',
      });
    });
    // Recompute aggregates from calls
    Object.values(map).forEach(c => {
      c.hours_logged = parseFloat(filteredRows
        .filter(r => (r.consultant_name || r.name) === c.name)
        .reduce((max, r) => Math.max(max, parseFloat(r.hours_logged || 0)), 0));
      c.capacity_pct = parseFloat(filteredRows
        .filter(r => (r.consultant_name || r.name) === c.name)
        .reduce((max, r) => Math.max(max, parseFloat(r.capacity_pct || 0)), 0));
    });
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
  }, [filteredRows]);

  // Clear selected consultant when week changes
  useEffect(() => {
    setSelectedConsultant(null);
  }, [selectedWeek]);

  if (data.loading) {
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-muted)', padding: '3rem' }}>
          <Loader2 size={20} className="spin" /> Loading SE Bandwidth data…
        </div>
      </div>
    );
  }

  if (data.error && data.error !== 'google_auth_needed') {
    return (
      <div style={{ ...cardStyle, padding: '2rem', textAlign: 'center', color: 'var(--accent-danger)' }}>
        <AlertCircle size={24} style={{ marginBottom: '0.5rem' }} />
        <p style={{ margin: 0, fontSize: '0.9rem' }}>Failed to load SE Bandwidth</p>
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{data.error}</p>
      </div>
    );
  }

  const totalCalls = consultants.reduce((sum, c) => sum + c.calls.length, 0);
  const totalHours = consultants.reduce((sum, c) => sum + c.hours_logged, 0);
  const avgCapacity = consultants.length
    ? Math.round(consultants.reduce((sum, c) => sum + c.capacity_pct, 0) / consultants.length)
    : 0;

  return (
    <div style={{ padding: '1.5rem 2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: 'linear-gradient(135deg, #10B981, #059669)',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
            <Headphones size={20} color="#fff" />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              SE Bandwidth
            </h2>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Consultant call capacity &amp; workload tracker
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {selectedConsultant && (
            <button
              onClick={() => setSelectedConsultant(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 14px', borderRadius: 10,
                border: '1px solid var(--border-color)',
                background: 'var(--bg-card)',
                color: 'var(--text-primary)',
                fontSize: '0.85rem', fontWeight: 600,
                cursor: 'pointer', fontFamily: 'inherit'
              }}
            >
              <ArrowLeft size={14} /> Back to list
            </button>
          )}
          <WeekFilter weeks={weeks} selected={selectedWeek} onChange={setSelectedWeek} />
        </div>
      </div>

      {/* Stat Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
        <StatPill icon={<Users size={16} />} label="Consultants" value={consultants.length} color="#3B82F6" />
        <StatPill icon={<Phone size={16} />} label="Total Calls" value={totalCalls} color="#10B981" />
        <StatPill icon={<Clock size={16} />} label="Hours Logged" value={totalHours.toFixed(1)} color="#F59E0B" />
        <StatPill icon={<BarChart3 size={16} />} label="Avg Capacity" value={`${avgCapacity}%`} color="#8B5CF6" />
      </div>

      {selectedConsultant ? (
        <ConsultantDetail consultant={selectedConsultant} onClose={() => setSelectedConsultant(null)} />
      ) : consultants.length === 0 ? (
        <div style={{ ...cardStyle, padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          No bandwidth data{selectedWeek !== 'all' ? ` for Week ${selectedWeek}` : ''}.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {consultants.map(c => (
            <ConsultantCard
              key={c.name}
              consultant={c}
              onClick={() => setSelectedConsultant(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConsultantDetail({ consultant, onClose }) {
  const { name, role, initials, shift, hours_logged, capacity_pct, calls } = consultant;

  const callTypeColor = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('merchant')) return '#3B82F6';
    if (t.includes('internal')) return '#8B5CF6';
    if (t.includes('prep')) return '#F59E0B';
    return '#6B7280';
  };

  const typeCounts = {};
  calls.forEach(c => {
    const t = c.call_type || 'Other';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Profile Header */}
      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: '1.25rem', flexWrap: 'wrap' }}>
        <div style={{
          width: 64, height: 64, borderRadius: '50%',
          background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1.5rem', fontWeight: 700, color: '#fff', flexShrink: 0
        }}>
          {initials || name.split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '1.25rem', color: 'var(--text-primary)' }}>{name}</span>
            {role && (
              <span style={{
                fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
                padding: '3px 10px', borderRadius: 4,
                background: 'var(--bg-secondary)', color: 'var(--text-muted)', border: '1px solid var(--border-color)'
              }}>{role}</span>
            )}
            {shift && (
              <span style={{
                fontSize: '0.75rem', fontWeight: 600,
                padding: '3px 10px', borderRadius: 4,
                background: 'rgba(16, 185, 129, 0.1)', color: '#059669', border: '1px solid rgba(16, 185, 129, 0.2)'
              }}>{shift}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '2rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            <Metric label="Total Calls" value={calls.length} icon={<Phone size={14} />} />
            <Metric label="Hours Logged" value={hours_logged.toFixed(1)} icon={<Clock size={14} />} />
            <Metric label="Capacity" value={`${Math.round(capacity_pct)}%`} icon={<TrendingUp size={14} />} />
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'none', border: '1px solid var(--border-color)', cursor: 'pointer',
            color: 'var(--text-muted)', width: 36, height: 36, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s', flexShrink: 0
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent-danger)'; e.currentTarget.style.color = 'var(--accent-danger)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Capacity Bar */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>Workload Capacity</span>
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: capacity_pct > 90 ? '#EF4444' : capacity_pct > 75 ? '#F59E0B' : '#10B981' }}>
            {Math.round(capacity_pct)}%
          </span>
        </div>
        <div style={{ height: 10, borderRadius: 5, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
          <div style={{
            width: `${Math.min(capacity_pct, 100)}%`,
            height: '100%',
            borderRadius: 5,
            background: capacity_pct > 90 ? '#EF4444' : capacity_pct > 75 ? '#F59E0B' : '#10B981',
            transition: 'width 0.4s ease'
          }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 6 }}>
          <span>0%</span>
          <span>{capacity_pct > 100 ? 'Overloaded' : capacity_pct > 90 ? 'High Load' : capacity_pct > 75 ? 'Moderate Load' : 'Healthy'}</span>
          <span>100%</span>
        </div>
      </div>

      {/* Call Type Breakdown */}
      {Object.keys(typeCounts).length > 0 && (
        <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>Call Type Breakdown</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            {Object.entries(typeCounts).map(([type, count]) => (
              <div key={type} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 14px', borderRadius: 8,
                background: `${callTypeColor(type)}10`,
                border: `1px solid ${callTypeColor(type)}25`,
                color: callTypeColor(type),
                fontSize: '0.85rem', fontWeight: 600
              }}>
                <Filter size={12} />
                {type}
                <span style={{
                  padding: '2px 8px', borderRadius: 99,
                  background: `${callTypeColor(type)}20`,
                  fontSize: '0.75rem'
                }}>{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Call Log Table */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>Call Log</span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{calls.length} calls</span>
        </div>
        {calls.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '2rem', fontSize: '0.9rem' }}>
            No calls recorded for this consultant.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {/* Table Header */}
            <div style={{
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 2fr',
              gap: '0.75rem', padding: '0.5rem 0.75rem',
              fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
              color: 'var(--text-muted)', borderBottom: '1px solid var(--border-color)'
            }}>
              <span>Call Name</span>
              <span>Type</span>
              <span>Duration</span>
              <span>Date &amp; Time</span>
            </div>
            {calls.map((call, i) => (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 2fr',
                gap: '0.75rem', padding: '0.75rem',
                fontSize: '0.85rem', color: 'var(--text-primary)',
                borderRadius: 6,
                background: i % 2 === 0 ? 'var(--bg-secondary)' : 'transparent',
                alignItems: 'center'
              }}>
                <span style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Phone size={12} color={callTypeColor(call.call_type)} />
                  {call.call_name || '—'}
                </span>
                <span style={{
                  fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em',
                  padding: '2px 8px', borderRadius: 4,
                  background: `${callTypeColor(call.call_type)}15`,
                  color: callTypeColor(call.call_type),
                  border: `1px solid ${callTypeColor(call.call_type)}25`,
                  justifySelf: 'start'
                }}>
                  {call.call_type}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>{call.call_duration || '—'}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{call.date_time || '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ConsultantCard({ consultant, onClick }) {
  const { name, role, initials, shift, hours_logged, capacity_pct, calls } = consultant;

  const callTypeColor = (type) => {
    const t = (type || '').toLowerCase();
    if (t.includes('merchant')) return '#3B82F6';
    if (t.includes('internal')) return '#8B5CF6';
    if (t.includes('prep')) return '#F59E0B';
    return '#6B7280';
  };

  return (
    <div
      onClick={onClick}
      style={{
        ...cardStyle,
        cursor: 'pointer',
        transition: 'transform 0.1s, box-shadow 0.15s'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = 'var(--shadow)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'none';
        e.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '1rem', fontWeight: 700, color: '#fff', flexShrink: 0
        }}>
          {initials || name.split(' ').map(p => p[0]).join('').substring(0, 2).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text-primary)' }}>{name}</span>
            {role && (
              <span style={{
                fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
                padding: '2px 8px', borderRadius: 4,
                background: 'var(--bg-secondary)', color: 'var(--text-muted)', border: '1px solid var(--border-color)'
              }}>{role}</span>
            )}
            {shift && (
              <span style={{
                fontSize: '0.7rem', fontWeight: 600,
                padding: '2px 8px', borderRadius: 4,
                background: 'rgba(16, 185, 129, 0.1)', color: '#059669', border: '1px solid rgba(16, 185, 129, 0.2)'
              }}>{shift}</span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '1.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            <Metric label="Hours" value={hours_logged.toFixed(1)} icon={<Clock size={14} />} />
            <Metric label="Calls" value={calls.length} icon={<Phone size={14} />} />
            <Metric label="Capacity" value={`${Math.round(capacity_pct)}%`} icon={<TrendingUp size={14} />} />
          </div>
          <div style={{ marginTop: '0.75rem' }}>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-secondary)', overflow: 'hidden' }}>
              <div style={{
                width: `${Math.min(capacity_pct, 100)}%`,
                height: '100%', borderRadius: 3,
                background: capacity_pct > 90 ? '#EF4444' : capacity_pct > 75 ? '#F59E0B' : '#10B981',
                transition: 'width 0.4s ease'
              }} />
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 200 }}>
          {calls.slice(0, 4).map((call, i) => (
            <span key={i} style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontSize: '0.7rem', padding: '2px 7px', borderRadius: 4,
              background: `${callTypeColor(call.call_type)}15`,
              color: callTypeColor(call.call_type),
              border: `1px solid ${callTypeColor(call.call_type)}30`,
              fontWeight: 500
            }}>
              {call.call_type}
            </span>
          ))}
          {calls.length > 4 && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 500, padding: '2px 4px' }}>
              +{calls.length - 4} more
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function WeekFilter({ weeks, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = React.useRef(null);

  React.useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', borderRadius: 10,
          border: '1px solid var(--border-color)',
          background: 'var(--bg-card)',
          color: 'var(--text-primary)',
          fontSize: '0.85rem', fontWeight: 600,
          cursor: 'pointer', fontFamily: 'inherit'
        }}
      >
        <Calendar size={14} color="var(--text-muted)" />
        {selected === 'all' ? 'All Weeks' : `Week ${selected}`}
        <ChevronDown size={14} style={{ transition: 'transform 0.2s', transform: open ? 'rotate(180deg)' : 'none' }} />
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0,
          minWidth: 160, zIndex: 50,
          background: 'var(--bg-card)', border: '1px solid var(--border-color)',
          borderRadius: 10, boxShadow: 'var(--shadow)', overflow: 'hidden'
        }}>
          <div
            onClick={() => { onChange('all'); setOpen(false); }}
            style={{
              padding: '8px 14px', fontSize: '0.85rem', cursor: 'pointer',
              background: selected === 'all' ? 'var(--bg-hover)' : 'transparent',
              color: selected === 'all' ? 'var(--text-primary)' : 'var(--text-secondary)',
              fontWeight: selected === 'all' ? 600 : 400
            }}
          >All Weeks</div>
          {weeks.map(w => (
            <div
              key={w}
              onClick={() => { onChange(w); setOpen(false); }}
              style={{
                padding: '8px 14px', fontSize: '0.85rem', cursor: 'pointer',
                background: selected === w ? 'var(--bg-hover)' : 'transparent',
                color: selected === w ? 'var(--text-primary)' : 'var(--text-secondary)',
                fontWeight: selected === w ? 600 : 400
              }}
            >Week {w}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatPill({ icon, label, value, color }) {
  return (
    <div style={{
      ...cardStyle,
      padding: '1rem 1.25rem',
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem'
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: `${color}15`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color
      }}>
        {icon}
      </div>
      <div>
        <div style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          {label}
        </div>
        <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>
          {value}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, icon }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
      <span style={{ color: 'var(--text-muted)' }}>{icon}</span>
      <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{value}</span>
      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{label}</span>
    </div>
  );
}

const cardStyle = {
  background: 'var(--bg-card)',
  borderRadius: 12,
  border: '1px solid var(--border-color)',
  padding: '1.5rem',
};
