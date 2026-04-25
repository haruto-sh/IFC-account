/* ================================================================
   CONFIG
================================================================ */
const CLIENT_ID = '387302608037-et2svb68cnf7lm3gltpn67u3ovbplrjq.apps.googleusercontent.com';
const SHEET_ID  = '1J-kv2Lwc4qBxVAvBGn0JCFS1BSc8UuXTwg1G2xY0nqc';
const SCOPES    = 'https://www.googleapis.com/auth/spreadsheets';
const API_BASE  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`;

const SH = {
  TX:      'transactions',
  MEMBERS: 'members',
  FEE_REC: 'fee_records',
  PRAC:    'practice_count',
  FEE_SET: 'fee_settings',
};

/* ================================================================
   CONSTANTS
================================================================ */
const ATTR_L     = { male:'男プレ', female:'女プレ', manager:'マネージャー', exec:'幹部上' };
const ATTR_ORDER = { male:0, female:1, manager:2, exec:3 };
const GRADE_ORDER= { 26:0,25:1,24:2,23:3,22:4,21:5 };

/* ================================================================
   AUTH STATE
================================================================ */
let accessToken = null;
let userEmail   = null;

/* ================================================================
   APP STATE
================================================================ */
let nid = 1;
let S = {
  txs:[], members:[], feeRec:{}, pracCount:{},
  fee: { base:{ male:2000, female:2000, manager:1500, exec:500 }, adjs:[] },
  acct: 'cash',
  type: 'income',
};
let trendChart    = null;
let currentLedger = 'cash';
let isSaving      = false;

/* ================================================================
   GOOGLE SIGN-IN
================================================================ */
window.addEventListener('load', () => {
  const waitGIS = setInterval(() => {
    if (typeof google !== 'undefined' && google.accounts) {
      clearInterval(waitGIS);
      initGIS();
    }
  }, 100);
});

function initGIS() {
  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: handleCredential,
    auto_select: true,
  });
  tryRestoreToken();
}

function tryRestoreToken() {
  const saved = sessionStorage.getItem('gapi_token');
  if (saved) {
    try {
      const obj = JSON.parse(saved);
      if (obj.expiry > Date.now()) {
        accessToken = obj.token;
        userEmail   = obj.email;
        startApp();
        return;
      }
    } catch(e) {
      sessionStorage.removeItem('gapi_token');
    }
  }
  showLoginScreen();
}

function showLoginScreen() {
  setLoading(false);
  document.getElementById('login-screen').style.display = 'flex';
  google.accounts.id.renderButton(
    document.getElementById('google-signin-btn'),
    { theme:'outline', size:'large', text:'signin_with', locale:'ja', shape:'pill' }
  );
}

async function handleCredential(response) {
  const payload = JSON.parse(atob(response.credential.split('.')[1]));
  userEmail = payload.email;

  const client = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    // ux_mode: popup だと COOP でブロックされるため select_account を指定して回避
    callback: async (tokenResp) => {
      if (tokenResp.error) { showLoginError(); return; }
      accessToken = tokenResp.access_token;
      sessionStorage.setItem('gapi_token', JSON.stringify({
        token:  accessToken,
        email:  userEmail,
        expiry: Date.now() + (tokenResp.expires_in - 60) * 1000,
      }));
      document.getElementById('login-screen').style.display = 'none';
      startApp();
    },
  });
  // prompt: 'none' だと COOP エラーになるため '' を 'consent' に変更
  // 初回は必ずポップアップを出すことで postMessage ブロックを回避
  client.requestAccessToken({ prompt: 'consent' });
}

function showLoginError() {
  document.getElementById('login-error').style.display = 'block';
}

function signOut() {
  google.accounts.id.disableAutoSelect();
  sessionStorage.removeItem('gapi_token');
  accessToken = null;
  location.reload();
}

/* ================================================================
   SHEETS API HELPERS
================================================================ */
async function sheetsGet(range) {
  const url = `${API_BASE}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers:{ Authorization:`Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets GET error: ${res.status}`);
  return (await res.json()).values || [];
}

async function sheetsAppend(sheetName, rows) {
  const url = `${API_BASE}/values/${encodeURIComponent(sheetName+'!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) throw new Error(`Sheets APPEND error: ${res.status}`);
  return res.json();
}

async function sheetsClear(sheetName) {
  const url = `${API_BASE}/values/${encodeURIComponent(sheetName+'!A2:Z9999')}:clear`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' },
  });
  if (!res.ok) throw new Error(`Sheets CLEAR error: ${res.status}`);
}

async function sheetsWriteAll(sheetName, rows) {
  await sheetsClear(sheetName);
  if (rows.length > 0) await sheetsAppend(sheetName, rows);
}

async function sheetsUpdate(range, values) {
  const url = `${API_BASE}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(`Sheets UPDATE error: ${res.status}`);
}

