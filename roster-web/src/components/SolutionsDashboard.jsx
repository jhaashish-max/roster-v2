import React from 'react';
import { FileText } from 'lucide-react';
import TranscriptUploader from './TranscriptUploader';

export default function SolutionsDashboard() {
  return (
    <div style={{ padding: '1.5rem 2rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: 'linear-gradient(135deg, #3B82F6, #8B5CF6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <FileText size={20} color="#fff" />
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            Score Card
          </h2>
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Transcript processing &amp; workflow automation
          </p>
        </div>
      </div>

      <TranscriptUploader />
    </div>
  );
}
