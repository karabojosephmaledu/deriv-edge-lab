/* Pure virtual Digit Matches ledger. No network, account access or order execution. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MatchesSimulation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const MAX_TRADES = 1000;
  const STAGES = [{from:47,to:100,stake:1},{from:100,to:200,stake:2},{from:200,to:500,stake:5},{from:500,to:1000,stake:10}];
  function numeric(v) { if (!['number','string'].includes(typeof v) || typeof v === 'string' && !v.trim() || !Number.isFinite(Number(v))) throw Error('Invalid numeric value'); return Number(v); }
  function cents(v) { const n = numeric(v); if (n < 0 || Math.abs(n*100-Math.round(n*100)) > 1e-7) throw Error('Use a nonnegative amount with at most two decimals'); return Math.round(n*100); }
  function quote(response, stake, symbol, digit, now) {
    const p = response?.proposal;
    if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 1000) throw Error('No verified public Matches quote');
    const ask = cents(p.ask_price), gross = cents(p.payout);
    if (ask !== cents(stake) || !ask || gross <= ask) throw Error('Quote stake or payout is invalid');
    if (p.currency != null && p.currency !== 'USD') throw Error('Quote currency mismatch');
    const q = response.echo_req;
    if (q && (q.contract_type !== 'DIGITMATCH' || q.underlying_symbol !== symbol || String(q.barrier) !== String(digit) || q.duration !== 1 || q.duration_unit !== 't' || q.currency !== 'USD' || cents(q.amount) !== ask)) throw Error('Quote does not match the requested contract');
    return {ask,gross,symbol,digit,received:now};
  }
  class Engine {
    constructor(cfg) {
      if (!cfg || !['fixed','growth'].includes(cfg.preset) || !Number.isInteger(cfg.digit) || cfg.digit<0 || cfg.digit>9 || !/^(R_(10|25|50|75|100)|1HZ(10|25|50|75|100)V)$/.test(cfg.symbol)) throw Error('Invalid simulation settings');
      const stake = cents(cfg.stake);
      if (stake < 35 || stake > 500000) throw Error('Fixed stake must be $0.35–$5,000');
      const limit = v => v == null || v === '' ? null : cents(v);
      const target = limit(cfg.target), loss = limit(cfg.loss);
      if (target===0 || loss===0) throw Error('Session limits must be positive or blank');
      this.cfg = {...cfg,stake:stake/100,target:target==null?null:target/100,loss:loss==null?null:loss/100};
      this.status='idle'; this.reason='Ready for live-data virtual testing'; this.net=0; this.wins=0; this.losses=0; this.unknown=0;
      this.peak=0; this.maxDD=0; this.pending=null; this.history=[]; this.sequence=0; this.lastEpoch=0;
    }
    get trades() { return this.wins+this.losses; }
    stage() {
      if (this.cfg.preset==='fixed') return {index:0,stake:this.cfg.stake,level:null,to:null};
      const level=(4700+this.net)/100;
      const index=level>=500?3:level>=200?2:level>=100?1:0;
      return {index,stake:STAGES[index].stake,level,to:STAGES[index].to};
    }
    limits() {
      if (this.cfg.target!=null && this.net>=cents(this.cfg.target)) return 'Session profit target reached';
      if (this.cfg.loss!=null && this.net<=-cents(this.cfg.loss)) return 'Total loss limit reached';
      if (this.trades>=MAX_TRADES) return '1,000-outcome session limit reached';
      if (this.cfg.preset==='growth' && 4700+this.net>=100000) return 'Video Growth $1,000 virtual milestone reached';
      return null;
    }
    start() { if (this.status==='done'||this.status==='stopping') return; const why=this.limits(); this.status=why?'done':'running'; this.reason=why||'Running · virtual Matches'; }
    pause() { if (this.status==='running') {this.status='paused';this.reason='Paused · pending virtual entry still settles on the next tick';} }
    stop() { this.status=this.pending?'stopping':'done';this.reason=this.pending?'Stopping · waiting for the open virtual result':'Stopped · virtual session'; }
    interrupt(reason) {
      if (this.pending) {this.history.unshift({...this.pending,n:++this.sequence,time:Date.now(),outcome:'unresolved',profit:null,detail:reason});this.unknown++;this.pending=null;this.history=this.history.slice(0,500);}
      if (['running','paused','stopping'].includes(this.status)) {this.status='done';this.reason=reason;}
    }
    feed(t, q, now=Date.now()) {
      if (!t || t.symbol!==this.cfg.symbol) return null;
      let price,pip,epoch;
      try {price=numeric(t.price);pip=numeric(t.pip);epoch=numeric(t.epoch);}catch{return null;}
      if (price<=0 || !Number.isInteger(pip)||pip<0||pip>20||!Number.isInteger(epoch)||epoch<=this.lastEpoch) return null;
      const interval=this.cfg.symbol.startsWith('1HZ')?1:2;
      if (this.lastEpoch && epoch-this.lastEpoch!==interval && (this.pending || ['running','stopping'].includes(this.status))) {this.interrupt('Missing live ticks · result unresolved; session stopped');this.lastEpoch=epoch;return {type:'interrupted'};}
      this.lastEpoch=epoch;
      const digit=Number(price.toFixed(pip).slice(-1));
      if (this.pending) {
        const entry=this.pending;
        if (entry.pip!==pip) {this.interrupt('Price precision changed · result unresolved');return {type:'interrupted'};}
        this.pending=null;
        const win=digit===entry.digit, pnl=win?entry.gross-entry.ask:-entry.ask;
        this.net+=pnl; this.wins+=Number(win);this.losses+=Number(!win);
        this.peak=Math.max(this.peak,this.net);this.maxDD=Math.max(this.maxDD,this.peak-this.net);
        const row={...entry,n:++this.sequence,time:now,outcome:win?'win':'loss',profit:pnl,exitDigit:digit,detail:'Next chronological live tick'};
        this.history.unshift(row);this.history=this.history.slice(0,500);
        const why=this.limits();
        if (why||this.status==='stopping') {this.status='done';this.reason=why||'Stopped after pending virtual settlement';}
        return {type:'settled',row}; // Never enter a second position on its settlement tick.
      }
      if (this.status!=='running') return null;
      const why=this.limits();if(why){this.status='done';this.reason=why;return null;}
      const stake=cents(this.stage().stake);
      if (this.cfg.loss!=null && this.net-stake < -cents(this.cfg.loss)) {this.status='done';this.reason='Stopped: another full-stake loss would exceed the loss limit';return null;}
      if (this.cfg.preset==='growth' && 4700+this.net<stake) {this.status='done';this.reason='Video Growth experiment cannot fund another virtual stake';return null;}
      if (!q || !Number.isSafeInteger(q.ask) || !Number.isSafeInteger(q.gross) || q.gross<=q.ask || !Number.isFinite(q.received) || q.ask!==stake || q.symbol!==this.cfg.symbol || q.digit!==this.cfg.digit || now-q.received>10000 || now<q.received) return null;
      this.pending={ask:q.ask,gross:q.gross,digit:this.cfg.digit,entryEpoch:epoch,pip,stage:this.stage().index,symbol:this.cfg.symbol};
      return {type:'opened'};
    }
    snapshot() {return JSON.parse(JSON.stringify(this));}
    static restore(s) {
      const engine=new Engine(s.cfg);
      for (const key of ['net','wins','losses','unknown','peak','maxDD','sequence','lastEpoch']) if (!Number.isSafeInteger(s[key]) || key!=='net' && s[key]<0) throw Error('Invalid saved session');
      if (!Array.isArray(s.history)||s.history.length>500||s.wins+s.losses>MAX_TRADES||s.sequence!==s.wins+s.losses+s.unknown||!['idle','running','paused','stopping','done'].includes(s.status)) throw Error('Invalid saved session');
      for (const row of s.history) if(!Number.isInteger(row.n)||!Number.isFinite(row.time)||!['win','loss','unresolved'].includes(row.outcome)||(row.profit!==null&&!Number.isSafeInteger(row.profit)))throw Error('Invalid saved history');
      if (new Set(s.history.map(r=>r.n)).size!==s.history.length) throw Error('Duplicate saved outcomes');
      if (s.sequence<=500 && (s.history.length!==s.sequence||s.history.filter(r=>r.outcome==='win').length!==s.wins||s.history.filter(r=>r.outcome==='loss').length!==s.losses||s.history.filter(r=>r.outcome==='unresolved').length!==s.unknown||s.history.reduce((n,r)=>n+(r.profit||0),0)!==s.net)) throw Error('Saved results do not reconcile');
      if (s.pending && (![s.pending.ask,s.pending.gross,s.pending.entryEpoch,s.pending.pip].every(Number.isSafeInteger)||s.pending.ask<35||s.pending.gross<=s.pending.ask||s.pending.digit!==engine.cfg.digit||s.pending.symbol!==engine.cfg.symbol||s.pending.pip<0||s.pending.pip>20)) throw Error('Invalid saved open entry');
      for(const key of ['net','wins','losses','unknown','peak','maxDD','sequence','history','pending','status'])engine[key]=s[key];
      engine.reason=typeof s.reason==='string'?s.reason.slice(0,600):'Restored virtual session';engine.lastEpoch=0;
      if(engine.pending){engine.interrupt('Page refreshed during an open virtual entry · outcome unresolved');}
      else if(engine.status==='running'){engine.status='paused';engine.reason='Restored paused · no automatic restart';}
      return engine;
    }
  }
  return {Engine,quote,STAGES,MAX_TRADES};
});
