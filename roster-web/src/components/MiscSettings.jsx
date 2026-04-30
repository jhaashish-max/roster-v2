import React, { useState, useEffect } from 'react';
import { Plus, Trash2, Save, Loader2, Palette, AlertCircle, Building2, ToggleLeft, ToggleRight } from 'lucide-react';
import { getShiftLegends, saveShiftLegends, updateDepartment } from '../lib/api';

const DEFAULT_LEGENDS = [
  { status_code: 'WO',   label: 'Week Off',      color: '#374151', text_color: '#ffffff', is_holiday: false },
  { status_code: 'PL',   label: 'Planned Leave', color: '#8B5CF6', text_color: '#ffffff', is_holiday: false },
  { status_code: 'SL',   label: 'Sick Leave',    color: '#DC2626', text_color: '#ffffff', is_holiday: false },
  { status_code: 'WL',   label: 'Work@Late',     color: '#F59E0B', text_color: '#000000', is_holiday: false },
  { status_code: 'WFH',  label: 'Work From Home',color: '#06B6D4', text_color: '#000000', is_holiday: false },
  { status_code: 'HL',   label: 'Holiday',       color: '#D97706', text_color: '#ffffff', is_holiday: true  },
];

const AVAILABLE_FEATURES = [
  { key: 'auto_bucket', label: 'Auto Bucket Management', description: 'Automatically enable/disable Freshdesk agent availability based on shift timings' },
];

