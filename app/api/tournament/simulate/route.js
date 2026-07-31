import { NextResponse } from 'next/server';
import { supabase } from '../../../../lib/supabase';

export async function POST(request) {
    try {
        const { squad, wallet_address, style = 'balanced', mode = 'classic' } = await request.json();

        if (!squad || !wallet_address) {
            return NextResponse.json({ error: 'Missing squad or wallet_address' }, { status: 400 });
        }

        const validPlayers = squad.filter(p => p !== null);
        if (validPlayers.length !== 11) {
            return NextResponse.json({ error: 'Incomplete squad' }, { status: 400 });
        }

        const teamRating = validPlayers.reduce((sum, p) => sum + p.rating, 0) / 11;

        /* ── Style modifiers ────────────────────────────────────────────────
           Defensive: +5 defense buff, but capped goal scoring (lower GD)
           Balanced:  no modifier
           Attacking: +5 attack buff, but slightly weaker defensively          */
        const styleModifiers = {
            defensive: { atkBonus: -2, defBonus: 5,  gdMultiplier: 0.7 },
            balanced:  { atkBonus: 0,  defBonus: 0,  gdMultiplier: 1.0 },
            attacking: { atkBonus: 5,  defBonus: -3, gdMultiplier: 1.4 }
        };

        /* ── Mode / Difficulty modifiers ────────────────────────────────────
           Classic:  Normal opponent ratings
           Almanac:  Opponents are 5-8 pts stronger per round                 */
        const modeModifiers = {
            classic:  { oppBoost: 0  },
            almanac:  { oppBoost: 6  }
        };

        const sm = styleModifiers[style] || styleModifiers.balanced;
        const mm = modeModifiers[mode] || modeModifiers.classic;

        // Tournament Simulation: 4 rounds
        let wonFinal = true;
        let goalDifference = 0;
        const rounds = ['Round of 16', 'Quarter Final', 'Semi Final', 'Final'];
        const matchResults = [];

        const baseOppRatings = [70, 75, 80, 85];

        for (let i = 0; i < baseOppRatings.length; i++) {
            const oppBase = baseOppRatings[i] + mm.oppBoost + Math.random() * 10;

            // My effective score for this match (attack for scoring, defense for conceding)
            const myAttack  = teamRating + sm.atkBonus + (Math.random() * 10 - 5);
            const myDefense = teamRating + sm.defBonus + (Math.random() * 8 - 4);

            // Opponent scores based on their rating vs my defense
            const oppAttack = oppBase + (Math.random() * 8 - 4);

            // Goals scored is attack vs opp defense (simplified)
            const myGoals  = Math.max(0, Math.round((myAttack - oppBase * 0.85) / 8));
            const oppGoals = Math.max(0, Math.round((oppAttack - myDefense * 0.85) / 8));

            const matchGd = myGoals - oppGoals;

            matchResults.push({
                round: rounds[i],
                myGoals,
                oppGoals,
                oppRating: Math.round(oppBase)
            });

            if (matchGd > 0) {
                goalDifference += Math.ceil(matchGd * sm.gdMultiplier);
            } else if (matchGd < 0) {
                wonFinal = false;
                goalDifference += matchGd; // negative
                break; // Knocked out
            } else {
                // Draw → penalty shootout: slight advantage to higher rated team
                const penaltyWin = (teamRating + sm.defBonus) > oppBase ? Math.random() > 0.35 : Math.random() > 0.55;
                if (penaltyWin) {
                    goalDifference += 1; // Symbolic +1 for penalty win
                    matchResults[matchResults.length - 1].penalties = 'Won';
                } else {
                    wonFinal = false;
                    matchResults[matchResults.length - 1].penalties = 'Lost';
                    break;
                }
            }
        }

        // Save result
        const { data, error } = await supabase
            .from('tournaments')
            .insert([{
                wallet_address,
                team_rating: Math.round(teamRating),
                goal_difference: goalDifference,
                won_final: wonFinal
            }])
            .select()
            .single();

        if (error) {
            console.error('Error saving tournament:', error);
            return NextResponse.json({ error: 'Database error' }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            team_rating: Math.round(teamRating),
            won_final: wonFinal,
            goal_difference: goalDifference,
            matches: matchResults,
            style,
            mode
        });

    } catch (err) {
        console.error('Simulation error:', err);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
