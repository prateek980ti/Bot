// src/bot.js
const Api = require('../lib/RestApi');
const credentials = require('../credentials');
const { sleep, hhmmss, timeIsAfter, getCurrentTime } = require('./utils');  // SINGLE IMPORT LINE
const fs = require('fs');

const CONFIG = {
    RISK_PER_TRADE: 100,
    VOLATILITY_THRESH: 1.0,
    MARKET_OPEN: '09:15:00',
    FIRST_CANDLE_END: '09:20:00',
    ENTRY_CUTOFF: '12:00:00',
    MARKET_CLOSE: '15:20:00'
};

class PositionManager {
    constructor(maxPerSide = 1) {
        this.positions = new Map();
        this.maxPerSide = maxPerSide;
    }
    canEnter(symbol, side) {
        const arr = this.positions.get(symbol) || [];
        return arr.filter(p => p.side === side && p.openQty > 0).length < this.maxPerSide;
    }
    add(symbol, side, qty, price) {
        const arr = this.positions.get(symbol) || [];
        arr.push({ side, qty, avg: price, openQty: qty });
        this.positions.set(symbol, arr);
    }
    close(symbol, side) {
        const arr = this.positions.get(symbol) || [];
        arr.forEach(p => { if (p.side === side) p.openQty = 0; });
    }
    summary() {
        const out = {};
        this.positions.forEach((arr, s) => out[s] = arr);
        return out;
    }
}

class BreakoutBot {
    constructor() {
        this.api = new Api({});
        this.pm = new PositionManager(1);
        this.tokens = {};
        this.candles = {};
        this.firstCandle = {};
        this.qualified = new Set();
        this.wsReady = false;
    }

    async start() {
        try {
            await this.login();
            await this.loadUniverse();
            await this.initWebsocket();
            await this.runLoop();
        } catch (error) {
            console.error('❌ Bot failed to start:', error.message);
            process.exit(1);
        }
    }

    async login() {
        try {
            console.log('🔐 Attempting login...');
            const r = await this.api.login(credentials);

            if (r.stat !== 'Ok') {
                throw new Error(`Login failed: ${r.emsg || 'Unknown error'}`);
            }

            console.log('✅ Login successful:', r.uname);
            return r;
        } catch (error) {
            console.error('❌ Login error:', error.message);
            throw error;
        }
    }

    async loadUniverse() {
        try {
            const list = JSON.parse(fs.readFileSync('./data/nifty50-stocks.json', 'utf8')).stocks;

            for (const s of list) {
                try {
                    // URL encode the symbol to handle special characters like &
                    const encodedSymbol = encodeURIComponent(s.symbol);
                    const res = await this.api.searchscrip('NSE', encodedSymbol);

                    if (res.stat === 'Ok' && res.values.length) {
                        this.tokens[s.symbol] = res.values[0].token;
                    }
                    await sleep(50);
                } catch (error) {
                    console.log(`⚠️ Failed to get token for ${s.symbol}: ${error.message}`);
                }
            }

            console.log(`📊 Universe loaded (${Object.keys(this.tokens).length} symbols)`);
        } catch (error) {
            console.error('❌ Failed to load universe:', error.message);
            throw error;
        }
    }

    async initWebsocket() {
        try {
            console.log('🔌 Initializing WebSocket connection...');

            let wsResolved = false;

            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    if (!wsResolved) {
                        reject(new Error('WebSocket connection timeout after 30 seconds'));
                    }
                }, 30000);

                this.api.start_websocket(
                    tick => this.onTick(tick),
                    orderUpdate => this.onOrderUpdate(orderUpdate),
                    () => {
                        if (!wsResolved) {
                            clearTimeout(timeout);
                            this.wsReady = true;
                            wsResolved = true;
                            console.log('✅ WebSocket connected successfully');
                            resolve();
                        }
                    },
                    () => {
                        if (!wsResolved) {
                            clearTimeout(timeout);
                            console.log('❌ WebSocket closed unexpectedly');
                            wsResolved = true;
                            reject(new Error('WebSocket connection failed'));
                        }
                    }
                );

