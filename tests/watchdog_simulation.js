/* 离线模拟浏览器视频；不访问真实学习平台、不模拟学习成果。 */
const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const path = require('path');
const sourceFile = path.join(__dirname, '..', '青岛干部网院自动刷课_油猴脚本.user.js');
let source = fs.readFileSync(sourceFile, 'utf8');
const insertionPoint = "  if (document.readyState === 'loading') {";
assert(source.includes(insertionPoint));
source = source.replace(insertionPoint, "  updateFloatingUI = () => {};\n  globalThis.__test = { observePlaybackHealth, state, getPlaybackRetry, readCourseLock, getAutoEnabled, progressBreakdown };\n" + insertionPoint);

function scenario({ initialTime = 0, storage = null, hasVideo = true } = {}) {
  const clock = { now: initialTime };
  const store = storage || new Map();
  const gm = new Map([['qdgbjy_study_mode_v311', 'special'], ['qdgbjy_auto_study_enabled_v3', true]]);
  const video = { ended: false, paused: false, seeking: false, readyState: 4, currentTime: 65, duration: 1000 };
  const timers = [];
  const nav = { closed: false, to: '' };
  const localStorage = {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const ctx = {
    window: { location: {}, self: null, top: null, opener: { closed: false }, closed: false, close: () => { nav.closed = true; } },
    document: {
      readyState: 'loading', hidden: false,
      querySelectorAll: (q) => q === 'video' && hasVideo ? [video] : [],
      querySelector: (q) => q === 'video' && hasVideo ? video : null,
      addEventListener: () => {},
    },
    location: { href: 'https://www.qdgbjy.gov.cn/detail?trainClassId=123', pathname: '/detail', search: '?trainClassId=123', assign: (u) => { nav.to = u; } },
    GM_getValue: (k, fallback) => gm.has(k) ? gm.get(k) : fallback,
    GM_setValue: (k, v) => gm.set(k, v),
    localStorage,
    sessionStorage: localStorage,
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); },
    setInterval: () => {},
    console: { warn: () => {}, info: () => {} },
    Date: class extends Date { static now() { return clock.now; } },
    URL, URLSearchParams, FormData, MouseEvent: class {},
  };
  ctx.window.top = ctx.window;
  ctx.window.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(source, ctx, { filename: sourceFile });
  const run = (credit='65%') => ctx.__test.observePlaybackHealth([], credit, '第一课第二节');
  return { ...ctx.__test, clock, store, gm, video, timers, nav, run }; 
}

function ticks(test, count, { videoAdvance = false } = {}) {
  for (let i = 0; i < count; i++) {
    test.clock.now += 2500;
    if (videoAdvance) test.video.currentTime += 0.8;
    test.run();
  }
}

// Frozen video: one bounded refresh; second freeze: user attention, no infinite reload.
const db = new Map();
let test = scenario({ storage: db });
test.run();
ticks(test, 75);
assert.equal(test.timers.filter(t => t.delay === 3500).length, 1);
assert.equal(test.getPlaybackRetry('第一课第二节').count, 1);
assert.equal(test.getAutoEnabled(), true);

test = scenario({ initialTime: 187500, storage: db });
test.run();
ticks(test, 74);
assert.equal(test.timers.filter(t => t.delay === 3500).length, 0);
assert.equal(test.getAutoEnabled(), false);
assert.equal(test.readCourseLock().status, 'stalled');

// Video keeps moving, site progress 65% unchanged: warning only, no refresh/skip.
test = scenario();
test.run();
ticks(test, 410, { videoAdvance: true });
assert.equal(test.timers.filter(t => t.delay === 3500).length, 0);
assert.equal(test.getAutoEnabled(), true);
assert(test.state.pendingEvents.some(e => e.message.includes('平台进度')));

// Video element missing (e.g. nested iframe): diagnostic warning but no blind refresh.
test = scenario({ hasVideo: false });
test.run();
ticks(test, 80);
assert.equal(test.timers.filter(t => t.delay === 3500).length, 0);
assert.equal(test.getAutoEnabled(), true);

