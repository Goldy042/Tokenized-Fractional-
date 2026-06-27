import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Networks, nativeToScVal } from '@stellar/stellar-sdk';

import Header from './components/Header/Header';
import Navbar from './components/Navbar/Navbar';
import Card from './components/Card/Card';
import Alert from './components/Alert/Alert';
import Skeleton from './components/Skeleton/Skeleton';
import AssetGrid from './components/AssetGrid/AssetGrid';
import AdminPage from './components/AdminPage/AdminPage';
import PortfolioPage from './components/PortfolioPage/PortfolioPage';
import BuyShares from './components/BuyShares/BuyShares';
import ToastContainer from './components/Toast/Toast';
import styles from './App.module.css';

import { useWalletStore } from './store/useWalletStore';
import { useAssetStore } from './store/useAssetStore';
import { useToastStore } from './store/useToastStore';
import { useSorobanRead, useSorobanWrite } from './hooks/useSoroban';
import useTransactionStatus from './hooks/useTransactionStatus';

const CONTRACT_ID = import.meta.env.VITE_CONTRACT_ID || 'C...';
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET;
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function App() {
  // ── Global store state ─────────────────────────────────────────────────────
  const {
    publicKey,
    isConnecting,
    walletError,
    shares,
    connect,
    disconnect,
    checkConnection,
    setShares,
    clearWalletError,
  } = useWalletStore();

  const {
    assetMeta,
    isFetchingMeta,
    assets,
    isFetchingAssets,
    assetsError,
    fetchMetadata,
    fetchAllAssets,
    clearMeta,
    clearAssets,
  } = useAssetStore();

  // ── Local UI state (not global — scoped to this component) ────────────────
  const [lastTxHash, setLastTxHash] = useState(null);
  const addToast = useToastStore((s) => s.addToast);
  const removeToast = useToastStore((s) => s.removeToast);
  const txStatus = useTransactionStatus(lastTxHash);
  const pendingToastRef = useRef(null);
  const notifiedRef = useRef({});

  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('theme') || 'dark';
  });

  // View state: 'marketplace' | 'portfolio' | 'admin'
  const [view, setView] = useState('marketplace');

  // ── Theme ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  // ── Poll transaction status and update toasts ──────────────────────────────
  useEffect(() => {
    if (!lastTxHash || notifiedRef.current[lastTxHash]) return;

    if (txStatus === 'confirmed') {
      notifiedRef.current[lastTxHash] = true;
      if (pendingToastRef.current) {
        removeToast(pendingToastRef.current);
        pendingToastRef.current = null;
      }
      addToast({ message: 'Transaction confirmed', type: 'success', txHash: lastTxHash });
      fetchShares();
    } else if (txStatus === 'failed') {
      notifiedRef.current[lastTxHash] = true;
      if (pendingToastRef.current) {
        removeToast(pendingToastRef.current);
        pendingToastRef.current = null;
      }
      addToast({ message: 'Transaction failed', type: 'error', txHash: lastTxHash });
    }
  }, [lastTxHash, txStatus]);

  // ── On mount: re-validate Freighter session ────────────────────────────────
  useEffect(() => {
    checkConnection();
  }, [checkConnection]);

  // Construct arguments dynamically
  const fetchSharesArgs = useMemo(() => {
    if (!publicKey) return [];
    try {
      return [nativeToScVal(publicKey, { type: 'address' })];
    } catch (e) {
      console.error('Failed to construct address ScVal:', e);
      return [];
    }
  }, [publicKey]);

  // Hook for get_shares
  const {
    loading: loadingShares,
    refetch: fetchShares,
  } = useSorobanRead('get_shares', fetchSharesArgs, {
    skip: !publicKey || CONTRACT_ID.length < 50,
    onSuccess: (result) => {
      if (result && result.retval) {
        setShares(Number(result.retval.u32()));
      }
    },
    onError: (err) => {
      console.error('Error fetching shares:', err);
      addToast({ message: 'Failed to fetch share balance.', type: 'error' });
    },
  });

  const buySharesTx = useSorobanWrite('buy_shares');
  const loadingBuy = buySharesTx.loading;

  // ── Fetch chain data whenever wallet connects ──────────────────────────────
  useEffect(() => {
    if (publicKey) {
      fetchMetadata(CONTRACT_ID, API_URL);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey]);

  // ── Fetch all assets on mount ──────────────────────────────────────────────
  useEffect(() => {
    fetchAllAssets(API_URL);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Wallet actions ─────────────────────────────────────────────────────────
  const connectWallet = async () => {
    clearWalletError();
    await connect();
  };

  const disconnectWallet = () => {
    disconnect();
    clearMeta();
    clearAssets();
  };

  // ── Transactions ───────────────────────────────────────────────────────────
  const handleBuyShares = async (buyAmount) => {
    if (!publicKey) return;
    if (buyAmount < 1) {
      addToast({ message: 'Must buy at least 1 share', type: 'error' });
      return;
    }

    setLastTxHash(null);

    try {
      const scValBuyer = nativeToScVal(publicKey, { type: 'address' });
      const scValShares = nativeToScVal(buyAmount, { type: 'u32' });

      const submitRes = await buySharesTx.execute([scValBuyer, scValShares]);

      const hash = submitRes.hash;
      setLastTxHash(hash);
      pendingToastRef.current = addToast({
        message: 'Transaction submitted, waiting for confirmation…',
        type: 'pending',
        txHash: hash,
      });
    } catch (err) {
      console.error('Error buying shares:', err);
      let msg = 'Transaction failed. Check your token balance and try again.';
      if (err.message?.includes('paused')) {
        msg = 'Marketplace is currently paused. Try again later.';
      } else if (err.message?.includes('Not enough shares')) {
        msg = 'Not enough shares available.';
      }
      addToast({ message: msg, type: 'error' });
    }
  };

  const isTestnet = NETWORK_PASSPHRASE === Networks.TESTNET;

  return (
    <div className={styles.container}>
      <Header
        publicKey={publicKey}
        isConnecting={isConnecting}
        isTestnet={isTestnet}
        theme={theme}
        onConnect={connectWallet}
        onDisconnect={disconnectWallet}
        onToggleTheme={toggleTheme}
      />

      <Navbar
        activeView={view}
        onNavigate={setView}
      />

      {view === 'portfolio' ? (
        <PortfolioPage />
      ) : view === 'admin' ? (
        <AdminPage
          publicKey={publicKey}
          onDisconnect={() => setView('marketplace')}
        />
      ) : (
        <>
      {/* Wallet errors (connection issues) */}
      {walletError && (
        <Alert variant="error">
          {walletError}
        </Alert>
      )}

      <ToastContainer />

      {/* Contract not configured */}
      {CONTRACT_ID === 'C...' && (
        <Alert variant="warning">
          Set VITE_CONTRACT_ID in frontend/.env to connect to a deployed contract.
        </Alert>
      )}

      {/* ── Asset Metadata Card ─────────────────────────────────────────── */}
      {isFetchingMeta ? (
        <Card>
          <div className={styles.assetImageWrapper}>
            <Skeleton variant="rect" height="100%" style={{ borderRadius: 'var(--radius-sm)' }} />
          </div>
          <Skeleton variant="text" height="1.4em" width="55%" style={{ marginBottom: 'var(--spacing-xs)' }} />
          <Skeleton variant="text" height="1em" width="35%" style={{ marginBottom: 'var(--spacing-sm)' }} />
          <Skeleton variant="text" lines={3} style={{ marginBottom: 'var(--spacing-md)' }} />
          <Skeleton variant="text" height="1.1em" width="40%" />
        </Card>
      ) : assetMeta ? (
        <Card hoverable>
          {assetMeta.imageUrl && (
            <div className={styles.assetImageWrapper}>
              <img src={assetMeta.imageUrl} alt={assetMeta.title} className={styles.assetImage} />
            </div>
          )}
          <h2 className={styles.assetTitle}>{assetMeta.title}</h2>
          <p className={styles.assetLocation}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.svgIcon}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
            {assetMeta.location}
          </p>
          <p className={styles.assetDescription}>{assetMeta.description}</p>
          {assetMeta.totalValuation && (
            <div className={styles.assetValuation}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={styles.svgIcon}><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
              <span>Valuation: {assetMeta.totalValuation}</span>
            </div>
          )}
        </Card>
      ) : null}

      {/* ── Asset Listing Grid ─────────────────────────────────────────── */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Available Assets</h2>
        <AssetGrid
          assets={assets}
          loading={isFetchingAssets}
          error={assetsError}
          isEmpty={!isFetchingAssets && !assetsError && assets.length === 0}
        />
      </section>

      {/* ── Holdings + Buy Card ─────────────────────────────────────────── */}
      {publicKey && (
        <BuyShares
          shares={shares}
          loadingShares={loadingShares}
          loadingBuy={loadingBuy}
          onBuy={handleBuyShares}
        />
      )}
        </>
      )}
    </div>
  );
}

export default App;
