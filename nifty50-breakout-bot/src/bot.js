// src/bot.js
const Api = require('../lib/RestApi');
const credentials = require('../credentials');
const { sleep, hhmmss, timeIsAfter } = require('./utils');
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
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('WebSocket connection timeout'));
                }, 30000);

                this.api.start_websocket(
                    tick => this.onTick(tick),
                    () => { },
                    () => {
                        clearTimeout(timeout);
                        this.wsReady = true;
                        resolve();
                    },
                    () => {
                        clearTimeout(timeout);
                        console.log('❌ WebSocket closed');
                        reject(new Error('WebSocket connection failed'));
                    }
                );
            });

            const ins = Object.values(this.tokens).map(t => `NSE|${t}`);
            await this.api.subscribe(ins);
            console.log('🔌 WebSocket connected and subscribed');
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

            if (!this.firstCandle[sym] && hhmmss() >= CONFIG.FIRST_CANDLE_END) {
                const first5 = arr.filter(c => c.ts < (ts + 1) && c.ts >= ts - 4 * 60000);
                if (first5.length === 5) {
                    const hi = Math.max(...first5.map(c => c.h));
                    const lo = Math.min(...first5.map(c => c.l));
                    const op = first5[0].o;
                    const v = ((hi - lo) / op) * 100;
                    if (v < CONFIG.VOLATILITY_THRESH) {
                        this.qualified.add(sym);
                        this.firstCandle[sym] = { hi, lo };
                        console.log(`✅ ${sym} qualified (vol=${v.toFixed(2)}%)`);
                    }
                }
            }

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
        while (true) {
            await sleep(1000);
            if (timeIsAfter(CONFIG.MARKET_CLOSE)) {
                await this.squareOff();
                console.log('📉 Market closed - bot exiting');
                process.exit(0);
            }
        }
    }

    async squareOff() {
        try {
            console.log('🔄 Squaring off positions...');
            const pos = await this.api.get_positions();

            if (pos.stat === 'Ok') {
                for (const p of pos.values) {
                    if (Number(p.netqty) !== 0) {
                        await this.api.place_order(
                            Number(p.netqty) > 0 ? 'S' : 'B', 'M', p.exch, p.tsym, Math.abs(p.netqty),
                            0, 'MKT', 0, 0, 'DAY', 'NO', 'EOD'
                        );
                    }
                }
            }
        } catch (error) {
            console.error('❌ Square off error:', error.message);
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
