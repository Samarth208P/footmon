'use client';
import { useState, useEffect, useCallback } from 'react';
import { useWallet } from '../contexts/WalletContext';
import { useGame } from '../contexts/GameContext';
import { supabase } from '../lib/supabase';

/* ── Formation configs: position labels + pitch coordinates ─────────────── */
const FORMATIONS = {
    '4-3-3': {
        labels: ['LW', 'ST', 'RW', 'CM', 'CM', 'CM', 'LB', 'CB', 'CB', 'RB', 'GK'],
        positions: [
            { top: '12%', left: '18%' }, { top: '8%',  left: '50%' }, { top: '12%', left: '82%' },
            { top: '38%', left: '25%' }, { top: '42%', left: '50%' }, { top: '38%', left: '75%' },
            { top: '68%', left: '12%' }, { top: '72%', left: '38%' }, { top: '72%', left: '62%' }, { top: '68%', left: '88%' },
            { top: '90%', left: '50%' }
        ],
        sections: { attack: ['LW','ST','RW'], midfield: ['CM','CM','CM'], defense: ['LB','CB','CB','RB','GK'] }
    },
    '4-4-2': {
        labels: ['ST', 'ST', 'LM', 'CM', 'CM', 'RM', 'LB', 'CB', 'CB', 'RB', 'GK'],
        positions: [
            { top: '10%', left: '35%' }, { top: '10%', left: '65%' },
            { top: '38%', left: '12%' }, { top: '42%', left: '38%' }, { top: '42%', left: '62%' }, { top: '38%', left: '88%' },
            { top: '68%', left: '12%' }, { top: '72%', left: '38%' }, { top: '72%', left: '62%' }, { top: '68%', left: '88%' },
            { top: '90%', left: '50%' }
        ],
        sections: { attack: ['ST','ST'], midfield: ['LM','CM','CM','RM'], defense: ['LB','CB','CB','RB','GK'] }
    },
    '4-2-3-1': {
        labels: ['ST', 'LW', 'CAM', 'RW', 'CDM', 'CDM', 'LB', 'CB', 'CB', 'RB', 'GK'],
        positions: [
            { top: '8%',  left: '50%' },
            { top: '26%', left: '15%' }, { top: '24%', left: '50%' }, { top: '26%', left: '85%' },
            { top: '48%', left: '35%' }, { top: '48%', left: '65%' },
            { top: '68%', left: '12%' }, { top: '72%', left: '38%' }, { top: '72%', left: '62%' }, { top: '68%', left: '88%' },
            { top: '90%', left: '50%' }
        ],
        sections: { attack: ['ST','LW','CAM','RW'], midfield: ['CDM','CDM'], defense: ['LB','CB','CB','RB','GK'] }
    },
    '4-2-4': {
        labels: ['LW', 'ST', 'ST', 'RW', 'CM', 'CM', 'LB', 'CB', 'CB', 'RB', 'GK'],
        positions: [
            { top: '10%', left: '12%' }, { top: '8%',  left: '38%' }, { top: '8%',  left: '62%' }, { top: '10%', left: '88%' },
            { top: '42%', left: '35%' }, { top: '42%', left: '65%' },
            { top: '68%', left: '12%' }, { top: '72%', left: '38%' }, { top: '72%', left: '62%' }, { top: '68%', left: '88%' },
            { top: '90%', left: '50%' }
        ],
        sections: { attack: ['LW','ST','ST','RW'], midfield: ['CM','CM'], defense: ['LB','CB','CB','RB','GK'] }
    },
    '3-5-2': {
        labels: ['ST', 'ST', 'LM', 'CM', 'CM', 'CM', 'RM', 'CB', 'CB', 'CB', 'GK'],
        positions: [
            { top: '10%', left: '35%' }, { top: '10%', left: '65%' },
            { top: '36%', left: '8%'  }, { top: '40%', left: '32%' }, { top: '44%', left: '50%' }, { top: '40%', left: '68%' }, { top: '36%', left: '92%' },
            { top: '70%', left: '25%' }, { top: '72%', left: '50%' }, { top: '70%', left: '75%' },
            { top: '90%', left: '50%' }
        ],
        sections: { attack: ['ST','ST'], midfield: ['LM','CM','CM','CM','RM'], defense: ['CB','CB','CB','GK'] }
    },
    '5-3-2': {
        labels: ['ST', 'ST', 'CM', 'CM', 'CM', 'LWB', 'CB', 'CB', 'CB', 'RWB', 'GK'],
        positions: [
            { top: '10%', left: '35%' }, { top: '10%', left: '65%' },
            { top: '38%', left: '25%' }, { top: '42%', left: '50%' }, { top: '38%', left: '75%' },
            { top: '62%', left: '8%'  }, { top: '70%', left: '30%' }, { top: '72%', left: '50%' }, { top: '70%', left: '70%' }, { top: '62%', left: '92%' },
            { top: '90%', left: '50%' }
        ],
        sections: { attack: ['ST','ST'], midfield: ['CM','CM','CM'], defense: ['LWB','CB','CB','CB','RWB','GK'] }
    },
    '4-5-1': {
        labels: ['ST', 'LM', 'CM', 'CM', 'CM', 'RM', 'LB', 'CB', 'CB', 'RB', 'GK'],
        positions: [
            { top: '8%',  left: '50%' },
            { top: '34%', left: '8%'  }, { top: '38%', left: '30%' }, { top: '42%', left: '50%' }, { top: '38%', left: '70%' }, { top: '34%', left: '92%' },
            { top: '68%', left: '12%' }, { top: '72%', left: '38%' }, { top: '72%', left: '62%' }, { top: '68%', left: '88%' },
            { top: '90%', left: '50%' }
        ],
        sections: { attack: ['ST'], midfield: ['LM','CM','CM','CM','RM'], defense: ['LB','CB','CB','RB','GK'] }
    },
    '3-4-3': {
        labels: ['LW', 'ST', 'RW', 'LM', 'CM', 'CM', 'RM', 'CB', 'CB', 'CB', 'GK'],
        positions: [
            { top: '10%', left: '18%' }, { top: '8%',  left: '50%' }, { top: '10%', left: '82%' },
            { top: '36%', left: '10%' }, { top: '40%', left: '38%' }, { top: '40%', left: '62%' }, { top: '36%', left: '90%' },
            { top: '70%', left: '25%' }, { top: '72%', left: '50%' }, { top: '70%', left: '75%' },
            { top: '90%', left: '50%' }
        ],
        sections: { attack: ['LW','ST','RW'], midfield: ['LM','CM','CM','RM'], defense: ['CB','CB','CB','GK'] }
    }
};

