const Api = require('../lib/RestApi');
const credentials = require('../credentials');
const { sleep, hhmmss, timeIsAfter, getCurrentTime } = require('./utils');
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
        this.tickCount = 0;
        this.debugMode = true; // Enable extensive debugging
    }

    async start() {
        try {
            await this.login();
            await this.checkMarketDataPermissions();
            await this.loadUniverse();
            await this.initWebsocket();
            await this.testWebSocketData();
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

    async checkMarketDataPermissions() {
        try {
            console.log('🔍 Checking market data permissions...');
            
            // Get user details
            const userDetails = await this.api.get_userdetails();
            console.log('👤 User Details:', JSON.stringify(userDetails, null, 2));
            
            // Check enabled exchanges
            if (userDetails.exarr) {
                console.log('✅ Enabled Exchanges:', userDetails.exarr);
                
                // Check if NSE is enabled
                const nseEnabled = userDetails.exarr.some(ex => ex.includes('NSE'));
                if (nseEnabled) {
                    console.log('✅ NSE market data access confirmed');
                } else {
                    console.log('⚠️ NSE access not found in enabled exchanges');
                }
            }
            
            // Try to get a test quote for RELIANCE
            try {
                const testQuote = await this.api.get_quotes('NSE', '2885');
                console.log('📈 Test Quote (RELIANCE):', JSON.stringify(testQuote, null, 2));
                if (testQuote.stat === 'Ok') {
                    console.log('✅ Market data API working - can fetch quotes');
                } else {
                    console.log('❌ Market data API issue:', testQuote.emsg);
                }
            } catch (quoteError) {
                console.log('❌ Quote test failed:', quoteError.message);
            }
            
        } catch (error) {
            console.error('❌ Permission check failed:', error.message);
        }
    }

    async loadUniverse() {
        try {
            console.log('🔍 Loading NIFTY 50 universe...');
            const list = JSON.parse(fs.readFileSync('./data/nifty50-stocks.json', 'utf8')).stocks;
            
            for (const s of list) {
                try {
                    const encodedSymbol = encodeURIComponent(s.symbol);
                    const res = await this.api.searchscrip('NSE', encodedSymbol);
                    
                    // Debug: Log search response for first few symbols
                    if (Object.keys(this.tokens).length < 3) {
                        console.log(`🔍 Search result for ${s.symbol}:`, JSON.stringify(res, null, 2));
                    }
                    
                    if (res.stat === 'Ok' && res.values && res.values.length > 0) {
                        this.tokens[s.symbol] = res.values[0].token; // ✅ FIXED
                        if (this.debugMode && Object.keys(this.tokens).length <= 5) {
                            console.log(`✅ Token for ${s.symbol}: ${res.values[0].token}`);
                        }
                    } else {
                        console.log(`❌ No token found for ${s.symbol}:`, res.emsg || 'No values returned');
                    }
                    await sleep(50);
                } catch (error) {
                    console.log(`⚠️ Failed to get token for ${s.symbol}: ${error.message}`);
                }
            }
            
            console.log(`📊 Universe loaded (${Object.keys(this.tokens).length} symbols)`);
            
            // Debug: Show sample tokens
            const sampleTokens = Object.entries(this.tokens).slice(0, 5);
            console.log('🔍 Sample tokens:', sampleTokens);
            
            if (Object.keys(this.tokens).length === 0) {
                throw new Error('No tokens loaded - check symbol search or API permissions');
            }
            
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
                        } else {
                            console.log('🔌 WebSocket connection closed');
                            this.wsReady = false;
                        }
                    }
                );
                
                // Timeout bypass
                setTimeout(() => {
                    if (!wsResolved) {
                        clearTimeout(timeout);
                        this.wsReady = true;
                        wsResolved = true;
                        console.log('✅ WebSocket connected (timeout bypass)');
                        resolve();
                    }
                }, 5000);
            });
            
            // Subscribe to all instruments
            const instruments = Object.values(this.tokens).map(t => `NSE|${t}`);
            console.log(`🔍 Subscribing to ${instruments.length} instruments...`);
            console.log('🔍 Sample instruments:', instruments.slice(0, 3));
            
            await this.api.subscribe(instruments);
            console.log(`📡 Subscribed to ${instruments.length} instruments`);
            console.log('🔌 WebSocket initialization complete');
            
        } catch (error) {
            console.error('❌ WebSocket initialization failed:', error.message);
            throw error;
        }
    }

    async testWebSocketData() {
        console.log('🧪 Testing WebSocket data reception...');
        console.log('⏳ Waiting 30 seconds to check for incoming ticks...');
        
        const initialTickCount = this.tickCount;
        
        setTimeout(() => {
            const ticksReceived = this.tickCount - initialTickCount;
            console.log(`📊 Ticks received in last 30 seconds: ${ticksReceived}`);
            
            if (ticksReceived === 0) {
                console.log('❌ No ticks received - possible issues:');
                console.log('   1. Market data permission not enabled');
                console.log('   2. WebSocket subscription failed');
                console.log('   3. Market is closed or no trading activity');
                console.log('   4. Token/symbol mapping incorrect');
            } else {
                console.log('✅ WebSocket receiving data properly');
                this.debugMode = false; // Turn off verbose debugging
            }
        }, 30000);
    }

    onTick(tick) {
        try {
            this.tickCount++;
            
            // Debug: Show first 50 ticks completely to diagnose issues
            if (this.debugMode && this.tickCount <= 50) {
                console.log(`🔍 RAW TICK #${this.tickCount}:`, JSON.stringify(tick, null, 2));
            }
            
            const sym = this.tokenToSymbol(tick.tk);
            if (!sym) {
                if (this.debugMode && this.tickCount <= 20) {
                    console.log(`❓ Unknown token: ${tick.tk}`);
                }
                return;
            }

            // Standard tick processing
            if (this.debugMode && this.tickCount <= 100) {
                console.log(`🔍 TICK: ${sym} @ ${parseFloat(tick.lp || tick.c)} at ${new Date().toLocaleTimeString()}`);
            } else if (Math.random() < 0.001) {
                console.log(`🔍 TICK: ${sym} @ ${parseFloat(tick.lp || tick.c)} at ${new Date().toLocaleTimeString()}`);
            }
            
            // Show tick count every 1000 ticks
            if (this.tickCount % 1000 === 0) {
                console.log(`📊 Received ${this.tickCount} ticks so far`);
            }

            const price = parseFloat(tick.lp || tick.c);
            const ts = Math.floor(Date.now() / 60000) * 60000;
            const arr = this.candles[sym] = this.candles[sym] || [];
            let candle = arr[arr.length - 1];

            if (!candle || candle.ts !== ts) {
                candle = { ts, o: price, h: price, l: price, c: price };
                arr.push(candle);
                
                // Debug: Show candle creation for first few
                if (this.debugMode && arr.length <= 5) {
                    console.log(`📊 New candle for ${sym}: ${new Date(ts).toLocaleTimeString()}, O=${price}`);
                }
            } else {
                candle.h = Math.max(candle.h, price);
                candle.l = Math.min(candle.l, price);
                candle.c = price;
            }

            // First candle qualification logic
            if (!this.firstCandle[sym] && hhmmss() >= CONFIG.FIRST_CANDLE_END) {
                const today = new Date();
                const marketOpen = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 15, 0);
                const firstCandleEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 20, 0);
                const marketOpenTs = Math.floor(marketOpen.getTime() / 60000) * 60000;
                const firstCandleEndTs = Math.floor(firstCandleEnd.getTime() / 60000) * 60000;
                const first5 = arr.filter(c => c.ts >= marketOpenTs && c.ts < firstCandleEndTs);

                // Debug qualification attempts
                if (first5.length > 0 && (this.debugMode || Math.random() < 0.01)) {
                    console.log(`🔍 ${sym}: Found ${first5.length}/5 candles for 9:15-9:20 qualification`);
                    if (first5.length > 0) {
                        console.log(`🔍 ${sym}: Candle times: ${first5.map(c => new Date(c.ts).toLocaleTimeString()).join(', ')}`);
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
                        console.log(`✅ ${sym} qualified (vol=${v.toFixed(2)}%, range=${lo}-${hi})`);
                    } else {
                        console.log(`❌ ${sym} disqualified (vol=${v.toFixed(2)}% > ${CONFIG.VOLATILITY_THRESH}%)`);
                    }
                }
            }

            // Breakout detection
            if (this.qualified.has(sym) && hhmmss() < CONFIG.ENTRY_CUTOFF) {
                const { hi, lo } = this.firstCandle[sym];
                if (price > hi && this.pm.canEnter(sym, 'LONG')) {
                    console.log(`🚀 BREAKOUT detected: ${sym} @ ${price} (above ${hi})`);
                    this.placeTrade(sym, 'LONG', hi, lo);
                    this.pm.add(sym, 'LONG', 0, hi);
                }
                if (price < lo && this.pm.canEnter(sym, 'SHORT')) {
                    console.log(`📉 BREAKDOWN detected: ${sym} @ ${price} (below ${lo})`);
                    this.placeTrade(sym, 'SHORT', lo, hi);
                    this.pm.add(sym, 'SHORT', 0, lo);
                }
            }
        } catch (error) {
            console.error('❌ Error in onTick:', error.message);
            console.error('❌ Tick data:', tick);
        }
    }

    debugCandleData() {
        console.log('\n🔍 === CANDLE DEBUG ===');
        const symbolsToCheck = Object.keys(this.tokens).slice(0, 5);
        
        symbolsToCheck.forEach(sym => {
            const candles = this.candles[sym] || [];
            console.log(`${sym}: ${candles.length} candles total`);
            
            if (candles.length > 0) {
                // Show first few candles
                candles.slice(0, 3).forEach((c, i) => {
                    console.log(`  [${i+1}] ${new Date(c.ts).toLocaleTimeString()}: O=${c.o}, H=${c.h}, L=${c.l}, C=${c.c}`);
                });
                
                // Show recent candles
                if (candles.length > 3) {
                    console.log(`  ... (${candles.length - 3} more candles)`);
                    const recent = candles.slice(-2);
                    recent.forEach((c, i) => {
                        console.log(`  [${candles.length - 2 + i + 1}] ${new Date(c.ts).toLocaleTimeString()}: O=${c.o}, H=${c.h}, L=${c.l}, C=${c.c}`);
                    });
                }
            }
            
            // Check 9:15-9:20 window specifically
            const today = new Date();
            const marketOpen = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 15, 0);
            const firstCandleEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 20, 0);
            const marketOpenTs = Math.floor(marketOpen.getTime() / 60000) * 60000;
            const firstCandleEndTs = Math.floor(firstCandleEnd.getTime() / 60000) * 60000;
            const first5 = candles.filter(c => c.ts >= marketOpenTs && c.ts < firstCandleEndTs);
            
            console.log(`  First 5-min candles (9:15-9:20): ${first5.length}/5`);
            console.log(`  Expected window: ${marketOpen.toLocaleTimeString()} - ${firstCandleEnd.toLocaleTimeString()}`);
            
            if (first5.length > 0) {
                const hi = Math.max(...first5.map(c => c.h));
                const lo = Math.min(...first5.map(c => c.l));
                const op = first5[0].o;
                const v = ((hi - lo) / op) * 100;
                console.log(`  Range: ${lo} - ${hi}, Volatility: ${v.toFixed(2)}%`);
            }
        });
        console.log('=====================\n');
    }

    onOrderUpdate(orderUpdate) {
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

            console.log(`🎯 Placing ${dir} trade for ${sym}: Entry: ${entry}, Stop: ${sl}, Target: ${tgt.toFixed(2)}, Qty: ${qty}`);

            const r = await this.api.place_order(
                side, 'M', 'NSE', `${sym}-EQ`, qty, 0, 'LMT', entry, 0, 'DAY', 'NO', dir
            );
            
            if (r.stat === 'Ok') {
                console.log(`🎯 ${dir} order placed for ${sym} qty=${qty} @${entry}`);
                
                // Place stop loss
                await this.api.place_order(
                    side === 'B' ? 'S' : 'B', 'M', 'NSE', `${sym}-EQ`, qty, 0, 'SL-MKT', 0, sl, 'DAY', 'NO', 'SL'
                );
                
                // Place target
                await this.api.place_order(
                    side === 'B' ? 'S' : 'B', 'M', 'NSE', `${sym}-EQ`, qty, 0, 'LMT', tgt, 0, 'DAY', 'NO', 'TGT'
                );
                
                console.log(`✅ Complete trade setup for ${sym}: Entry + Stop Loss + Target orders placed`);
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
            await sleep(5000);
            const currentTime = hhmmss();
            const now = Date.now();

            if (timeIsAfter(CONFIG.MARKET_CLOSE)) {
                console.log(`🔔 Market close time (${CONFIG.MARKET_CLOSE}) reached`);
                await this.squareOff();
                await this.generateSummary();
                console.log('📉 Market closed - Bot exiting');
                console.log(`🕐 Session ends at: ${getCurrentTime()}`);
                process.exit(0);
            }

            // Status updates every 30 seconds
            if (now - lastStatusTime >= 30000) {
                const qualified = this.qualified.size;
                const positions = Array.from(this.pm.positions.values()).flat().filter(p => p.openQty > 0).length;
                const wsStatus = this.wsReady ? '🟢 Connected' : '🔴 Disconnected';
                console.log(`📊 Status [${currentTime}]: ${qualified} qualified stocks, ${positions} active positions, WebSocket: ${wsStatus}, Ticks: ${this.tickCount}`);
                lastStatusTime = now;
            }

            // Candle debug at specific times
            if (currentTime === '09:21:00' || currentTime === '11:05:00') {
                this.debugCandleData();
            }

            // Detailed minute updates
            if (now - lastMinuteUpdate >= 60000) {
                const currentHour = new Date().getHours();
                if (currentHour >= 9 && currentHour < 16) {
                    console.log(`\n⏰ === ${currentTime} Market Update ===`);
                    
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
                    
                    if (this.qualified.size > 0) {
                        console.log(`✅ Qualified Stocks (${this.qualified.size}): ${Array.from(this.qualified).slice(0, 10).join(', ')}${this.qualified.size > 10 ? '...' : ''}`);
                    } else if (timeIsAfter(CONFIG.FIRST_CANDLE_END)) {
                        console.log('⚠️ No stocks qualified yet (waiting for 1% volatility rule)');
                    }
                    
                    const allPositions = Array.from(this.pm.positions.values()).flat();
                    const activePositions = allPositions.filter(p => p.openQty > 0);
                    
                    if (activePositions.length > 0) {
                        console.log(`💼 Active Positions (${activePositions.length}):`);
                        activePositions.forEach(pos => {
                            console.log(`   ${pos.side} - Qty: ${pos.openQty}, Avg: ${pos.avg}`);
                        });
                    }
                    
                    const memUsage = process.memoryUsage();
                    const memMB = Math.round(memUsage.heapUsed / 1024 / 1024);
                    if (memMB > 100) console.log(`⚠️ Memory Usage: ${memMB}MB`);
                    
                    console.log('================================\n');
                }
                lastMinuteUpdate = now;
            }

            // Time-based alerts
            const timeStr = currentTime;
            if (timeStr === '11:55:00') console.log('⏰ ALERT: 5 minutes until entry cutoff (12:00 PM)');
            if (timeStr === '15:10:00') console.log('⏰ ALERT: 10 minutes until market close (3:20 PM)');
            if (timeStr === '15:18:00') console.log('⏰ ALERT: 2 minutes until market close - preparing for square-off');
            
            if (timeIsAfter(CONFIG.FIRST_CANDLE_END) && !timeIsAfter(CONFIG.ENTRY_CUTOFF) &&
                currentTime.endsWith(':00:00') && new Date().getMinutes() % 5 === 0) {
                console.log(`💓 Heartbeat: Bot actively monitoring ${this.qualified.size} qualified stocks for breakouts`);
            }
            
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
            console.log(`🔢 Total Ticks Received: ${this.tickCount}`);
            
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
