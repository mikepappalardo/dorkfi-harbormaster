#!/usr/bin/env node
/**
 * DorkFi Harbormaster — Auto-Rebalance / Position Harbormaster Microservice
 *
 * Monitors DorkFi positions across Voi and Algorand.
 * When a wallet's health factor drops below a configured floor,
 * Harbormaster can alert via Telegram and/or automatically execute
 * a repayment or collateral add to restore the target HF.
 *
 * Modes:
 *   alert   — Telegram notification only (default, no funds required)
 *   execute — Auto-repay debt using harbormaster wallet funds
 *
 * Setup: cp .env.example .env && fill in values
 *        Edit config.json to add wallets to watch
 *        node harbormaster.mjs
 */

import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env
const envPath = join(__dirname, '.env');
if (existsSync(envPath)) {
  const envFile = readFileSync(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) process.env[key] = val;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_PATH  = join(__dirname, 'state.json');

function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { last_alerts: {}, last_actions: {} };
  return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── DorkFi API ────────────────────────────────────────────────────────────────

const DORKFI_API = 'https://dorkfi-api.nautilus.sh';

async function getHealthFactor(address, chain) {
  const url = `${DORKFI_API}/user-health/user/${address}?network=${chain}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`API ${r.status}: ${url}`);
  const data = await r.json();

  // API returns float directly or object depending on endpoint version
  if (typeof data === 'number') return { hf: data, collateral: null, debt: null };

  const hf = data?.health_factor ?? data?.healthFactor ?? data?.hf ?? null;
  const collateral = data?.collateral_value ?? data?.collateralValue ?? null;
  const debt = data?.borrow_value ?? data?.borrowValue ?? null;

  return { hf: parseFloat(hf), collateral, debt };
}

async function getPosition(address, chain) {
  const url = `${DORKFI_API}/user-health/user/${address}?network=${chain}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  return r.json();
}

async function getMarkets(chain) {
  const url = `${DORKFI_API}/market-data/${chain}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const data = await r.json();
  return Array.isArray(data) ? data : (data.markets ?? []);
}

// ── Telegram ──────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    log(`Telegram error: ${e.message}`);
  }
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function hfEmoji(hf) {
  if (hf === null || isNaN(hf)) return '❓';
  if (hf >= 2.0)  return '✅';
  if (hf >= 1.5)  return '🟢';
  if (hf >= 1.3)  return '🟡';
  if (hf >= 1.1)  return '🟠';
  return '🔴';
}

function hfStatus(hf) {
  if (hf === null || isNaN(hf)) return 'Unknown';
  if (hf >= 2.0)  return 'Healthy';
  if (hf >= 1.5)  return 'Safe';
  if (hf >= 1.3)  return 'Watch';
  if (hf >= 1.1)  return 'Warning';
  if (hf >= 1.0)  return 'Danger';
  return 'Liquidatable';
}

// ── Alert logic ───────────────────────────────────────────────────────────────

function shouldAlert(wallet, chain, state, cooldownMinutes) {
  const key = `${wallet.address}:${chain}`;
  const lastAlert = state.last_alerts[key];
  if (!lastAlert) return true;
  const elapsed = (Date.now() - lastAlert) / 1000 / 60;
  return elapsed >= cooldownMinutes;
}

async function fireAlert(wallet, chain, hf, collateral, debt, state) {
  const key = `${wallet.address}:${chain}`;
  const label = wallet.label || wallet.address.slice(0, 8) + '...';
  const shortAddr = wallet.address.slice(0, 8) + '...' + wallet.address.slice(-4);

  const collateralStr = collateral ? `$${parseFloat(collateral).toFixed(2)}` : 'N/A';
  const debtStr = debt ? `$${parseFloat(debt).toFixed(2)}` : 'N/A';

  const msg = [
    `${hfEmoji(hf)} *DorkFi Harbormaster Alert*`,
    ``,
    `*Wallet:* ${label} (\`${shortAddr}\`)`,
    `*Chain:* ${chain.charAt(0).toUpperCase() + chain.slice(1)}`,
    `*Health Factor:* ${hf?.toFixed(4) ?? 'N/A'} — ${hfStatus(hf)}`,
    `*Floor:* ${wallet.hf_floor} | *Target:* ${wallet.hf_target}`,
    `*Collateral:* ${collateralStr} | *Debt:* ${debtStr}`,
    ``,
    `Position is below your configured floor of ${wallet.hf_floor}.`,
    wallet.action === 'execute'
      ? `Harbormaster is attempting automatic rebalance.`
      : `Manual action required: repay debt or add collateral.`,
    ``,
    `[View Position](https://app.dork.fi/portfolio)`,
  ].join('\n');

  await sendTelegram(msg);
  state.last_alerts[key] = Date.now();
  log(`  Alert fired for ${label} on ${chain} (HF: ${hf?.toFixed(4)})`);
}

// ── Execute: auto-repay ───────────────────────────────────────────────────────

async function executeRebalance(wallet, chain, hf, position) {
  // Only supported in execute mode with a harbormaster mnemonic
  const mnemonic = process.env.GUARDIAN_MNEMONIC;
  if (!mnemonic) {
    log(`  Execute mode requires GUARDIAN_MNEMONIC in .env`);
    return false;
  }

  try {
    const algosdk = (await import('algosdk')).default;

    // Derive harbormaster account
    const account = algosdk.mnemonicToSecretKey(mnemonic);

    log(`  Harbormaster wallet: ${account.addr}`);

    // Get markets to find best repay candidate
    const markets = await getMarkets(chain);
    if (!markets.length) {
      log(`  No markets found for ${chain}`);
      return false;
    }

    // Find the borrowed asset with highest USD value to repay first
    // Position data structure varies — look for borrow_value fields
    const borrows = position?.borrows ?? position?.borrowed_markets ?? [];

    if (!borrows.length) {
      log(`  No borrow positions found to repay`);
      return false;
    }

    // Sort borrows by USD value descending
    const sorted = [...borrows].sort((a, b) => {
      const aVal = parseFloat(a.borrow_value_usd ?? a.value_usd ?? 0);
      const bVal = parseFloat(b.borrow_value_usd ?? b.value_usd ?? 0);
      return bVal - aVal;
    });

    const topBorrow = sorted[0];
    const symbol = topBorrow.symbol ?? topBorrow.asset ?? 'Unknown';
    const borrowValueUsd = parseFloat(topBorrow.borrow_value_usd ?? topBorrow.value_usd ?? 0);

    log(`  Top borrow: ${symbol} ($${borrowValueUsd.toFixed(2)})`);

    // Calculate repay amount to restore target HF
    // ΔRepay ≈ (currentDebt - collateral × threshold / targetHF)
    // Simplified: repay 10% of top borrow to nudge HF upward
    const repayPct = Math.min(0.25, (wallet.hf_target - hf) / hf);
    log(`  Repay ${(repayPct * 100).toFixed(1)}% of ${symbol} position to target HF ${wallet.hf_target}`);

    // Build repay transaction via DorkFi API
    const pool_id = chain === 'voi' ? 47139778 : 3333688282;
    const txnResp = await fetch(`${DORKFI_API}/build-txn/repay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain,
        pool_id,
        symbol,
        amount_pct: repayPct,
        sender: account.addr,
        borrower: wallet.address,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!txnResp.ok) {
      log(`  Repay tx build failed: ${txnResp.status}`);
      // Fall back to alert-only
      return false;
    }

    const { transactions } = await txnResp.json();

    // Sign and send
    const algodClient = new algosdk.Algodv2(
      process.env.ALGOD_TOKEN || '',
      process.env.ALGOD_SERVER || 'https://mainnet-api.voi.nodely.dev',
      process.env.ALGOD_PORT || 443
    );

    const signedTxns = transactions.map(txnB64 => {
      const txn = algosdk.decodeUnsignedTransaction(Buffer.from(txnB64, 'base64'));
      return txn.signTxn(account.sk);
    });

    const result = await algodClient.sendRawTransaction(signedTxns).do();
    log(`  Rebalance tx submitted: ${result.txid}`);

    await sendTelegram(
      `✅ *DorkFi Harbormaster — Rebalanced*\n\nWallet: \`${wallet.address.slice(0, 8)}...\`\nRepaid ${(repayPct * 100).toFixed(1)}% of ${symbol} position\nTx: \`${result.txid}\``
    );

    return true;
  } catch (e) {
    log(`  Execute error: ${e.message}`);
    return false;
  }
}

// ── Main cycle ────────────────────────────────────────────────────────────────

async function runCycle(config, state) {
  for (const wallet of config.wallets) {
    const chains = wallet.chains ?? ['voi', 'algorand'];

    for (const chain of chains) {
      try {
        const { hf, collateral, debt } = await getHealthFactor(wallet.address, chain);

        const label = wallet.label || wallet.address.slice(0, 8) + '...';
        log(`${hfEmoji(hf)} ${label} [${chain}] HF: ${hf?.toFixed(4) ?? 'N/A'} — ${hfStatus(hf)}`);

        if (hf === null || isNaN(hf)) continue;

        // Below floor — action required
        if (hf < wallet.hf_floor) {
          const cooldown = config.alert_cooldown_minutes ?? 30;
          const canAlert = shouldAlert(wallet, chain, state, cooldown);

          if (canAlert && wallet.notify !== false) {
            const position = await getPosition(wallet.address, chain);
            await fireAlert(wallet, chain, hf, collateral, debt, state);

            const mode = wallet.action ?? process.env.MODE ?? 'alert';
            if (mode === 'execute') {
              await executeRebalance(wallet, chain, hf, position);
              const key = `${wallet.address}:${chain}`;
              state.last_actions[key] = Date.now();
            }
          } else {
            log(`  Alert suppressed (cooldown active)`);
          }
        }

        // Approaching floor — early warning at 110% of floor
        const earlyWarnThreshold = wallet.hf_floor * 1.1;
        if (hf >= wallet.hf_floor && hf < earlyWarnThreshold) {
          log(`  ⚠️  Approaching floor (${wallet.hf_floor}) — current: ${hf?.toFixed(4)}`);
        }

      } catch (e) {
        log(`  Error checking ${wallet.address} on ${chain}: ${e.message}`);
      }
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  log('DorkFi Harbormaster starting...');

  const config = loadConfig();
  log(`Watching ${config.wallets.length} wallet(s) | Poll: ${config.poll_interval_seconds}s`);
  log(`Mode: ${process.env.MODE || 'alert'}`);

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    log('Note: TELEGRAM_BOT_TOKEN not set — alerts will log to console only');
  }

  const state = loadState();

  // Run immediately on start
  await runCycle(config, state);
  saveState(state);

  // Then on interval
  setInterval(async () => {
    try {
      const freshConfig = loadConfig(); // reload config each cycle (live updates)
      await runCycle(freshConfig, state);
      saveState(state);
    } catch (e) {
      log(`Cycle error: ${e.message}`);
    }
  }, (config.poll_interval_seconds ?? 60) * 1000);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