/** Adjust slot vertical position based on tactical style (Defensive drops back, Attacking pushes forward) */
function getAdjustedTop(topStr, label, style) {
    const numericTop = parseFloat(topStr);
    if (label === 'GK') return `${numericTop}%`;
    
    let shift = 0;
    if (style === 'attacking') shift = -5; // Push team higher up pitch
    else if (style === 'defensive') shift = 5;  // Drop team deeper back

    const adjusted = Math.min(88, Math.max(5, numericTop + shift));
    return `${adjusted}%`;
}

export default function Home() {
    const { address, username, connect, isRegistering, registerUser, setIsRegistering, balance } = useWallet();
    const {
        formation, setFormation,
        style, setStyle,
        mode, setMode,
        squad, pickPlayer, handleSlotClick,
        selectedDraftPlayer, selectDraftPlayer, placeDraftPlayerToSlot,
        hasFreeRoll, currentDraft, roll, isRolling,
        selectedSlot, canPlaySlot, getPlayerJerseyNumber,
        restart
    } = useGame();

    const [screen, setScreen] = useState('formation');
    const [leaderboard, setLeaderboard] = useState([]);
    const [activeTab, setActiveTab] = useState('Top 100');
    const [timeTab, setTimeTab] = useState('Last 24h');
    const [isSimulating, setIsSimulating] = useState(false);
    const [result, setResult] = useState(null);
    const [regInput, setRegInput] = useState('');
    const [regError, setRegError] = useState('');
    const [utcCountdown, setUtcCountdown] = useState('');

    const fm = FORMATIONS[formation] || FORMATIONS['4-3-3'];
    const filledCount = squad.filter(p => p).length;

    // UTC countdown timer
    useEffect(() => {
        const tick = () => {
            const now = new Date();
            const utcH = 23 - now.getUTCHours();
            const utcM = 59 - now.getUTCMinutes();
            const utcS = 59 - now.getUTCSeconds();
            setUtcCountdown(`${String(utcH).padStart(2,'0')}:${String(utcM).padStart(2,'0')}:${String(utcS).padStart(2,'0')}`);
        };
        tick();
        const id = setInterval(tick, 1000);
        return () => clearInterval(id);
    }, []);

    // Fetch leaderboard
    const fetchLeaderboard = useCallback(async () => {
        let query = supabase
            .from('tournaments')
            .select('wallet_address, team_rating, goal_difference, won_final, created_at')
            .eq('won_final', true)
            .order('goal_difference', { ascending: false })
            .order('team_rating', { ascending: false })
            .limit(100);

        if (timeTab === 'Last 24h') {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            query = query.gte('created_at', yesterday.toISOString());
        }

        const { data } = await query;
        if (data) {
            // Resolve usernames
            const addresses = [...new Set(data.map(d => d.wallet_address))];
            const { data: users } = await supabase.from('users').select('wallet_address, username').in('wallet_address', addresses);
            const userMap = {};
            if (users) users.forEach(u => userMap[u.wallet_address] = u.username);
            setLeaderboard(data.map(d => ({ ...d, username: userMap[d.wallet_address] || d.wallet_address.slice(0, 8) + '...' })));
        }
    }, [timeTab]);

    useEffect(() => { fetchLeaderboard(); }, [fetchLeaderboard]);

    // Team avg rating
    const getScore = () => {
        const filled = squad.filter(p => p);
        if (filled.length === 0) return 0;
        return Math.round(filled.reduce((sum, p) => sum + p.rating, 0) / filled.length);
    };

    // Handle roll click
    const handleRoll = async (opts = {}) => {
        if (address && !username) {
            setIsRegistering(true);
            return;
        }
        if (screen === 'formation') setScreen('play');
        await roll(opts);
    };

    // Handle tournament submission
    const handleSubmit = async () => {
        if (filledCount < 11) return;
        if (!address) {
            await connect();
            return;
        }
        if (!username) {
            setIsRegistering(true);
            return;
        }
        setIsSimulating(true);
        try {
            const res = await fetch('/api/tournament/simulate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ squad, wallet_address: address, style, mode })
            });
            const data = await res.json();
            setResult(data);
            fetchLeaderboard();
        } catch (e) {
            console.error(e);
        }
        setIsSimulating(false);
    };

    // Rank badge colors
    const rankBg = (rank) => {
        if (rank === 1) return 'bg-[#f6d061] text-gray-900';
        if (rank === 2) return 'bg-[#cfd3db] text-gray-900';
        if (rank === 3) return 'bg-[#d69f69] text-gray-900';
        return 'bg-gray-900 text-white';
    };

    const btnActive = "bg-[#115e3b] text-white border-[#115e3b]";
    const btnInactive = "bg-white text-gray-700 border-gray-300 hover:border-gray-400";

    /* ══════════════════════════════════════════════════════════════════════════
       RENDER
       ══════════════════════════════════════════════════════════════════════════ */
    return (
        <>
            {/* ── Registration Modal (Mandatory for Leaderboard) ────────────── */}
            {isRegistering && (
                <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-white rounded-2xl shadow-2xl p-8 w-[380px] flex flex-col gap-4 border border-gray-100 relative">
                        <button 
                            onClick={() => setIsRegistering(false)}
                            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 font-bold text-lg w-7 h-7 flex items-center justify-center rounded-full hover:bg-gray-100 transition-colors"
                        >
                            ✕
                        </button>
                        <div className="flex flex-col gap-1">
                            <h2 className="text-xl font-black text-gray-900">Choose a Unique Username</h2>
                            <p className="text-xs text-gray-500">Required to register on the global leaderboard.</p>
                        </div>
                        <input
                            type="text"
                            value={regInput}
                            onChange={(e) => {
                                setRegInput(e.target.value);
                                setRegError('');
                            }}
                            placeholder="Enter username..."
                            className="border-2 border-gray-200 rounded-xl px-4 py-3 text-sm font-bold text-gray-900 focus:border-[#115e3b] outline-none transition-colors"
                            maxLength={20}
                        />
                        {regError && <p className="text-red-500 text-xs font-bold bg-red-50 p-2 rounded-lg text-center">{regError}</p>}
                        <button
                            className="bg-[#115e3b] text-white font-bold py-3.5 rounded-xl hover:bg-[#0e4d31] transition-colors disabled:opacity-50 shadow-md"
                            disabled={!regInput.trim()}
                            onClick={async () => {
                                setRegError('');
                                const { error } = await registerUser(regInput.trim());
                                if (error) setRegError(error);
                            }}
                        >
                            Complete Registration
                        </button>
                    </div>
                </div>
            )}

            {/* ── Result Modal ───────────────────────────────────────────────── */}
            {result && (
                <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
                    <div className="bg-white rounded-2xl shadow-2xl p-8 w-[420px] flex flex-col items-center gap-4 text-center">
                        <div className="text-5xl">{result.won_final ? '🏆' : '😞'}</div>
                        <h2 className="text-2xl font-black text-gray-900">
                            {result.won_final ? 'You Won the Tournament!' : 'Knocked Out!'}
                        </h2>
                        <div className="flex gap-8 mt-2">
                            <div className="flex flex-col">
                                <span className="text-3xl font-black text-[#115e3b]">{result.goal_difference > 0 ? '+' : ''}{result.goal_difference}</span>
                                <span className="text-xs font-bold text-gray-400 uppercase">Goal Diff</span>
                            </div>
                            <div className="flex flex-col">
                                <span className="text-3xl font-black text-gray-900">{Math.round(result.team_rating)}</span>
                                <span className="text-xs font-bold text-gray-400 uppercase">Team Rating</span>
                            </div>
                        </div>
                        {/* Match breakdown */}
                        {result.matches && (
                            <div className="w-full mt-3 flex flex-col gap-1.5">
                                {result.matches.map((m, i) => (
                                    <div key={i} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-xs">
                                        <span className="font-bold text-gray-500 w-24 text-left">{m.round}</span>
                                        <span className="font-black text-gray-900">{m.myGoals} - {m.oppGoals}</span>
                                        {m.penalties && <span className="text-[9px] font-bold text-gray-400">(pens: {m.penalties})</span>}
                                        <span className="text-[10px] text-gray-400">vs {m.oppRating} rated</span>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="flex gap-2 mt-2">
                            <span className="text-[9px] font-bold bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 capitalize">{result.style}</span>
                            <span className="text-[9px] font-bold bg-gray-100 text-gray-500 rounded-full px-2 py-0.5 capitalize">{result.mode}</span>
                        </div>
                        <button
                            className="mt-4 bg-[#115e3b] text-white font-bold py-3 px-8 rounded-lg hover:bg-[#0e4d31]"
                            onClick={() => { setResult(null); restart(); setScreen('formation'); }}
                        >
                            Play Again
                        </button>
                    </div>
                </div>
            )}

            <main className="h-screen w-full flex p-4 gap-4 items-stretch justify-center max-w-[1400px] mx-auto bg-[#f9f8f4]">
                
                {/* ═══ LEFT COLUMN ═══ */}
                <aside className="w-[280px] flex flex-col gap-3 shrink-0">

                    {/* ── Formation/Style Card (Only shown initially) ─────────────── */}
                    {screen === 'formation' && !result && (
                        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                            <div className="mb-5">
                                <h3 className="text-[11px] font-bold text-gray-500 tracking-[0.15em] uppercase mb-2">Formation</h3>
                                <div className="flex flex-wrap gap-1.5">
                                    {Object.keys(FORMATIONS).map(f => (
                                        <button key={f} onClick={() => setFormation(f)}
                                            className={`px-2.5 py-1 text-[11px] font-bold rounded border transition-colors ${formation === f ? btnActive : btnInactive}`}>
                                            {f}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div className="mb-5">
                                <h3 className="text-[11px] font-bold text-gray-500 tracking-[0.15em] uppercase mb-2">Style</h3>
                                <div className="flex flex-wrap gap-1.5">
                                    {['Defensive', 'Balanced', 'Attacking'].map(s => (
                                        <button key={s} onClick={() => setStyle(s.toLowerCase())}
                                            className={`px-2.5 py-1 text-[11px] font-bold rounded border transition-colors ${style === s.toLowerCase() ? btnActive : btnInactive}`}>
                                            {s}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            <div>
                                <h3 className="text-[11px] font-bold text-gray-500 tracking-[0.15em] uppercase mb-2">Mode · Difficulty</h3>
                                <div className="flex flex-wrap gap-1.5">
                                    {['Classic', 'Almanac'].map(m => (
                                        <button key={m} onClick={() => setMode(m.toLowerCase())}
                                            className={`px-2.5 py-1 text-[11px] font-bold rounded border transition-colors ${mode === m.toLowerCase() ? btnActive : btnInactive}`}>
                                            {m}
                                        </button>
                                    ))}
                                </div>
                                <p className="text-[9px] text-gray-400 mt-1.5 leading-tight">
                                    {mode === 'classic' ? 'Player ratings visible when picking.' : 'Ratings hidden until picked. Blind draft!'}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* ── Waiting for Next Roll Prompt (when draft is empty in play mode) ── */}
                    {screen === 'play' && !currentDraft && filledCount < 11 && (
                        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex flex-col items-center justify-center text-center gap-3">
                            <div className="text-xs font-black text-gray-400 uppercase tracking-widest">DRAFT PLAYER {filledCount + 1}/11</div>
                            <h3 className="text-lg font-black text-gray-900 leading-snug">Roll to draw a nation and World Cup year</h3>
                            <button
                                onClick={() => handleRoll()}
                                disabled={isRolling}
                                className="w-full bg-[#115e3b] text-white font-bold text-xs py-3 rounded-xl hover:bg-[#0e4d31] transition-colors shadow-sm mt-1"
                            >
                                {isRolling ? 'Rolling...' : 'ROLL 🎲'}
                            </button>
                        </div>
                    )}

                    {/* ── Draft Card (after roll) ──────────────────────────────── */}
                    {screen === 'play' && currentDraft && (
                        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 flex flex-col overflow-hidden">
                            <h3 className="text-[11px] font-bold text-gray-500 tracking-[0.15em] uppercase mb-1">Drawn</h3>
                            <div className="mb-4">
                                <div className="text-3xl font-black text-gray-900 tracking-tight leading-tight">{currentDraft.nationName}</div>
                                <div className="text-xl font-black text-[#ff5c4a] tracking-tight leading-tight">World Cup<br/>{currentDraft.year}</div>
                            </div>

                            <div className="mb-3">
                                <h3 className="text-[10px] font-bold text-gray-500 tracking-[0.12em] uppercase mb-1.5">
                                    Reroll For Advantage · 0.001 MON
                                </h3>
                                <div className="flex gap-1.5">
                                    <button
                                        onClick={() => handleRoll({ lockYear: currentDraft.year, isPaid: true })}
                                        disabled={isRolling}
                                        className="flex-1 py-1.5 text-[10px] font-bold border-2 border-gray-800 rounded text-gray-800 hover:bg-gray-100 flex items-center justify-center gap-1 disabled:opacity-40">
                                        ↻ Another Nation
                                    </button>
                                    <button
                                        onClick={() => handleRoll({ lockNation: currentDraft.nationName, isPaid: true })}
                                        disabled={isRolling}
                                        className="flex-1 py-1.5 text-[10px] font-bold border-2 border-gray-800 rounded text-gray-800 hover:bg-gray-100 flex items-center justify-center gap-1 disabled:opacity-40">
                                        ↻ Another World Cup
                                    </button>
                                </div>
                            </div>

                            <h3 className="text-[10px] font-bold text-gray-500 tracking-[0.12em] uppercase mb-1">Pick a Player</h3>
                            <div className="flex flex-col gap-1 overflow-y-auto flex-1 pr-1 max-h-[240px]">
                                {currentDraft.players.map((p, i) => {
                                    const isSelected = selectedDraftPlayer && selectedDraftPlayer.id === p.id;
                                    const alreadyPicked = squad.some(s => s && (s.id === p.id || s.name.trim().toLowerCase() === p.name.trim().toLowerCase()));
                                    const hasCompatibleSlot = fm.labels.some((lbl, idx) => squad[idx] === null && canPlaySlot(p, lbl));
                                    const disabled = alreadyPicked || !hasCompatibleSlot;
                                    return (
                                        <button
                                            key={p.id || i}
                                            disabled={disabled}
                                            onClick={() => selectDraftPlayer(p)}
                                            className={`flex items-center justify-between py-1.5 px-2 rounded transition-all text-left ${
                                                isSelected 
                                                    ? 'bg-[#115e3b] text-white ring-2 ring-[#115e3b] shadow-md' 
                                                    : disabled 
                                                        ? 'opacity-30 cursor-not-allowed' 
                                                        : 'hover:bg-[#e8f5ee] cursor-pointer text-gray-900'
                                            }`}>
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span className={`text-[10px] font-bold w-5 shrink-0 ${isSelected ? 'text-white/70' : 'text-gray-400'}`}>
                                                    {p.jersey_number && p.jersey_number > 0 ? `#${p.jersey_number}` : '#-'}
                                                </span>
                                                <span className={`text-xs font-black truncate ${isSelected ? 'text-white' : p.is_legendary ? 'text-[#b8860b]' : 'text-gray-900'}`}>
                                                    {p.name}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <span className={`text-[9px] font-bold uppercase ${isSelected ? 'text-white/80' : 'text-gray-400'}`}>{p.position}</span>
                                                {mode === 'classic' ? (
                                                    <span className={`text-sm font-black ${isSelected ? 'text-white' : 'text-gray-900'}`}>{p.rating}</span>
                                                ) : (
                                                    <span className={`text-sm font-black ${isSelected ? 'text-white/70' : 'text-gray-400'}`}>??</span>
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                                {!fm.labels.some((lbl, idx) => squad[idx] === null) && (
                                    <div className="text-center text-[10px] font-bold text-[#d63a29] uppercase tracking-wider py-2">No Open Position</div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* ── Bottom: CTA area / Lineup Complete ──────────────────── */}
                    <div className="flex-1 flex flex-col justify-end gap-3 mt-auto">
                        {filledCount === 11 ? (
                            <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5 flex flex-col gap-4">
                                <div>
                                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">LINEUP COMPLETE</div>
                                    <div className="text-4xl font-black text-gray-900 tracking-tight">11/11</div>
                                </div>
                                <button
                                    onClick={handleSubmit}
                                    disabled={isSimulating || !address}
                                    className="w-full bg-gradient-to-b from-[#ff7a63] to-[#ff4733] text-white font-black text-xl italic tracking-wide py-4 rounded-xl shadow-lg border-b-4 border-[#d63a29] hover:brightness-105 active:border-b-2 active:translate-y-0.5 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                                >
                                    {isSimulating ? 'SIMULATING...' : !address ? 'CONNECT WALLET TO SIMULATE' : <>SIMULATE THE TOURNAMENT <span className="text-2xl leading-none">→</span></>}
                                </button>
                            </div>
                        ) : (
                            <>
                                {(!currentDraft || screen === 'formation') && (
                                    <div className="bg-white rounded-xl border border-dashed border-gray-300 p-6 flex items-center justify-center text-center">
                                        <span className="font-bold text-gray-400 text-sm leading-snug">Roll to draw a nation and<br/>World Cup year</span>
                                    </div>
                                )}

                                {/* ROLL Button */}
                                <button
                                    className="w-full bg-gradient-to-b from-[#ff7a63] to-[#ff4733] text-white font-black text-2xl italic tracking-wide py-4 rounded-xl shadow-lg border-b-4 border-[#d63a29] hover:brightness-105 active:border-b-2 active:translate-y-0.5 transition-all disabled:opacity-50"
                                    onClick={() => handleRoll()}
                                    disabled={isRolling || filledCount >= 11}
                                >
                                    {isRolling ? 'Rolling...' : 'ROLL 🎲'}
                                </button>
                            </>
                        )}
                    </div>
                </aside>

                {/* ═══ CENTER COLUMN (PITCH) ═══ */}
                <div className="flex-1 max-w-[560px] h-full flex flex-col">
                    <div className="flex-1 pitch-stripes rounded-xl border-2 border-[#1e5631] shadow-xl relative overflow-hidden">
                        {/* Pitch markings */}
                        <div className="absolute top-1/2 left-0 right-0 h-[2px] bg-white/25 -translate-y-1/2"></div>
                        <div className="absolute top-1/2 left-1/2 w-[28%] aspect-square rounded-full border-[2px] border-white/25 -translate-x-1/2 -translate-y-1/2"></div>
                        <div className="absolute top-1/2 left-1/2 w-2 h-2 rounded-full bg-white/40 -translate-x-1/2 -translate-y-1/2"></div>
                        {/* Top penalty area */}
                        <div className="absolute top-0 left-1/2 w-[50%] h-[14%] border-[2px] border-t-0 border-white/25 -translate-x-1/2"></div>
                        <div className="absolute top-0 left-1/2 w-[22%] h-[6%] border-[2px] border-t-0 border-white/25 -translate-x-1/2"></div>
                        {/* Bottom penalty area */}
                        <div className="absolute bottom-0 left-1/2 w-[50%] h-[14%] border-[2px] border-b-0 border-white/25 -translate-x-1/2"></div>
                        <div className="absolute bottom-0 left-1/2 w-[22%] h-[6%] border-[2px] border-b-0 border-white/25 -translate-x-1/2"></div>

                        {/* Slots */}
                        {fm.positions.map((pos, i) => {
                            const player = squad[i];
                            const label = fm.labels[i];
                            const isSelected = selectedSlot === i;

                            // Selected player from pitch slot (for swapping)
                            const selectedPitchPlayer = selectedSlot !== null ? squad[selectedSlot] : null;
                            const isSwapSource = selectedSlot === i;

                            // Swap compatibility checks:
                            // 1. Target is occupied: BOTH players must satisfy each other's positions
                            const canSwapOccupied = selectedSlot !== null && !isSwapSource && player && selectedPitchPlayer && 
                                canPlaySlot(selectedPitchPlayer, label) && canPlaySlot(player, fm.labels[selectedSlot]);

                            // 2. Target is empty: Selected player must satisfy empty slot position
                            const canSwapEmpty = selectedSlot !== null && !isSwapSource && !player && selectedPitchPlayer && 
                                canPlaySlot(selectedPitchPlayer, label);

                            // Draft player placement target
                            const isDraftTarget = selectedDraftPlayer && !player && canPlaySlot(selectedDraftPlayer, label);

                            // General draft compatibility
                            const isCompatible = currentDraft && !player && !selectedDraftPlayer && currentDraft.players.some(p =>
                                !squad.some(s => s && (s.id === p.id || s.name.trim().toLowerCase() === p.name.trim().toLowerCase())) && canPlaySlot(p, label)
                            );

                            const handleSlotClickAction = () => {
                                if (selectedDraftPlayer && !player) {
                                    if (canPlaySlot(selectedDraftPlayer, label)) {
                                        placeDraftPlayerToSlot(i, label);
                                    }
                                } else {
                                    handleSlotClick(i, fm.labels);
                                }
                            };

                            const jerseyDisplayNum = player ? getPlayerJerseyNumber(player, i, label) : '';

                            return (
                                <div
                                    key={i}
                                    onClick={handleSlotClickAction}
                                    className={`absolute cursor-pointer flex flex-col items-center transition-all duration-500 ease-out z-10`}
                                    style={{ top: getAdjustedTop(pos.top, label, style), left: pos.left, transform: 'translate(-50%, -50%)' }}
                                >
                                    {/* Jersey circle */}
                                    <div className={`w-[48px] h-[48px] rounded-full flex items-center justify-center transition-all
                                        ${isSwapSource
                                            ? 'border-4 border-solid border-yellow-400 bg-yellow-400/40 scale-110 ring-4 ring-yellow-400/50 shadow-xl'
                                            : canSwapOccupied
                                                ? 'border-4 border-solid border-green-500 bg-green-500/40 ring-4 ring-green-400/60 scale-110 animate-pulse shadow-xl'
                                                : canSwapEmpty
                                                    ? 'border-2 border-dashed border-green-400 bg-green-500/25 ring-4 ring-green-400/50 animate-pulse scale-105'
                                                    : player
                                                        ? `border-2 border-solid shadow-md ${player.is_legendary ? 'border-yellow-400 bg-[#f5f0e0]' : 'border-white/90 bg-[#f5f0e0]'}`
                                                        : isDraftTarget
                                                            ? 'border-2 border-dashed border-red-500 bg-red-500/25 ring-4 ring-red-400/60 animate-bounce scale-110 shadow-lg'
                                                            : isCompatible
                                                                ? 'border-[2px] border-dashed border-red-400 bg-red-500/10 animate-pulse'
                                                                : 'border-yellow-600/50 bg-white/5'
                                        }`}
                                    >
                                        {player ? (
                                            <span className={`font-black text-lg ${isSwapSource ? 'text-gray-900' : canSwapOccupied ? 'text-white' : player.is_legendary ? 'text-[#b8860b]' : 'text-gray-900'}`}>
                                                {jerseyDisplayNum}
                                            </span>
                                        ) : (
                                            <span className="text-white/50 font-bold text-[10px] tracking-wide">{label}</span>
                                        )}
                                    </div>
                                    {/* Name below */}
                                    {player && (
                                        <div className={`mt-0.5 rounded px-1.5 py-px max-w-[64px] ${canSwapOccupied ? 'bg-green-700' : 'bg-black/70'}`}>
                                            <span className="text-white font-black text-[8px] uppercase tracking-wide truncate block text-center">
                                                {player.name.split(' ').pop()}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        {/* Selected Draft Player placement hint */}
                        {selectedDraftPlayer && (
                            <div className="absolute bottom-2 left-0 right-0 text-center z-20">
                                <span className="bg-[#d63a29] text-white text-xs font-black px-4 py-1.5 rounded-full shadow-lg animate-pulse">
                                    Tap a glowing red slot on pitch to place {selectedDraftPlayer.name}
                                </span>
                            </div>
                        )}
                        {/* Swap hint */}
                        {selectedSlot !== null && (
                            <div className="absolute bottom-2 left-0 right-0 text-center">
                                <span className="bg-black/60 text-white text-[10px] font-bold px-3 py-1 rounded-full">
                                    Tap another player to swap
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                {/* ═══ RIGHT COLUMN ═══ */}
                <aside className="w-[300px] flex flex-col gap-3 shrink-0">

                    {/* Wallet bar */}
                    <div className="flex items-center justify-end gap-2 mb-1">
                        {address ? (
                            <div className="flex items-center gap-2 bg-white rounded-full px-3 py-1.5 border border-gray-200 shadow-sm">
                                <div className="w-2 h-2 rounded-full bg-green-500"></div>
                                <span className="text-[11px] font-bold text-gray-700">{username || address.slice(0, 6) + '...' + address.slice(-4)}</span>
                                <span className="text-[10px] font-bold text-gray-400">{parseFloat(balance).toFixed(2)} MON</span>
                            </div>
                        ) : (
                            <button onClick={connect} className="bg-[#115e3b] text-white text-[11px] font-bold px-4 py-1.5 rounded-full hover:bg-[#0e4d31] transition-colors">
                                Connect Wallet
                            </button>
                        )}
                    </div>

                    {/* Tabs */}
                    <div className="flex gap-2">
                        <button
                            className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-colors ${activeTab === 'Top 100' ? 'bg-[#115e3b] text-white shadow' : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'}`}
                            onClick={() => setActiveTab('Top 100')}>
                            Top 100
                        </button>
                        <button
                            className={`flex-1 py-2.5 text-xs font-bold rounded-xl transition-colors ${activeTab === 'Scorecard' ? 'bg-[#115e3b] text-white shadow' : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'}`}
                            onClick={() => setActiveTab('Scorecard')}>
                            Scorecard
                        </button>
                    </div>

                    {/* Content Card */}
                    <div className="flex-1 bg-white rounded-xl shadow-sm border border-gray-200 p-3 flex flex-col overflow-hidden">

                        {activeTab === 'Top 100' && (
                            <>
                                <div className="bg-gray-50 rounded-lg p-0.5 flex mb-3 border border-gray-100">
                                    {['Last 24h', 'All-Time'].map(t => (
                                        <button key={t} onClick={() => setTimeTab(t)}
                                            className={`flex-1 py-1.5 text-[10px] font-bold rounded-md transition-colors ${timeTab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-400 hover:text-gray-600'}`}>
                                            {t}
                                        </button>
                                    ))}
                                </div>

                                <div className="flex justify-between items-center mb-3 px-1">
                                    <span className="text-[9px] font-bold text-gray-400 tracking-wider">UTC reset <span className="text-gray-800 font-black">{utcCountdown}</span></span>
                                    <div className="w-4 h-4 rounded-full border border-gray-300 flex items-center justify-center text-[9px] text-gray-400 font-bold cursor-help">?</div>
                                </div>

                                <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-1">
                                    {leaderboard.length === 0 && (
                                        <div className="text-center text-sm text-gray-400 py-8">No entries yet. Be the first!</div>
                                    )}
                                    {leaderboard.map((lb, i) => (
                                        <div key={i} className="flex items-center gap-2.5 py-1">
                                            <div className={`w-7 h-7 rounded-full flex items-center justify-center font-black text-[11px] shrink-0 ${rankBg(i + 1)}`}>
                                                {i + 1}
                                            </div>
                                            <div className="flex-1 flex flex-col min-w-0">
                                                <span className="text-xs font-black text-gray-900 leading-tight uppercase truncate">{lb.username}</span>
                                                <div className="flex items-center gap-1 mt-0.5">
                                                    <span className="text-[7px] font-bold bg-[#115e3b] text-white rounded px-1 py-px">{lb.won_final ? '7-0' : 'OUT'}</span>
                                                    <span className="text-[7px] font-bold text-gray-400 uppercase tracking-wide">GD {lb.goal_difference} · RATING {Math.round(lb.team_rating)}</span>
                                                </div>
                                            </div>
                                            <span className="text-lg font-black text-[#d63a29] shrink-0">{lb.goal_difference}</span>
                                        </div>
                                    ))}
                                </div>
                            </>
                        )}

                        {activeTab === 'Scorecard' && (
                            <div className="flex flex-col h-full">
                                <div className="flex justify-between items-center mb-4 border-b border-gray-100 pb-3">
                                    <span className="text-[10px] font-bold text-gray-500 tracking-[0.12em] uppercase">Scorecard · {filledCount}/11</span>
                                    <div className="flex items-center gap-2">
                                        <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                                            <div className="h-full bg-[#115e3b] rounded-full transition-all" style={{ width: `${(filledCount / 11) * 100}%` }}></div>
                                        </div>
                                        <span className="text-2xl font-black text-gray-900">{getScore()}</span>
                                    </div>
                                </div>

                                <div className="flex flex-col gap-0.5 flex-1 overflow-y-auto">
                                    {/* Attack */}
                                    <div className="text-[9px] font-bold text-red-500 uppercase tracking-widest mt-1 mb-0.5 flex items-center gap-1">
                                        <div className="w-3 h-1 bg-red-500 rounded-full"></div>Attack —
                                    </div>
                                    {fm.sections.attack.map((pos, i) => {
                                        const player = squad[fm.labels.indexOf(pos) >= 0 ? (() => {
                                            let count = 0;
                                            for (let j = 0; j < fm.labels.length; j++) {
                                                if (fm.labels[j] === pos) {
                                                    if (count === i - fm.sections.attack.indexOf(pos)) return j;
                                                    count++;
                                                }
                                            }
                                            return i;
                                        })() : i];
                                        return (
                                            <div key={`att-${i}`} className="flex items-center border-b border-gray-50 py-1.5 gap-2">
                                                <span className="text-[10px] font-bold text-gray-400 w-7 shrink-0">{pos}</span>
                                                <span className={`text-xs font-bold flex-1 truncate ${player ? 'text-gray-900' : 'text-gray-300'}`}>
                                                    {player ? player.name : '—'}
                                                </span>
                                                {player && <span className="text-[10px] font-black text-gray-600 shrink-0">{player.rating}</span>}
                                            </div>
                                        );
                                    })}
                                    {/* Midfield */}
                                    <div className="text-[9px] font-bold text-gray-900 uppercase tracking-widest mt-2 mb-0.5 flex items-center gap-1">
                                        <div className="w-3 h-1 bg-gray-900 rounded-full"></div>Midfield —
                                    </div>
                                    {fm.sections.midfield.map((pos, i) => {
                                        const slotIdx = fm.sections.attack.length + i;
                                        const player = squad[slotIdx];
                                        return (
                                            <div key={`mid-${i}`} className="flex items-center border-b border-gray-50 py-1.5 gap-2">
                                                <span className="text-[10px] font-bold text-gray-400 w-7 shrink-0">{pos}</span>
                                                <span className={`text-xs font-bold flex-1 truncate ${player ? 'text-gray-900' : 'text-gray-300'}`}>
                                                    {player ? player.name : '—'}
                                                </span>
                                                {player && <span className="text-[10px] font-black text-gray-600 shrink-0">{player.rating}</span>}
                                            </div>
                                        );
                                    })}
                                    {/* Defense */}
                                    <div className="text-[9px] font-bold text-gray-900 uppercase tracking-widest mt-2 mb-0.5 flex items-center gap-1">
                                        <div className="w-3 h-1 bg-gray-900 rounded-full"></div>Defense —
                                    </div>
                                    {fm.sections.defense.map((pos, i) => {
                                        const slotIdx = fm.sections.attack.length + fm.sections.midfield.length + i;
                                        const player = squad[slotIdx];
                                        return (
                                            <div key={`def-${i}`} className="flex items-center border-b border-gray-50 py-1.5 gap-2">
                                                <span className="text-[10px] font-bold text-gray-400 w-7 shrink-0">{pos}</span>
                                                <span className={`text-xs font-bold flex-1 truncate ${player ? 'text-gray-900' : 'text-gray-300'}`}>
                                                    {player ? player.name : '—'}
                                                </span>
                                                {player && <span className="text-[10px] font-black text-gray-600 shrink-0">{player.rating}</span>}
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        )}
                    </div>
                </aside>
            </main>
        </>
    );
}
