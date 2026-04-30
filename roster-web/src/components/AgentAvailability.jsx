import React, { useState, useEffect } from 'react';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { getToken } from '../lib/api';

const AgentAvailability = ({ email, isAutoEnableOn, onShowToast }) => {
    const [status, setStatus] = useState('loading'); // 'loading', 'available', 'unavailable', 'error', 'toggling'

    const fetchStatus = async () => {
        try {
            const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://roster-api-v2.jha-ashish.workers.dev';
            const token = getToken();
            const response = await fetch(`${API_BASE}/api/freshdesk/availability?email=${encodeURIComponent(email)}`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!response.ok) throw new Error('Network response was not ok');
            const data = await response.json();
            setStatus(data.available ? 'available' : 'unavailable');
        } catch (error) {
            console.error("Error fetching agent availability:", error);
            setStatus('error');
        }
    };

    useEffect(() => {
        if (!email) {
            setStatus('error');
            return;
        }
        fetchStatus();
        const interval = setInterval(fetchStatus, 60000); // Poll every 60s
        return () => clearInterval(interval);
    }, [email]);

    const handleToggle = async () => {
        if (isAutoEnableOn) {
            if (onShowToast) {
                onShowToast({
                    message: "Please uncheck 'Auto Enable' and click 'Save Configurations' first.",
                    type: 'error'
                });
            }
            return;
        }

        if (status === 'loading' || status === 'toggling') return;

        const currentAvailable = status === 'available';
        const action = currentAvailable ? 'disable' : 'enable';

        setStatus('toggling');

        try {
            const API_BASE = import.meta.env.VITE_API_BASE_URL || 'https://roster-api-v2.jha-ashish.workers.dev';
            const TOGGLE_URL = `${API_BASE}/api/freshdesk/availability/toggle`;
            const token = getToken();

            const response = await fetch(TOGGLE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ email, action })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `Server responded with ${response.status}`);
            }

            // Immediately switch local state to feel fast and responsive
            setStatus(currentAvailable ? 'unavailable' : 'available');

        } catch (error) {
            console.error("Error toggling agent availability:", error);
            if (onShowToast) {
                onShowToast({ message: `Failed to toggle availability: ${error.message}`, type: 'error' });
            }
            // Re-fetch to get accurate state
            await fetchStatus();
        }
    };

    if (status === 'loading' || status === 'toggling') {
        return (
            <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--text-muted)' }}>
                <Loader2 size={16} className="lucide-spin" style={{ animation: 'spin 1s linear infinite' }} />
                <style>{`@keyframes spin { 100% { transform: rotate(360deg); } }`}</style>
            </div>
        );
    }

    const clickStyle = {
        cursor: isAutoEnableOn ? 'not-allowed' : 'pointer',
        display: 'flex',
        justifyContent: 'center',
        transition: 'transform 0.1s ease-in-out',
        opacity: isAutoEnableOn ? 0.6 : 1
    };

    if (status === 'available') {
        return (
            <div
                style={{ ...clickStyle, color: 'var(--accent-success)' }}
                title={isAutoEnableOn ? "Auto-Enabled (Cannot manual toggle)" : "Click to Disable Agent"}
                onClick={handleToggle}
                onMouseEnter={(e) => !isAutoEnableOn && (e.currentTarget.style.transform = 'scale(1.15)')}
                onMouseLeave={(e) => !isAutoEnableOn && (e.currentTarget.style.transform = 'scale(1)')}
            >
                <CheckCircle size={18} />
            </div>
        );
    }

    if (status === 'unavailable') {
        return (
            <div
                style={{ ...clickStyle, color: 'var(--accent-danger)' }}
                title={isAutoEnableOn ? "Auto-Enabled (Cannot manual toggle)" : "Click to Enable Agent"}
                onClick={handleToggle}
                onMouseEnter={(e) => !isAutoEnableOn && (e.currentTarget.style.transform = 'scale(1.15)')}
                onMouseLeave={(e) => !isAutoEnableOn && (e.currentTarget.style.transform = 'scale(1)')}
            >
                <XCircle size={18} />
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', justifyContent: 'center', color: 'var(--text-muted)' }} title="No Email or Error">
            <span style={{ fontSize: '1rem', fontWeight: 600 }}>-</span>
        </div>
    );
};

export default AgentAvailability;