async function ensureSheets() {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}`,
    { headers:{ Authorization:`Bearer ${accessToken}` } });
  if (!res.ok) throw new Error('スプレッドシートにアクセスできません');
  const meta     = await res.json();
  const existing = meta.sheets.map(s => s.properties.title);
  const toAdd    = Object.values(SH).filter(n => !existing.includes(n));

  if (toAdd.length > 0) {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ requests: toAdd.map(title => ({ addSheet:{ properties:{ title } } })) }),
    });
    const headers = {
      [SH.TX]:      [['id','date','type','acct','toAcct','amount','desc','cat','note']],
      [SH.MEMBERS]: [['id','name','grade','attr']],
      [SH.FEE_REC]: [['id','member_id','ym','paid']],
      [SH.PRAC]:    [['id','member_id','ym','count']],
      [SH.FEE_SET]: [['id','attr','amount','type','from_ym','to_ym']],
    };
    for (const name of toAdd) await sheetsUpdate(`${name}!A1`, headers[name]);
  }
}

/* ================================================================
   LOAD FROM SHEETS
================================================================ */
async function loadAll() {
  setLoading(true, 'データを読み込み中...');
  await ensureSheets();

  const [txRows, mRows, frRows, pcRows, fsRows] = await Promise.all([
    sheetsGet(SH.TX      + '!A2:I'),
    sheetsGet(SH.MEMBERS + '!A2:D'),
    sheetsGet(SH.FEE_REC + '!A2:D'),
    sheetsGet(SH.PRAC    + '!A2:D'),
    sheetsGet(SH.FEE_SET + '!A2:F'),
  ]);

  S.txs = txRows.map(r => ({
    id:r[0]|0, date:r[1], type:r[2], acct:r[3],
    toAcct:r[4]||'', amount:r[5]|0, desc:r[6], cat:r[7], note:r[8]||'',
  }));

  S.members = mRows.map(r => ({ id:r[0]|0, name:r[1], grade:r[2], attr:r[3] }));

  nid = Math.max(
    S.txs.reduce((m,t) => Math.max(m,t.id), 0),
    S.members.reduce((m,t) => Math.max(m,t.id), 0)
  ) + 1;

  S.feeRec = {};
  frRows.forEach(r => {
    if (!S.feeRec[r[2]]) S.feeRec[r[2]] = {};
    S.feeRec[r[2]][r[1]|0] = r[3]==='true' || r[3]===true || r[3]==='TRUE';
  });

  S.pracCount = {};
  pcRows.forEach(r => {
    if (!S.pracCount[r[2]]) S.pracCount[r[2]] = {};
    S.pracCount[r[2]][r[1]|0] = r[3]|0;
  });

  S.fee = { base:{ male:2000, female:2000, manager:1500, exec:500 }, adjs:[] };
  fsRows.forEach(r => {
    if (r[3]==='base') S.fee.base[r[1]] = r[2]|0;
    else S.fee.adjs.push({ id:r[0]|0, attr:r[1], amount:r[2]|0, from:r[4], to:r[5] });
  });
  if (fsRows.length === 0) await saveFeeSettings();

  setLoading(false);
}

/* ================================================================
   SAVE TO SHEETS
================================================================ */
async function saveSheet(fn) {
  if (isSaving) return;
  isSaving = true;
  showSaveInd(true);
  try { await fn(); }
  catch(e) { console.error(e); toast('保存に失敗しました。再試行してください。'); }
  finally { isSaving = false; showSaveInd(false); }
}

const saveTx = () => saveSheet(async () => {
  await sheetsWriteAll(SH.TX,
    S.txs.map(t => [t.id,t.date,t.type,t.acct,t.toAcct||'',t.amount,t.desc,t.cat,t.note||'']));
});

const saveMembers = () => saveSheet(async () => {
  await sheetsWriteAll(SH.MEMBERS, S.members.map(m => [m.id,m.name,m.grade,m.attr]));
});

const saveFeeRec = () => saveSheet(async () => {
  const rows = [];
  let rid = 1;
  Object.entries(S.feeRec).forEach(([ym,recs]) =>
    Object.entries(recs).forEach(([mid,paid]) => rows.push([rid++, mid, ym, paid])));
  await sheetsWriteAll(SH.FEE_REC, rows);
});

const savePrac = () => saveSheet(async () => {
  const rows = [];
  let rid = 1;
  Object.entries(S.pracCount).forEach(([ym,recs]) =>
    Object.entries(recs).forEach(([mid,cnt]) => rows.push([rid++, mid, ym, cnt])));
  await sheetsWriteAll(SH.PRAC, rows);
});

const saveFeeSettings = () => saveSheet(async () => {
  const rows = [];
  let rid = 1;
  Object.entries(S.fee.base).forEach(([attr,amt]) => rows.push([rid++,attr,amt,'base','','']));
  S.fee.adjs.forEach(a => rows.push([a.id,a.attr,a.amount,'adj',a.from,a.to]));
  await sheetsWriteAll(SH.FEE_SET, rows);
});

function showSaveInd(on) {
  const el = document.getElementById('save-ind');
  if (el) el.style.opacity = on ? '1' : '0';
}

/* ================================================================
   START APP
================================================================ */
async function startApp() {
  setLoading(true, 'データを読み込み中...');
  try {
    await loadAll();
    document.getElementById('main-app').style.display = 'flex';
    const today = new Date(), ym = toYM(today);
    document.getElementById('tx-date').value   = today.toISOString().split('T')[0];
    document.getElementById('tr-date').value   = today.toISOString().split('T')[0];
    document.getElementById('fee-month').value = ym;
    render();
  } catch(e) {
    console.error(e);
    setLoading(true, 'データ読み込みに失敗しました。ページを再読み込みしてください。');
  }
}

function setLoading(on, msg='') {
  const el = document.getElementById('loading-screen');
  el.style.display = on ? 'flex' : 'none';
  if (msg) document.getElementById('loading-msg').textContent = msg;
}

/* ================================================================
   UTIL
================================================================ */
const toYM   = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
const prevYM = ym => { const d=new Date(ym+'-01'); d.setMonth(d.getMonth()-1); return toYM(d); };
const fmt    = n => '¥' + Number(n).toLocaleString();
const fmtN   = n => Number(n).toLocaleString();

/* ================================================================
   NAVIGATION
================================================================ */
const PAGE_NAMES = ['dashboard','transactions','ledger','members','fees','report'];

function showPage(n) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.bnav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + n).classList.add('active');
  const idx = PAGE_NAMES.indexOf(n);
  document.querySelectorAll('.nav-btn')[idx]?.classList.add('active');
  document.querySelectorAll('.bnav-btn')[idx]?.classList.add('active');
  render();
  if (n === 'ledger') showLedger(currentLedger);
  if (n === 'report') renderChart();
}

/* ================================================================
   CALC
================================================================ */
function calcBal() {
  let cash=0, bank=0;
  S.txs.forEach(t => {
    if (t.type==='income')
      { if(t.acct==='cash') cash+=t.amount; else bank+=t.amount; }
    else if (t.type==='expense')
      { if(t.acct==='cash') cash-=t.amount; else bank-=t.amount; }
    else if (t.type==='transfer') {
      if(t.acct==='cash') cash-=t.amount; else bank-=t.amount;
      if(t.toAcct==='cash') cash+=t.amount; else bank+=t.amount;
    }
  });
  return { cash, bank, total:cash+bank };
}

function calcFee(attr, ym, pc) {
  const adj = S.fee.adjs.find(a => a.attr===attr && a.from<=ym && ym<=a.to);
  if (attr==='exec') { const per=adj?adj.amount:S.fee.base.exec; return per*(pc||0); }
  return adj ? adj.amount : (S.fee.base[attr]||0);
}

function sortedMembers() {
  return [...S.members].sort((a,b) => {
    const gd = GRADE_ORDER[parseInt(a.grade)] - GRADE_ORDER[parseInt(b.grade)];
    return gd !== 0 ? gd : ATTR_ORDER[a.attr] - ATTR_ORDER[b.attr];
  });
}

/* ================================================================
   RENDER ALL
================================================================ */
function render() {
  renderHdr(); renderDash(); renderTx(); renderMembers();
  renderFee(); renderFeeView(); renderReport();
}

/* ================================================================
   HEADER
================================================================ */
function renderHdr() {
  const { cash, bank, total } = calcBal();
  document.getElementById('h-cash').textContent  = fmt(cash);
  document.getElementById('h-bank').textContent  = fmt(bank);
  document.getElementById('h-total').textContent = fmt(total);
}

/* ================================================================
   DASHBOARD
================================================================ */
function renderDash() {
  const { cash, bank } = calcBal();
  const ym = toYM(new Date());
  let inc=0,exp=0,ci=0,co=0,bi=0,bo=0;
  S.txs.forEach(t => {
    if (!t.date.startsWith(ym)) return;
    if (t.type==='income')  { inc+=t.amount; t.acct==='cash'?ci+=t.amount:bi+=t.amount; }
    if (t.type==='expense') { exp+=t.amount; t.acct==='cash'?co+=t.amount:bo+=t.amount; }
  });

  document.getElementById('dash-sg').innerHTML = `
    <div class="sc"><div class="lb"><span class="dot" style="background:var(--csh)"></span>現金残高</div><div class="vl" style="color:var(--csh)">${fmt(cash)}</div></div>
    <div class="sc"><div class="lb"><span class="dot" style="background:var(--bnk)"></span>銀行残高</div><div class="vl" style="color:var(--bnk)">${fmt(bank)}</div></div>
    <div class="sc"><div class="lb">今月収入</div><div class="vl" style="color:var(--grn)">${fmt(inc)}</div></div>
    <div class="sc"><div class="lb">今月支出</div><div class="vl" style="color:var(--red)">${fmt(exp)}</div></div>`;

  document.getElementById('acct-bd').innerHTML = `
    <div>
      <div style="font-size:12px;font-weight:500;color:var(--csh);margin-bottom:7px;display:flex;align-items:center;gap:5px">
        <span style="width:7px;height:7px;border-radius:50%;background:var(--csh);display:inline-block"></span>現金
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid var(--bdr)"><span style="color:var(--tx2)">収入</span><span style="color:var(--grn);font-family:'DM Mono',monospace">${fmt(ci)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0"><span style="color:var(--tx2)">支出</span><span style="color:var(--red);font-family:'DM Mono',monospace">${fmt(co)}</span></div>
    </div>
    <div>
      <div style="font-size:12px;font-weight:500;color:var(--bnk);margin-bottom:7px;display:flex;align-items:center;gap:5px">
        <span style="width:7px;height:7px;border-radius:50%;background:var(--bnk);display:inline-block"></span>銀行預金
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0;border-bottom:1px solid var(--bdr)"><span style="color:var(--tx2)">収入</span><span style="color:var(--grn);font-family:'DM Mono',monospace">${fmt(bi)}</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;padding:4px 0"><span style="color:var(--tx2)">支出</span><span style="color:var(--red);font-family:'DM Mono',monospace">${fmt(bo)}</span></div>
    </div>`;

  const fym = document.getElementById('fee-month')?.value || ym;
  const rec = S.feeRec[fym] || {};
  const tot = S.members.length;
  const paid = Object.values(rec).filter(Boolean).length;
  const pct  = tot>0 ? Math.round(paid/tot*100) : 0;
  document.getElementById('fee-dash-text').textContent = `${paid}名 / ${tot}名 納入済み（${pct}%）`;
  document.getElementById('fee-prog').style.width = pct + '%';

  const recent = [...S.txs].sort((a,b) => b.date.localeCompare(a.date)).slice(0,5);
  document.getElementById('recent-list').innerHTML = recent.length===0
    ? '<div class="empty">まだ取引がありません</div>'
    : recent.map(txRow).join('');
}

/* ================================================================
   TX ROW / RENDER
================================================================ */
function txRow(t) {
  let ab, amtStr, amtCls;
  if (t.type==='transfer') {
    ab = `<span class="bdg transfer">振替</span>`;
    amtStr = fmt(t.amount); amtCls = 'transfer';
  } else {
    ab = `<span class="bdg ${t.acct}">${t.acct==='cash'?'現金':'銀行'}</span>`;
    amtStr = (t.type==='income'?'+':'-') + fmt(t.amount); amtCls = t.type;
  }
  const catLabel = t.type==='transfer'
    ? `${t.acct==='cash'?'現金':'銀行'}→${t.toAcct==='cash'?'現金':'銀行'}` : t.cat;
  return `<div class="txr tx6">
    <span class="txdate">${t.date.slice(5)}</span>
    ${ab}
    <span style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.desc}</span>
    <span class="txcat tx-cat-col">${catLabel}</span>
    <span class="txamt ${amtCls}">${amtStr}</span>
    <span class="tx-del-col" style="display:flex;justify-content:flex-end">
      <button class="btn bd sm" onclick="delTx(${t.id})">削除</button>
    </span>
  </div>`;
}

function renderTx() {
  const fa = document.getElementById('f-acct')?.value || '';
  const ft = document.getElementById('f-type')?.value || '';
  let txs  = [...S.txs].sort((a,b) => b.date.localeCompare(a.date));
  if (fa) txs = txs.filter(t => t.acct===fa || (t.type==='transfer' && t.toAcct===fa));
  if (ft) txs = txs.filter(t => t.type===ft);
  const el = document.getElementById('tx-list');
  if (!el) return;
  el.innerHTML = txs.length===0
    ? '<div class="empty">取引がありません</div>'
    : txs.map(txRow).join('');
}

/* ================================================================
   TYPE / ACCT TOGGLE
================================================================ */
function setType(t) {
  S.type = t;
  ['income','expense','transfer'].forEach(x =>
    document.getElementById('t-'+x).classList.toggle('on', x===t));
  document.getElementById('normal-fields').style.display   = t==='transfer' ? 'none'  : 'block';
  document.getElementById('transfer-fields').style.display = t==='transfer' ? 'block' : 'none';
}

function setAcct(a) {
  S.acct = a;
  document.getElementById('a-cash').classList.toggle('on', a==='cash');
  document.getElementById('a-bank').classList.toggle('on', a==='bank');
}

/* ================================================================
   ADD / DELETE TX
================================================================ */
async function addTx() {
  if (S.type==='transfer') {
    const date   = document.getElementById('tr-date').value;
    const amount = parseInt(document.getElementById('tr-amt').value);
    const from   = document.getElementById('tr-from').value;
    const to     = document.getElementById('tr-to').value;
    const desc   = document.getElementById('tr-desc').value.trim() || `${from==='cash'?'現金':'銀行'}→${to==='cash'?'現金':'銀行'}`;
    const note   = document.getElementById('tr-note').value.trim();
    if (!date)           { toast('日付を入力してください'); return; }
    if (!amount||amount<=0) { toast('金額を正しく入力してください'); return; }
    if (from===to)       { toast('移動元と移動先が同じです'); return; }
    S.txs.push({ id:nid++, date, type:'transfer', acct:from, toAcct:to, amount, desc, cat:'振替', note });
    ['tr-amt','tr-desc','tr-note'].forEach(id => document.getElementById(id).value='');
  } else {
    const date   = document.getElementById('tx-date').value;
    const amount = parseInt(document.getElementById('tx-amt').value);
    const desc   = document.getElementById('tx-desc').value.trim();
    const cat    = document.getElementById('tx-cat').value;
    const note   = document.getElementById('tx-note').value.trim();
    if (!date)           { toast('日付を入力してください'); return; }
    if (!amount||amount<=0) { toast('金額を正しく入力してください'); return; }
    if (!desc)           { toast('摘要を入力してください'); return; }
    S.txs.push({ id:nid++, date, type:S.type, acct:S.acct, amount, desc, cat, note });
    ['tx-amt','tx-desc','tx-note'].forEach(id => document.getElementById(id).value='');
  }
  toast('追加しました ✓');
  render();
  await saveTx();
}

async function delTx(id) {
  if (!confirm('この取引を削除しますか？')) return;
  S.txs = S.txs.filter(t => t.id!==id);
  render();
  await saveTx();
  toast('削除しました');
}

/* ================================================================
   LEDGER
================================================================ */
function showLedger(type) {
  currentLedger = type;
  document.querySelectorAll('#ledger-tabs .pill').forEach((p,i) =>
    p.classList.toggle('active', ['cash','bank','cat','summary'][i]===type));
  const el = document.getElementById('ledger-content');
  if      (type==='cash')    el.innerHTML = renderCashLedger('cash','現金出納帳');
  else if (type==='bank')    el.innerHTML = renderCashLedger('bank','預金出納帳');
  else if (type==='cat')     el.innerHTML = renderCatLedger();
  else                       el.innerHTML = renderSummaryStatement();
}

function renderCashLedger(acct, title) {
  const txs = S.txs.filter(t => {
    if (t.type==='transfer') return t.acct===acct || t.toAcct===acct;
    return t.acct===acct;
  }).sort((a,b) => a.date.localeCompare(b.date));

  let bal=0, totalIn=0, totalOut=0, rows='';
  txs.forEach(t => {
    let inAmt=0, outAmt=0, label=t.desc;
    if (t.type==='income')  { inAmt=t.amount; bal+=t.amount; totalIn+=t.amount; }
    else if (t.type==='expense') { outAmt=t.amount; bal-=t.amount; totalOut+=t.amount; }
    else if (t.type==='transfer') {
      if (t.acct===acct)  { outAmt=t.amount; bal-=t.amount; totalOut+=t.amount; label=`振替出金→${t.toAcct==='cash'?'現金':'銀行'}`; }
      else                { inAmt=t.amount;  bal+=t.amount; totalIn+=t.amount;  label=`振替入金←${t.acct==='cash'?'現金':'銀行'}`; }
    }
    rows += `<tr>
      <td class="num">${t.date}</td><td>${label}</td>
      <td class="num" style="color:var(--grn)">${inAmt?fmtN(inAmt):''}</td>
      <td class="num" style="color:var(--red)">${outAmt?fmtN(outAmt):''}</td>
      <td class="num ${bal>=0?'bal-pos':'bal-neg'}">${fmtN(bal)}</td>
    </tr>`;
  });
  return `<div class="card" style="padding:0;overflow:hidden">
    <div style="padding:12px 16px;font-weight:600;font-size:14px;border-bottom:1px solid var(--bdr)">${title}</div>
    <div style="overflow-x:auto"><table class="ltbl">
      <thead><tr><th>日付</th><th>摘要</th><th style="text-align:right">入金</th><th style="text-align:right">出金</th><th style="text-align:right">残高</th></tr></thead>
      <tbody>${rows||'<tr><td colspan="5" class="empty">データがありません</td></tr>'}</tbody>
      <tfoot><tr><td colspan="2" style="font-weight:600">合計</td>
        <td class="num" style="color:var(--grn)">${fmtN(totalIn)}</td>
        <td class="num" style="color:var(--red)">${fmtN(totalOut)}</td>
        <td class="num">${fmtN(bal)}</td>
      </tr></tfoot>
    </table></div></div>`;
}

function renderCatLedger() {
  const cats = {};
  S.txs.filter(t => t.type!=='transfer').forEach(t => {
    if (!cats[t.cat]) cats[t.cat] = [];
    cats[t.cat].push(t);
  });
  let html = '';
  Object.keys(cats).sort().forEach(cat => {
    const txs = cats[cat].sort((a,b) => a.date.localeCompare(b.date));
    let total=0, rows='';
    txs.forEach(t => {
      const amt = t.type==='income' ? t.amount : -t.amount;
      total += amt;
      rows += `<tr>
        <td class="num">${t.date}</td><td>${t.desc}</td>
        <td><span class="bdg ${t.acct}">${t.acct==='cash'?'現金':'銀行'}</span></td>
        <td class="num" style="color:${t.type==='income'?'var(--grn)':'var(--red)'}">${t.type==='income'?'+':'-'}${fmtN(t.amount)}</td>
      </tr>`;
    });
    html += `<div class="card" style="padding:0;overflow:hidden;margin-bottom:10px">
      <div style="padding:10px 16px;font-weight:600;font-size:14px;border-bottom:1px solid var(--bdr);display:flex;justify-content:space-between">
        <span>${cat}</span>
        <span style="font-family:'DM Mono',monospace;font-size:13px;color:${total>=0?'var(--grn)':'var(--red)'}">${total>=0?'+':''}${fmtN(total)}</span>
      </div>
      <div style="overflow-x:auto"><table class="ltbl">
        <thead><tr><th>日付</th><th>摘要</th><th>口座</th><th style="text-align:right">金額</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>`;
  });
  return html || '<div class="empty">データがありません</div>';
}

function renderSummaryStatement() {
  let incTotal=0, expTotal=0;
  const catInc={}, catExp={};
  S.txs.filter(t => t.type!=='transfer').forEach(t => {
    if (t.type==='income')  { catInc[t.cat]=(catInc[t.cat]||0)+t.amount; incTotal+=t.amount; }
    else                    { catExp[t.cat]=(catExp[t.cat]||0)+t.amount; expTotal+=t.amount; }
  });
  const incRows = Object.keys(catInc).sort().map(c =>
    `<tr><td style="padding-left:24px">${c}</td><td class="num" style="color:var(--grn)">${fmtN(catInc[c])}</td></tr>`).join('');
  const expRows = Object.keys(catExp).sort().map(c =>
    `<tr><td style="padding-left:24px">${c}</td><td class="num" style="color:var(--red)">${fmtN(catExp[c])}</td></tr>`).join('');
  const net = incTotal - expTotal;
  return `<div class="card" style="padding:0;overflow:hidden">
    <div style="padding:12px 16px;font-weight:600;font-size:14px;border-bottom:1px solid var(--bdr)">収支計算書（全期間）</div>
    <div style="overflow-x:auto"><table class="ltbl"><tbody>
      <tr><td style="font-weight:600;background:var(--grn-l);color:var(--grn);padding:8px 14px">【収入の部】</td><td class="num" style="background:var(--grn-l);color:var(--grn);font-weight:600">${fmtN(incTotal)}</td></tr>
      ${incRows}
      <tr><td style="font-weight:600;background:var(--red-l);color:var(--red);padding:8px 14px">【支出の部】</td><td class="num" style="background:var(--red-l);color:var(--red);font-weight:600">${fmtN(expTotal)}</td></tr>
      ${expRows}
      <tr style="border-top:2px solid var(--bdr)">
        <td style="font-weight:700;font-size:15px;padding:12px 14px">当期収支差額</td>
        <td class="num" style="font-weight:700;font-size:15px;color:${net>=0?'var(--grn)':'var(--red)'}">${net>=0?'+':''}${fmtN(net)}</td>
      </tr>
    </tbody></table></div></div>`;
}

/* ================================================================
   MEMBERS
================================================================ */
const badge     = (cls,lbl) => `<span class="bdg ${cls}">${lbl}</span>`;
const attrBadge = attr => badge(attr, ATTR_L[attr]);

function renderMembers() {
  const fa = document.getElementById('f-attr')?.value  || '';
  const fg = document.getElementById('f-grade')?.value || '';
  let ms   = sortedMembers();
  if (fa) ms = ms.filter(m => m.attr===fa);
  if (fg) ms = ms.filter(m => m.grade===fg);
  const tb = document.getElementById('m-tbody');
  if (!tb) return;
  tb.innerHTML = ms.length===0
    ? '<tr><td colspan="3" class="empty">部員がいません</td></tr>'
    : ms.map(m => `<tr>
        <td style="font-weight:500">${m.name}</td>
        <td style="color:var(--tx2)">${m.grade}</td>
        <td>${attrBadge(m.attr)}</td>
        <td style="text-align:right"><button class="btn bs sm" onclick="openEdit(${m.id})">編集</button></td>
      </tr>`).join('');
}

async function addMember() {
  const name  = document.getElementById('ma-name').value.trim();
  const grade = document.getElementById('ma-grade').value;
  const attr  = document.getElementById('ma-attr').value;
  if (!name) { toast('氏名を入力してください'); return; }
  S.members.push({ id:nid++, name, grade, attr });
  document.getElementById('ma-name').value = '';
  closeM('m-add'); toast('追加しました ✓');
  render(); await saveMembers();
}

function openEdit(id) {
  const m = S.members.find(m => m.id===id); if (!m) return;
  document.getElementById('me-id').value    = id;
  document.getElementById('me-name').value  = m.name;
  document.getElementById('me-grade').value = m.grade;
  document.getElementById('me-attr').value  = m.attr;
  openM('m-edit');
}

async function saveMember() {
  const id = parseInt(document.getElementById('me-id').value);
  const m  = S.members.find(m => m.id===id); if (!m) return;
  m.name  = document.getElementById('me-name').value.trim();
  m.grade = document.getElementById('me-grade').value;
  m.attr  = document.getElementById('me-attr').value;
  closeM('m-edit'); toast('更新しました ✓');
  render(); await saveMembers();
}

async function deleteMember() {
  const id = parseInt(document.getElementById('me-id').value);
  const m  = S.members.find(m => m.id===id);
  if (!confirm(`「${m?.name}」を削除しますか？`)) return;
  S.members = S.members.filter(m => m.id!==id);
  closeM('m-edit'); toast('削除しました');
  render(); await saveMembers();
}

/* ================================================================
   FEES
================================================================ */
function renderFee() {
  const ym = document.getElementById('fee-month')?.value; if (!ym) return;
  if (!S.feeRec[ym])    S.feeRec[ym]    = {};
  if (!S.pracCount[ym]) S.pracCount[ym] = {};
  const rec=S.feeRec[ym], pc=S.pracCount[ym];
  let paid=0,unpaid=0,coll=0,rem=0;
  S.members.forEach(m => {
    const fee = calcFee(m.attr, ym, pc[m.id]||0);
    if (rec[m.id]) { paid++; coll+=fee; } else { unpaid++; rem+=fee; }
  });
  document.getElementById('fp-c').textContent = paid;
  document.getElementById('fu-c').textContent = unpaid;
  document.getElementById('fc-a').textContent = fmt(coll);
  document.getElementById('fr-a').textContent = fmt(rem);

  const tb = document.getElementById('fee-tbody'); if (!tb) return;
  tb.innerHTML = sortedMembers().map(m => {
    const isPaid = !!rec[m.id];
    const fee    = calcFee(m.attr, ym, pc[m.id]||0);
    const pi = m.attr==='exec'
      ? `<input type="number" min="0" max="31" value="${pc[m.id]||0}"
           style="width:62px;padding:8px;border:1px solid var(--bdr);border-radius:6px;font-size:16px;text-align:center"
           onchange="setPrac(${m.id},'${ym}',this.value)">`
      : `<span style="color:var(--tx3);font-size:12px">—</span>`;
    return `<tr>
      <td style="font-weight:500">${m.name}<br><span style="font-size:11px;color:var(--tx3)">${m.grade}</span></td>
      <td>${attrBadge(m.attr)}</td>
      <td>${pi}</td>
      <td style="text-align:right;font-family:'DM Mono',monospace;font-size:13px;font-weight:500">${fmt(fee)}</td>
      <td style="text-align:center">
        <button class="btn sm" style="background:${isPaid?'var(--grn-l)':'var(--red-l)'};color:${isPaid?'var(--grn)':'var(--red)'};min-width:68px"
          onclick="toggleFee(${m.id},'${ym}')">${isPaid?'✓ 済み':'✕ 未納'}</button>
      </td>
    </tr>`;
  }).join('');
  renderExecUnpaid();
}

async function setPrac(id, ym, v) {
  if (!S.pracCount[ym]) S.pracCount[ym] = {};
  S.pracCount[ym][id] = parseInt(v)||0;
  renderFee(); await savePrac();
}

async function toggleFee(id, ym) {
  if (!S.feeRec[ym]) S.feeRec[ym] = {};
  S.feeRec[ym][id] = !S.feeRec[ym][id];
  renderFee(); renderDash(); await saveFeeRec();
}

function renderExecUnpaid() {
  const el = document.getElementById('exec-unpaid-wrap'); if (!el) return;
  const execMembers = sortedMembers().filter(m => m.attr==='exec');
  if (execMembers.length===0) { el.innerHTML='<div class="empty">幹部上の部員がいません</div>'; return; }

  const months = [...new Set(Object.keys(S.feeRec))].sort();
  const data   = {};
  execMembers.forEach(m => {
    const unpaid = {};
    months.forEach(ym => {
      if (S.feeRec[ym]?.[m.id]===false) {
        const pc  = (S.pracCount[ym]||{})[m.id]||0;
        unpaid[ym] = calcFee('exec', ym, pc);
      }
    });
    if (Object.keys(unpaid).length>0) data[m.id] = unpaid;
  });

  const active = execMembers.filter(m => data[m.id]);
  if (active.length===0) {
    el.innerHTML = `<div class="card"><div style="text-align:center;color:var(--grn);padding:20px;font-size:13px">✓ 未納の幹部上はいません</div></div>`;
    return;
  }

  const cols = [...new Set(active.flatMap(m => Object.keys(data[m.id])))].sort();
  const thead = `<tr><th>氏名</th>${cols.map(ym=>`<th>${ym}</th>`).join('')}<th>合計</th></tr>`;
  const tbody = active.map(m => {
    let total=0;
    const cells = cols.map(ym => {
      const fee = data[m.id]?.[ym];
      if (fee!==undefined&&fee>0) { total+=fee; return `<td>${fmtN(fee)}</td>`; }
      return `<td style="color:var(--tx3)">—</td>`;
    }).join('');
    return `<tr>
      <td>${m.name}<br><span style="font-size:11px;color:var(--tx3)">${m.grade}</span></td>
      ${cells}
      <td class="total-col">${fmtN(total)}</td>
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="card" style="padding:0;overflow:hidden">
    <div class="unp-wrap"><table class="unp-tbl" style="min-width:100%">
      <thead>${thead}</thead><tbody>${tbody}</tbody>
    </table></div></div>`;
}

/* ================================================================
   FEE SETTINGS
================================================================ */
function renderFeeView() {
  const ym = toYM(new Date());
  document.getElementById('fee-setting-view').innerHTML =
    ['male','female','manager','exec'].map(attr => {
      const adj  = S.fee.adjs.find(a => a.attr===attr && a.from<=ym && ym<=a.to);
      const base = attr==='exec' ? `${fmt(S.fee.base.exec)}/回` : fmt(S.fee.base[attr]);
      const adjHtml = adj
        ? `<div style="margin-top:4px;font-size:11px;color:var(--amb);background:var(--amb-l);padding:2px 7px;border-radius:4px">
             調整中: ${fmt(adj.amount)}${attr==='exec'?'/回':''}
           </div>` : '';
      return `<div class="fat-c">
        <div style="margin-bottom:6px">${attrBadge(attr)}</div>
        <div style="font-family:'DM Mono',monospace;font-size:16px;font-weight:500">${base}</div>
        ${attr==='exec'?'<div style="font-size:10px;color:var(--tx3)">回数×単価</div>':''}
        ${adjHtml}
      </div>`;
    }).join('');
}

function openFeeModal() {
  const b = S.fee.base;
  ['male','female','manager','exec'].forEach(k =>
    document.getElementById('fs-'+k).value = b[k]);
  renderAdjList(); openM('m-fee');
}

async function saveFee() {
  S.fee.base = {
    male:    parseInt(document.getElementById('fs-male').value)    || 0,
    female:  parseInt(document.getElementById('fs-female').value)  || 0,
    manager: parseInt(document.getElementById('fs-manager').value) || 0,
    exec:    parseInt(document.getElementById('fs-exec').value)    || 0,
  };
  closeM('m-fee'); toast('部費設定を保存しました ✓');
  render(); await saveFeeSettings();
}

function renderAdjList() {
  const el = document.getElementById('adj-list'); if (!el) return;
  el.innerHTML = S.fee.adjs.length===0
    ? '<div style="color:var(--tx3);font-size:12px;margin-bottom:8px">一時調整なし</div>'
    : S.fee.adjs.map(a => `
        <div class="adj-item">
          <span>${attrBadge(a.attr)} <span style="font-family:'DM Mono',monospace;font-size:12px">${fmt(a.amount)}</span></span>
          <span style="font-size:12px;color:var(--tx2)">${a.from}〜${a.to}</span>
          <button class="btn bd sm" onclick="delAdj(${a.id})">削除</button>
        </div>`).join('');
}

async function addAdj() {
  const attr   = document.getElementById('adj-attr').value;
  const amount = parseInt(document.getElementById('adj-amt').value);
  const from   = document.getElementById('adj-from').value;
  const to     = document.getElementById('adj-to').value;
  if (!amount||amount<0) { toast('金額を入力してください'); return; }
  if (!from||!to)        { toast('期間を入力してください'); return; }
  if (from>to)           { toast('開始・終了月を正しく設定してください'); return; }
  S.fee.adjs.push({ id:nid++, attr, amount, from, to });
  ['adj-amt','adj-from','adj-to'].forEach(id => document.getElementById(id).value='');
  renderAdjList(); toast('一時調整を追加しました ✓');
  await saveFeeSettings();
}

async function delAdj(id) {
  S.fee.adjs = S.fee.adjs.filter(a => a.id!==id);
  renderAdjList(); renderFeeView(); renderFee();
  await saveFeeSettings();
}

/* ================================================================
   REPORT
================================================================ */
function renderReport() {
  const monthly = {};
  S.txs.forEach(t => {
    const ym = t.date.slice(0,7);
    if (!monthly[ym]) monthly[ym] = { inc:0,exp:0,ci:0,co:0,bi:0,bo:0 };
    if (t.type==='income')  { monthly[ym].inc+=t.amount; t.acct==='cash'?monthly[ym].ci+=t.amount:monthly[ym].bi+=t.amount; }
    if (t.type==='expense') { monthly[ym].exp+=t.amount; t.acct==='cash'?monthly[ym].co+=t.amount:monthly[ym].bo+=t.amount; }
  });
  const ms = Object.keys(monthly).sort().reverse();

  const mel = document.getElementById('r-monthly');
  if (mel) mel.innerHTML = ms.length===0 ? '<div class="empty">データがありません</div>'
    : ms.map(ym => {
        const d=monthly[ym], bal=d.inc-d.exp;
        return `<div style="padding:7px 0;border-bottom:1px solid var(--bdr)">
          <div style="display:flex;justify-content:space-between;margin-bottom:2px">
            <span style="font-family:'DM Mono',monospace;font-size:12px">${ym}</span>
            <span style="font-size:13px;font-weight:500;color:${bal>=0?'var(--grn)':'var(--red)'}">${bal>=0?'+':''}${fmt(bal)}</span>
          </div>
          <div style="font-size:11px;color:var(--tx2)">
            現金 <span style="color:var(--grn)">${fmt(d.ci)}</span>/<span style="color:var(--red)">${fmt(d.co)}</span>
            銀行 <span style="color:var(--grn)">${fmt(d.bi)}</span>/<span style="color:var(--red)">${fmt(d.bo)}</span>
          </div></div>`;
      }).join('');

  const cats = {};
  S.txs.filter(t => t.type!=='transfer').forEach(t => {
    if (!cats[t.cat]) cats[t.cat] = { inc:0,exp:0 };
    if (t.type==='income') cats[t.cat].inc+=t.amount;
    else cats[t.cat].exp+=t.amount;
  });
  const cel = document.getElementById('r-cats');
  if (cel) cel.innerHTML = Object.keys(cats).sort().length===0 ? '<div class="empty">データがありません</div>'
    : Object.keys(cats).sort().map(k => {
        const d=cats[k];
        return `<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--bdr)">
          <span style="font-size:12px;background:var(--sur2);padding:2px 8px;border-radius:20px">${k}</span>
          <span style="font-size:13px">
            ${d.inc?`<span style="color:var(--grn)">${fmt(d.inc)}</span> `:''}
            ${d.exp?`<span style="color:var(--red)">-${fmt(d.exp)}</span>`:''}
          </span>
        </div>`;
      }).join('');

  renderTrendTable(monthly);
}

function renderTrendTable(monthly) {
  const el = document.getElementById('trend-table'); if (!el) return;
  const ms = Object.keys(monthly).sort();
  if (ms.length===0) { el.innerHTML='<tr><td class="empty">データがありません</td></tr>'; return; }
  let cum=0;
  el.innerHTML = `<thead><tr>
    <th>月</th>
    <th style="text-align:right">収入</th>
    <th style="text-align:right">支出</th>
    <th style="text-align:right">差引</th>
    <th style="text-align:right">累計残高</th>
  </tr></thead><tbody>${
    ms.map(ym => {
      const d=monthly[ym], bal=d.inc-d.exp; cum+=bal;
      return `<tr>
        <td style="font-family:'DM Mono',monospace;font-size:12px">${ym}</td>
        <td class="num" style="color:var(--grn)">${fmtN(d.inc)}</td>
        <td class="num" style="color:var(--red)">${fmtN(d.exp)}</td>
        <td class="num" style="color:${bal>=0?'var(--grn)':'var(--red)'};font-weight:500">${bal>=0?'+':''}${fmtN(bal)}</td>
        <td class="num" style="font-weight:600">${fmtN(cum)}</td>
      </tr>`;
    }).join('')
  }</tbody>`;
}

function renderChart() {
  const monthly = {};
  S.txs.filter(t => t.type!=='transfer').forEach(t => {
    const ym = t.date.slice(0,7);
    if (!monthly[ym]) monthly[ym] = { inc:0,exp:0 };
    if (t.type==='income') monthly[ym].inc+=t.amount;
    else monthly[ym].exp+=t.amount;
  });
  const labels  = Object.keys(monthly).sort();
  const incData = labels.map(l => monthly[l].inc);
  const expData = labels.map(l => monthly[l].exp);
  let cum=0;
  const balData = labels.map(l => { cum+=monthly[l].inc-monthly[l].exp; return cum; });
  const ctx = document.getElementById('trend-chart'); if (!ctx) return;
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    data: { labels, datasets: [
      { type:'bar',  label:'収入', data:incData, backgroundColor:'rgba(45,106,79,.65)', borderRadius:4, order:2 },
      { type:'bar',  label:'支出', data:expData, backgroundColor:'rgba(192,57,43,.65)', borderRadius:4, order:2 },
      { type:'line', label:'累計残高', data:balData, borderColor:'#1d4ed8', backgroundColor:'rgba(29,78,216,.08)', borderWidth:2, pointRadius:3, fill:true, tension:.3, order:1, yAxisID:'y2' },
    ]},
    options: {
      responsive:true, maintainAspectRatio:false,
      interaction: { mode:'index', intersect:false },
      plugins: { legend: { labels: { font:{ size:11 }, boxWidth:12 } } },
      scales: {
        x:  { ticks:{ font:{ size:11 } }, grid:{ display:false } },
        y:  { ticks:{ font:{ size:11 }, callback:v=>'¥'+v.toLocaleString() }, grid:{ color:'rgba(0,0,0,.05)' } },
        y2: { position:'right', ticks:{ font:{ size:11 }, callback:v=>'¥'+v.toLocaleString() }, grid:{ display:false } },
      },
    },
  });
}

/* ================================================================
   EXPORT
================================================================ */
function exportCSV() {
  const h = ['日付','口座','移動先','種別','金額','摘要','科目','備考'];
  const rows = S.txs
    .sort((a,b) => a.date.localeCompare(b.date))
    .map(t => [
      t.date,
      t.acct==='cash'?'現金':'銀行預金',
      t.type==='transfer'?(t.toAcct==='cash'?'現金':'銀行預金'):'',
      t.type==='income'?'収入':t.type==='expense'?'支出':'口座振替',
      t.amount, t.desc, t.cat, t.note,
    ]);
  const csv  = [h,...rows].map(r => r.map(v=>`"${v}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], { type:'text/csv;charset=utf-8' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `部活会計_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  toast('CSVをダウンロードしました ✓');
}