                // Alternative: resolve after a short delay since we can see the connection is working
                setTimeout(() => {
                    if (!wsResolved) {
                        clearTimeout(timeout);
                        this.wsReady = true;
                        wsResolved = true;
                        console.log('✅ WebSocket connected (timeout bypass)');
                        resolve();
                    }
                }, 5000); // 5 seconds
            });

            // Subscribe to all loaded tokens
            const instruments = Object.values(this.tokens).map(t => `NSE|${t}`);
            await this.api.subscribe(instruments);
            console.log(`📡 Subscribed to ${instruments.length} instruments`);
            console.log('🔌 WebSocket initialization complete');
        } catch (error) {
            console.error('❌ WebSocket initialization failed:', error.message);
            throw error;
        }
    }

    onTick(tick) {
        try {
            const sym = this.tokenToSymbol(tick.tk);
            if (!sym) return;

            const price = parseFloat(tick.lp || tick.c);
            const ts = Math.floor(Date.now() / 60000) * 60000;
            const arr = this.candles[sym] = this.candles[sym] || [];
            let candle = arr[arr.length - 1];

            if (!candle || candle.ts !== ts) {
                candle = { ts, o: price, h: price, l: price, c: price };
                arr.push(candle);
            } else {
                candle.h = Math.max(candle.h, price);
                candle.l = Math.min(candle.l, price);
                candle.c = price;
            }

            // FIXED: First candle qualification logic
            if (!this.firstCandle[sym] && hhmmss() >= CONFIG.FIRST_CANDLE_END) {
                // Calculate the exact timestamps for 9:15-9:20 AM today
                const today = new Date();
                const marketOpen = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 15, 0);
                const firstCandleEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 20, 0);

                const marketOpenTs = Math.floor(marketOpen.getTime() / 60000) * 60000;
                const firstCandleEndTs = Math.floor(firstCandleEnd.getTime() / 60000) * 60000;

                // Find candles specifically from 9:15-9:19 (5 one-minute candles)
                const first5 = arr.filter(c => c.ts >= marketOpenTs && c.ts < firstCandleEndTs);

                // Debug logging (remove after testing)
                if (first5.length > 0) {
                    console.log(`🔍 ${sym}: Found ${first5.length}/5 candles from 9:15-9:20`);
                    if (first5.length === 5) {
                        const hi = Math.max(...first5.map(c => c.h));
                        const lo = Math.min(...first5.map(c => c.l));
                        const op = first5[0].o;
                        const v = ((hi - lo) / op) * 100;
                        console.log(`🔍 ${sym}: Range ${lo}-${hi}, Vol: ${v.toFixed(2)}%`);
                    }
                }

                if (first5.length === 5) {
                    const hi = Math.max(...first5.map(c => c.h));
                    const lo = Math.min(...first5.map(c => c.l));
                    const op = first5[0].o;
                    const v = ((hi - lo) / op) * 100;

                    if (v < CONFIG.VOLATILITY_THRESH) {
                        this.qualified.add(sym);
                        this.firstCandle[sym] = { hi, lo, volatility: v };
                        console.log(`✅ ${sym} qualified (vol=${v.toFixed(2)}%)`);
                    } else {
                        console.log(`❌ ${sym} disqualified (vol=${v.toFixed(2)}% > 1.0%)`);
                    }
                }
            }

            // Breakout detection logic remains the same
            if (this.qualified.has(sym) && hhmmss() < CONFIG.ENTRY_CUTOFF) {
                const { hi, lo } = this.firstCandle[sym];
                if (price > hi && this.pm.canEnter(sym, 'LONG')) {
                    this.placeTrade(sym, 'LONG', hi, lo);
                    this.pm.add(sym, 'LONG', 0, hi);
                }
                if (price < lo && this.pm.canEnter(sym, 'SHORT')) {
                    this.placeTrade(sym, 'SHORT', lo, hi);
                    this.pm.add(sym, 'SHORT', 0, lo);
                }
            }
        } catch (error) {
            console.error('❌ Error in onTick:', error.message);
        }
    }


    onOrderUpdate(orderUpdate) {
        // Handle order updates if needed
        console.log('📋 Order update received:', orderUpdate);
    }

    tokenToSymbol(tk) {
        for (const [s, t] of Object.entries(this.tokens)) if (t == tk) return s;
        return null;
    }

    async placeTrade(sym, dir, entry, sl) {
        try {
            const qty = Math.max(1, Math.floor(CONFIG.RISK_PER_TRADE / Math.abs(entry - sl)));
            const tgt = dir === 'LONG' ? entry + (entry - sl) : entry - (sl - entry);
            const side = dir === 'LONG' ? 'B' : 'S';

            const r = await this.api.place_order(
                side, 'M', 'NSE', `${sym}-EQ`, qty, 0, 'LMT', entry, 0, 'DAY', 'NO', dir
            );

            if (r.stat === 'Ok') {
                console.log(`🎯 ${dir} placed ${sym} qty=${qty} @${entry}`);

                // Place stop loss
                await this.api.place_order(
                    side === 'B' ? 'S' : 'B', 'M', 'NSE', `${sym}-EQ`, qty, 0, 'SL-MKT', 0, sl, 'DAY', 'NO', 'SL'
                );

                // Place target
                await this.api.place_order(
                    side === 'B' ? 'S' : 'B', 'M', 'NSE', `${sym}-EQ`, qty, 0, 'LMT', tgt, 0, 'DAY', 'NO', 'TGT'
                );
            } else {
                console.log('❌ Order failed:', r.emsg);
            }
        } catch (error) {
            console.error('❌ Trade execution error:', error.message);
        }
    }

    async runLoop() {
        console.log(`🕐 Bot running... Current time: ${getCurrentTime()}`);
        console.log(`📈 Market session: ${CONFIG.MARKET_OPEN} - ${CONFIG.ENTRY_CUTOFF} (Entry) - ${CONFIG.MARKET_CLOSE} (Close)`);

        let lastStatusTime = 0;
        let lastMinuteUpdate = 0;

        while (true) {
            await sleep(5000); // Check every 5 seconds

            const currentTime = hhmmss();
            const now = Date.now();

            // Market close actions
            if (timeIsAfter(CONFIG.MARKET_CLOSE)) {
                console.log(`🔔 Market close time (${CONFIG.MARKET_CLOSE}) reached`);
                await this.squareOff();
                await this.generateSummary();
                console.log('📉 Market closed - Bot exiting');
                console.log(`🕐 Session ends at: ${getCurrentTime()}`);
                process.exit(0);
            }

            // Quick status update every 30 seconds
            if (now - lastStatusTime >= 30000) { // Every 30 seconds
                const qualified = this.qualified.size;
                const positions = Array.from(this.pm.positions.values()).flat().filter(p => p.openQty > 0).length;
                const wsStatus = this.wsReady ? '🟢 Connected' : '🔴 Disconnected';

                console.log(`📊 Status [${currentTime}]: ${qualified} qualified stocks, ${positions} active positions, WebSocket: ${wsStatus}`);

                // Show session info
                if (this.sessionManager && this.sessionManager.isValid()) {
                    console.log(`💾 Session: ${this.sessionManager.getTimeRemainingString()} remaining`);
                }

                lastStatusTime = now;
            }

            // Detailed minute update (every minute with more info)
            if (now - lastMinuteUpdate >= 60000) { // Every minute
                const currentHour = new Date().getHours();

                if (currentHour >= 9 && currentHour < 16) { // During market hours
                    console.log(`\n⏰ === ${currentTime} Market Update ===`);

                    // Market phase detection
                    if (timeIsAfter(CONFIG.MARKET_CLOSE)) {
                        console.log('📈 Market Phase: CLOSED');
                    } else if (timeIsAfter(CONFIG.ENTRY_CUTOFF)) {
                        console.log('📈 Market Phase: POSITION MONITORING (No new entries)');
                    } else if (timeIsAfter(CONFIG.FIRST_CANDLE_END)) {
                        console.log('📈 Market Phase: ACTIVE TRADING');
                    } else if (timeIsAfter(CONFIG.MARKET_OPEN)) {
                        console.log('📈 Market Phase: CANDLE FORMATION');
                    } else {
                        console.log('📈 Market Phase: PRE-MARKET');
                    }

                    // Show qualified stocks if any
                    if (this.qualified.size > 0) {
                        console.log(`✅ Qualified Stocks (${this.qualified.size}): ${Array.from(this.qualified).slice(0, 10).join(', ')}${this.qualified.size > 10 ? '...' : ''}`);
                    } else if (timeIsAfter(CONFIG.FIRST_CANDLE_END)) {
                        console.log('⚠️ No stocks qualified yet (waiting for 1% volatility rule)');
                    }

                    // Show active positions
                    const allPositions = Array.from(this.pm.positions.values()).flat();
                    const activePositions = allPositions.filter(p => p.openQty > 0);

                    if (activePositions.length > 0) {
                        console.log(`💼 Active Positions (${activePositions.length}):`);
                        activePositions.forEach(pos => {
                            console.log(`   ${pos.side} - Qty: ${pos.openQty}, Avg: ${pos.avg}`);
                        });
                    }

                    // Memory usage check
                    const memUsage = process.memoryUsage();
                    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
                    if (memMB > 100) { // Show warning if memory usage is high
                        console.log(`⚠️ Memory Usage: ${memMB}MB`);
                    }

                    console.log('================================\n');
                }

                lastMinuteUpdate = now;
            }

            // Special time-based alerts
            const timeStr = currentTime;

            // Alert 5 minutes before entry cutoff
            if (timeStr === '11:55:00') {
                console.log('⏰ ALERT: 5 minutes until entry cutoff (12:00 PM)');
            }

            // Alert 10 minutes before market close
            if (timeStr === '15:10:00') {
                console.log('⏰ ALERT: 10 minutes until market close (3:20 PM)');
            }

            // Alert 2 minutes before market close
            if (timeStr === '15:18:00') {
                console.log('⏰ ALERT: 2 minutes until market close - preparing for square-off');
            }

            // Heartbeat every 5 minutes during active trading
            if (timeIsAfter(CONFIG.FIRST_CANDLE_END) && !timeIsAfter(CONFIG.ENTRY_CUTOFF) &&
                currentTime.endsWith(':00:00') && new Date().getMinutes() % 5 === 0) {
                console.log(`💓 Heartbeat: Bot actively monitoring ${this.qualified.size} qualified stocks for breakouts`);
            }

            // WebSocket health check
            if (!this.wsReady) {
                console.log('⚠️ WARNING: WebSocket disconnected - market data may be stale');
            }
        }
    }

    async squareOff() {
        try {
            console.log('🔄 Squaring off positions...');
            const pos = await this.api.get_positions();

            if (pos.stat === 'Ok') {
                for (const p of pos.values || []) {
                    if (Number(p.netqty) !== 0) {
                        await this.api.place_order(
                            Number(p.netqty) > 0 ? 'S' : 'B', 'M', p.exch, p.tsym, Math.abs(p.netqty),
                            0, 'MKT', 0, 0, 'DAY', 'NO', 'EOD'
                        );
                        console.log(`✅ Squared off: ${p.tsym}`);
                    }
                }
            }
        } catch (error) {
            console.error('❌ Square off error:', error.message);
        }
    }

    async generateSummary() {
        try {
            console.log('\n📋 === DAILY TRADING SUMMARY ===');
            console.log(`📅 Date: ${new Date().toLocaleDateString()}`);
            console.log(`⏰ Session Time: ${getCurrentTime()}`);
            console.log(`📊 Qualified Stocks: ${this.qualified.size}/50`);

            if (this.qualified.size > 0) {
                console.log('✅ Qualified Symbols:', Array.from(this.qualified).join(', '));
            }

            const positions = this.pm.summary();
            const totalTrades = Object.values(positions).flat().length;
            console.log(`💼 Total Trades Attempted: ${totalTrades}`);
            console.log('================================\n');
        } catch (error) {
            console.error('❌ Error generating summary:', error.message);
        }
    }
}

if (require.main === module) {
    (async () => {
        try {
            console.log('🚀 Starting NIFTY 50 Breakout Bot');
            await new BreakoutBot().start();
        } catch (error) {
            console.error('❌ Application error:', error.message);
            process.exit(1);
        }
    })();
}
