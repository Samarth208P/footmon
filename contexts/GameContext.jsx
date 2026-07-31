'use client';
import React, { createContext, useContext, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useWallet } from './WalletContext';
import { parseEther } from 'ethers';

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;

const GameContext = createContext();

const WC_YEARS = [1970, 1974, 1978, 1982, 1986, 1990, 1994, 1998, 2002, 2006, 2010, 2014, 2018, 2022, 2026];

/* ── Position compatibility mapping ─────────────────────────────────────────
   Maps each slot label to which player positions can fill it.
   Player positions are comma-separated strings like "CB, LB, RB" or "ST, LW". */
const SLOT_ACCEPTS = {
    'GK':  ['GK'],
    'CB':  ['CB', 'LB', 'RB'],
    'LB':  ['LB', 'CB', 'LWB'],
    'RB':  ['RB', 'CB', 'RWB'],
    'LWB': ['LWB', 'LB', 'LM'],
    'RWB': ['RWB', 'RB', 'RM'],
    'CDM': ['CDM', 'CM', 'CB'],
    'CM':  ['CM', 'CDM', 'CAM', 'LM', 'RM'],
    'CAM': ['CAM', 'CM', 'CF', 'ST'],
    'LM':  ['LM', 'LW', 'CM', 'LWB'],
    'RM':  ['RM', 'RW', 'CM', 'RWB'],
    'LW':  ['LW', 'LM', 'ST', 'CF'],
    'RW':  ['RW', 'RM', 'ST', 'CF'],
    'ST':  ['ST', 'CF', 'LW', 'RW', 'CAM'],
    'CF':  ['CF', 'ST', 'CAM', 'LW', 'RW'],
};

/** Get a valid display jersey number for a player */
function getPlayerJerseyNumber(player, slotIndex = 0, slotLabel = '') {
    if (player && player.jersey_number && player.jersey_number > 0) {
        return player.jersey_number;
    }
    const defaults = {
        'GK': 1, 'RB': 2, 'LB': 3, 'CB': 4,
        'CDM': 6, 'RM': 7, 'CM': 8, 'ST': 9,
        'CAM': 10, 'LM': 11, 'LW': 11, 'RW': 7,
        'CF': 9, 'LWB': 3, 'RWB': 2
    };
    return defaults[slotLabel?.toUpperCase()] || (slotIndex + 1);
}

/** Check if a player can fill a given slot label */
function canPlaySlot(player, slotLabel) {
    if (!player || !slotLabel) return false;
    const playerPositions = player.position.split(',').map(p => p.trim().toUpperCase());
    const accepted = SLOT_ACCEPTS[slotLabel.toUpperCase()] || [];
    return playerPositions.some(pp => accepted.includes(pp));
}

