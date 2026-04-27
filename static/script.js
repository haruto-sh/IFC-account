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
  CATEGORIES: 'categories',
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
  txs:[], members:[], feeRec:{}, pracCount:{}, categories:[],
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
  // URLハッシュにアクセストークンが含まれているか確認（リダイレクト後）
  const hashToken = parseTokenFromHash();
  if (hashToken) {
    accessToken = hashToken.token;
    // リダイレクト前に保存したメールアドレスを復元
    userEmail   = sessionStorage.getItem('pending_email') || '';
    sessionStorage.removeItem('pending_email');
    sessionStorage.setItem('gapi_token', JSON.stringify({
      token:  accessToken,
      email:  userEmail,
      expiry: Date.now() + (hashToken.expiresIn - 60) * 1000,
    }));
    // ハッシュをURLから除去（履歴に残さない）
    history.replaceState(null, '', location.pathname);
    startApp();
    return;
  }

  // sessionStorageに有効なトークンがあれば再利用
  tryRestoreToken();
}

function parseTokenFromHash() {
  const hash = location.hash.substring(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const token  = params.get('access_token');
  const expires = parseInt(params.get('expires_in') || '3600');
  if (!token) return null;
  return { token, expiresIn: expires, email: '' };
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
  // Google One Tap ボタンをレンダリング（IDトークン取得用）
  google.accounts.id.initialize({
    client_id: CLIENT_ID,
    callback: handleOneTap,
    auto_select: false,
  });
  google.accounts.id.renderButton(
    document.getElementById('google-signin-btn'),
    { theme:'outline', size:'large', text:'signin_with', locale:'ja', shape:'pill' }
  );
}

// One Tap でIDトークンを受け取った後、リダイレクトフローでアクセストークンを取得
function handleOneTap(response) {
  const payload = JSON.parse(atob(response.credential.split('.')[1]));
  userEmail = payload.email;
  sessionStorage.setItem('pending_email', userEmail);
  // リダイレクト方式でアクセストークンを要求（postMessageを使わないのでCOOP非該当）
  requestTokenViaRedirect();
}

function requestTokenViaRedirect() {
  const redirectUri = location.origin + location.pathname;
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'token',
    scope:         SCOPES,
    include_granted_scopes: 'true',
  });
  location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

function showLoginError() {
  document.getElementById('login-error').style.display = 'block';
}

function signOut() {
  sessionStorage.removeItem('gapi_token');
  sessionStorage.removeItem('pending_email');
  accessToken = null;
  location.href = location.origin + location.pathname;
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
      [SH.TX]:      [['id','date','type','acct','toAcct','amount','desc','classification','cat','note']],
      [SH.MEMBERS]: [['id','name','grade','attr']],
      [SH.FEE_REC]: [['id','member_id','ym','paid']],
      [SH.PRAC]:    [['id','member_id','ym','count']],
      [SH.FEE_SET]: [['id','attr','amount','type','from_ym','to_ym']],
      [SH.CATEGORIES]: [['type','classification','category','order']],
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

  const [txRows, mRows, frRows, pcRows, fsRows, catRows] = await Promise.all([
    sheetsGet(SH.TX      + '!A2:J'),
    sheetsGet(SH.MEMBERS + '!A2:D'),
    sheetsGet(SH.FEE_REC + '!A2:D'),
    sheetsGet(SH.PRAC    + '!A2:D'),
    sheetsGet(SH.FEE_SET + '!A2:F'),
    sheetsGet(SH.CATEGORIES + '!A2:D'),
  ]);

  S.txs = txRows
    .filter(r => r[0] && r[1] && r[2])  // id・date・typeが存在する行のみ
    .map(r => ({
      id:r[0]|0, date:String(r[1]), type:r[2], acct:r[3]||'cash',
      toAcct:r[4]||'', amount:r[5]|0, desc:r[6]||'', classification:r[7]||'その他', cat:r[8]||'その他', note:r[9]||'',
    }));

  S.members = mRows
    .filter(r => r[0] && r[1])  // id・nameが存在する行のみ
    .map(r => ({ id:r[0]|0, name:String(r[1]), grade:r[2]||'', attr:r[3]||'male' }));

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

  S.fee = { base:{ male:2000, female:2000, manager:1500, exec:500 }, maxExec:2500, adjs:[] };
  fsRows.forEach(r => {
    if (r[3]==='base') S.fee.base[r[1]] = r[2]|0;
    else if (r[3]==='maxExec') S.fee.maxExec = r[2]|0;
    else S.fee.adjs.push({ id:r[0]|0, attr:r[1], amount:r[2]|0, from:r[4], to:r[5] });
  });
  if (fsRows.length === 0) await saveFeeSettings();

  S.categories = catRows
    .filter(r => r[0] && r[1] && r[2])
    .map(r => ({ type:r[0], classification:r[1], category:r[2], order:r[3]|0 }))
    .sort((a,b) => a.order - b.order);

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
    S.txs.map(t => [t.id,t.date,t.type,t.acct,t.toAcct||'',t.amount,t.desc,t.classification||'',t.cat,t.note||'']));
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
  rows.push([rid++,'exec',S.fee.maxExec,'maxExec','','']);
  S.fee.adjs.forEach(a => rows.push([a.id,a.attr,a.amount,'adj',a.from,a.to]));
  await sheetsWriteAll(SH.FEE_SET, rows);
});

