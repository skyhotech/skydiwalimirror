// Karthigai Deepam vilakku (traditional oil lamp) with animated flame
export function VilakkuLamp({ className = "" }: { className?: string }) {
  return (
    <div className={`vilakku-wrap ${className}`} aria-hidden="true">
      <svg
        className="vilakku"
        viewBox="0 0 80 110"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
      >
        <defs>
          <radialGradient id="flameGlow" cx="50%" cy="80%" r="50%">
            <stop offset="0%" stopColor="#ffcc44" stopOpacity="0.6" />
            <stop offset="100%" stopColor="#ff6600" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="lampGold" cx="50%" cy="30%" r="60%">
            <stop offset="0%" stopColor="#f5d78e" />
            <stop offset="60%" stopColor="#d4a017" />
            <stop offset="100%" stopColor="#8b6508" />
          </radialGradient>
          <radialGradient id="lampBase" cx="50%" cy="20%" r="70%">
            <stop offset="0%" stopColor="#e8c060" />
            <stop offset="100%" stopColor="#9a6e00" />
          </radialGradient>
        </defs>

        {/* Glow halo behind flame */}
        <ellipse className="vilakku-halo" cx="40" cy="34" rx="18" ry="22" fill="url(#flameGlow)" />

        {/* Outer flame */}
        <path
          className="vilakku-flame-outer"
          d="M40 8 C34 16 28 22 29 32 C30 40 36 44 40 44 C44 44 50 40 51 32 C52 22 46 16 40 8Z"
          fill="#ff6b00"
        />
        {/* Mid flame */}
        <path
          className="vilakku-flame-mid"
          d="M40 14 C37 20 33 26 34 33 C35 39 38 42 40 42 C42 42 45 39 46 33 C47 26 43 20 40 14Z"
          fill="#ffaa00"
        />
        {/* Inner flame (bright core) */}
        <path
          className="vilakku-flame-inner"
          d="M40 20 C38 24 36 28 37 33 C37.5 36.5 39 38 40 38 C41 38 42.5 36.5 43 33 C44 28 42 24 40 20Z"
          fill="#fff9c4"
        />

        {/* Lamp cup (top bowl) */}
        <path
          d="M28 50 Q22 46 24 44 Q26 42 32 44 Q36 48 40 48 Q44 48 48 44 Q54 42 56 44 Q58 46 52 50 Z"
          fill="url(#lampGold)"
          stroke="#b8860b"
          strokeWidth="0.5"
        />
        {/* Oil in cup */}
        <ellipse cx="40" cy="49" rx="10" ry="2.5" fill="#c8a000" opacity="0.7" />
        {/* Wick */}
        <rect x="39" y="43" width="2" height="6" rx="1" fill="#8b6508" />

        {/* Lamp stem */}
        <rect x="37" y="56" width="6" height="18" rx="3" fill="url(#lampGold)" stroke="#b8860b" strokeWidth="0.5" />

        {/* Lamp base disc (top) */}
        <ellipse cx="40" cy="74" rx="12" ry="3" fill="url(#lampBase)" stroke="#b8860b" strokeWidth="0.5" />
        {/* Lamp base body */}
        <path
          d="M28 74 Q27 80 30 84 Q34 88 40 88 Q46 88 50 84 Q53 80 52 74 Z"
          fill="url(#lampBase)"
          stroke="#b8860b"
          strokeWidth="0.5"
        />
        {/* Lamp base disc (bottom) */}
        <ellipse cx="40" cy="88" rx="13" ry="3.5" fill="url(#lampBase)" stroke="#b8860b" strokeWidth="0.5" />
        {/* Stand foot */}
        <path
          d="M27 88 Q23 92 24 95 Q26 98 40 98 Q54 98 56 95 Q57 92 53 88 Z"
          fill="url(#lampBase)"
          stroke="#b8860b"
          strokeWidth="0.5"
        />
        <ellipse cx="40" cy="97" rx="16" ry="4" fill="#c8a000" opacity="0.5" />

        {/* Decorative dots on base */}
        <circle cx="33" cy="81" r="1.5" fill="#ffe082" opacity="0.8" />
        <circle cx="40" cy="83" r="1.5" fill="#ffe082" opacity="0.8" />
        <circle cx="47" cy="81" r="1.5" fill="#ffe082" opacity="0.8" />

        {/* Sparkles */}
        <g className="vilakku-sparks">
          <circle className="vspark vspark-1" cx="22" cy="22" r="1.5" fill="#ffdd00" />
          <circle className="vspark vspark-2" cx="58" cy="18" r="1" fill="#ffaa00" />
          <circle className="vspark vspark-3" cx="18" cy="38" r="1" fill="#ff8800" />
          <circle className="vspark vspark-4" cx="62" cy="30" r="1.5" fill="#ffdd00" />
          <circle className="vspark vspark-5" cx="30" cy="10" r="1" fill="#fff9c4" />
          <circle className="vspark vspark-6" cx="52" cy="12" r="1" fill="#fff9c4" />
        </g>
      </svg>
    </div>
  );
}