/* ================================================================
   MODAL / TOAST
================================================================ */
function openM(id)  { document.getElementById(id).classList.add('open'); }
function closeM(id) { document.getElementById(id).classList.remove('open'); }

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.mbg').forEach(m =>
    m.addEventListener('click', e => { if (e.target===m) m.classList.remove('open'); }));
});

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2200);
}

/* ================================================================
   BOTTOM SHEET — スマホ収支入力
================================================================ */

let bsType = 'income';
let bsAcct = 'cash';

function openBottomSheet() {
  const today = new Date();
  document.getElementById('bs-date').value    = today.toISOString().split('T')[0];
  document.getElementById('bs-tr-date').value = today.toISOString().split('T')[0];
  document.getElementById('bs-sheet').classList.add('open');
  document.getElementById('bs-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
  // 金額欄にフォーカス
  setTimeout(() => document.getElementById('bs-amt')?.focus(), 350);
}

function closeBottomSheet() {
  document.getElementById('bs-sheet').classList.remove('open');
  document.getElementById('bs-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

function setBsType(type, el) {
  bsType = type;
  el.closest('.bs-tog3').querySelectorAll('.bs-tbtn').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('bs-normal').style.display   = type === 'transfer' ? 'none' : 'block';
  document.getElementById('bs-transfer').style.display = type === 'transfer' ? 'block' : 'none';
}

function setBsAcct(acct, el) {
  bsAcct = acct;
  el.closest('.bs-tog2').querySelectorAll('.bs-abtn').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
}

async function addTxFromSheet() {
  if (bsType === 'transfer') {
    const amount = parseInt(document.getElementById('bs-tr-amt').value);
    const from   = document.getElementById('bs-tr-from').value;
    const to     = document.getElementById('bs-tr-to').value;
    const date   = document.getElementById('bs-tr-date').value;
    const desc   = document.getElementById('bs-tr-desc').value.trim() ||
                   `${from === 'cash' ? '現金' : '銀行'}→${to === 'cash' ? '現金' : '銀行'}`;
    if (!amount || amount <= 0) { toast('金額を入力してください'); return; }
    if (!date)                  { toast('日付を入力してください'); return; }
    if (from === to)            { toast('移動元と移動先が同じです'); return; }
    S.txs.push({ id: nid++, date, type: 'transfer', acct: from, toAcct: to, amount, desc, cat: '振替', note: '' });
    document.getElementById('bs-tr-amt').value  = '';
    document.getElementById('bs-tr-desc').value = '';
  } else {
    const amount = parseInt(document.getElementById('bs-amt').value);
    const desc   = document.getElementById('bs-desc').value.trim();
    const date   = document.getElementById('bs-date').value;
    const cat    = document.getElementById('bs-cat').value;
    const note   = document.getElementById('bs-note').value.trim();
    if (!amount || amount <= 0) { toast('金額を入力してください'); return; }
    if (!desc)                  { toast('摘要を入力してください'); return; }
    if (!date)                  { toast('日付を入力してください'); return; }
    S.txs.push({ id: nid++, date, type: bsType, acct: bsAcct, amount, desc, cat, note });
    document.getElementById('bs-amt').value  = '';
    document.getElementById('bs-desc').value = '';
    document.getElementById('bs-note').value = '';
  }
  closeBottomSheet();
  toast('追加しました ✓');
  render();
  await saveTx();
}

/* スマホ用フィルタをPCフィルタと同期して renderTx が両方に反映されるよう上書き */
const _origRenderTx = renderTx;
function renderTx() {
  // PCフィルタ
  const fa = document.getElementById('f-acct')?.value || '';
  const ft = document.getElementById('f-type')?.value || '';
  // SPフィルタ（存在する場合）
  const faSp = document.getElementById('f-acct-sp')?.value || '';
  const ftSp = document.getElementById('f-type-sp')?.value || '';

  const filterAcct = fa || faSp;
  const filterType = ft || ftSp;

  let txs = [...S.txs].sort((a, b) => b.date.localeCompare(a.date));
  if (filterAcct) txs = txs.filter(t => t.acct === filterAcct || (t.type === 'transfer' && t.toAcct === filterAcct));
  if (filterType) txs = txs.filter(t => t.type === filterType);

  const html = txs.length === 0
    ? '<div class="empty">取引がありません</div>'
    : txs.map(txRow).join('');

  const pcList = document.getElementById('tx-list');
  const spList = document.getElementById('tx-list-sp');
  if (pcList) pcList.innerHTML = html;
  if (spList) spList.innerHTML = html;
}

/* スワイプで閉じる（任意） */
(function initSwipeClose() {
  let startY = 0;
  const sheet = document.getElementById('bs-sheet');
  if (!sheet) return;
  sheet.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
  sheet.addEventListener('touchend', e => {
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 80) closeBottomSheet();
  }, { passive: true });
})();