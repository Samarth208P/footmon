import { NextResponse } from 'next/server';
import { supabase } from '../../../../lib/supabase';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';

export async function GET(request) {
    // Only allow cron to trigger this (e.g. via Vercel Cron or secure token)
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // 1. Get the top ranker of the day (highest rating who won final)
        const today = new Date();
        today.setHours(0, 0, 0, 0); // Start of today

        const { data: topPlayers, error } = await supabase
            .from('tournaments')
            .select('wallet_address, team_rating, goal_difference')
            .gte('created_at', today.toISOString())
            .eq('won_final', true)
            .order('team_rating', { ascending: false })
            .order('goal_difference', { ascending: false })
            .limit(1);

        if (error || !topPlayers || topPlayers.length === 0) {
            return NextResponse.json({ message: 'No winners today' });
        }

        const winnerAddress = topPlayers[0].wallet_address;

        // 2. Calculate daily earnings from rerolls
        const { data: rerolls, error: rerollError } = await supabase
            .from('rerolls')
            .select('amount_paid')
            .gte('created_at', today.toISOString());

        let totalEarned = 0;
        if (!rerollError && rerolls) {
            totalEarned = rerolls.reduce((sum, r) => sum + Number(r.amount_paid), 0);
        }

        if (totalEarned <= 0) {
            return NextResponse.json({ message: 'No earnings today to distribute' });
        }

        const prizeAmount = totalEarned * 0.5; // 50% of earnings

        // 3. Send MON to winner using owner wallet
        const privateKey = process.env.OWNER_PRIVATE_KEY;
        if (!privateKey) throw new Error("OWNER_PRIVATE_KEY not set");

        const provider = new JsonRpcProvider('https://testnet-rpc.monad.xyz/');
        const wallet = new Wallet(privateKey, provider);

        const tx = await wallet.sendTransaction({
            to: winnerAddress,
            value: parseEther(prizeAmount.toString())
        });

        await tx.wait();

        return NextResponse.json({
            success: true,
            winner: winnerAddress,
            prize_amount: prizeAmount,
            tx_hash: tx.hash
        });

    } catch (err) {
        console.error('Payout error:', err);
        return NextResponse.json({ error: 'Internal Server Error', details: err.message }, { status: 500 });
    }
}
