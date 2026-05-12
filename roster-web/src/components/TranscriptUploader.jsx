import React, { useState, useRef } from 'react';
import { Upload, X, FileText, Loader2, CheckCircle, AlertCircle, Copy, Download, RotateCcw, Send } from 'lucide-react';

const WEBHOOK_URL = 'https://n8n-conc.razorpay.com/webhook/process-transcript';
const ALLOWED = ['txt', 'pdf', 'docx', 'csv', 'json', 'vtt', 'srt'];

export default function TranscriptUploader() {
  const [currentFile, setCurrentFile] = useState(null);
  const [instructions, setInstructions] = useState('');
  const [status, setStatus] = useState(''); // '' | 'ok' | 'err' | 'sending'
  const [statusMsg, setStatusMsg] = useState('Ready');
  const [output, setOutput] = useState(null);
  const [showCorsTip, setShowCorsTip] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const ext = (name) => {
    const p = name.split('.');
    return p.length > 1 ? p.pop().toLowerCase() : '';
  };

  const fmtSize = (b) => {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  };

  const validateAndSetFile = (f) => {
    if (!ALLOWED.includes(ext(f.name))) {
      setCurrentFile(null);
      setStatus('err');
      setStatusMsg('Unsupported file type');
    } else {
      setCurrentFile(f);
      setStatus('ok');
      setStatusMsg('File ready');
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files[0]) {
      validateAndSetFile(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const clearFile = () => {
    setCurrentFile(null);
    setStatus('');
    setStatusMsg('Ready');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const clearAll = () => {
    setCurrentFile(null);
    setInstructions('');
    setOutput(null);
    setShowCorsTip(false);
    setStatus('');
    setStatusMsg('Ready');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const sendFile = async () => {
    if (!currentFile) {
      setStatus('err');
      setStatusMsg('Add a transcript file first');
      return;
    }

    const fd = new FormData();
    fd.append('file', currentFile, currentFile.name);
    if (instructions.trim()) fd.append('instructions', instructions.trim());
    fd.append('submitted_at', new Date().toISOString());
    fd.append('filename', currentFile.name);

    setStatus('sending');
    setStatusMsg('Sending to workflow…');
    setShowCorsTip(false);
    setOutput(null);

    try {
      const res = await fetch(WEBHOOK_URL, { method: 'POST', body: fd });
      const raw = await res.text();
      let pretty = raw;
      try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep as-is if not JSON */ }

      setOutput({
        text: pretty,
        status: `${res.status} ${res.statusText}`,
        ok: res.ok
      });
      setStatus(res.ok ? 'ok' : 'err');
      setStatusMsg(res.ok ? 'Done — output received' : `Error ${res.status}`);
    } catch (err) {
      const isCors = err.message.toLowerCase().includes('failed to fetch');
      setOutput({
        text: `Request failed:\n${err.message}`,
        status: 'network error',
        ok: false
      });
      setShowCorsTip(isCors);
      setStatus('err');
      setStatusMsg('Network error — check CORS settings');
    }
  };

  const copyOutput = () => {
    if (output?.text) {
      navigator.clipboard.writeText(output.text);
    }
  };

  const downloadOutput = () => {
    if (!output?.text) return;
    const blob = new Blob([output.text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `transcript-output-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: '1.5rem 2rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
        <div style={{
          width: 40, height: 40, borderRadius: 10,
          background: 'linear-gradient(135deg, #007a65, #009678)',
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <FileText size={20} color="#fff" />
        </div>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            Transcript Upload
          </h2>
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Drop your file below — the workflow will process it and return the output
          </p>
        </div>
      </div>

      {/* Card 1: File Upload */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 14,
        padding: '1.5rem',
        boxShadow: 'var(--shadow-sm)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
          <span style={{
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            borderRadius: 6, padding: '3px 8px'
          }}>Step 01</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>Select transcript file</span>
        </div>

        {/* Drop Zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          style={{
            border: `1.5px dashed ${isDragOver ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            borderRadius: 8,
            padding: '2.75rem 1.5rem',
            textAlign: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s',
            background: isDragOver ? 'rgba(0, 115, 255, 0.04)' : 'var(--bg-secondary)',
          }}
        >
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            border: '1px solid var(--border-color)',
            background: 'var(--bg-card)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 1rem',
            boxShadow: 'var(--shadow-sm)'
          }}>
            <Upload size={22} color="var(--accent-primary)" />
          </div>
          <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
            Drop file here or click to browse
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '1.1rem' }}>
            One file at a time
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 5 }}>
            {ALLOWED.map(f => (
              <span key={f} style={{
                fontSize: '9px', letterSpacing: '0.1em', textTransform: 'uppercase',
                padding: '3px 9px', borderRadius: 99,
                background: 'var(--bg-card)', border: '1px solid var(--border-color)',
                color: 'var(--text-muted)', fontWeight: 500
              }}>{f}</span>
            ))}
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.pdf,.docx,.csv,.json,.vtt,.srt"
          style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files[0]) validateAndSetFile(e.target.files[0]); }}
        />

        {/* File Item */}
        {currentFile && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            padding: '10px 12px',
            marginTop: 10
          }}>
            <span style={{
              fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
              padding: '3px 8px', borderRadius: 6,
              background: 'rgba(0, 115, 255, 0.08)', color: 'var(--accent-primary)',
              border: '1px solid rgba(0, 115, 255, 0.15)',
              flexShrink: 0, minWidth: 36, textAlign: 'center'
            }}>{ext(currentFile.name) || '?'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {currentFile.name}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{fmtSize(currentFile.size)}</div>
            </div>
            <button
              onClick={clearFile}
              style={{
                background: 'none', border: '1px solid var(--border-color)', cursor: 'pointer',
                color: 'var(--text-muted)', width: 26, height: 26, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, transition: 'all 0.15s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent-danger)'; e.currentTarget.style.color = 'var(--accent-danger)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-color)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Card 2: Instructions */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-color)',
        borderRadius: 14,
        padding: '1.5rem',
        boxShadow: 'var(--shadow-sm)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
          <span style={{
            fontSize: '9px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            borderRadius: 6, padding: '3px 8px'
          }}>Step 02</span>
          <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
            Instructions <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional)</span>
          </span>
        </div>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="e.g. Summarise this call, extract action items, score the agent…"
          style={{
            width: '100%',
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            color: 'var(--text-primary)',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            fontWeight: 300,
            padding: '12px 14px',
            outline: 'none',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            resize: 'vertical',
            minHeight: 70,
            lineHeight: 1.6
          }}
          onFocus={(e) => { e.target.style.borderColor = 'var(--accent-primary)'; e.target.style.boxShadow = '0 0 0 3px rgba(0, 115, 255, 0.08)'; }}
          onBlur={(e) => { e.target.style.borderColor = 'var(--border-color)'; e.target.style.boxShadow = 'none'; }}
        />
      </div>

      {/* Divider */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0'
      }}>
        <div style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.1em' }}>ready to submit</span>
        <div style={{ flex: 1, height: 1, background: 'var(--border-color)' }} />
      </div>

      {/* Send Button */}
      <button
        onClick={sendFile}
        disabled={status === 'sending'}
        style={{
          width: '100%', padding: 15,
          fontSize: '13px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
          borderRadius: 14, border: 'none',
          background: 'var(--accent-primary)', color: '#fff',
          cursor: status === 'sending' ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s, transform 0.1s, box-shadow 0.15s',
          boxShadow: '0 2px 12px rgba(0, 115, 255, 0.28)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          opacity: status === 'sending' ? 0.7 : 1
        }}
      >
        {status === 'sending' ? (
          <>
            <Loader2 size={16} className="spin" /> Processing…
          </>
        ) : (
          <>
            Process transcript <Send size={16} />
          </>
        )}
      </button>

      {/* Status Row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginTop: 10, fontSize: '11px', color: 'var(--text-muted)', minHeight: 22
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: status === 'ok' ? 'var(--accent-success)' : status === 'err' ? 'var(--accent-danger)' : status === 'sending' ? 'var(--accent-warning)' : 'var(--border-color)',
          animation: status === 'sending' ? 'pulse 1s infinite' : 'none'
        }} />
        <span>{statusMsg}</span>
      </div>

      {/* CORS Tip */}
      {showCorsTip && (
        <div style={{
          background: 'rgba(180, 83, 9, 0.06)',
          border: '1px solid rgba(180, 83, 9, 0.18)',
          borderRadius: 8,
          padding: '12px 16px',
          fontSize: '11px',
          color: 'var(--amber)',
          lineHeight: 1.7
        }}>
          <strong>CORS error detected.</strong> In your n8n Webhook node &rarr; Response Headers, add:<br />
          <code style={{ background: 'rgba(180, 83, 9, 0.08)', padding: '1px 6px', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace' }}>
            Access-Control-Allow-Origin: *
          </code>{' '}
          and{' '}
          <code style={{ background: 'rgba(180, 83, 9, 0.08)', padding: '1px 6px', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace' }}>
            Access-Control-Allow-Methods: POST, OPTIONS
          </code>
        </div>
      )}

      {/* Output */}
      {output && (
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--border-color)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: 'var(--shadow)',
          marginTop: 12
        }}>
          {/* Output Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 16px',
            background: 'var(--bg-secondary)',
            borderBottom: '1px solid var(--border-color)'
          }}>
            <span style={{
              fontSize: '11px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              color: 'var(--text-muted)'
            }}>Workflow output</span>
            <span style={{
              fontSize: '10px', fontWeight: 600, letterSpacing: '0.06em',
              padding: '3px 10px', borderRadius: 99,
              background: output.ok ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
              color: output.ok ? 'var(--accent-success)' : 'var(--accent-danger)',
              border: `1px solid ${output.ok ? 'rgba(34, 197, 94, 0.18)' : 'rgba(239, 68, 68, 0.18)'}`
            }}>{output.status}</span>
          </div>

          {/* Output Body */}
          <div style={{
            padding: '1.25rem',
            fontSize: 12, fontWeight: 300,
            color: 'var(--text-primary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 340,
            overflowY: 'auto',
            lineHeight: 1.8,
            fontFamily: 'JetBrains Mono, monospace'
          }}>
            {output.text}
          </div>

          {/* Output Actions */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            borderTop: '1px solid var(--border-color)'
          }}>
            <button
              onClick={copyOutput}
              style={{
                padding: 10, background: 'var(--bg-card)', border: 'none',
                borderRight: '1px solid var(--border-color)',
                color: 'var(--text-muted)', fontSize: 11,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4
              }}
            >
              <Copy size={14} /> Copy
            </button>
            <button
              onClick={downloadOutput}
              style={{
                padding: 10, background: 'var(--bg-card)', border: 'none',
                borderRight: '1px solid var(--border-color)',
                color: 'var(--text-muted)', fontSize: 11,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4
              }}
            >
              <Download size={14} /> Download .txt
            </button>
            <button
              onClick={clearAll}
              style={{
                padding: 10, background: 'var(--bg-card)', border: 'none',
                color: 'var(--text-muted)', fontSize: 11,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4
              }}
            >
              <RotateCcw size={14} /> Clear
            </button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.25} }
      `}</style>
    </div>
  );
}
