import React from 'react';

const Logo = ({ className, width, height, collapsed = false }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={collapsed ? "45 30 140 140" : "45 30 560 140"}
        width={width ? width : (collapsed ? "40px" : undefined)}
        height={height || "100%"}
        className={className}
        style={{ transition: 'all 0.3s ease' }}
    >
        <defs>
            {/* Deep Navy Background Gradient */}
            <linearGradient id="gradStem" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#113A63" />
                <stop offset="100%" stopColor="#0A2540" />
            </linearGradient>

            {/* Bright Cyan/Azure Accent Gradient */}
            <linearGradient id="gradLoop" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#00D4FF" />
                <stop offset="100%" stopColor="#0073FF" />
            </linearGradient>

            {/* Subtle Drop Shadow for depth */}
            <filter id="subtleShadow" x="-10%" y="-10%" width="120%" height="120%">
                <feDropShadow dx="2" dy="4" stdDeviation="4" floodColor="#0A2540" floodOpacity="0.1" />
            </filter>
        </defs>

        {/* Clean, Crisp White Background */}
        <rect width="100%" height="100%" fill="transparent" />

        {/* Abstract dynamic background slash for brand texture - Adjusted for new width */}
        {/* Removed background polygons and rect to make the logo transparent/integrate better with UI */}

        {/* LOGO MARK: Indian Worker Silhouette in a Modern Badge */}
        {/* Shifted up slightly to center in the new 200px height */}
        <g id="logo-icon" transform="translate(40, 25)" filter="url(#subtleShadow)">

            {/* Outer Badge */}
            <circle cx="75" cy="75" r="65" fill="url(#gradStem)" />
            {/* Inner subtle ring for premium feel */}
            <circle cx="75" cy="75" r="63" fill="none" stroke="#FFFFFF" strokeOpacity="0.15" strokeWidth="1.5" />

            {/* Abstract Ground Line */}
            <line x1="30" y1="120" x2="120" y2="120" stroke="#E2E8F0" strokeOpacity="0.2" strokeWidth="2" strokeLinecap="round" />

            {/* WORKER ILLUSTRATION */}
            {/* Left Arm (Resting on hip, placed behind torso) */}
            <path d="M 60 60 L 48 72 L 54 78 L 62 68 Z" fill="#E2E8F0" />

            {/* Left Leg (Back) */}
            <path d="M 63 90 L 57 120 L 65 120 L 69 90 Z" fill="#E2E8F0" />
            {/* Right Leg (Front) */}
            <path d="M 77 90 L 83 120 L 75 120 L 71 90 Z" fill="#FFFFFF" />

            {/* Torso */}
            <path d="M 60 60 L 80 60 L 77 90 L 63 90 Z" fill="#FFFFFF" />
            {/* V-Neck Cutout */}
            <path d="M 66 60 L 70 66 L 74 60" fill="url(#gradStem)" />

            {/* Waist-Tie (Traditional Gamcha wrap) */}
            <path d="M 62 86 L 78 86 L 77 92 L 63 92 Z" fill="url(#gradLoop)" />
            {/* Hanging Knot of the Gamcha */}
            <path d="M 65 92 L 69 104 L 63 104 Z" fill="url(#gradLoop)" />

            {/* Face (Clean U-Shape curve) */}
            <path d="M 62 42 C 62 55 78 55 78 42 Z" fill="#FFFFFF" />

            {/* Traditional Turban (Safa) Dome */}
            <path d="M 60 42 C 60 28 80 28 80 42 Z" fill="url(#gradLoop)" />
            {/* Turban folds/texture */}
            <path d="M 63 36 Q 70 40 77 36 M 66 33 Q 70 36 74 33" stroke="#0A2540" strokeOpacity="0.3" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            {/* Safa Tail draping down the back */}
            <path d="M 62 40 Q 52 45 54 58 Q 59 50 66 42 Z" fill="url(#gradLoop)" />

            {/* Pickaxe Handle */}
            <line x1="80" y1="110" x2="97" y2="35" stroke="#E2E8F0" strokeWidth="4" strokeLinecap="round" />

            {/* Pickaxe Head (Sharp Cyan Curve) */}
            <path d="M 80 25 Q 97 35 120 50" stroke="url(#gradLoop)" strokeWidth="7" strokeLinecap="round" fill="none" />

            {/* Right Arm (Front layer, holding the pickaxe handle) */}
            <path d="M 80 60 L 92 68 L 86 73 L 78 66 Z" fill="#FFFFFF" />
            {/* Right Hand grip */}
            <circle cx="89" cy="70" r="4.5" fill="#FFFFFF" />

        </g>

        {/* BRAND TYPOGRAPHY */}
        <g
            id="logo-text"
            transform="translate(210, 0)"
            style={{
                opacity: collapsed ? 0 : 1,
                transition: 'opacity 0.2s ease',
                display: collapsed ? 'none' : 'block'
            }}
        >
            {/* Main Brand Name - Adjusted Y position to perfectly center with the icon */}
            <text x="0" y="115" fontFamily="'Montserrat', 'Inter', 'Helvetica Neue', sans-serif" fontSize="48" fontWeight="900" fill="var(--text-primary)" letterSpacing="-1">
                Rozgaar<tspan fill="#0073FF" fontWeight="300"> Register</tspan>
            </text>
        </g>
    </svg>
);

export default Logo;
