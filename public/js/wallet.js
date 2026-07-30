// js/wallet.js — MetaMask + Monad Testnet connection

const WalletManager = (() => {
  let provider = null;
  let signer   = null;
  let address  = null;

  function isMetaMaskAvailable() {
    return typeof window.ethereum !== "undefined";
  }

  async function connect() {
    if (!isMetaMaskAvailable()) {
      throw new Error("MetaMask not found. Please install MetaMask to play.");
    }

    // ethers v6
    provider = new ethers.BrowserProvider(window.ethereum);

    // Request accounts
    await provider.send("eth_requestAccounts", []);

    // Ensure we're on Monad Testnet
    await switchToMonad();

    signer  = await provider.getSigner();
    address = await signer.getAddress();

    // Listen for account/chain changes
    window.ethereum.on("accountsChanged", (accounts) => {
      if (accounts.length === 0) {
        address = null;
        document.dispatchEvent(new CustomEvent("wallet:disconnected"));
      } else {
        address = accounts[0];
        document.dispatchEvent(new CustomEvent("wallet:accountChanged", { detail: address }));
      }
    });

    window.ethereum.on("chainChanged", () => {
      window.location.reload();
    });

    return address;
  }

  async function switchToMonad() {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: MONAD_CHAIN.chainId }],
      });
    } catch (err) {
      if (err.code === 4902 || err.code === -32603) {
        // Chain not added — add it
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [MONAD_CHAIN],
        });
      } else {
        throw err;
      }
    }
  }

  function getAddress()  { return address;  }
  function getSigner()   { return signer;   }
  function getProvider() { return provider; }
  function isConnected() { return !!address; }

  async function getBalance() {
    if (!provider || !address) return "0";
    const bal = await provider.getBalance(address);
    return ethers.formatEther(bal);
  }

  return { connect, switchToMonad, getAddress, getSigner, getProvider, isConnected, getBalance, isMetaMaskAvailable };
})();