export function GameProvider({ children }) {
    const { signer } = useWallet();
    const [formation, setFormation] = useState('4-3-3');
    const [style, setStyle] = useState('balanced');
    const [mode, setMode] = useState('classic');
    const [squad, setSquad] = useState(Array(11).fill(null));
    const [hasFreeRoll, setHasFreeRoll] = useState(true);
    const [currentDraft, setCurrentDraft] = useState(null);
    const [selectedDraftPlayer, setSelectedDraftPlayer] = useState(null);
    const [isRolling, setIsRolling] = useState(false);
    const [selectedSlot, setSelectedSlot] = useState(null); // index of tapped slot for swapping

    // Helpers
    const getRandomYear = (exclude = null) => {
        let years = WC_YEARS;
        if (exclude) years = years.filter(y => y !== exclude);
        return years[Math.floor(Math.random() * years.length)];
    };

    const fetchTeam = async (year, lockNation = null) => {
        const { data, error } = await supabase
            .from('players')
            .select('*')
            .like('team_year', `%${year}`);

        if (error || !data || !data.length) return null;

        const nationsMap = {};
        data.forEach(p => {
            const nationName = p.team_year.replace(` ${year}`, '');
            if (!nationsMap[nationName]) nationsMap[nationName] = [];
            nationsMap[nationName].push(p);
        });

        const availableNations = Object.keys(nationsMap);
        if (availableNations.length === 0) return null;

        let pickedNation = availableNations[Math.floor(Math.random() * availableNations.length)];
        if (lockNation && availableNations.includes(lockNation)) {
            pickedNation = lockNation;
        }

        return {
            year,
            nationName: pickedNation,
            players: nationsMap[pickedNation].sort((a, b) => b.rating - a.rating)
        };
    };

    const roll = async ({ lockYear = null, lockNation = null, isPaid = false } = {}) => {
        // Rerolling specific nation or year requires paid MON transaction
        const requiresPayment = isPaid || lockYear !== null || lockNation !== null;

        if (requiresPayment) {
            if (!CONTRACT_ADDRESS) {
                alert("Contract address not configured!");
                return false;
            }
            if (!signer) {
                alert("Please connect your wallet to pay 0.001 MON for a tactical reroll.");
                return false;
            }
            setIsRolling(true);
            try {
                const tx = await signer.sendTransaction({
                    to: CONTRACT_ADDRESS,
                    value: parseEther('0.001')
                });
                await tx.wait();

                const address = await signer.getAddress();
                await supabase.from('rerolls').insert([{
                    wallet_address: address,
                    amount_paid: 0.001
                }]);
            } catch (err) {
                console.error("Payment failed", err);
                setIsRolling(false);
                alert("Payment cancelled or failed.");
                return false;
            }
        } else {
            setIsRolling(true);
        }

        try {
            let result = null;
            if (lockYear) {
                result = await fetchTeam(lockYear, null);
            } else if (lockNation) {
                const year = getRandomYear();
                result = await fetchTeam(year, lockNation);
                if (!result || result.nationName !== lockNation) {
                    result = await fetchTeam(getRandomYear(), null);
                }
            } else {
                result = await fetchTeam(getRandomYear(), null);
            }

            setCurrentDraft(result);
            setSelectedDraftPlayer(null);
            setHasFreeRoll(false); // Used free roll for this turn
            setIsRolling(false);
            return true;
        } catch (e) {
            console.error(e);
            setIsRolling(false);
            return false;
        }
    };

    /** Select / toggle a player from the drawn list */
    const selectDraftPlayer = (player) => {
        if (selectedDraftPlayer && selectedDraftPlayer.id === player.id) {
            setSelectedDraftPlayer(null);
        } else {
            setSelectedDraftPlayer(player);
        }
    };

    /** Place currently selected draft player into a specific slot */
    const placeDraftPlayerToSlot = (slotIndex, slotLabel) => {
        if (!selectedDraftPlayer) return false;
        if (!canPlaySlot(selectedDraftPlayer, slotLabel)) return false;
        if (squad[slotIndex] !== null) return false;

        const jerseyNum = getPlayerJerseyNumber(selectedDraftPlayer, slotIndex, slotLabel);
        const playerToPlace = { ...selectedDraftPlayer, jersey_number: jerseyNum };

        const newSquad = [...squad];
        newSquad[slotIndex] = playerToPlace;
        setSquad(newSquad);
        setSelectedDraftPlayer(null);
        setCurrentDraft(null);
        setHasFreeRoll(true); // Reset free roll for next player pick!
        return true;
    };

    /** Pick a player into the first compatible empty slot */
    const pickPlayer = (player, formationLabels) => {
        // Prevent duplicate player by name (e.g. Ronaldo 2022 vs Ronaldo 2026)
        if (squad.some(s => s && s.name.trim().toLowerCase() === player.name.trim().toLowerCase())) {
            return false;
        }

        const newSquad = [...squad];
        // Find first empty slot whose label is compatible with the player
        for (let i = 0; i < formationLabels.length; i++) {
            if (newSquad[i] === null && canPlaySlot(player, formationLabels[i])) {
                newSquad[i] = player;
                setSquad(newSquad);
                setCurrentDraft(null);
                setHasFreeRoll(true); // Reset free roll for next player pick!
                return true;
            }
        }
        return false; // No compatible open slot
    };

    /** Pick a player into a specific slot index (direct click on slot) */
    const pickPlayerToSlot = (player, slotIndex, slotLabel) => {
        if (!canPlaySlot(player, slotLabel)) return false;
        if (squad[slotIndex] !== null) return false;
        const newSquad = [...squad];
        newSquad[slotIndex] = player;
        setSquad(newSquad);
        setCurrentDraft(null);
        return true;
    };

    /** Swap two players (or move to empty slot) */
    const swapPlayers = (indexA, indexB, labels) => {
        const playerA = squad[indexA];
        const playerB = squad[indexB];

        // Check compatibility both ways
        if (playerA && !canPlaySlot(playerA, labels[indexB])) return false;
        if (playerB && !canPlaySlot(playerB, labels[indexA])) return false;

        const newSquad = [...squad];
        newSquad[indexA] = playerB;
        newSquad[indexB] = playerA;
        setSquad(newSquad);
        setSelectedSlot(null);
        return true;
    };

    /** Handle slot click for swapping */
    const handleSlotClick = (index, labels) => {
        if (selectedSlot === null) {
            // Select this slot (only if it has a player)
            if (squad[index] !== null) {
                setSelectedSlot(index);
            }
        } else if (selectedSlot === index) {
            // Deselect
            setSelectedSlot(null);
        } else {
            // Try to swap
            const success = swapPlayers(selectedSlot, index, labels);
            if (!success) {
                alert("Can't swap — position incompatible!");
            }
            setSelectedSlot(null);
        }
    };

    const restart = () => {
        setSquad(Array(11).fill(null));
        setHasFreeRoll(true);
        setCurrentDraft(null);
        setSelectedDraftPlayer(null);
        setSelectedSlot(null);
    };

    return (
        <GameContext.Provider value={{
            formation, setFormation,
            style, setStyle,
            mode, setMode,
            squad, pickPlayer, pickPlayerToSlot, swapPlayers, handleSlotClick,
            selectedDraftPlayer, selectDraftPlayer, placeDraftPlayerToSlot,
            hasFreeRoll, setHasFreeRoll,
            currentDraft, roll, isRolling,
            selectedSlot, setSelectedSlot,
            restart,
            canPlaySlot, getPlayerJerseyNumber,
            SLOT_ACCEPTS
        }}>
            {children}
        </GameContext.Provider>
    );
}

export function useGame() {
    return useContext(GameContext);
}
