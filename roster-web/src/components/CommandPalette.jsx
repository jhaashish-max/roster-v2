import { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Calendar, Table, PieChart, Settings, Moon, Sun, RefreshCw } from 'lucide-react';

const CommandPalette = ({ isOpen, onClose, onNavigate, onAction, darkMode }) => {
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);
    const inputRef = useRef(null);
    const listRef = useRef(null);

    const commands = useMemo(() => [
        { id: 'dashboard', label: 'Go to Dashboard', icon: Calendar, action: () => onNavigate('dashboard') },
        { id: 'roster', label: 'Go to Roster View', icon: Table, action: () => onNavigate('roster') },
        { id: 'summary', label: 'Go to Summary', icon: PieChart, action: () => onNavigate('summary') },
        { id: 'settings', label: 'Go to Settings', icon: Settings, action: () => onNavigate('settings') },
        { id: 'theme', label: darkMode ? 'Switch to Light Mode' : 'Switch to Dark Mode', icon: darkMode ? Sun : Moon, action: () => onAction('toggle-theme') },
        { id: 'refresh', label: 'Refresh Data', icon: RefreshCw, action: () => onAction('refresh') },
    ], [onNavigate, onAction, darkMode]);

    const filtered = useMemo(() => {
        if (!query) return commands;
        return commands.filter(c =>
            c.label.toLowerCase().includes(query.toLowerCase())
        );
    }, [query, commands]);

    // Reset active index when filtered results change
    useEffect(() => {
        setActiveIndex(0);
    }, [filtered]);

    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
            setQuery('');
            setActiveIndex(0);
        }
    }, [isOpen]);

    // Scroll active item into view
    useEffect(() => {
        if (listRef.current) {
            const activeEl = listRef.current.querySelector('.command-item.active');
            if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
        }
    }, [activeIndex]);

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                onClose();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex(i => (i + 1) % filtered.length);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex(i => (i - 1 + filtered.length) % filtered.length);
            } else if (e.key === 'Enter' && filtered.length > 0) {
                filtered[activeIndex]?.action();
                onClose();
            }
        };

        if (isOpen) {
            document.addEventListener('keydown', handleKeyDown);
            return () => document.removeEventListener('keydown', handleKeyDown);
        }
    }, [isOpen, filtered, activeIndex, onClose]);

    if (!isOpen) return null;

    return (
        <div className="command-overlay" onClick={onClose}>
            <div className="command-palette" onClick={(e) => e.stopPropagation()}>
                <div className="command-input-wrapper">
                    <Search size={18} className="command-search-icon" />
                    <input
                        ref={inputRef}
                        type="text"
                        className="command-input"
                        placeholder="Type a command..."
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    <kbd className="command-kbd">ESC</kbd>
                </div>
                <div className="command-list" ref={listRef}>
                    {filtered.length === 0 ? (
                        <div className="command-empty">No commands found</div>
                    ) : (
                        filtered.map((cmd, i) => (
                            <button
                                key={cmd.id}
                                className={`command-item${i === activeIndex ? ' active' : ''}`}
                                onMouseEnter={() => setActiveIndex(i)}
                                onClick={() => {
                                    cmd.action();
                                    onClose();
                                }}
                            >
                                <cmd.icon size={16} />
                                <span>{cmd.label}</span>
                            </button>
                        ))
                    )}
                </div>
                <div className="command-footer">
                    <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
                    <span><kbd>↵</kbd> select</span>
                    <span><kbd>esc</kbd> close</span>
                </div>
            </div>
        </div>
    );
};

export default CommandPalette;
