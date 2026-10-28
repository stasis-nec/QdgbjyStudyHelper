/* v3.3.5 account transition regression; no real login or network needed. */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', '青岛干部网院自动刷课_油猴脚本.user.js'), 'utf8');
const hooked = source.replace("  if (document.readyState === 'loading') {", `
  globalThis.__account = {state, checkAccountSwitch, accountFingerprint,
    readCourseLock, writeCourseLock, readLocalJson, writeLocalJson};
  if (document.readyState === 'loading') {`);
const store = new Map();
const session = new Map();
const gm = new Map([['qdgbjy_study_mode_v311', 'special'],
 ['qdgbjy_auto_study_enabled_v3', true]]);
const mapStorage = m => ({getItem:k=>m.get(k)??null,
  setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k),
  key:i=>Array.from(m.keys())[i]??null, get length(){return m.size;}});
const browser = {self:null,top:null,addEventListener(){}};
browser.self = browser;browser.top=browser;
const context = {
  window:browser,
  location:{href:'https://www.qdgbjy.gov.cn/trainDetail?trainClassId=222',pathname:'/trainDetail',hash:'',search:'?trainClassId=222'},
  document:{readyState:'loading', addEventListener(){},querySelector(){return null}},
  GM_getValue:(k,d)=>gm.has(k)?gm.get(k):d, GM_setValue:(k,v)=>gm.set(k,v),
  localStorage:mapStorage(store),sessionStorage:mapStorage(session),
  Date,URL,Math,console:{info(){},warn(){}},setTimeout(){},setInterval(){},
};
vm.createContext(context);vm.runInContext(hooked,context);
const a=context.__account;
const setUser=(id,name)=>store.set('userInfo',JSON.stringify({userId:id, name}));
setUser('A','用户甲');
a.state.mode='special-class';
store.set('qdgbjy_course_tab_lock_v311', JSON.stringify({status:'active',title:'甲的旧课',owner:'old',at:Date.now()}));
assert.equal(a.checkAccountSwitch(),true); // one-time migration clears unscoped old lock
assert.equal(a.readCourseLock(),null);
a.writeCourseLock('active','用户甲的学习');
a.writeLocalJson('qdgbjy_special_skipped_v316',{'class-1':[{id:'1',title:'甲需要跳过的课'}]});
const keyA=a.accountFingerprint();
setUser('B','用户乙');
assert.equal(a.checkAccountSwitch(),true);
assert.equal(a.readCourseLock(),null); // B cannot inherit A's lock
assert.equal(a.readLocalJson('qdgbjy_special_skipped_v316',null),null);
assert.equal(gm.get('qdgbjy_study_mode_v311'),'special');
assert.equal(gm.get('qdgbjy_auto_study_enabled_v3'),true);
a.writeCourseLock('active','用户乙的学习');
setUser('A','用户甲');
assert.equal(a.checkAccountSwitch(),true);
assert.equal(a.readCourseLock(),null);
assert.equal(a.readLocalJson('qdgbjy_special_skipped_v316')['class-1'][0].title,'甲需要跳过的课');
assert.equal(a.accountFingerprint(),keyA);
// Old account's player is not permitted to overwrite a newly signed-in account.
a.state.mode='detail';
setUser('B','用户乙');
assert.equal(a.checkAccountSwitch(),false);
assert.equal(a.state.accountInvalidated,true);
console.log('PASS: migration, A-to-B-to-A isolation, skip preservation, old video blocked');