export default function MiscSettings({ departmentId, departmentName, departments }) {
  const [legends, setLegends] = useState([]);
  const [features, setFeatures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingFeatures, setSavingFeatures] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await getShiftLegends(departmentId);
        setLegends(data.length > 0 ? data : DEFAULT_LEGENDS.map(d => ({ ...d, id: null })));
      } catch (err) {
        setLegends(DEFAULT_LEGENDS.map(d => ({ ...d, id: null })));
      }
      // Load features from department
      const dept = departments?.find(d => d.id === departmentId);
      setFeatures(dept?.features || []);
      setLoading(false);
    };
    load();
  }, [departmentId, departments]);

  const handleAdd = () => {
    setLegends(prev => [...prev, {
      id: null,
      status_code: '',
      label: '',
      color: '#3B82F6',
      text_color: '#ffffff',
      is_holiday: false
    }]);
  };

  const handleRemove = (idx) => {
    setLegends(prev => prev.filter((_, i) => i !== idx));
  };

  const handleChange = (idx, field, value) => {
    setLegends(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  const handleSave = async () => {
    const invalid = legends.find(l => !l.status_code.trim() || !l.label.trim());
    if (invalid) {
      showToast('All entries must have a Status Code and Label.', 'error');
      return;
    }
    setSaving(true);
    try {
      const prepared = legends.map(l => ({ ...l, status_code: l.status_code.trim() }));
      await saveShiftLegends(prepared, departmentId);
      // Re-fetch to get assigned IDs
      const fresh = await getShiftLegends(departmentId);
      setLegends(fresh);
      showToast('Shift legends saved successfully!');
      // Signal global refresh
      window.dispatchEvent(new CustomEvent('shiftLegendsUpdated'));
    } catch (err) {
      showToast(err.message || 'Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleFeatureToggle = async (featureKey) => {
    const newFeatures = features.includes(featureKey)
      ? features.filter(f => f !== featureKey)
      : [...features, featureKey];

    setSavingFeatures(true);
    try {
      await updateDepartment(departmentId, { features: newFeatures });
      setFeatures(newFeatures);
      // Signal global refresh so sidebar updates
      window.dispatchEvent(new CustomEvent('departmentFeaturesUpdated'));
      showToast(`${featureKey === 'auto_bucket' ? 'Auto Bucket Management' : featureKey} ${newFeatures.includes(featureKey) ? 'enabled' : 'disabled'}`);
    } catch (err) {
      showToast(err.message || 'Failed to update features', 'error');
    } finally {
      setSavingFeatures(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
        <Loader2 size={28} className="spin" style={{ color: 'var(--accent-primary)' }} />
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
      {toast && (
        <div style={{
          position: 'fixed', top: '1rem', right: '1rem', zIndex: 9999,
          background: toast.type === 'error' ? 'var(--accent-danger)' : 'var(--accent-success)',
          color: '#fff', padding: '0.75rem 1.5rem', borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)', fontWeight: 600, fontSize: '0.9rem'
        }}>
          {toast.message}
        </div>
      )}

      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>
          <Palette size={22} style={{ display: 'inline', marginRight: '0.5rem', color: 'var(--accent-primary)' }} />
          Shift Legend Designer
        </h1>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          Define every status code that appears in your roster, its display color, label, and whether it counts as a Holiday in the overview panel.
        </p>
        {departmentName && (
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
            marginTop: '0.75rem',
            background: 'var(--accent-primary)', color: '#fff',
            padding: '0.35rem 0.9rem', borderRadius: '20px',
            fontSize: '0.8rem', fontWeight: 700
          }}>
            <Building2 size={13} /> Editing: {departmentName}
          </div>
        )}
      </div>

      {/* Preview Strip */}
      <div style={{ background: 'var(--bg-card)', borderRadius: '10px', border: '1px solid var(--border-color)', padding: '1rem 1.5rem', marginBottom: '1.5rem' }}>
        <h3 style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '0.75rem' }}>Live Preview</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {legends.map((l, i) => (
            l.status_code || l.label ? (
              <span key={i} style={{
                background: l.color,
                color: l.text_color,
                padding: '0.3rem 0.75rem',
                borderRadius: '20px',
                fontSize: '0.8rem',
                fontWeight: 600,
                whiteSpace: 'nowrap'
              }}>
                {l.status_code && l.label && l.status_code !== l.label ? `${l.status_code} - ` : ''}{l.label || l.status_code || '…'}
                {l.is_holiday && ' 🏖️'}
              </span>
            ) : null
          ))}
        </div>
      </div>

      {/* Legend Rows */}
      <div style={{ background: 'var(--bg-card)', borderRadius: '10px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
        {/* Header */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: '100px 1fr 90px 90px 90px 44px',
          gap: '0.5rem',
          padding: '0.75rem 1rem',
          background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border-color)',
          fontSize: '0.72rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          color: 'var(--text-muted)'
        }}>
          <span>Code</span>
          <span>Label</span>
          <span style={{ textAlign: 'center' }}>Cell Color</span>
          <span style={{ textAlign: 'center' }}>Text Color</span>
          <span style={{ textAlign: 'center' }}>Holiday?</span>
          <span />
        </div>

        {legends.map((l, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '100px 1fr 90px 90px 90px 44px',
            gap: '0.5rem',
            alignItems: 'center',
            padding: '0.6rem 1rem',
            borderBottom: '1px solid var(--border-color)',
            background: i % 2 === 0 ? 'transparent' : 'var(--bg-hover)'
          }}>
            {/* Status Code */}
            <input
              value={l.status_code}
              onChange={e => handleChange(i, 'status_code', e.target.value)}
              placeholder="e.g. WO, PL..."
              style={{
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                border: '1px solid var(--border-color)', borderRadius: '6px',
                padding: '0.4rem 0.6rem', fontSize: '0.82rem', width: '100%',
                fontFamily: 'monospace', textTransform: 'uppercase'
              }}
            />
            {/* Label */}
            <input
              value={l.label}
              onChange={e => handleChange(i, 'label', e.target.value)}
              placeholder="e.g. Week Off, Comp Off..."
              style={{
                background: 'var(--bg-secondary)', color: 'var(--text-primary)',
                border: '1px solid var(--border-color)', borderRadius: '6px',
                padding: '0.4rem 0.6rem', fontSize: '0.82rem', width: '100%'
              }}
            />
            {/* Cell Color */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
              <input
                type="color"
                value={l.color}
                onChange={e => handleChange(i, 'color', e.target.value)}
                style={{ width: '36px', height: '32px', border: 'none', borderRadius: '6px', cursor: 'pointer', background: 'none', padding: 0 }}
              />
              <span style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{l.color}</span>
            </div>
            {/* Text Color */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
              <input
                type="color"
                value={l.text_color}
                onChange={e => handleChange(i, 'text_color', e.target.value)}
                style={{ width: '36px', height: '32px', border: 'none', borderRadius: '6px', cursor: 'pointer', background: 'none', padding: 0 }}
              />
            </div>
            {/* Is Holiday */}
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <input
                type="checkbox"
                checked={l.is_holiday}
                onChange={e => handleChange(i, 'is_holiday', e.target.checked)}
                style={{ width: '18px', height: '18px', accentColor: 'var(--accent-primary)', cursor: 'pointer' }}
              />
            </div>
            {/* Remove */}
            <button
              onClick={() => handleRemove(i)}
              style={{
                background: 'none', border: 'none', color: 'var(--accent-danger)',
                cursor: 'pointer', padding: '0.3rem', borderRadius: '4px',
                display: 'flex', alignItems: 'center', justifyContent: 'center'
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}

        {legends.length === 0 && (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            <AlertCircle size={22} style={{ marginBottom: '0.5rem', color: 'var(--accent-warning)' }} />
            <p>No legends defined yet. Click "Add Status" to get started.</p>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '1rem', marginTop: '1.5rem', justifyContent: 'flex-end' }}>
        <button
          onClick={handleAdd}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            background: 'var(--bg-secondary)', color: 'var(--text-primary)',
            border: '1px solid var(--border-color)', borderRadius: '8px',
            padding: '0.6rem 1.25rem', fontSize: '0.85rem', fontWeight: 600,
            cursor: 'pointer'
          }}
        >
          <Plus size={16} /> Add Status
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            background: 'var(--accent-primary)', color: '#fff',
            border: 'none', borderRadius: '8px',
            padding: '0.6rem 1.5rem', fontSize: '0.85rem', fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer', opacity: saving ? 0.7 : 1
          }}
        >
          {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
          {saving ? 'Saving…' : 'Save Legends'}
        </button>
      </div>

      {/* ============ FEATURES SECTION ============ */}
      <div style={{ marginTop: '3rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.4rem' }}>
          <ToggleRight size={22} style={{ display: 'inline', marginRight: '0.5rem', color: 'var(--accent-primary)' }} />
          Department Features
        </h1>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1.5rem' }}>
          Enable or disable features for this department. Only enabled features will appear in the sidebar.
        </p>

        <div style={{ background: 'var(--bg-card)', borderRadius: '10px', border: '1px solid var(--border-color)', overflow: 'hidden' }}>
          {AVAILABLE_FEATURES.map(feat => {
            const isEnabled = features.includes(feat.key);
            return (
              <div key={feat.key} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '1rem 1.5rem',
                borderBottom: '1px solid var(--border-color)'
              }}>
                <div>
                  <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' }}>{feat.label}</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>{feat.description}</div>
                </div>
                <button
                  onClick={() => handleFeatureToggle(feat.key)}
                  disabled={savingFeatures}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    background: isEnabled ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                    color: isEnabled ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${isEnabled ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                    borderRadius: '20px',
                    padding: '0.4rem 1rem',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    cursor: savingFeatures ? 'not-allowed' : 'pointer',
                    opacity: savingFeatures ? 0.7 : 1,
                    transition: 'all 0.15s ease'
                  }}
                >
                  {isEnabled ? <ToggleRight size={14} /> : <ToggleLeft size={14} />}
                  {isEnabled ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