function showSaveInd(on) {
  const saveInd = document.getElementById('save-ind');
  const hbals = document.querySelector('.hbals');
  if (saveInd) {
    saveInd.style.display = on ? 'block' : 'none';
    saveInd.style.opacity = on ? '1' : '0';
  }
  if (hbals) {
    hbals.style.display = on ? 'none' : 'flex';
  }
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
    document.getElementById('bs-date').value   = today.toISOString().split('T')[0];
    document.getElementById('tr-date').value   = today.toISOString().split('T')[0];
    document.getElementById('fee-month').value = ym;
    render();
    setType('income');
    initializeCategories();
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
      if (t.acct==='cash') cash-=t.amount; else bank-=t.amount;
      if (t.toAcct==='cash') cash+=t.amount; else if (t.toAcct==='bank') bank+=t.amount;
    }
  });
  return { cash, bank, total:cash+bank };
}

function calcFee(attr, ym, pc) {
  const adj = S.fee.adjs.find(a => a.attr===attr && a.from<=ym && ym<=a.to);
  if (attr==='exec') {
    const per = adj ? adj.amount : S.fee.base.exec;
    const total = per * (pc||0);
    return Math.min(total, S.fee.maxExec||2500);
  }
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
    if (!t.date || !t.date.startsWith(ym)) return;
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
  if (!t || !t.date) return '';
  let acctBadge, amtStr, amtCls, catLabel;
  if (t.type === 'transfer') {
    acctBadge = `<span class="bdg transfer">振替</span>`;
    amtStr    = fmt(t.amount);
    amtCls    = 'transfer';
    catLabel  = `${t.acct==='cash'?'現金':'銀行'}→${t.toAcct==='cash'?'現金':'銀行'}`;
  } else {
    acctBadge = `<span class="bdg ${t.acct}">${t.acct==='cash'?'現金':'銀行'}</span>`;
    amtStr    = (t.type==='income'?'+':'-') + fmt(t.amount);
    amtCls    = t.type;
    catLabel  = t.classification ? `${t.classification} > ${t.cat}` : t.cat;
  }
  // 日付を m/d 形式に変換
  const dateParts = t.date.slice(5).split('-');
  const dateLabel = dateParts.length === 2
    ? `${parseInt(dateParts[0])}/${parseInt(dateParts[1])}`
    : t.date.slice(5);

  return `<div class="txr">
    <div class="txr-row1">
      <span class="txdate">${dateLabel}</span>
      ${acctBadge}
      <span class="txcat">${catLabel}</span>
    </div>
    <div class="txr-row2">
      <span class="txdesc">${t.desc}</span>
      <span class="txamt ${amtCls}">${amtStr}</span>
      <button class="btn bs sm" onclick="openEditTx(${t.id})" style="padding:4px 10px;font-size:11px;min-height:28px;flex-shrink:0">編集</button>
      <button class="btn bd sm" onclick="delTx(${t.id})"     style="padding:4px 10px;font-size:11px;min-height:28px;flex-shrink:0">削除</button>
    </div>
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

  // 科目分類を type に基づいて更新
  if (t !== 'transfer') {
    const txCls = document.getElementById('tx-cls');
    if (txCls) {
      const classifications = [...new Set(S.categories.filter(c => c.type === t).map(c => c.classification))];
      txCls.innerHTML = classifications.map((cls, idx) => `<option value="${cls}" ${idx===0 ? 'selected' : ''}>${cls}</option>`).join('');
      updateTxCategories();
    }
  }
}

function setAcct(a) {
  S.acct = a;
  document.getElementById('a-cash').classList.toggle('on', a==='cash');
  document.getElementById('a-bank').classList.toggle('on', a==='bank');
}

/* ================================================================
   CATEGORY SELECTION
================================================================ */
function initializeCategories() {
  // PC版の科目分類初期化
  const txCls = document.getElementById('tx-cls');
  if (txCls) {
    const classifications = [...new Set(S.categories.filter(c => c.type === 'income').map(c => c.classification))];
    txCls.innerHTML = classifications.map((cls, idx) => `<option value="${cls}" ${idx===0 ? 'selected' : ''}>${cls}</option>`).join('');
    updateTxCategories();
  }

  // モバイル版の科目分類初期化
  const bsCls = document.getElementById('bs-cls');
  if (bsCls) {
    const classifications = [...new Set(S.categories.filter(c => c.type === 'income').map(c => c.classification))];
    bsCls.innerHTML = classifications.map((cls, idx) => `<option value="${cls}" ${idx===0 ? 'selected' : ''}>${cls}</option>`).join('');
    updateBsCategories();
  }

  // 編集画面の科目分類初期化
  const etxCls = document.getElementById('etx-cls');
  if (etxCls) {
    const classifications = [...new Set(S.categories.filter(c => c.type === 'income').map(c => c.classification))];
    etxCls.innerHTML = classifications.map((cls, idx) => `<option value="${cls}" ${idx===0 ? 'selected' : ''}>${cls}</option>`).join('');
  }
}

function updateTxCategories() {
  const cls = document.getElementById('tx-cls')?.value || '';
  const cats = S.categories.filter(c => c.type === S.type && c.classification === cls).sort((a, b) => a.order - b.order);
  const catSelect = document.getElementById('tx-cat');
  if (catSelect) {
    catSelect.innerHTML = cats.map(c => `<option value="${c.category}">${c.category}</option>`).join('');
  }
}

function updateBsCategories() {
  const cls = document.getElementById('bs-cls')?.value || '';
  const cats = S.categories.filter(c => c.type === S.type && c.classification === cls).sort((a, b) => a.order - b.order);
  const catSelect = document.getElementById('bs-cat');
  if (catSelect) {
    catSelect.innerHTML = cats.map(c => `<option value="${c.category}">${c.category}</option>`).join('');
  }
}

function updateEditCategories() {
  const cls = document.getElementById('etx-cls')?.value || '';
  const cats = S.categories.filter(c => c.type === S.type && c.classification === cls).sort((a, b) => a.order - b.order);
  const catSelect = document.getElementById('etx-cat');
  if (catSelect) {
    catSelect.innerHTML = cats.map(c => `<option value="${c.category}">${c.category}</option>`).join('');
  }
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
    const classification = document.getElementById('tx-cls').value;
    const cat    = document.getElementById('tx-cat').value;
    const note   = document.getElementById('tx-note').value.trim();
    if (!date)           { toast('日付を入力してください'); return; }
    if (!amount||amount<=0) { toast('金額を正しく入力してください'); return; }
    if (!desc)           { toast('摘要を入力してください'); return; }
    S.txs.push({ id:nid++, date, type:S.type, acct:S.acct, amount, desc, classification, cat, note });
    ['tx-amt','tx-desc','tx-note'].forEach(id => document.getElementById(id).value='');
  }
  toast('追加しました ✓');
  render();
  await saveTx();
}

function openEditTx(id) {
  const t = S.txs.find(t => t.id === id);
  if (!t) return;
  document.getElementById('etx-id').value    = id;
  document.getElementById('etx-date').value  = t.date;
  document.getElementById('etx-amt').value   = t.amount;
  document.getElementById('etx-desc').value  = t.desc;
  document.getElementById('etx-note').value  = t.note || '';

  const isTransfer = t.type === 'transfer';
  document.getElementById('etx-normal').style.display   = isTransfer ? 'none' : 'block';
  document.getElementById('etx-transfer').style.display = isTransfer ? 'block' : 'none';

  if (isTransfer) {
    document.getElementById('etx-date').value    = t.date;
    document.getElementById('etx-amt').value     = t.amount;
    document.getElementById('etx-tr-from').value = t.acct;
    document.getElementById('etx-tr-to').value   = t.toAcct;
    document.getElementById('etx-tr-desc').value = t.desc;
  } else {
    // 種別ボタン & S.type 更新
    S.type = t.type;
    ['income','expense'].forEach(tp => {
      document.getElementById('etx-t-' + tp).classList.toggle('on', t.type === tp);
    });
    // 口座ボタン
    ['cash','bank'].forEach(ac => {
      document.getElementById('etx-a-' + ac).classList.toggle('on', t.acct === ac);
    });
    // 科目分類と科目
    const etxCls = document.getElementById('etx-cls');
    const classifications = [...new Set(S.categories.filter(c => c.type === t.type).map(c => c.classification))];
    etxCls.innerHTML = classifications.map((cls, idx) => `<option value="${cls}" ${idx===0 ? 'selected' : ''}>${cls}</option>`).join('');
    etxCls.value = t.classification || classifications[0];
    updateEditCategories();
    const catSelect = document.getElementById('etx-cat');
    catSelect.value = t.cat || catSelect.options[0]?.value || '';
  }
  openM('m-edit-tx');
}

async function saveEditTx() {
  const id = parseInt(document.getElementById('etx-id').value);
  const t  = S.txs.find(t => t.id === id);
  if (!t) return;

  const isTransfer = t.type === 'transfer';
  if (isTransfer) {
    t.date   = document.getElementById('etx-date').value;
    t.amount = parseInt(document.getElementById('etx-amt').value) || 0;
    t.acct   = document.getElementById('etx-tr-from').value;
    t.toAcct = document.getElementById('etx-tr-to').value;
    t.desc   = document.getElementById('etx-tr-desc').value.trim() ||
               `${t.acct==='cash'?'現金':'銀行'}→${t.toAcct==='cash'?'現金':'銀行'}`;
    if (t.acct === t.toAcct) { toast('移動元と移動先が同じです'); return; }
  } else {
    const typeOn = ['income','expense'].find(tp =>
      document.getElementById('etx-t-' + tp).classList.contains('on'));
    const acctOn = ['cash','bank'].find(ac =>
      document.getElementById('etx-a-' + ac).classList.contains('on'));
    t.type   = typeOn || t.type;
    t.acct   = acctOn || t.acct;
    t.date   = document.getElementById('etx-date').value;
    t.amount = parseInt(document.getElementById('etx-amt').value) || 0;
    t.desc   = document.getElementById('etx-desc').value.trim();
    t.classification = document.getElementById('etx-cls').value;
    t.cat    = document.getElementById('etx-cat').value;
    t.note   = document.getElementById('etx-note').value.trim();
  }
  closeM('m-edit-tx');
  toast('更新しました ✓');
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
      <td class="num">${t.date.replace(/-/g, '/')}</td><td>${label}</td>
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
  const clss = {};
  S.txs.filter(t => t.type!=='transfer').forEach(t => {
    if (!clss[t.classification]) clss[t.classification] = [];
    clss[t.classification].push(t);
  });
  let html = '';
  Object.keys(clss).sort().forEach(cls => {
    const txs = clss[cls].sort((a,b) => a.date.localeCompare(b.date));
    let total=0, rows='';
    txs.forEach(t => {
      const amt = t.type==='income' ? t.amount : -t.amount;
      total += amt;
      rows += `<tr>
        <td class="num">${t.date.replace(/-/g, '/')}</td><td>${t.desc}</td>
        <td class="num" style="font-size:11px;color:var(--tx2)">${t.classification} > ${t.cat}</td>
        <td><span class="bdg ${t.acct}">${t.acct==='cash'?'現金':'銀行'}</span></td>
        <td class="num" style="color:${t.type==='income'?'var(--grn)':'var(--red)'}">${t.type==='income'?'+':'-'}${fmtN(t.amount)}</td>
      </tr>`;
    });
    html += `<div class="card" style="padding:0;overflow:hidden;margin-bottom:10px">
      <div style="padding:10px 16px;font-weight:600;font-size:14px;border-bottom:1px solid var(--bdr);display:flex;justify-content:space-between">
        <span>${cls}</span>
        <span style="font-family:'DM Mono',monospace;font-size:13px;color:${total>=0?'var(--grn)':'var(--red)'}">${total>=0?'+':''}${fmtN(total)}</span>
      </div>
      <div style="overflow-x:auto"><table class="ltbl">
        <thead><tr><th>日付</th><th>摘要</th><th style="text-align:center">科目</th><th>口座</th><th style="text-align:right">金額</th></tr></thead>
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
    ? '<tr><td colspan="4" class="empty">部員がいません</td></tr>'
    : ms.map(m => `<tr>
        <td style="font-weight:500">${m.name}</td>
        <td style="color:var(--tx2)">${m.grade}</td>
        <td>${attrBadge(m.attr)}</td>
        <td style="text-align:right"><button class="btn bs sm" onclick="openEdit(${m.id})">編集</button></td>
      </tr>`).join('');
}

