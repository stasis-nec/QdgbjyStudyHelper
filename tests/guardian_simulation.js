/* v3.3.5 guard tests: strict popup ownership, targeted close, no arbitrary tab closure. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('node:assert/strict');
const file = path.join(__dirname, '..', '青岛干部网院自动刷课_油猴脚本.user.js');
const original = fs.readFileSync(file, 'utf8');
const marker = "  if (document.readyState === 'loading') {";
const source = original.replace(marker, `  updateFloatingUI = () => {};
  globalThis.__guardian = { state, setupSpecialPopupOwnership, handleDesktopRecovery, readCourseLock };
` + marker);
function scenario({canClose = true, classId = 'class123', course = '行政诉讼'} = {}) {
  const memory = new Map();
  const gm = new Map([['qdgbjy_study_mode_v311', 'special'], ['qdgbjy_auto_study_enabled_v3', true]]);
  const listeners = {};
  const timeouts = [];
  let closed = false;
  let callCount = 0;
  const popup = {
    get closed() {return closed;},
    close() {callCount++; if (canClose) closed = true;},
  };
  const ctx = {
    window: { self:null, top:null, addEventListener: (name, cb) => {listeners[name] = cb;}, open: () => popup},
    location: {href:`https://www.qdgbjy.gov.cn/trainDetail?trainClassId=${classId}`,
      pathname:'/trainDetail', search:`?trainClassId=${classId}`, reload: () => {}},
    document: {readyState: 'loading', addEventListener: () => {}, querySelector: () => null},
    GM_getValue: (k, fallback) => gm.has(k) ? gm.get(k) : fallback,
    GM_setValue: (k, v) => gm.set(k, v),
    localStorage: {getItem:(k)=> memory.get(k) ?? null,
      setItem:(k,v)=> memory.set(k, String(v)), removeItem:(k)=>memory.delete(k)},
    sessionStorage: {getItem:(k)=> memory.get(k) ?? null,
      setItem:(k,v)=> memory.set(k, String(v)), removeItem:(k)=>memory.delete(k)},
    setTimeout: (fn, ms)=>{timeouts.push({fn,ms});},
    setInterval: () => {},
    Date, URL,
    console: {warn:()=>{},info:()=>{}},
  };
  ctx.window.self = ctx.window; ctx.window.top = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  ctx.__guardian.state.mode = 'special-class';
  memory.set('qdgbjy_course_tab_lock_v311', JSON.stringify({status:'active', title:course, at: Date.now(), owner:'player'}));
  return {ctx, memory, gm, listeners, timeouts, popup, count:()=>callCount,
    register: (tabId='player-123') => {
      ctx.__guardian.setupSpecialPopupOwnership();
      listeners.message({origin:'https://www.qdgbjy.gov.cn',source:popup,
        data:{qdgbjy:'child-ready-333',classId, tabId,courseKey:course}});
    },
    request:(tabId='player-123')=> ({id:'req-1',tabId,courseKey:course,classId,reason:'video not advancing'}),
    runDelayed:(ms)=>{const i = timeouts.findIndex(t=>t.ms === ms);
      assert(i>=0,`timer ${ms} not scheduled`);timeouts.splice(i,1)[0].fn();}
  };
}
// Strict identity first: no child handshake = no automatic tab closure.
let t = scenario();
t.ctx.__guardian.handleDesktopRecovery(t.request());
assert.equal(t.count(), 0);
assert.equal(t.ctx.__guardian.state.recoveryAck.status, 'failed');
assert.equal(t.gm.get('qdgbjy_auto_study_enabled_v3'), false);

// A real child handshake authorizes exactly the matching tab.
t = scenario(); t.register();
t.ctx.__guardian.handleDesktopRecovery(t.request());
assert.equal(t.count(), 1);
t.runDelayed(500);
assert.equal(t.ctx.__guardian.state.recoveryAck.status, 'closed');
assert.equal(t.gm.get('qdgbjy_auto_study_enabled_v3'), true);
assert.equal(t.ctx.__guardian.readCourseLock(), null);
assert.equal(t.ctx.__guardian.state.specialPopup, null);
t.ctx.__guardian.handleDesktopRecovery(t.request());
assert.equal(t.count(), 1); // repeated command is idempotent

// Wrong tabId: no window.close (even though opener has a handle).
t = scenario(); t.register();
t.ctx.__guardian.handleDesktopRecovery(t.request('unrelated-player'));
assert.equal(t.count(), 0);
assert.equal(t.ctx.__guardian.state.recoveryAck.status, 'failed');

// Browser refuses popup.close(): never resume/reopen and signal manual help.
t = scenario({canClose: false});t.register();
t.ctx.__guardian.handleDesktopRecovery(t.request());
t.runDelayed(500);
assert.equal(t.ctx.__guardian.state.recoveryAck.status, 'failed');
assert.equal(t.gm.get('qdgbjy_auto_study_enabled_v3'), false);

// Origin/class mismatch cannot supply a usable tab handle.
t = scenario();t.ctx.__guardian.setupSpecialPopupOwnership();
t.listeners.message({origin:'https://example.org',source:t.popup,
  data:{qdgbjy:'child-ready-333', classId:'class123', tabId:'player-123', courseKey:'行政诉讼'}});
assert.equal(t.ctx.__guardian.state.specialPopup, null);
console.log('PASS: verified child ownership, idempotent recovery, wrong tab rejected, safe failure');
