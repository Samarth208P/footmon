'use client';

import { WalletProvider } from '../contexts/WalletContext';
import { GameProvider } from '../contexts/GameContext';

export function Providers({ children }) {
    return (
        <WalletProvider>
            <GameProvider>
                {children}
            </GameProvider>
        </WalletProvider>
    );
}