async function addMember() {
  const firstName = document.getElementById('ma-first-name').value.trim();
  const lastName  = document.getElementById('ma-last-name').value.trim();
  const grade     = document.getElementById('ma-grade').value;
  const attr      = document.getElementById('ma-attr').value;
  if (!firstName) { toast('姓を入力してください'); return; }
  if (!lastName)  { toast('名を入力してください'); return; }
  const name = `${firstName} ${lastName}`;
  S.members.push({ id:nid++, name, grade, attr });
  document.getElementById('ma-first-name').value = '';
  document.getElementById('ma-last-name').value = '';
  closeM('m-add'); toast('追加しました ✓');
  render(); await saveMembers();
}

function openEdit(id) {
  const m = S.members.find(m => m.id===id); if (!m) return;
  document.getElementById('me-id').value = id;
  const [firstName, lastName] = (m.name + ' ').split(' ');
  document.getElementById('me-first-name').value = firstName;
  document.getElementById('me-last-name').value = lastName.trim();
  document.getElementById('me-grade').value = m.grade;
  document.getElementById('me-attr').value = m.attr;
  openM('m-edit');
}

async function saveMember() {
  const id = parseInt(document.getElementById('me-id').value);
  const m  = S.members.find(m => m.id===id); if (!m) return;
  const firstName = document.getElementById('me-first-name').value.trim();
  const lastName  = document.getElementById('me-last-name').value.trim();
  if (!firstName) { toast('姓を入力してください'); return; }
  if (!lastName)  { toast('名を入力してください'); return; }
  m.name  = `${firstName} ${lastName}`;
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

/* ===== BULK OPERATIONS ===== */
function getSelectedMembers() {
  const checkboxes = document.querySelectorAll('.member-checkbox:checked');
  return Array.from(checkboxes).map(cb => parseInt(cb.value));
}

function updateBulkButtons() {
  const selected = getSelectedMembers();
  const changeBtn = document.getElementById('bulk-change-btn');
  const deleteBtn = document.getElementById('bulk-delete-btn');
  if (changeBtn) changeBtn.style.display = selected.length > 0 ? 'inline-block' : 'none';
  if (deleteBtn) deleteBtn.style.display = selected.length > 0 ? 'inline-block' : 'none';
}

function toggleSelectAll(checked) {
  document.querySelectorAll('.member-checkbox').forEach(cb => cb.checked = checked);
  updateBulkButtons();
}

async function bulkAddMembers() {
  const text = document.getElementById('bulk-members-text').value.trim();
  if (!text) { toast('入力してください'); return; }
  const lines = text.split('\n').filter(l => l.trim());
  let added = 0;
  for (const line of lines) {
    const [firstName, lastName, grade, attr] = line.split(',').map(s => s.trim());
    if (!firstName || !lastName || !grade || !attr) {
      toast(`形式が違う行があります: ${line}`);
      return;
    }
    if (!['26','25','24','23','22','21'].includes(grade)) {
      toast(`学年が不正です: ${grade}`);
      return;
    }
    if (!['male','female','manager','exec'].includes(attr)) {
      toast(`属性が不正です: ${attr}`);
      return;
    }
    const name = `${firstName} ${lastName}`;
    S.members.push({ id:nid++, name, grade, attr });
    added++;
  }
  closeM('m-bulk-add');
  document.getElementById('bulk-members-text').value = '';
  toast(`${added}名追加しました ✓`);
  render(); await saveMembers();
}

function bulkChangeAttr() {
  const selected = getSelectedMembers();
  if (selected.length === 0) { toast('部員を選択してください'); return; }
  const preview = document.getElementById('bulk-change-preview');
  const names = selected.map(id => S.members.find(m => m.id===id)?.name).join(', ');
  preview.textContent = `選択中の部員: ${names}`;
  openM('m-bulk-change-attr');
}

async function confirmBulkChangeAttr() {
  const selected = getSelectedMembers();
  const newAttr = document.getElementById('bulk-change-to-attr').value;
  if (!newAttr) { toast('属性を選択してください'); return; }
  selected.forEach(id => {
    const m = S.members.find(m => m.id===id);
    if (m) m.attr = newAttr;
  });
  closeM('m-bulk-change-attr');
  toast(`${selected.length}名の属性を変更しました ✓`);
  render(); await saveMembers();
}

async function bulkDelete() {
  const selected = getSelectedMembers();
  if (selected.length === 0) { toast('部員を選択してください'); return; }
  const names = selected.map(id => S.members.find(m => m.id===id)?.name).join(', ');
  if (!confirm(`以下の${selected.length}名を削除しますか？\n${names}`)) return;
  S.members = S.members.filter(m => !selected.includes(m.id));
  toast(`${selected.length}名削除しました`);
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
      ? `<input type="number" id="prac-${m.id}-${ym.replace('-','_')}" name="practice-count" min="0" max="31" value="${pc[m.id]||0}"
           style="width:62px;padding:8px;border:1px solid var(--bdr);border-radius:6px;font-size:16px;text-align:center"
           autocomplete="off"
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
  document.getElementById('fs-max-exec').value = S.fee.maxExec || 2500;
  renderAdjList(); openM('m-fee');
}

async function saveFee() {
  S.fee.base = {
    male:    parseInt(document.getElementById('fs-male').value)    || 0,
    female:  parseInt(document.getElementById('fs-female').value)  || 0,
    manager: parseInt(document.getElementById('fs-manager').value) || 0,
    exec:    parseInt(document.getElementById('fs-exec').value)    || 0,
  };
  S.fee.maxExec = parseInt(document.getElementById('fs-max-exec').value) || 2500;
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
    if (!t.date) return;
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

  const clss = {};
  S.txs.filter(t => t.type!=='transfer').forEach(t => {
    if (!clss[t.classification]) clss[t.classification] = { inc:0,exp:0 };
    if (t.type==='income') clss[t.classification].inc+=t.amount;
    else clss[t.classification].exp+=t.amount;
  });
  const cel = document.getElementById('r-cats');
  if (cel) cel.innerHTML = Object.keys(clss).sort().length===0 ? '<div class="empty">データがありません</div>'
    : Object.keys(clss).sort().map(k => {
        const d=clss[k];
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

let toastTimeout = null;
function toast(msg) {
  const el = document.getElementById('toast');

  // 前のタイムアウトをクリア
  if (toastTimeout) clearTimeout(toastTimeout);

  el.textContent = msg;
  el.classList.add('show');

  toastTimeout = setTimeout(() => {
    el.classList.remove('show');
    el.textContent = '';
  }, 2200);
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
  S.type = type;
  bsType = type;
  el.closest('.bs-tog3').querySelectorAll('.bs-tbtn').forEach(b => b.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('bs-normal').style.display   = type === 'transfer' ? 'none' : 'block';
  document.getElementById('bs-transfer').style.display = type === 'transfer' ? 'block' : 'none';

  // 科目分類を type に基づいて更新
  if (type !== 'transfer') {
    const bsCls = document.getElementById('bs-cls');
    if (bsCls) {
      const classifications = [...new Set(S.categories.filter(c => c.type === type).map(c => c.classification))];
      bsCls.innerHTML = classifications.map((cls, idx) => `<option value="${cls}" ${idx===0 ? 'selected' : ''}>${cls}</option>`).join('');
      updateBsCategories();
    }
  }
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
    const classification = document.getElementById('bs-cls').value;
    const cat    = document.getElementById('bs-cat').value;
    const note   = document.getElementById('bs-note').value.trim();
    if (!amount || amount <= 0) { toast('金額を入力してください'); return; }
    if (!desc)                  { toast('摘要を入力してください'); return; }
    if (!date)                  { toast('日付を入力してください'); return; }
    S.txs.push({ id: nid++, date, type: bsType, acct: bsAcct, amount, desc, classification, cat, note });
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

/* FAB は常時表示（スクロール制御なし） */