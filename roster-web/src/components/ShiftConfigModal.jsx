import React, { useState } from 'react';
import { X, Save, Trash2, Plus, Loader2 } from 'lucide-react';
import { saveShiftConfigs, deleteShiftConfig } from '../lib/api';

const ShiftConfigModal = ({ team, configs, onClose, onConfigsUpdated }) => {
    const [localConfigs, setLocalConfigs] = useState(
        configs.filter(c => c.team_id === team?.id).map(c => ({ ...c, _id: c.id || crypto.randomUUID() }))
    );
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const handleAdd = () => {
        setLocalConfigs(prev => [
            ...prev,
            { _id: crypto.randomUUID(), team_id: team.id, shift_name: '', start_offset_mins: 0, end_offset_mins: 0, isNew: true }
        ]);
    };

    const handleUpdate = (id, field, value) => {
        setLocalConfigs(prev => prev.map(c => c._id === id ? { ...c, [field]: value } : c));
    };

    const handleDelete = async (config) => {
        // If it's a new row that hasn't been saved to DB yet, just remove from UI
        if (config.isNew) {
            setLocalConfigs(prev => prev.filter(c => c._id !== config._id));
            return;
        }

        try {
            setSaving(true);
            await deleteShiftConfig(config.id);
            setLocalConfigs(prev => prev.filter(c => c._id !== config._id));
            onConfigsUpdated();
        } catch (err) {
            setError(err.message || 'Failed to delete configuration');
        } finally {
            setSaving(false);
        }
    };

    const handleSave = async () => {
        // Filter out rows without shift_name
        const validConfigs = localConfigs.filter(c => c.shift_name.trim() !== '');
        if (validConfigs.length === 0 && localConfigs.length > 0) {
            setError('Please provide a Shift Name for your configurations.');
            return;
        }

        // Strip temp IDs
        const payload = validConfigs.map(c => {
            return {
                team_id: c.team_id,
                shift_name: c.shift_name,
                start_offset_mins: c.start_offset_mins,
                end_offset_mins: c.end_offset_mins
            };
        });

        try {
            setSaving(true);
            setError(null);
            await saveShiftConfigs(payload);
            await onConfigsUpdated();
            onClose();
        } catch (err) {
            setError(err.message || 'Failed to save configurations');
        } finally {
            setSaving(false);
        }
    };

    return (
        <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000, WebkitBackdropFilter: 'blur(4px)', backdropFilter: 'blur(4px)'
        }}>
            <div style={{
                background: 'var(--bg-card)', width: '100%', maxWidth: '600px', borderRadius: '12px',
                boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)',
                border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', maxHeight: '90vh'
            }}>
                {/* Header */}
                <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <h3 style={{ margin: 0, fontSize: '1.25rem', color: 'var(--text-primary)' }}>Shift Configurations</h3>
                        <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.85rem', color: 'var(--text-muted)' }}>{team?.name || 'Loading Team'}</p>
                    </div>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '0.5rem', borderRadius: '8px', display: 'flex' }}>
                        <X size={20} />
                    </button>
                </div>

                {/* Content */}
                <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
                    {error && (
                        <div style={{ padding: '0.75rem 1rem', background: '#fee2e2', color: '#b91c1c', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.85rem' }}>
                            {error}
                        </div>
                    )}

                    <div style={{ marginBottom: '1.5rem' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                            <thead>
                                <tr style={{ color: 'var(--text-muted)', borderBottom: '2px solid var(--border-color)' }}>
                                    <th style={{ padding: '0.5rem', textAlign: 'left', fontWeight: 600 }}>Shift Name</th>
                                    <th style={{ padding: '0.5rem', textAlign: 'center', fontWeight: 600 }}>Start Buffer (M)</th>
                                    <th style={{ padding: '0.5rem', textAlign: 'center', fontWeight: 600 }}>End Buffer (M)</th>
                                    <th style={{ padding: '0.5rem', textAlign: 'center', width: '40px' }}></th>
                                </tr>
                            </thead>
                            <tbody>
                                {localConfigs.map((config, index) => (
                                    <tr key={config._id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                                        <td style={{ padding: '0.75rem 0.5rem' }}>
                                            <input
                                                type="text"
                                                placeholder="e.g. 09 - 18"
                                                value={config.shift_name}
                                                onChange={e => handleUpdate(config._id, 'shift_name', e.target.value)}
                                                className="form-input"
                                                style={{ padding: '0.4rem 0.75rem', fontSize: '0.85rem', width: '100%' }}
                                                disabled={saving}
                                            />
                                        </td>
                                        <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>
                                            <input
                                                type="number"
                                                value={config.start_offset_mins}
                                                onChange={e => handleUpdate(config._id, 'start_offset_mins', parseInt(e.target.value) || 0)}
                                                className="form-input"
                                                style={{ padding: '0.4rem', fontSize: '0.85rem', width: '70px', textAlign: 'center' }}
                                                disabled={saving}
                                            />
                                        </td>
                                        <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>
                                            <input
                                                type="number"
                                                value={config.end_offset_mins}
                                                onChange={e => handleUpdate(config._id, 'end_offset_mins', parseInt(e.target.value) || 0)}
                                                className="form-input"
                                                style={{ padding: '0.4rem', fontSize: '0.85rem', width: '70px', textAlign: 'center' }}
                                                disabled={saving}
                                            />
                                        </td>
                                        <td style={{ padding: '0.75rem 0.5rem', textAlign: 'center' }}>
                                            <button
                                                title="Delete Shift Configuration"
                                                onClick={() => handleDelete(config)}
                                                disabled={saving}
                                                style={{ background: 'none', border: 'none', color: 'var(--accent-danger)', cursor: 'pointer', padding: '0.25rem', opacity: 0.8 }}
                                            >
                                                <Trash2 size={16} />
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                {localConfigs.length === 0 && (
                                    <tr>
                                        <td colSpan="4" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                                            No shift configurations yet.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>

                    <button
                        onClick={handleAdd}
                        disabled={saving}
                        className="btn btn-secondary"
                        style={{ width: '100%', justifyContent: 'center', borderStyle: 'dashed' }}
                    >
                        <Plus size={16} /> Add Shift Configuration
                    </button>
                </div>

                {/* Footer */}
                <div style={{ padding: '1.25rem 1.5rem', borderTop: '1px solid var(--border-color)', display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', background: 'var(--bg-hover)', borderRadius: '0 0 12px 12px' }}>
                    <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
                        Cancel
                    </button>
                    <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                        {saving ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
                        {saving ? 'Saving...' : 'Save Configurations'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ShiftConfigModal;