// One-minute background timer delay while video advanced: no fake stall.
test = scenario();
test.run();
test.clock.now += 60000;
test.video.currentTime += 60;
test.run();
assert.equal(test.state.diagnostics.status, 'playing');
assert.equal(test.state.diagnostics.stalledSeconds, 0);
assert(test.state.pendingEvents.some(e => e.kind === 'timing'));

// One hour suspended tab: do not mistake the wake-up's first tick for a continuous stall.
test = scenario();
test.run();
test.clock.now += 3600000;
test.run();
assert.equal(test.timers.filter(t => t.delay === 3500).length, 0);
assert.equal(test.state.diagnostics.status, 'playing');
// Misleading webpage overall text must not override actual section data.
test = scenario();
const actual = test.progressBreakdown([
  { progress: '100%' }, { progress: '50%' }
]);
assert.equal(actual.value, '75%');
assert.equal(actual.source, 'sections-average');
console.log('PASS: watchdog, progress source isolation, limited refresh and sleeping tabs');

// Two one-minute timer interruptions *without* playback or credit advancement:
// close only the script-owned course page and allow the class list to reopen it.
function setReturnContext(test) {
  test.store.set('qdgbjy_course_return_v311', JSON.stringify({
    kind: 'special', url: 'https://www.qdgbjy.gov.cn/trainDetail?trainClassId=123',
    courseTitle: '第一课第二节', at: test.clock.now,
  }));
}
test = scenario();
setReturnContext(test);
test.run();
test.clock.now += 60000; test.run();
assert.equal(test.state.watchdog.timingStrikes, 1);
assert.equal(test.timers.filter(t => t.delay === 3500).length, 0);
test.clock.now += 60000; test.run();
assert.equal(test.state.watchdog.timingStrikes, 2);
assert.equal(test.timers.filter(t => t.delay === 3500).length, 1);
assert.equal(test.readCourseLock().status, 'closed');
assert(test.state.pendingEvents.some(e => e.kind === 'recovery'));
test.timers.find(t => t.delay === 3500).fn();
assert.equal(test.nav.closed, true);

// Throttled timer with a *healthy* media clock: never close/reopen.
test = scenario();
setReturnContext(test);
test.run();
for (let i = 0; i < 4; i++) {
  test.clock.now += 60000;
  test.video.currentTime += 60;
  test.run();
}
assert.equal(test.state.watchdog.timingStrikes, 0);
assert.equal(test.timers.filter(t => t.delay === 3500).length, 0);

// Long frozen gap (7021 seconds) with only 1% advancement: immediate recovery.
test = scenario({hasVideo:false});
setReturnContext(test);
test.run('24%');
test.clock.now += 7021000;
test.run('25%');
assert.equal(test.timers.filter(t => t.delay === 3500).length, 1);
assert.equal(test.state.watchdog.timingStrikes, 2);
assert.equal(test.readCourseLock().status, 'closed');

// No reopen when class-return address is not verifiable.
test = scenario({hasVideo:false});
test.run('24%');
test.clock.now += 7021000;
test.run('25%');
assert.equal(test.timers.filter(t => t.delay === 3500).length, 0);
assert(test.state.pendingEvents.some(e => e.message.includes('返回地址')));

// Bounded retries: no infinite reopening of a permanently frozen course.
const repeated = new Map();
for (let attempt = 0; attempt < 3; attempt++) {
  test = scenario({initialTime: attempt * 7050000, hasVideo: false, storage: repeated});
  setReturnContext(test);
  test.run('24%');
  test.clock.now += 7021000;
  test.run('25%');
  assert.equal(test.timers.filter(t => t.delay === 3500).length, attempt < 2 ? 1 : 0);
  assert.equal(test.getAutoEnabled(), attempt < 2);
}
console.log('PASS: two-strike timing recovery, severe freeze, healthy throttling, safe fallback, retry cap');
