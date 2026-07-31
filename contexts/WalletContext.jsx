'use client';
import React, { createContext, useContext, useState, useEffect } from 'react';
import { BrowserProvider, formatEther } from 'ethers';
import { supabase } from '../lib/supabase';

const WalletContext = createContext();

export function WalletProvider({ children }) {
    const [provider, setProvider] = useState(null);
    const [signer, setSigner] = useState(null);
    const [address, setAddress] = useState(null);
    const [balance, setBalance] = useState('0');
    const [username, setUsername] = useState(null);
    const [isRegistering, setIsRegistering] = useState(false);
    
    const MONAD_CHAIN = {
        chainId: "0x279f", // 10143
        chainName: "Monad Testnet",
        nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
        rpcUrls: ["https://testnet-rpc.monad.xyz/"],
        blockExplorerUrls: ["https://testnet.monadexplorer.com/"]
    };

    useEffect(() => {
        if (typeof window.ethereum !== 'undefined') {
            const handleAccountsChanged = (accounts) => {
                if (accounts.length === 0) {
                    disconnect();
                } else {
                    handleAccountChange(accounts[0]);
                }
            };
            window.ethereum.on('accountsChanged', handleAccountsChanged);
            window.ethereum.on('chainChanged', () => window.location.reload());
            return () => {
                window.ethereum.removeListener('accountsChanged', handleAccountsChanged);
            };
        }
    }, []);

    const handleAccountChange = async (newAddress) => {
        setAddress(newAddress);
        await checkUserRegistration(newAddress);
    };

    const checkUserRegistration = async (walletAddress) => {
        const { data, error } = await supabase
            .from('users')
            .select('username')
            .eq('wallet_address', walletAddress)
            .single();
            
        if (data && data.username) {
            setUsername(data.username);
        } else {
            setUsername(null);
            setIsRegistering(true);
        }
    };

    const registerUser = async (newUsername) => {
        if (!address) return { error: "No wallet connected" };
        const cleanName = newUsername.trim();
        if (!cleanName) return { error: "Username cannot be empty" };

        // Check if username is already taken (case-insensitive)
        const { data: existing } = await supabase
            .from('users')
            .select('username')
            .ilike('username', cleanName)
            .maybeSingle();

        if (existing) {
            return { error: `Username "${cleanName}" is already taken!` };
        }

        const { error } = await supabase
            .from('users')
            .insert([{ wallet_address: address, username: cleanName }]);
            
        if (!error) {
            setUsername(cleanName);
            setIsRegistering(false);
            return { success: true };
        }
        if (error.code === '23505') {
            return { error: `Username "${cleanName}" is already taken!` };
        }
        return { error: error.message };
    };

    const connect = async () => {
        if (typeof window.ethereum === 'undefined') {
            alert('MetaMask not found!');
            return;
        }
        try {
            const newProvider = new BrowserProvider(window.ethereum);
            await newProvider.send("eth_requestAccounts", []);
            
            // Switch to Monad
            try {
                await window.ethereum.request({
                    method: "wallet_switchEthereumChain",
                    params: [{ chainId: MONAD_CHAIN.chainId }],
                });
            } catch (err) {
                if (err.code === 4902 || err.code === -32603) {
                    await window.ethereum.request({
                        method: "wallet_addEthereumChain",
                        params: [MONAD_CHAIN],
                    });
                } else {
                    throw err;
                }
            }

            const newSigner = await newProvider.getSigner();
            const newAddress = await newSigner.getAddress();
            const bal = await newProvider.getBalance(newAddress);
            
            setProvider(newProvider);
            setSigner(newSigner);
            setAddress(newAddress);
            setBalance(formatEther(bal));
            
            await checkUserRegistration(newAddress);
        } catch (error) {
            console.error("Connection error", error);
        }
    };

    const disconnect = () => {
        setProvider(null);
        setSigner(null);
        setAddress(null);
        setUsername(null);
        setBalance('0');
    };

    return (
        <WalletContext.Provider value={{
            provider, signer, address, balance, username, 
            connect, disconnect, isRegistering, registerUser, setIsRegistering
        }}>
            {children}
        </WalletContext.Provider>
    );
}

export function useWallet() {
    return useContext(WalletContext);
}
