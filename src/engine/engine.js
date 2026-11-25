// Charcoal Run — the screens and logic from Kin's prototype, running on the Rails api.
//
// The screens are built as HTML strings (exactly as in the prototype) and drawn into
// #app / #bar. Everything that used to save into the prototype's document store now
// goes through the api; the app pulls changes from /sync every few seconds, so the
// office and the driver see each other's updates.
import { COMPANY } from "./company.js";

export function createEngine(ctx){
const api = ctx.api;
const ME = ctx.user; // {name, role, staff}
const who = () => S.role==="driver" ? "Driver" : "Admin";
let pendingRender = false, invNextT = null;
const seenLastMin = new Set(); // last-minute stops already animated in

function sgToday(){ return new Date(Date.now() + 8*3600e3).toISOString().slice(0,10); }
async function safe(p){
  try{ return await p; }
  catch(e){ toast(e && e.message ? e.message : "Not saved — check your connection"); scheduleSync(1500); return null; }
}
function saveBlob(blob, filename){
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href), 4000);
}
function applyLine(l){
  const d = l.date; if(!d) return;
  for(const k of Object.keys(S.days)) if(k!==d && S.days[k].lines && S.days[k].lines[l.id]) delete S.days[k].lines[l.id];
  const day = S.days[d] || (S.days[d] = {date:d, status:"draft", lines:{}});
  day.lines = day.lines || {};
  day.lines[l.id] = l;
}
function applyDay(dy){
  const cur = S.days[dy.date] || {lines:{}};
  S.days[dy.date] = Object.assign(cur, dy, {lines:cur.lines||{}});
}
function mergeCustomers(list){
  const by = Object.fromEntries(SERVER_CUSTOMERS.map(c=>[c.id,c]));
  list.forEach(c=>{ by[c.id] = c; });
  SERVER_CUSTOMERS = Object.values(by);
}
async function bulkLines(updates, what, date){
  if(!updates.length) return;
  const r = await safe(api("/lines", {method:"PATCH", body:{updates, log:what||"", log_date:date||TODAY}}));
  if(r){ r.lines.forEach(applyLine); render(); }
  if(what) localLog(date||TODAY, what);
}

/* ===================== state ===================== */
let TODAY = sgToday();
let SERVER_CUSTOMERS = [];
let CUSTOMERS = [];
let CM = {};
const TYPES = ["KB","KK","10KG","6KG","3KG","KB15","KK15","NB","FS","CW","B"];
const LOAD_ORDER = ["KB","KK","10KG","6KG","3KG","KB15","KK15","NB","FS"];
const DIV = {KB:1,KK:1,"10KG":1,"6KG":1,"3KG":1,KB15:2,KK15:2,NB:3};
const PAYNAME = {cash:"Cash",paynow:"Bank",account:"Monthly a/c",delayed:"Delayed cash",unpaid:"Not paid"};
const PAYCLS  = {cash:"c-ok",paynow:"c-ok",account:"c-acct",delayed:"c-warn",unpaid:"c-warn"};
const DEFPAY  = {C:"cash",PN:"paynow",M:"account",DC:"unpaid"};
const PAYFULL = {C:"Cash",PN:"Bank",M:"Monthly",DC:"Delayed cash"};
const DRVPAY = {cash:"Cash", paynow:"Bank", account:"Mth invoice", unpaid:"Not paid"};
const DRVDEF = {C:"cash", PN:"unpaid", M:"account", DC:"unpaid"};
const METH = {bank:"Bank", cash:"Cash", cheque:"Cheque"};
function drvPick(l){ if(S.dpick[l.id]) return S.dpick[l.id]; if(l.status==="delivered") return l.payStatus==="delayed"?"unpaid":l.payStatus; return DRVDEF[l.pay]||"cash"; }
function drvLabel(ps){ return ps==="cash"?"Cash":ps==="paynow"?"Bank":ps==="account"?"Mth invoice":"Not paid"; }
function drvUsual(pay){ return pay==="M"?"Mth invoice":pay==="PN"?"pays by bank &mdash; tap Not paid":pay==="DC"?"not paid on the spot":"Cash"; }
const paidChip = l => `<span class="chip c-ok">Paid${l.setMethod?" &middot; "+(METH[l.setMethod]||l.setMethod):""}</span>`;

/* ---- restaurants: one restaurant, up to 4 charcoal types (each type is a "product" with its own price + terms) ---- */
const SHARED = ["name","billing","addr","postal","tel","emails","cycle","cycleWeeks","needPhoto","aliases","area","rpos","waNums","contacts"];
const fmtPhone = v => { const d=String(v||"").replace(/\D/g,""); if(!d) return "";
  const n = d.length===8 ? "65"+d : d; return "+"+n.slice(0,2)+" "+n.slice(2,6)+" "+n.slice(6); };
function sendTo(c){ const cs=(c&&c.contacts)||[]; const e=cs.filter(x=>x.invE&&x.email).map(x=>x.email), w=cs.filter(x=>x.invW&&x.wa).map(x=>x.wa);
  return (e.length||w.length) ? [e.length?"Email: "+e.join(", "):"", w.length?"WhatsApp: "+w.join(", "):""].filter(Boolean).join(" · ") : "no invoice contact yet"; }
function shiftDate(base, n){ const [y,m,d]=String(base).split("-").map(Number); return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10); }
let RESTS = {}, RLIST = [], ALLCM = {};
const acctOf = cid => (ALLCM[cid]||{}).acct || cid;
const RM = cid => RESTS[acctOf(cid)] || null;

/* ---- route: areas in driving order ---- */
const AREAS = [
  {id:"rc",  name:"Race Course / Serangoon Rd", pfx:["21"]},
  {id:"sa",  name:"Syed Alwi / Kitchener / Jalan Besar", pfx:["20"]},
  {id:"bl",  name:"Balestier / Toa Payoh", pfx:["30","31","32","33"]},
  {id:"bg",  name:"Bugis / Beach Rd", pfx:["18","19"]},
  {id:"ch",  name:"City Hall / Marina", pfx:["17","03"]},
  {id:"cbd", name:"CBD / Lau Pa Sat / Chinatown", pfx:["01","04","05","06","07","08"]},
  {id:"bm",  name:"Bukit Merah / Tiong Bahru", pfx:["15","16"]},
  {id:"or",  name:"Orchard / Killiney", pfx:["22","23","24","25"]},
  {id:"st",  name:"Sentosa / HarbourFront", pfx:["09","10"]},
  {id:"est", name:"Geylang / East / North-East", pfx:["34","35","36","37","38","39","40","41","42","43","44","45","46","47","48","49","50","51","52","53","54","55"]},
  {id:"nth", name:"North &mdash; Yishun / Mandai / Seletar", pfx:["56","57","72","73","75","76","77","78","79","80","81","82"]},
  {id:"wst", name:"West", pfx:["11","12","13","14","26","27","28","29","58","59","60","61","62","63","64","65","66","67","68","69","70","71"]},
  {id:"none",name:"No postal code yet", pfx:[]}];
const AM = Object.fromEntries(AREAS.map(a=>[a.id,a]));
function areaOf(r){ if(!r) return "none"; if(r.area && AM[r.area]) return r.area;
  const pc=String(r.postal||"").replace(/\D/g,""); if(pc.length<6) return "none";
  const a=AREAS.find(x=>x.pfx.includes(pc.slice(0,2))); return a?a.id:"none"; }
function routeOrder(){ const r=(S.custEdits&&S.custEdits.route)||[]; const ids=r.filter(x=>AM[x]); AREAS.forEach(a=>{ if(!ids.includes(a.id)) ids.push(a.id); }); return ids; }
const areaRank = id => routeOrder().indexOf(id);
const rposOf = r => (r && r.rpos!=null && r.rpos!=="") ? +r.rpos : (parseInt(String((r||{}).postal||"").replace(/\D/g,""))||999999);
function routeKey(l){ const r=RM(l.cust)||{}; return [areaRank(areaOf(r)), rposOf(r), String(r.id||l.cust), LOAD_ORDER.indexOf(l.type)]; }
function routeSort(ls){ return ls.slice().sort((a,b)=>{ const x=routeKey(a), y=routeKey(b);
  for(let i=0;i<x.length;i++){ if(x[i]<y[i]) return -1; if(x[i]>y[i]) return 1; } return 0; }); }

const S = {
  role: (!ME.staff || window.matchMedia("(max-width:700px)").matches) ? "driver" : "admin",
  days: {},
  audit: {},
  open: null,            // driver: open stop id
  tab: "today",          // admin tab
  adminDate: TODAY,
  draft: {},             // admin tabulate draft { custId: qty }
  filt: {from:shiftDate(TODAY,-14), to:TODAY, cust:"", pay:"", bill:""},
  cust: null,            // restaurant drill-in
  gridQ: "", gridAll: false,
  inv: {moves:{}},
  mv: {},
  costs: {shipments:{}, overheads:{}}, costWin: 6, sf: null, photoIds: {},
  wa: null, waf: {}, waPaste: false, dpick: {}, dsel: {}, cashIn: {}, pc: null, payMethod: "bank", adding: false, addQ: "", addDate: "", sec: null, confirm: false,
  dview: "run", drq: "", drTab: "all", drOpen: null,
  thumbs: {}, fullPh: {}, bcur: null, bshot: null, bbusy: false, lb: null,
  bq: [], bqRunning: 0, aiOk: null, bqMode: "glass", splits: [],
  no: {cust:"", q:"", price:"", date:""}, noOpen: false,
  custEdits: {route:[]}, cf: null,
  month: shiftDate(TODAY.slice(0,7)+"-01", -1).slice(0,7),
  bills: {next:2779, map:{}}, invView: null, invPick: null, invCut: "", stView: null, editNo: false,
  pick: {}, remark: "",
};

/* ===================== helpers ===================== */
const $ = s => document.querySelector(s);
const esc = s => String(s==null?"":s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const money = n => "$" + (Math.round(n*100)/100).toLocaleString("en-SG",{minimumFractionDigits:(n%1?2:0),maximumFractionDigits:2});
const D = s => new Date(s+"T00:00:00+08:00");
const TZ = "Asia/Singapore";
const fmtD = s => D(s).toLocaleDateString("en-SG",{timeZone:TZ,weekday:"short",day:"numeric",month:"short"});
const fmtDL = s => D(s).toLocaleDateString("en-SG",{timeZone:TZ,weekday:"long",day:"numeric",month:"long",year:"numeric"});
const fmtDM = s => D(s).toLocaleDateString("en-SG",{timeZone:TZ,day:"numeric",month:"short"});
const fmtDD = s => D(s).toLocaleDateString("en-SG",{timeZone:TZ,weekday:"long",day:"numeric",month:"short"});
const fmtT = s => s ? new Date(s).toLocaleString("en-SG",{timeZone:TZ,day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit",hour12:true}) : "";
const dayKeys = () => Object.keys(S.days).sort();
const lines = d => Object.values((S.days[d]||{}).lines||{}).sort((a,b)=>a.seq-b.seq);
const calc = l => Math.round(((l.status==="skipped"?0:(l.qtyDel??l.qty)) * (l.price||0))*100)/100;
const amt = l => (l.total!=null ? l.total : calc(l));
function freeze(l){ l.total = calc(l); return l; }
const nameOf = id => (CM[id]||ALLCM[id]||{}).name || id;

function toast(m){ const t=$("#toast"); t.textContent=m; t.classList.add("on"); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove("on"),2200); }

function loadList(d){
  const acc={}, ls=lines(d);
  for(const l of ls){ const t=(l.type||"KB").toUpperCase(); acc[t]=(acc[t]||0)+(l.status==="skipped"?0:(l.qtyDel??l.qty)); }
  let tot=0; for(const t of LOAD_ORDER) if(acc[t]) tot += acc[t]/(DIV[t]||1);
  return {acc, tot:Math.round(tot*100)/100};
}
const dayGap = (a,b) => Math.round((D(b)-D(a))/864e5);
function billable(l){ return l.status==="delivered" && (l.payStatus==="account"||l.payStatus==="delayed"||l.payStatus==="unpaid"); }
function deliveredBy(d){
  const acc={};
  for(const l of lines(d)) if(l.status==="delivered") { const t=(l.type||"KB").toUpperCase(); acc[t]=Math.round(((acc[t]||0)+(l.qtyDel??l.qty))*100)/100; }
  return acc;
}
function lorrySpace(acc){ let t=0; for(const k of LOAD_ORDER) if(acc[k]) t+=acc[k]/(DIV[k]||1); return Math.round(t*100)/100; }
function gridDates(){ const out=[]; for(let i=-20;i<=7;i++) out.push(shiftDate(TODAY,i)); return out; }
function consumption(d){
  const took=(S.days[d]||{}).load||{}, left=(S.days[d]||{}).left||{}, del=deliveredBy(d), out={};
  for(const t of LOAD_ORDER){
    const hasT = took[t]!=null, hasL = left[t]!=null;
    out[t] = (hasT||hasL) ? Math.round(((hasT?took[t]:0) - (hasL?left[t]:0))*100)/100 : (del[t]||0);
    if(out[t]<0) out[t]=0;
  }
  return out;
}
function invMoves(){ return Object.entries((S.inv||{}).moves||{}).map(([id,m])=>({id,...m})).sort((a,b)=>String(b.at).localeCompare(String(a.at))); }
function stockOf(t){
  const ms = invMoves().filter(m=>m.type===t);
  const check = ms.filter(m=>m.kind==="check").sort((a,b)=>String(b.date).localeCompare(String(a.date)))[0];
  const since = check ? check.date : "0000-00-00";
  const base = check ? +check.qty : 0;
  const ins = ms.filter(m=>m.kind==="in" && m.date>since).reduce((s,m)=>s+(+m.qty||0),0);
  let out=0; for(const d of dayKeys()) if(d>since && d<=TODAY) out += (consumption(d)[t]||0);
  return {stock: Math.round((base+ins-out)*100)/100, base, ins, out: Math.round(out*100)/100, check};
}
function lastDelivery(cid, beforeDate){
  for(const d of dayKeys().slice().reverse()){
    if(beforeDate && d>=beforeDate) continue;
    const l = lines(d).find(x=>x.cust===cid && x.status==="delivered");
    if(l) return {date:d, ...l};
  }
  return null;
}
function priceChangeAt(cid, date){
  const ps = (((CM[cid]||{}).prices)||[]).filter(p=>p.from<=date)
    .sort((a,b)=>a.from.localeCompare(b.from) || String(a.at).localeCompare(String(b.at)));
  return ps.pop() || null;
}
function priceFrom(cid, beforeDate){
  const l = lastDelivery(cid, beforeDate);
  const ch = priceChangeAt(cid, beforeDate || "9999-12-31");
  if(ch && (!l || ch.from > l.date)) return ch.price;
  if(l && l.price) return l.price;
  return (CM[cid]||{}).price || 0;
}
function custHistory(cid, limit){
  const out=[];
  for(const d of dayKeys().slice().reverse()){
    for(const l of lines(d)) if(l.cust===cid) out.push({date:d, ...l});
    if(limit && out.length>=limit) break;
  }
  return limit ? out.slice(0,limit) : out;
}
function restHistory(cid, limit){
  const aid = acctOf(cid), out=[];
  for(const d of dayKeys().slice().reverse()){
    for(const l of lines(d)) if(acctOf(l.cust)===aid) out.push({date:d, ...l});
    if(limit && out.length>=limit) break;
  }
  return limit ? out.slice(0,limit) : out;
}
function owingRows(cid){ return restHistory(cid).filter(l=>billable(l) && !l.settled); }
function outstanding(cid){ return owingRows(cid).reduce((s,l)=>s+amt(l),0); }
const INVPFX = "SG-";
const invNo = n => INVPFX + String(n).padStart(5,"0");
const DESC = {KB:"Charcoal 30kgs", KK:"Charcoal 30kgs", KB15:"Charcoal 15kgs",
  KK15:"Charcoal 15kgs", NB:"Charcoal 10kgs", "10KG":"Charcoal 10kgs",
  "6KG":"Charcoal 6x5kgs", "3KG":"Charcoal 3x10kgs", FS:"Charcoal FS", CW:"Charcoal CW"};
const descOf = t => (DESC[String(t||"").toUpperCase()] || ("Charcoal "+t));
const NOBILL = "-";
function normBill(v){ const t=String(v||"").trim(); return /^[-\u2013\u2014]+$/.test(t) ? NOBILL : t; }
function billCell(b){ if(!b) return '<span class="muted">—</span>'; return b===NOBILL ? '<span class="muted tny">no bill</span>' : esc(b); }
function nextBill(){
  let m=24500;
  for(const d of dayKeys()) for(const l of lines(d)){ const n=+l.bill; if(l.bill && !isNaN(n) && n>m) m=n; }
  return m+1;
}

/* ===================== persistence ===================== */
async function saveLine(date, line, what){
  const day = S.days[date]; if(!day) return;
  if(day.status==="processed"){ line.late = true; if(what) what = "After processing — " + what; }
  freeze(line);
  day.lines[line.id] = line;
  render();
  const r = await safe(api("/lines/"+line.id, {method:"PATCH", body:{line, log:what||""}}));
  if(r){ applyLine(r.line); render(); }
  if(what) localLog(date, what);
}
async function saveDay(date, patch, what){
  S.days[date] = Object.assign(S.days[date]||{date,lines:{}}, patch);
  render();
  const r = await safe(api("/days/"+date, {method:"PATCH", body:{day:patch, log:what||""}}));
  if(r){ applyDay(r.day); render(); }
  if(what) localLog(date, what);
}
async function saveCount(date, kind, type, val){
  const day = S.days[date]; if(!day) return;
  const next = Object.assign({}, day[kind]||{});
  if(val==="" || val==null || isNaN(+val)) delete next[type]; else next[type] = +val;
  await saveDay(date, {[kind]:next}, `${kind==="load"?"Loaded out":"Leftover"} ${type}: ${val===""?"cleared":val}`);
}
async function upsertCell(date, cid, val, quiet){
  if(date < TODAY){ toast("Past days are locked — fix it in Deliveries"); return; }
  const c = CM[cid]; if(!c) return;
  let day = S.days[date];
  if(!day){ day = {date, status:"draft", lines:{}}; S.days[date]=day; }
  const existing = Object.values(day.lines).find(l=>l.cust===cid);
  const q = (val===""||val==null) ? 0 : +val;
  if(!q || isNaN(q)){
    if(existing){
      delete day.lines[existing.id];
      await safe(api("/lines/"+existing.id, {method:"DELETE", body:{log:`Removed ${c.name} from ${fmtD(date)}`}}));
      localLog(date, `Removed ${c.name} from ${fmtD(date)}`);
    }
  } else if(existing){
    existing.qty = q; if(existing.status==="pending") existing.qtyDel = q;
    existing.by = "Admin"; existing.at = new Date().toISOString(); freeze(existing);
    const what = `${c.name} ${fmtD(date)} — quantity set to ${q} ${existing.type}`;
    const r = await safe(api("/lines/"+existing.id, {method:"PATCH", body:{line:existing, log:what}}));
    if(r) applyLine(r.line);
    localLog(date, what);
  } else {
    const fresh = !!(day.status && day.status!=="draft");
    const nl = {cust:cid, date, qty:q, qtyDel:q, type:c.type, price:priceFrom(cid, date), pay:c.pay,
      seq:Object.keys(day.lines).length+1, status:"pending", payStatus:"unpaid", by:"Admin", at:new Date().toISOString()};
    if(fresh){ nl.fresh=true; nl.addedAt=nl.at; }
    const what = `${c.name} ${fmtD(date)} — ${fresh?"new order after dispatch, ":""}added ${q} ${c.type}`;
    const r = await safe(api("/lines", {method:"POST", body:{line:nl, log:what}}));
    if(r){ applyLine(r.line); applyDay(r.day); }
    localLog(date, what);
  }
  if(quiet) patchGridCol(date); else render();
}
function patchGridCol(date){
  const td = document.querySelector(`td.c input[data-d="${date}"]`);
  document.querySelectorAll(`td.c input[data-d="${date}"]`).forEach(inp=>{
    inp.parentElement.classList.toggle("ed", inp.value!=="" && +inp.value>0);
  });
  const L = loadList(date), n = lines(date).length;
  const idx = gridDates().indexOf(date);
  const foot = document.querySelectorAll("table.grid tfoot td.c")[idx];
  if(foot) foot.innerHTML = n ? L.tot+"<br>"+n : "";
}
async function addOrder(date, cid, qty, price){
  const c = CM[cid]; if(!c) return;
  const day = S.days[date] || {date, status:"draft", lines:{}};
  const dispatched = day.status && day.status !== "draft";
  const nl = {cust:cid, date, qty:+qty||1, qtyDel:+qty||1, type:c.type,
    price:(price!==""&&price!=null&&!isNaN(+price)) ? +price : priceFrom(cid, date), pay:c.pay,
    seq:Object.keys(day.lines).length+1, status:"pending", payStatus:"unpaid", by:who(), at:new Date().toISOString()};
  if(dispatched && S.role !== "driver"){ nl.fresh = true; nl.addedAt = nl.at; }
  const what = `${dispatched?"New order after dispatch — ":"Added — "}${c.name}: ${nl.qty} ${nl.type} at ${money(nl.price)}`;
  const r = await safe(api("/lines", {method:"POST", body:{line:nl, log:what}}));
  if(!r) return null;
  applyLine(r.line); applyDay(r.day);
  render();
  localLog(date, what);
  return S.days[date].lines[r.line.id];
}
async function ackFresh(date){
  const day = S.days[date]; if(!day) return;
  const f = Object.values(day.lines).filter(l=>l.fresh);
  f.forEach(l=>{ delete l.fresh; });
  render();
  const what = `Driver saw ${f.length} new order${f.length===1?"":"s"}`;
  await bulkLines(f.map(l=>({id:l.id, fresh:false})), what, date);
}
function unbilled(cid){ return restHistory(cid).filter(l=>billable(l) && !l.inv); }
function cycleOf(c){
  const w = +c.cycleWeeks||0;
  if(c.cycle==="request") return {kind:"request", label:"On request"};
  if(c.cycle==="weeks" && w) return {kind:"weeks", w, label:"Every "+w+" weeks"};
  return {kind:"monthly", label:"Monthly"};
}
function dueState(c, rows){
  if(!rows.length) return {due:false, why:"nothing outstanding"};
  const oldest = rows[rows.length-1].date, age = dayGap(oldest, TODAY), cy = cycleOf(c);
  if(cy.kind==="request") return {due:false, why:"waiting for you", age};
  if(cy.kind==="weeks") return {due: age >= cy.w*7, why: age>=cy.w*7 ? "past "+cy.w+" weeks" : (cy.w*7-age)+"d to go", age};
  const ended = oldest.slice(0,7) < TODAY.slice(0,7);
  return {due: ended, why: ended ? "month closed" : "current month", age};
}
function monthRows(cid, m){ return restHistory(cid).filter(l=>billable(l) && l.date.startsWith(m)); }
function monthlyCusts(m){
  return RLIST.map(c=>{
    if(cycleOf(c).kind!=="monthly") return null;
    const rows = monthRows(c.id, m); if(!rows.length) return null;
    const un = rows.filter(l=>!l.inv);
    return {c, rows, un, total: rows.reduce((t,l)=>t+amt(l),0), invs:[...new Set(rows.map(l=>l.inv).filter(Boolean))]};
  }).filter(Boolean).sort((a,b)=>(a.c.name||"").localeCompare(b.c.name||""));
}
function offCycle(){
  return RLIST.map(c=>{
    if(cycleOf(c).kind==="monthly") return null;
    const rows = owingRows(c.id); if(!rows.length) return null;
    const un = rows.filter(l=>!l.inv);
    return {c, rows, un, total: rows.reduce((t,l)=>t+amt(l),0), oldest: rows[rows.length-1].date, ...dueState(c, rows)};
  }).filter(Boolean).sort((a,b)=>(b.age||0)-(a.age||0));
}
function readyToBill(){
  return RLIST.map(c=>{
    const rows = unbilled(c.id);
    if(!rows.length) return null;
    const total = rows.reduce((t,l)=>t+amt(l),0);
    return {c, rows, total, oldest: rows[rows.length-1].date, newest: rows[0].date, ...dueState(c, rows)};
  }).filter(Boolean).sort((a,b)=>(b.due?1:0)-(a.due?1:0) || (b.age||0)-(a.age||0));
}
function rebuildCustomers(){
  // last delivery and deliveries in the last 90 days, worked out from the lines we hold
  const stats = {}, cut = shiftDate(TODAY, -90), newCut = shiftDate(TODAY, -30);
  for(const d of Object.keys(S.days)) for(const l of Object.values(S.days[d].lines||{})){
    if(l.status==="skipped") continue;
    const s = stats[l.cust] = stats[l.cust] || {last:null, n90:0};
    if(l.status==="delivered" && (!s.last || d>s.last)) s.last = d;
    if(d>=cut) s.n90++;
  }
  const all = SERVER_CUSTOMERS.map(c=>{ const s = stats[c.id] || {};
    const fresh = c.createdAt && c.createdAt.slice(0,10) >= newCut ? 1 : 0;
    return Object.assign({}, c, {last:s.last||null, n90:Math.max(s.n90||0, fresh)}); });
  ALLCM = Object.fromEntries(all.map(c=>[c.id,c]));
  CUSTOMERS = all.filter(c=>!c.retired);
  CM = Object.fromEntries(CUSTOMERS.map(c=>[c.id,c]));
  RESTS = {};
  CUSTOMERS.forEach(c=>{ (RESTS[c.acct] = RESTS[c.acct] || {id:c.acct, products:[]}).products.push(c); });
  const blank = v => v==null || v==="" || (Array.isArray(v) && !v.length);
  Object.values(RESTS).forEach(r=>{
    r.products.sort((a,b)=>LOAD_ORDER.indexOf(a.type)-LOAD_ORDER.indexOf(b.type) || (+a.id)-(+b.id));
    const prim = r.products[0];
    SHARED.forEach(f=>{
      let v = prim[f];
      if(f==="aliases"||f==="waNums") v = [...new Set(r.products.flatMap(p=>p[f]||[]))];
      else if(blank(v)){ const o=r.products.find(p=>!blank(p[f])); if(o) v=o[f]; }
      r[f]=v; r.products.forEach(p=>{ p[f]=v; });
    });
    r.contacts = r.contacts || [];
    r.emails = r.contacts.filter(x=>x.invE && x.email).map(x=>x.email).join(", ");
    r.products.forEach(p=>{ p.contacts = r.contacts; p.emails = r.emails; });
    r.n90 = r.products.reduce((t,p)=>t+(+p.n90||0),0);
    r.last = r.products.map(p=>p.last).filter(Boolean).sort().pop() || null;
    r.terms = [...new Set(r.products.map(p=>PAYFULL[p.pay]||p.pay))].join(" / ");
  });
  RLIST = Object.values(RESTS).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
}
async function saveCustMany(writes, what){
  const r = await safe(api("/restaurants/save", {method:"POST", body:{writes, log:what||""}}));
  if(r){ mergeCustomers(r.customers); rebuildCustomers(); }
  render();
  if(what) localLog(TODAY, what);
}
async function saveRoute(order){
  S.custEdits.route = order; render();
  await safe(api("/settings/route", {method:"PUT", body:{value:order}}));
}

/* ---- cash the driver hands over ---- */
function driverDebtCash(date){
  const out=[];
  for(const d of dayKeys()) for(const l of lines(d))
    if(l.settled && l.setBy==="Driver" && l.setMethod==="cash" && l.setDay===date) out.push({date:d, ...l});
  return out;
}
function cashExpected(date){
  const st = lines(date).filter(l=>l.status==="delivered" && l.payStatus==="cash");
  const db = driverDebtCash(date);
  const stopAmt = st.reduce((t,l)=>t+amt(l),0), debtAmt = db.reduce((t,l)=>t+amt(l),0);
  return {stops:st.length, stopAmt, debts:db.length, debtAmt, total:Math.round((stopAmt+debtAmt)*100)/100};
}
function cashState(date){
  const e = cashExpected(date), rec = (S.days[date]||{}).cashIn;
  if(!rec) return {e, rec, st: e.total ? "wait" : "none"};
  if(rec.amt===e.total || (rec.ok && rec.exp===e.total)) return {e, rec, st:"done"};
  return {e, rec, st: rec.exp!==e.total && rec.amt===rec.exp ? "changed" : "diff"};
}
function cashDays(){
  return dayKeys().filter(d=>d<=TODAY && dayGap(d,TODAY)<=45 && (d<TODAY || (S.days[d]||{}).status==="processed"))
    .map(d=>({d, ...cashState(d)})).filter(x=>x.st!=="none").reverse();
}
async function saveCash(date, amount, remark, accept){
  const e = cashExpected(date), prev = (S.days[date]||{}).cashIn || {};
  const rec = accept
    ? Object.assign({}, prev, {ok:true, exp:e.total, okAt:new Date().toISOString(), okBy:"Admin", okRemark:remark||prev.remark||""})
    : {amt:Math.round(amount*100)/100, exp:e.total, at:new Date().toISOString(), by:"Admin", remark:remark||"", ok:false};
  await saveDay(date, {cashIn:rec}, accept
    ? `Cash ${fmtD(date)} — difference of ${money(rec.amt-e.total)} accepted${remark?" — "+remark:""}`
    : `Cash ${fmtD(date)} — received ${money(rec.amt)} from driver (expected ${money(e.total)})${remark?" — "+remark:""}`);
}

/* ---- leftover the driver should have ---- */
function leftExpected(date){
  const plan = loadList(date).acc, took = (S.days[date]||{}).load||{}, del = deliveredBy(date), out={};
  LOAD_ORDER.forEach(t=>{ const tk = took[t]!=null ? took[t] : (plan[t]||0);
    if(tk || del[t]) out[t] = Math.max(0, Math.round((tk-(del[t]||0))*100)/100); });
  return out;
}
function leftDiffs(date){
  const ex = leftExpected(date), left = (S.days[date]||{}).left||{};
  if(!Object.keys(left).length) return [];
  return Object.keys(ex).filter(t=>(left[t]||0)!==ex[t]).map(t=>({t, ex:ex[t], got:left[t]||0, d:Math.round(((left[t]||0)-ex[t])*100)/100}));
}
async function saveCust(id, fields, what){ await saveCustMany({[id]:fields}, what); }
async function issueInvoice(cid, rows, monthLabel){
  const c = CM[cid] || RESTS[acctOf(cid)]; if(!c || !rows.length) return null;
  const tot = Math.round(rows.reduce((t,l)=>t+amt(l),0)*100)/100;
  const r = await safe(api("/invoices", {method:"POST", body:{line_ids:rows.map(l=>l.id), period:monthLabel||"",
    log:`Invoice ${invNo(S.bills.next)} issued — ${c.name}, ${rows.length} deliveries ${fmtD(rows[rows.length-1].date)} to ${fmtD(rows[0].date)}, ${money(tot)}`}}));
  if(!r) return null;
  r.lines.forEach(applyLine);
  S.bills.map = S.bills.map||{}; S.bills.map[r.invoice.no] = r.invoice;
  S.bills.next = r.next;
  localLog(TODAY, `Invoice ${r.invoice.no} issued — ${c.name}`);
  return r.invoice;
}
async function markSent(no){
  const rec = S.bills.map[no]; if(!rec) return;
  rec.status = "sent"; rec.sentAt = new Date().toISOString();
  render();
  const what = `Invoice ${no} emailed to ${rec.emails||"(no address on file)"}`;
  const r = await safe(api("/invoices/"+encodeURIComponent(no), {method:"PATCH", body:{status:"sent", log:what}}));
  if(r){ S.bills.map[no] = r.invoice; }
  localLog(TODAY, what);
}
function liveInvoice(no){
  const rec = (S.bills.map||{})[no]; if(!rec) return null;
  const rows=[];
  for(const d of dayKeys()) for(const l of lines(d)) if(l.inv===no) rows.push(Object.assign({date:d}, l));
  if(!rows.length) return rec;
  rows.sort((a,b)=>a.date.localeCompare(b.date));
  return Object.assign({}, rec, {
    lines: rows.map(l=>({date:l.date, qty:(l.qtyDel??l.qty), type:l.type, price:l.price, total:amt(l), bill:l.bill||""})),
    total: Math.round(rows.reduce((t,l)=>t+amt(l),0)*100)/100,
    from: rows[0].date, to: rows[rows.length-1].date});
}
function invoiceBlob(rec, JS){
  const d = new JS({unit:"pt", format:"a4"});
  const M=46, R=549;
  const issueD = rec.issuedAt ? rec.issuedAt.slice(0,10) : TODAY;
  let y=56;
  d.setFont("helvetica","bold"); d.setFontSize(14); d.text(COMPANY.name, M, y);
  d.setFontSize(13); d.text("INVOICE", R, y, {align:"right"});
  y+=14;
  d.setFont("helvetica","normal"); d.setFontSize(9); d.text("Reg no : "+COMPANY.reg, M, y);
  d.setFont("helvetica","bold"); d.setFontSize(10);
  d.text(String(rec.period||"").toUpperCase(), R, y, {align:"right"});
  y+=34;
  d.setFont("helvetica","normal"); d.setFontSize(10);
  d.text("To  :", M, y);
  d.setFont("helvetica","bold"); d.text(String(rec.name||"").slice(0,52), M+42, y); d.setFont("helvetica","normal");
  d.text("Date:", 400, y); d.text(fmtD(issueD), 450, y);
  y+=14;
  if(rec.addr){ d.text(String(rec.addr).slice(0,60), M+42, y); }
  d.text("Invoice # :", 400, y); d.setFont("helvetica","bold"); d.text(rec.no, 460, y); d.setFont("helvetica","normal");
  y+=30;
  const C={sn:M, dt:M+26, ds:M+96, up:M+336, qt:M+404, am:R};
  d.setFont("helvetica","bold"); d.setFontSize(9);
  d.text("S/N", C.sn, y); d.text("Date", C.dt, y); d.text("Description & Bill No.", C.ds, y);
  d.text("Unit Price", C.up, y, {align:"right"}); d.text("QTY", C.qt, y, {align:"right"}); d.text("Amount", C.am, y, {align:"right"});
  d.setLineWidth(.7); d.line(M, y+5, R, y+5);
  d.setFont("helvetica","normal"); d.setFontSize(9.5); y+=20;
  const mon = s => D(s).toLocaleDateString("en-SG",{timeZone:TZ,month:"short"}).toUpperCase();
  rec.lines.forEach((l,i)=>{
    if(y>745){ d.addPage(); y=60; }
    d.text(String(i+1), C.sn, y);
    d.text(String(+l.date.slice(8,10))+" / "+mon(l.date)+" "+l.date.slice(2,4), C.dt, y);
    d.text(descOf(l.type)+(l.bill&&l.bill!==NOBILL?", #"+l.bill:""), C.ds, y);
    d.text(money(l.price), C.up, y, {align:"right"});
    d.text(String(l.qty), C.qt, y, {align:"right"});
    d.text(money(l.total), C.am, y, {align:"right"});
    y+=15;
  });
  y+=6; d.line(M, y, R, y); y+=18;
  d.setFont("helvetica","bold"); d.setFontSize(10.5);
  d.text("Amount Payable (SGD)", C.ds, y);
  d.setFontSize(12); d.text(money(rec.total), C.am, y, {align:"right"});
  y+=40; d.setFont("helvetica","normal"); d.setFontSize(9);
  COMPANY.footer.forEach(t=>{ d.text(t, M, y); y+=13; });
  return d.output("blob");
}
async function downloadInvoice(no){
  const rec = liveInvoice(no); if(!rec) return;
  const { jsPDF } = await import("jspdf");
  const blob = invoiceBlob(rec, jsPDF);
  if(!blob){ toast("PDF library did not load"); return; }
  saveBlob(blob, `Invoice-${rec.no}-${String(rec.short||"").replace(/[^A-Za-z0-9]+/g,"-").slice(0,28)}.pdf`);
  toast("Invoice "+rec.no+" saved");
}
function mailtoFor(rec){
  const to = String(rec.emails||"").split(/[,;]+/).map(x=>x.trim()).filter(Boolean).join(",");
  const sub = `Invoice ${rec.no} — ${rec.name}`;
  const body = [`Dear ${rec.name},`,"",
    `Please find attached invoice ${rec.no} for charcoal delivered from ${fmtD(rec.from)} to ${fmtD(rec.to)}.`,
    `${rec.lines.length} deliveries, total ${money(rec.total)}.`,"","Thank you.",COMPANY.name].join("\n");
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(sub)}&body=${encodeURIComponent(body)}`;
}
const pkey = (d,id) => d+"|"+id;
function pickedList(){
  const out=[];
  Object.keys(S.pick).forEach(k=>{ if(!S.pick[k]) return;
    const i=k.indexOf("|"), d=k.slice(0,i), id=k.slice(i+1);
    const l = S.days[d] && S.days[d].lines[id]; if(l) out.push({date:d, line:l}); });
  return out;
}
async function applyPaid(paid){
  const sel = pickedList(); if(!sel.length) return;
  const at = new Date().toISOString(), rm = String(S.remark||"").trim();
  let n=0, tot=0; const names=new Set(), ups=[];
  sel.forEach(x=>{ const l=x.line;
    if(paid){ Object.assign(l, {settled:true, setAt:at, setBy:who(), setRemark:rm, setMethod:S.payMethod, setDay:TODAY}); delete l.claim;
      ups.push({id:l.id, settled:true, setAt:at, setRemark:rm, setMethod:S.payMethod, setDay:TODAY, claim:null}); }
    else { ["settled","setAt","setBy","setRemark","setMethod","setDay"].forEach(k=>delete l[k]);
      ups.push({id:l.id, settled:false, setAt:null, setRemark:null, setMethod:null, setDay:null}); }
    n++; tot+=amt(l); names.add(nameOf(l.cust)); });
  S.pick={}; S.remark=""; render();
  const what = paid
    ? `Payment received (${METH[S.payMethod]||S.payMethod}) — ${[...names].join(", ")}: ${n} deliver${n===1?"y":"ies"}, ${money(tot)}${rm?" — "+rm:""}`
    : `Payment un-marked — ${[...names].join(", ")}: ${n} deliver${n===1?"y":"ies"}, ${money(tot)}`;
  await bulkLines(ups, what, TODAY);
  toast(paid ? `${n} marked paid` : `${n} reopened`);
}
function payBar(){
  const sel = pickedList(); if(!sel.length) return "";
  const tot = sel.reduce((t,x)=>t+amt(x.line),0);
  const anyPaid = sel.some(x=>x.line.settled);
  const names = [...new Set(sel.map(x=>nameOf(x.line.cust)))];
  return `<div class="paybar"><div>
    <span class="lbl">Payment</span>
    <span class="cnt">${sel.length} deliver${sel.length===1?"y":"ies"} &middot; ${money(tot)}</span>
    <span class="tny muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(names.join(", "))}</span>
    <input type="text" id="payremark" value="${esc(S.remark)}" placeholder="e.g. PayNow 12 Sept, OCBC &mdash; goes on every line ticked" style="flex:1;min-width:220px" autocomplete="off">
    <select id="paymethod" style="width:auto">${Object.keys(METH).map(k=>`<option value="${k}" ${S.payMethod===k?"selected":""}>${METH[k]}</option>`).join("")}</select>
    <button class="btn pri" data-act="paygo">Mark paid</button>
    ${anyPaid?`<button class="btn" data-act="payundo">Mark unpaid</button>`:""}
    <button class="btn" data-act="payclear">Clear</button>
  </div></div>`;
}
function shipTotal(x){ return Math.round(((+x.cogs||0)+(+x.fwdO||0)+(+x.fwdSG||0)+(+x.gst||0)+(+x.unload||0))*100)/100; }
function shipQty(x){
  const t = x.types||{};
  const ks = Object.keys(t).filter(k=>+t[k]>0);
  if(ks.length) return Math.round(ks.reduce((a,k)=>a+(+t[k]||0)/(DIV[k]||1),0)*100)/100;
  return +x.qty||0;
}
function shipContents(x){
  const t = x.types||{}, ks = LOAD_ORDER.filter(k=>+t[k]>0);
  if(ks.length) return ks.map(k=>t[k]+" "+k).join(", ");
  return x.desc||"";
}
function shipPer(x){ const q=shipQty(x); return q? Math.round(shipTotal(x)/q*100)/100 : 0; }
function shipLead(x){ return (x.ordered && x.date) ? dayGap(x.ordered, x.date) : null; }
function onOrder(x){ return !!(x.ordered && !x.date); }
const SHIPMODE = {container:"Container", lorry:"Lorry load", local:"Local pickup"};
function shipList(){
  return Object.entries((S.costs||{}).shipments||{}).map(([id,x])=>Object.assign({id}, x))
    .sort((a,b)=>String(b.date||"").localeCompare(String(a.date||"")) || String(b.id).localeCompare(String(a.id)));
}
function landedCost(){
  const bags = shipList().filter(x=>(x.kind||"bag30")==="bag30" && !onOrder(x) && shipQty(x)>0);
  const use = S.costWin==="all" ? bags : bags.slice(0, +S.costWin||6);
  const q = use.reduce((t,x)=>t+shipQty(x),0), v = use.reduce((t,x)=>t+shipTotal(x),0);
  return {per: q? Math.round(v/q*100)/100 : 0, bags:q, value:v, n:use.length, used:use};
}
function overheads(){ const o=(S.costs||{}).overheads||{}; return {
  items:[["rental","Warehouse rental"],["lorry","Lorry — instalment, insurance, road tax, ERP, diesel"],
    ["driver","Driver"],["worker","Part-time worker"],["admin","Admin"],["other","Anything else"]],
  vals:o, total: Math.round(Object.values(o).reduce((t,v)=>t+(+v||0),0)*100)/100}; }
async function saveOverheads(vals, what){
  S.costs.overheads = Object.assign({}, vals); render();
  await safe(api("/settings/overheads", {method:"PUT", body:{value:S.costs.overheads, log:what||""}}));
  if(what) localLog(TODAY, what);
}
async function saveShipRec(id, rec, what){
  const r = await safe(api(id ? "/shipments/"+id : "/shipments", {method:id?"PATCH":"POST", body:{shipment:rec, log:what||""}}));
  if(r){ S.costs.shipments[r.shipment.id] = r.shipment; }
  render();
  if(what) localLog(TODAY, what);
  return r && r.shipment;
}
function salesWindow(days){
  const from = shiftDate(TODAY, -days+1), out={bags:0, rev:0, stops:0, days:0, custs:{}};
  for(const d of dayKeys()){
    if(d<from || d>TODAY) continue;
    let any=false;
    for(const l of lines(d)){
      if(l.status!=="delivered") continue;
      const q = l.qtyDel??l.qty, eq = q/(DIV[String(l.type||"KB").toUpperCase()]||1);
      out.bags += eq; out.rev += amt(l); out.stops++; any=true;
      const c = out.custs[l.cust] = out.custs[l.cust] || {bags:0, rev:0, stops:0};
      c.bags += eq; c.rev += amt(l); c.stops++;
    }
    if(any) out.days++;
  }
  out.bags = Math.round(out.bags*100)/100; out.rev = Math.round(out.rev*100)/100;
  return out;
}
function shipForm(){
  const f = S.sf, isNew = !f.id, t = f.types||{};
  const q30 = shipQty(f), tot = shipTotal(f);
  return `<div class="card" style="border-left:4px solid var(--ember)">
    <div class="pad" style="border-bottom:1px solid var(--line)">
      <div class="lbl" style="color:var(--ember)">${isNew?"Record a shipment":"Edit — "+esc(f.name||"")}</div>
      <div class="tny muted">Fill in what you know now. Record it the day you <b>order</b> and leave the unload date blank &mdash; it sits under &ldquo;on order&rdquo; until the goods land, then you come back and finish it.</div>
    </div>
    <div class="pad" style="display:grid;gap:12px">
      <div class="filters">
        <label><span class="lbl">Name</span><input type="text" data-sf="name" value="${esc(f.name||"")}" placeholder="Medan 4" style="width:150px"></label>
        <label><span class="lbl">Supplier</span><input type="text" data-sf="supplier" value="${esc(f.supplier||"")}" placeholder="Ah Thye" style="width:150px"></label>
        <label><span class="lbl">Origin</span><input type="text" data-sf="origin" value="${esc(f.origin||"")}" placeholder="Medan / Vietnam" style="width:140px"></label>
        <label><span class="lbl">Container / ref no.</span><input type="text" data-sf="ref" value="${esc(f.ref||"")}" placeholder="BL or container no." style="width:170px"></label>
        <label><span class="lbl">Arrived as</span><select data-sf="mode" style="width:auto">
          ${Object.entries(SHIPMODE).map(([v,n])=>`<option value="${v}" ${(f.mode||"container")===v?"selected":""}>${n}</option>`).join("")}</select></label>
      </div>
      <div class="filters">
        <label><span class="lbl">Ordered on</span><input type="date" data-sf="ordered" value="${esc(f.ordered||"")}"></label>
        <label><span class="lbl">Unloaded on &mdash; blank until it lands</span><input type="date" data-sf="date" value="${esc(f.date||"")}"></label>
        <label><span class="lbl">Price per ton</span><input type="text" inputmode="decimal" data-sf="perTon" value="${esc(f.perTon==null?"":f.perTon)}" placeholder="700" style="width:90px"></label>
        <label><span class="lbl">Currency</span><input type="text" data-sf="ccy" value="${esc(f.ccy||"USD")}" style="width:70px"></label>
        ${shipLead(f)!=null?`<div><span class="lbl">Lead time</span><div class="num" style="font-size:19px">${shipLead(f)} days</div></div>`:""}
      </div>

      <div><div class="lbl">What came in &mdash; this also posts straight into Inventory</div>
        <div class="scroll" style="margin-top:6px"><table class="mvtab">
          <thead><tr>${LOAD_ORDER.map(k=>`<th class="ta-r">${k}</th>`).join("")}<th class="ta-r">30kg equiv.</th></tr></thead>
          <tbody><tr>${LOAD_ORDER.map(k=>`<td class="ta-r"><input class="n" inputmode="decimal" data-sfq="${k}" value="${esc(t[k]==null?"":t[k])}" placeholder="—"></td>`).join("")}
            <td class="ta-r num"><b id="sfq30">${q30||"—"}</b></td></tr></tbody>
        </table></div>
      </div>

      <div class="filters">
        <label><span class="lbl">Goods</span><input type="text" inputmode="decimal" data-sf="cogs" value="${esc(f.cogs==null?"":f.cogs)}" style="width:110px" class="num"></label>
        <label><span class="lbl">Fwder (other)</span><input type="text" inputmode="decimal" data-sf="fwdO" value="${esc(f.fwdO==null?"":f.fwdO)}" style="width:100px" class="num"></label>
        <label><span class="lbl">Fwder SG</span><input type="text" inputmode="decimal" data-sf="fwdSG" value="${esc(f.fwdSG==null?"":f.fwdSG)}" style="width:100px" class="num"></label>
        <label><span class="lbl">GST</span><input type="text" inputmode="decimal" data-sf="gst" value="${esc(f.gst==null?"":f.gst)}" style="width:95px" class="num"></label>
        <label><span class="lbl">Unloading</span><input type="text" inputmode="decimal" data-sf="unload" value="${esc(f.unload==null?"":f.unload)}" style="width:95px" class="num"></label>
        <div><span class="lbl">Total</span><div class="num" id="sftot" style="font-size:19px">${money(tot)}</div></div>
        <div><span class="lbl">Per 30kg bag</span><div class="num" id="sfper" style="font-size:19px;color:var(--ember)">${q30?money(Math.round(tot/q30*100)/100):"—"}</div></div>
      </div>

      <div class="filters">
        <label><span class="lbl">Counts as</span><select data-sf="kind" style="width:auto">
          ${[["bag30","30kg bags"],["box","Boxes"],["quote","Quote only"]].map(([v,n])=>`<option value="${v}" ${(f.kind||"bag30")===v?"selected":""}>${n}</option>`).join("")}</select></label>
        <label style="flex:1"><span class="lbl">Note &mdash; quality, moisture, who handled it, anything you will want to remember</span>
          <input type="text" data-sf="note" value="${esc(f.note||"")}" style="min-width:280px"></label>
      </div>

      <div class="row">
        <button class="btn pri" data-act="sfsave">${isNew?"Save shipment":"Save changes"}</button>
        <button class="btn" data-act="sfcancel">Cancel</button>
        ${f.posted?'<span class="chip c-ok" style="margin-left:auto">Already posted to Inventory</span>'
          :(q30?'<span class="tny muted" style="margin-left:auto">Saving with an unload date posts the quantities into Inventory as goods in.</span>':"")}
      </div>
    </div>
  </div>`;
}
function sfCalc(){
  if(!S.sf) return;
  const q = shipQty(S.sf), t = shipTotal(S.sf);
  const a=document.getElementById("sfq30"), b=document.getElementById("sftot"), c=document.getElementById("sfper");
  if(a) a.textContent = q||"—";
  if(b) b.textContent = money(t);
  if(c) c.textContent = q ? money(Math.round(t/q*100)/100) : "—";
}
async function saveShip(){
  const f = S.sf; if(!f) return;
  if(!String(f.name||"").trim()){ toast("Give the shipment a name"); return; }
  const types = {};
  LOAD_ORDER.forEach(k=>{ const v=(f.types||{})[k]; if(v!=="" && v!=null && +v>0) types[k]=+v; });
  const rec = {name:String(f.name).trim(), supplier:f.supplier||"", origin:f.origin||"", ref:f.ref||"",
    mode:f.mode||"container", ordered:f.ordered||"", date:f.date||"", perTon:+f.perTon||0, ccy:f.ccy||"USD",
    cogs:+f.cogs||0, fwdO:+f.fwdO||0, fwdSG:+f.fwdSG||0, gst:+f.gst||0, unload:+f.unload||0,
    types, qty:+f.qty||0, kind:f.kind||"bag30", note:f.note||"", desc:f.desc||"", posted:!!f.posted};
  const post = rec.date && !rec.posted && Object.keys(types).length;
  if(post) rec.posted = true;
  S.sf = null;
  const saved = await saveShipRec(f.id, rec, `${f.id?"Shipment updated":"Shipment recorded"} — ${rec.name}${rec.ref?" ("+rec.ref+")":""}: ${rec.date?"unloaded "+fmtD(rec.date):"on order"}, ${money(shipTotal(rec))}${shipQty(rec)?" for "+shipQty(rec)+" bags at "+money(shipPer(rec))+" each":""}`);
  if(!saved) return;
  if(post){
    await addMoves(Object.keys(types).map(k=>({kind:"in", type:k, qty:types[k], date:rec.date,
      note:rec.name+(rec.ref?" · "+rec.ref:"")})));
    toast("Saved and posted to Inventory");
  } else toast(f.id?"Shipment updated":"Shipment recorded");
}
async function addMoves(list){
  if(!list.length) return 0;
  const ins = list.filter(m=>m.kind==="in"), ch = list.filter(m=>m.kind==="check");
  const parts = [];
  if(ins.length) parts.push("Goods in — "+ins.map(m=>m.qty+" "+m.type+" ("+fmtD(m.date)+")").join(", "));
  if(ch.length)  parts.push("Stock check — "+ch.map(m=>m.type+" counted at "+m.qty+" ("+fmtD(m.date)+")").join(", "));
  const what = parts.join("  ·  ");
  const r = await safe(api("/stock_moves", {method:"POST", body:{moves:list, log:what}}));
  if(!r) return 0;
  r.moves.forEach(m=>{ S.inv.moves[m.id] = m; });
  render();
  localLog(TODAY, what);
  return r.moves.length;
}
function localLog(date, what){
  const id = "local"+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
  S.audit[date] = S.audit[date] || {date, entries:{}};
  S.audit[date].entries[id] = {at:new Date().toISOString(), who:ME.name, role:ME.role, what};
}
async function logIt(date, what){
  localLog(date, what);
  await safe(api("/audit_entries", {method:"POST", body:{date, what}}));
}

/* ===================== WA orders ===================== */
const WA_STOP = new Set(["good","morning","boss","thank","thanks","please","need","send","today","tomorrow","bags","house","also","before","after","night","noon","order","more","delivery","deliver","charcoal","hello","with","have","want","this","that","from","later","friday","monday","tuesday","wednesday","thursday","saturday","sunday"]);
const phoneKey = p => { const d=String(p||"").replace(/\D/g,""); return d.length>8 ? d.slice(-8) : d; };
function waByNumber(from){
  const k = phoneKey(from); if(k.length<8) return null;
  return RLIST.find(r=>(r.waNums||[]).some(n=>phoneKey(n)===k) || (r.contacts||[]).some(x=>phoneKey(x.wa)===k) || phoneKey(r.tel)===k) || null;
}
function waGuess(m){
  const known = waByNumber(m.from);
  if(known) return {how:"number", list:[{r:known, s:1}]};
  const words = new Set(normName(m.text+" "+(m.push||"")).split(" ").filter(w=>w.length>=3 && !WA_STOP.has(w)));
  const sc = RLIST.filter(r=>r.n90>0 || r.last).map(r=>{
    let best = m.push ? nameSim(m.push, r)*0.9 : 0;
    [r.name, r.billing].concat(r.aliases||[]).forEach(o=>{
      const toks = normName(o).split(" ").filter(w=>w.length>=4 && !/^\d+$/.test(w));
      if(!toks.length) return;
      const hit = toks.filter(w=>words.has(w)).length;
      if(hit) best = Math.max(best, 0.55 + 0.45*hit/toks.length);
    });
    return {r, s:best};
  }).filter(x=>x.s>=0.55).sort((a,b)=>b.s-a.s).slice(0,3);
  return {how: sc.length?"name":"none", list:sc};
}
const WTYPE = {kb:"KB",kk:"KK",nb:"NB","10kg":"10KG","6kg":"6KG","3kg":"3KG",kb15:"KB15",kk15:"KK15",fs:"FS",cw:"CW"};
function waParse(m){
  const t = " "+String(m.text||"").toLowerCase()+" ", out = {qty:{}, date:null};
  const re = /(\d+(?:\.\d+)?)\s*(?:x\s*)?(kb15|kk15|10kg|6kg|3kg|kb|kk|nb|fs|cw|bags?|pkts?|packets?|sacks?|ctns?|boxes?)\b/g;
  let x; while((x=re.exec(t))){ const ty = WTYPE[x[2]] || "*"; out.qty[ty] = (out.qty[ty]||0) + (+x[1]); }
  const md = (m.at||"").slice(0,10) || TODAY;
  if(/\b(tmr|tml|tmrw|tomorrow|tomolo|besok)\b/.test(t)) out.date = shiftDate(md, 1);
  else if(/\b(today|now|asap|later)\b/.test(t)) out.date = md;
  else { const days=["sun","mon","tue","wed","thu","fri","sat"]; const k=days.findIndex(d=>new RegExp("\\b"+d+"(day|s|nes|rs|ur|urs)?\\b").test(t));
    if(k>=0){ let d=md; for(let i=1;i<=7;i++){ d=shiftDate(md,i); if(new Date(d+"T00:00:00Z").getUTCDay()===k) break; } out.date=d; } }
  if(!out.date || out.date<TODAY) out.date = md<TODAY ? TODAY : md;
  return out;
}
function waForm(m){
  S.waf[m.id] = S.waf[m.id] || (()=>{
    const g = waGuess(m), p = waParse(m);
    const r = (g.how==="number" || (g.list[0] && g.list[0].s>=0.8 && (!g.list[1] || g.list[0].s-g.list[1].s>=0.15))) ? g.list[0].r : null;
    return {q:"", rid: r ? r.id : "", date:p.date, qty: r ? waQtyFor(r, p) : {}, parsed:p};
  })();
  return S.waf[m.id];
}
function waQtyFor(r, p){
  const out = {}, hasTyped = Object.keys(p.qty).some(k=>k!=="*");
  r.products.forEach(pr=>{ if(p.qty[pr.type]) out[pr.id] = String(p.qty[pr.type]); });
  if(!hasTyped && p.qty["*"]) out[r.products[0].id] = String(p.qty["*"]);
  return out;
}
function waSame(a, b){ const ka=phoneKey(a.from), kb=phoneKey(b.from);
  if(ka.length>=8 && kb.length>=8) return ka===kb;
  return !!(a.push && b.push && a.push.trim().toLowerCase()===b.push.trim().toLowerCase()); }
function waPrev(m, n){ return waList().filter(x=>x.id!==m.id && String(x.at)<String(m.at) && waSame(x,m)).slice(-(n||3)); }
function waList(){ return Object.entries((S.wa||{}).msgs||{}).map(([id,m])=>Object.assign({id}, m)).sort((a,b)=>String(a.at).localeCompare(String(b.at))); }
const waNew = () => waList().filter(m=>m.status==="new").length;
async function saveWA(id, m, what){
  S.wa.msgs[id] = m; render();
  const r = await safe(api("/wa_messages/"+id, {method:"PATCH", body:{message:{status:m.status, rid:m.rid||null, added:m.added||[], doneAt:m.doneAt||null}, log:what||""}}));
  if(r){ S.wa.msgs[r.message.id] = r.message; render(); }
}
function waParsePaste(txt){
  const rows = String(txt||"").split(/\r?\n/), out = [];
  const reA = /^\[?(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)\]?\s*[-–]?\s*([^:]{1,60}):\s?(.*)$/i;
  const reB = /^\[(\d{1,2}:\d{2}\s*(?:[ap]\.?m\.?)?),\s*(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})\]\s*([^:]{1,60}):\s?(.*)$/i;
  const toISO = (d, t) => { const [dd,mm,yy] = d.split(/[\/.]/).map(Number); const y = yy<100?2000+yy:yy;
    let [h,mi] = t.replace(/[^\d:]/g,"").split(":").map(Number); const pm=/p/i.test(t), am=/a/i.test(t);
    if(pm && h<12) h+=12; if(am && h===12) h=0;
    return `${y}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}T${String(h).padStart(2,"0")}:${String(mi||0).padStart(2,"0")}:00+08:00`; };
  rows.forEach(line=>{ let x;
    if((x=line.match(reA))) out.push({at:toISO(x[1],x[2]), who:x[3].trim(), text:x[4]});
    else if((x=line.match(reB))) out.push({at:toISO(x[2],x[1]), who:x[3].trim(), text:x[4]});
    else if(out.length && line.trim()) out[out.length-1].text += "\n"+line;
    else if(line.trim()) out.push({at:new Date().toISOString(), who:"", text:line}); });
  return out.map(o=>({at:o.at, from:/^[+\d][\d\s-]{6,}$/.test(o.who)?o.who:"", push:/^[+\d][\d\s-]{6,}$/.test(o.who)?"":o.who, text:o.text.trim(), status:"new", pasted:true}));
}

function paneWA(){
  const all = waList(), nw = all.filter(m=>m.status==="new"), dn = all.filter(m=>m.status==="done").reverse(), ig = all.filter(m=>m.status==="ignored").reverse();
  const card = m => {
    const f = waForm(m), g = waGuess(m), r = f.rid ? RESTS[f.rid] : null;
    const q = f.q.trim().toLowerCase();
    const hits = (!r && q) ? RLIST.filter(c=>String(c.name).toLowerCase().includes(q)||(c.billing||"").toLowerCase().includes(q)||(c.aliases||[]).some(a=>a.toLowerCase().includes(q))).slice(0,6) : [];
    const onList = r ? lines(f.date).filter(l=>acctOf(l.cust)===r.id) : [];
    const last = r ? restHistory(r.id, 1)[0] : null;
    const anyQty = r && r.products.some(p=>+f.qty[p.id]>0);
    return `<div class="card" style="border-left:4px solid var(--ok)">
      <div class="two" style="grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:16px;padding:13px 14px">
        <div>
          <div class="row" style="justify-content:space-between;gap:8px"><b>${esc(m.push||m.from||"Unknown")}</b><span class="tny muted num">${esc(fmtT(m.at))}</span></div>
          <div class="tny muted num">${esc(m.from||"number not in pasted text")}</div>
          ${(()=>{ const pv=waPrev(m,3); if(!pv.length) return "";
            return `<div class="lbl" style="margin-top:9px;font-size:10.5px">Earlier from this ${phoneKey(m.from).length>=8?"number":"sender"}</div>
              ${pv.map(x=>`<div style="margin-top:4px;background:var(--panel2);border-radius:4px 10px 10px 10px;padding:6px 10px;font-size:13px;color:var(--ink2)">
                <div class="row" style="justify-content:space-between;gap:8px"><span style="white-space:pre-wrap">${esc(x.text)}</span><span class="tny num" style="flex:none">${esc(fmtT(x.at))}</span></div>
                <div class="tny" style="margin-top:2px;color:${x.status==="done"?"var(--ok)":x.status==="new"?"var(--ember)":"var(--ink3)"}">${x.status==="done"
                  ? "&#10003; Added "+(x.added||[]).map(a=>a.qty+" "+esc(a.type)).join(" + ")+" &middot; "+esc((RESTS[x.rid]||{}).name||"")+" &middot; for "+esc(fmtDM((x.added||[{}])[0].date||TODAY))
                  : x.status==="new" ? "Still waiting above" : "Not an order"}</div></div>`).join("")}
              <div class="lbl" style="margin-top:9px;font-size:10.5px">New</div>`; })()}
          <div style="margin-top:6px;background:var(--ok-soft);border-radius:4px 12px 12px 12px;padding:9px 12px;white-space:pre-wrap;font-size:15px">${esc(m.text)}</div>
        </div>
        <div style="display:grid;gap:8px;align-content:start">
          <div>
            <div class="row" style="gap:7px"><span class="lbl">Restaurant</span>
              ${r ? (g.how==="number" && g.list[0].r.id===r.id ? '<span class="chip c-ok tny">Known number</span>' : (f.picked?'':'<span class="chip c-warn tny">Best guess &mdash; check</span>')) : ""}</div>
            ${r ? `<div class="row" style="gap:8px;margin-top:3px"><b style="font-size:16px">${esc(r.name)}</b>
                <button class="btn tny" style="padding:3px 8px" data-act="warclear" data-id="${m.id}">Change</button></div>
                <div class="tny muted">${esc(r.addr||"")}${last?` &middot; last ${last.qtyDel??last.qty} ${esc(last.type)} on ${esc(fmtD(last.date))}`:""}</div>`
              : `<input type="search" data-wq="${m.id}" value="${esc(f.q)}" placeholder="Type restaurant name…" autocomplete="off" style="margin-top:3px">
                 ${(hits.length?hits:g.list.map(x=>x.r)).map(c=>`<button class="btn tny" style="padding:5px 10px;margin:5px 5px 0 0" data-act="wapick" data-id="${m.id}" data-k="${c.id}">${esc(c.name)}</button>`).join("")}
                 ${!hits.length&&g.list.length?'<div class="tny muted" style="margin-top:3px">Suggested from the message &mdash; tap the right one.</div>':""}`}
          </div>
          ${r ? `<div class="row" style="gap:8px;flex-wrap:wrap;align-items:end">
              ${r.products.map(p=>`<label style="display:grid;gap:2px"><span class="lbl">${esc(p.type)} &middot; ${money(priceFrom(p.id, f.date))}</span>
                <input type="text" inputmode="decimal" class="num" data-waq="${m.id}" data-k="${p.id}" value="${esc(f.qty[p.id]||"")}" placeholder="0" style="width:74px"></label>`).join("")}
              <label style="display:grid;gap:2px"><span class="lbl">Deliver on</span><input type="date" data-wad="${m.id}" value="${esc(f.date)}" style="width:auto"></label>
            </div>
            ${onList.length?`<div class="tny" style="color:var(--warn)">Already on ${esc(fmtDM(f.date))}&rsquo;s list: ${onList.map(l=>`${l.qtyDel??l.qty} ${esc(l.type)}`).join(", ")}. Adding puts in another stop.</div>`:""}` : ""}
          <div class="row" style="gap:7px">
            <button class="btn pri" data-act="waadd" data-id="${m.id}" ${anyQty?"":"disabled"}>Add order</button>
            <button class="btn" data-act="waign" data-id="${m.id}">Not an order</button>
            ${!r?`<button class="btn tny" style="margin-left:auto;padding:4px 9px" data-act="wanewrest" data-id="${m.id}">New restaurant</button>`:""}
          </div>
        </div>
      </div>
    </div>`;
  };
  const doneCard = m => `<div class="card" style="background:${m.status==="done"?"var(--ok-soft)":"var(--panel2)"};border-color:transparent">
    <div class="pad row" style="gap:12px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex:1;min-width:220px"><span class="tny muted num">${esc(fmtT(m.at))}</span> &middot; <b class="small">${esc(m.push||m.from||"Unknown")}</b>
        <div class="small" style="white-space:pre-wrap;color:var(--ink2)">${esc(m.text)}</div></div>
      <div class="small" style="min-width:220px">${m.status==="done"
        ? `<b style="color:var(--ok)">&#10003; Added</b> ${(m.added||[]).map(x=>`${x.qty} ${esc(x.type)}`).join(" + ")} &middot; <b>${esc((RESTS[m.rid]||{}).name||nameOf(m.rid))}</b> &middot; ${esc(fmtDM((m.added||[{}])[0].date||TODAY))}`
        : '<span class="muted">Not an order</span>'}
        <div class="tny muted">${esc(fmtT(m.doneAt))}</div></div>
      <button class="btn tny" style="padding:4px 9px" data-act="wareopen" data-id="${m.id}">Reopen</button>
    </div></div>`;
  return `<div class="ph"><h2>WA orders</h2>
    <div class="row"><button class="btn" data-act="wapaste">${S.waPaste?"&times; Close":"Paste messages"}</button>
      <span class="muted small">${nw.length} waiting</span></div></div>
  <div class="note">Paste messages copied from WhatsApp with <b>Paste messages</b>. A number the app has seen before is matched straight away; a new one gets a best guess from the words in the message. After you add it, the number is remembered for that restaurant. (Messages arriving here by themselves needs the WhatsApp Business API connected to the server &mdash; a later step.)</div>
  ${S.waPaste?`<div class="card pad" style="display:grid;gap:8px">
    <div class="lbl">Paste copied WhatsApp messages</div>
    <textarea id="wapastetxt" rows="6" style="width:100%;font:inherit;padding:9px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--ink)" placeholder="[08/09/2026, 7:12 am] Anjappar: 2 bag tmr"></textarea>
    <div class="row"><button class="btn pri" data-act="wapastego">Add to WA orders</button><span class="tny muted">Select messages in WhatsApp &rarr; Copy &rarr; paste here. Each message becomes one row.</span></div>
  </div>`:""}
  ${nw.map(card).join("") || '<div class="card empty">No new messages. Everything has been handled.</div>'}
  ${dn.length||ig.length?`<div class="ph" style="margin-top:8px"><h2 style="font-size:18px">Handled</h2><span class="muted small">${dn.length} added &middot; ${ig.length} not orders</span></div>
    ${dn.concat(ig).sort((a,b)=>String(b.doneAt).localeCompare(String(a.doneAt))).map(doneCard).join("")}`:""}`;
}

/* ===================== driver view ===================== */
const phKey = (d,id) => d+"__"+id;
function drivePath(d, l){
  const c = CM[l.cust]||{name:l.cust};
  const nm = String(c.name).replace(/[\\/:*?"<>|]+/g,"").replace(/\s+/g," ").trim().slice(0,40);
  return `Bill photos/${d.slice(0,4)}/${d.slice(5,7)}/${d}/${d}${l.bill&&l.bill!=="-"?" #"+l.bill:""} ${nm}.jpg`;
}
async function loadBitmap(file){
  try{ return await createImageBitmap(file, {imageOrientation:"from-image"}); }catch(e){}
  return await new Promise((res,rej)=>{ const u=URL.createObjectURL(file), im=new Image();
    im.onload=()=>res(im); im.onerror=rej; im.src=u; });
}
function toDoc(src, maxEdge, q){
  const w0 = src.width, h0 = src.height, k = Math.min(1, maxEdge/Math.max(w0,h0));
  const w = Math.round(w0*k), h = Math.round(h0*k);
  const cv = document.createElement("canvas"); cv.width=w; cv.height=h;
  const cx = cv.getContext("2d"); cx.drawImage(src,0,0,w,h);
  const im = cx.getImageData(0,0,w,h), px = im.data, hist = new Uint32Array(256);
  for(let i=0;i<px.length;i+=4){ const y=(px[i]*0.299+px[i+1]*0.587+px[i+2]*0.114)|0; px[i]=y; hist[y]++; }
  const tot=w*h; let lo=0, hi=255, acc=0;
  for(let v=0; v<256; v++){ acc+=hist[v]; if(acc>tot*0.02){ lo=v; break; } }
  acc=0; for(let v=255; v>=0; v--){ acc+=hist[v]; if(acc>tot*0.10){ hi=v; break; } }
  if(hi-lo<30){ lo=Math.max(0,lo-15); hi=Math.min(255,hi+15); }
  const lut = new Uint8ClampedArray(256);
  for(let v=0; v<256; v++){ let t=(v-lo)/(hi-lo); t=Math.max(0,Math.min(1,t)); lut[v]=Math.round(255*Math.pow(t,1.35)); }
  for(let i=0;i<px.length;i+=4){ const y=lut[px[i]]; px[i]=px[i+1]=px[i+2]=y; }
  cx.putImageData(im,0,0);
  return new Promise(res=>cv.toBlob(b=>res({blob:b, w, h, url:cv.toDataURL("image/jpeg", q)}), "image/jpeg", q));
}
async function processBillSrc(src, origSize){
  const full = await toDoc(src, 2000, 0.55);
  const th = await toDoc(src, 320, 0.5);
  return {blob:full.blob, fullUrl:URL.createObjectURL(full.blob), w:full.w, h:full.h,
          size:full.blob.size, orig:origSize, thumb:th.url};
}
async function processBill(file){ return processBillSrc(await loadBitmap(file), file.size); }
function toColor(src, maxEdge, q){
  const k = Math.min(1, maxEdge/Math.max(src.width, src.height));
  const w = Math.round(src.width*k), h = Math.round(src.height*k);
  const cv = document.createElement("canvas"); cv.width=w; cv.height=h;
  cv.getContext("2d").drawImage(src,0,0,w,h);
  return new Promise(res=>cv.toBlob(b=>res({blob:b, w, h, url:cv.toDataURL("image/jpeg", q)}), "image/jpeg", q));
}
async function processScene(file){
  const bmp = await loadBitmap(file);
  const full = await toColor(bmp, 1600, 0.7);
  const th = await toColor(bmp, 320, 0.55);
  return {blob:full.blob, fullUrl:URL.createObjectURL(full.blob), w:full.w, h:full.h,
          size:full.blob.size, orig:file.size, thumb:th.url};
}
function morph(M, w, h, op, n){
  let A = M;
  for(let r=0;r<n;r++){
    const B = new Uint8Array(w*h);
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      let v = op==="d" ? 0 : 1;
      for(let dy=-1;dy<=1;dy++){ const yy=y+dy; if(yy<0||yy>=h){ if(op==="e") v=0; continue; }
        for(let dx=-1;dx<=1;dx++){ const xx=x+dx; if(xx<0||xx>=w){ if(op==="e") v=0; continue; }
          const p=A[yy*w+xx]; if(op==="d"&&p){ v=1; } if(op==="e"&&!p){ v=0; } } }
      B[y*w+x]=v;
    }
    A = B;
  }
  return A;
}
function detectBills(bmp){
  const W0=bmp.width, H0=bmp.height, k=Math.min(1, 420/Math.max(W0,H0));
  const w=Math.max(1,Math.round(W0*k)), h=Math.max(1,Math.round(H0*k)), N=w*h;
  const cv=document.createElement("canvas"); cv.width=w; cv.height=h;
  const cx=cv.getContext("2d"); cx.drawImage(bmp,0,0,w,h);
  const px=cx.getImageData(0,0,w,h).data, L=new Uint8Array(N), hist=new Uint32Array(256);
  for(let i=0,j=0;i<px.length;i+=4,j++){ const y=(px[i]*0.299+px[i+1]*0.587+px[i+2]*0.114)|0; L[j]=y; hist[y]++; }
  let sum=0; for(let t=0;t<256;t++) sum+=t*hist[t];
  let sB=0,wB=0,best=0,th=128;
  for(let t=0;t<256;t++){ wB+=hist[t]; if(!wB) continue; const wF=N-wB; if(!wF) break; sB+=t*hist[t];
    const mB=sB/wB, mF=(sum-sB)/wF, bt=wB*wF*(mB-mF)*(mB-mF); if(bt>best){ best=bt; th=t; } }
  let M=new Uint8Array(N), bright=0;
  for(let i=0;i<N;i++) if(L[i]>th){ M[i]=1; bright++; }
  const frac=bright/N;
  if(frac>0.88||frac<0.06) return null;
  M=morph(M,w,h,"d",2); M=morph(M,w,h,"e",2);
  M=morph(M,w,h,"e",3); M=morph(M,w,h,"d",3);
  const lab=new Int32Array(N), comps=[], st=[];
  for(let i=0;i<N;i++){ if(!M[i]||lab[i]) continue;
    const id=comps.length+1; let a=0,x0=w,x1=0,y0=h,y1=0; st.push(i); lab[i]=id;
    while(st.length){ const p=st.pop(), x=p%w, y=(p/w)|0; a++;
      if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y;
      const nb=[p-1,p+1,p-w,p+w];
      for(let q=0;q<4;q++){ const n=nb[q]; if(n<0||n>=N) continue;
        if((q===0&&x===0)||(q===1&&x===w-1)) continue;
        if(M[n]&&!lab[n]){ lab[n]=id; st.push(n); } } }
    comps.push({a,x0,x1,y0,y1});
  }
  let boxes=comps.filter(c=>{ const bw=c.x1-c.x0+1, bh=c.y1-c.y0+1;
      return c.a>=0.02*N && c.a/(bw*bh)>=0.5 && bw>=0.08*w && bh>=0.08*h && !(bw>0.95*w&&bh>0.95*h); })
    .sort((a,b)=>b.a-a.a).slice(0,8);
  if(!boxes.length) return null;
  const pad=Math.round(0.012*Math.max(W0,H0));
  boxes=boxes.map(c=>{ const x=Math.max(0,Math.round(c.x0/k)-pad), y=Math.max(0,Math.round(c.y0/k)-pad);
    return {x, y, w:Math.min(W0,Math.round((c.x1+1)/k)+pad)-x, h:Math.min(H0,Math.round((c.y1+1)/k)+pad)-y}; });
  return orderBoxes(boxes);
}
function orderBoxes(bx){
  const avgH = bx.reduce((t,b)=>t+b.h,0)/bx.length;
  bx.sort((a,b)=>(a.y+a.h/2)-(b.y+b.h/2));
  const rows=[]; for(const b of bx){ const cy=b.y+b.h/2, r=rows.find(r=>Math.abs(r.cy-cy)<avgH*0.5);
    if(r){ r.items.push(b); } else rows.push({cy, items:[b]}); }
  return rows.flatMap(r=>r.items.sort((a,b)=>a.x-b.x));
}
function gridBoxes(bmp, rows, cols){
  const out=[], W=bmp.width, H=bmp.height;
  for(let r=0;r<rows;r++) for(let c=0;c<cols;c++)
    out.push({x:Math.round(c*W/cols), y:Math.round(r*H/rows), w:Math.round(W/cols), h:Math.round(H/rows)});
  return out;
}
function cropTo(bmp, b){
  const cv=document.createElement("canvas"); cv.width=b.w; cv.height=b.h;
  cv.getContext("2d").drawImage(bmp, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
  return cv;
}
async function uploadPhoto(d, id, kind, shot){
  const fd = new FormData();
  fd.append("line_id", id); fd.append("kind", kind); fd.append("thumb", shot.thumb);
  fd.append("image", shot.blob, "photo.jpg");
  const r = await safe(ctx.upload("/photos", fd));
  if(r){ S.thumbs[r.photo.key] = r.photo.thumb; S.photoIds[r.photo.key] = r.photo.id; }
  return r;
}
async function saveBillPhoto(d, id, shot){
  const day = S.days[d]; if(!day || !day.lines[id]) return;
  const k = phKey(d,id), l = day.lines[id];
  S.thumbs[k] = shot.thumb; S.fullPh[k] = shot.fullUrl;
  if(!await uploadPhoto(d, id, "bill", shot)) return;
  const meta = {at:new Date().toISOString(), by:ME.name, size:shot.size, orig:shot.orig, w:shot.w, h:shot.h, path:drivePath(d, l)};
  await saveLine(d, Object.assign({}, l, {photo:meta}), `${nameOf(l.cust)} ${fmtD(d)} — bill photo taken (${Math.round(shot.size/1024)} KB)`);
}
async function saveScenePhoto(d, id, shot){
  const day = S.days[d]; if(!day || !day.lines[id]) return;
  const k = "s__"+phKey(d,id), l = day.lines[id], c = CM[l.cust]||{name:l.cust};
  S.thumbs[k] = shot.thumb; S.fullPh[k] = shot.fullUrl;
  if(!await uploadPhoto(d, id, "scene", shot)) return;
  const nm = String(c.name).replace(/[\\/:*?"<>|]+/g,"").trim().slice(0,40);
  const meta = {at:new Date().toISOString(), by:ME.name, size:shot.size, orig:shot.orig,
    w:shot.w, h:shot.h, path:`Delivery photos/${d.slice(0,4)}/${d.slice(5,7)}/${d} ${nm}.jpg`};
  await saveLine(d, Object.assign({}, l, {scene:meta}), `${c.name} ${fmtD(d)} — delivery photo taken (${Math.round(shot.size/1024)} KB)`);
}
function billQueue(d){
  return lines(d).filter(l=>l.status==="delivered" && l.bill!=="-");
}
function openLB(k, cap){ S.lb={k, cap}; renderBar();
  if(!S.fullPh[k] && S.photoIds[k]) ctx.fetchBlob("/photos/"+S.photoIds[k]).then(b=>{ S.fullPh[k]=URL.createObjectURL(b); renderBar(); }).catch(()=>{}); }
function lightbox(){
  if(!S.lb) return "";
  const src = S.fullPh[S.lb.k] || S.thumbs[S.lb.k];
  if(!src) return "";
  return `<div class="lightbox" data-act="lbclose"><div><img src="${src}" alt="Bill photo"><div class="cap">${esc(S.lb.cap||"")}${S.fullPh[S.lb.k]?"":" &middot; loading full photo&hellip;"}</div></div></div>`;
}
function viewDriverBills(){
  const d = TODAY, q = billQueue(d);
  const done = q.filter(l=>l.photo).length;
  if(!S.bcur || !q.some(l=>l.id===S.bcur)){ const nx = q.find(l=>!l.photo) || q[0]; S.bcur = nx ? nx.id : null; }
  const cur = q.find(l=>l.id===S.bcur);
  const k = cur ? phKey(d, cur.id) : "";
  const shot = S.bshot;
  const curCard = !cur ? `<div class="card empty">No delivered stops yet today. Photos are taken once stops are marked delivered.</div>` : `
    <div class="camcard">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div><div class="lbl">Bill ${q.findIndex(l=>l.id===cur.id)+1} of ${q.length}</div>
          <h2>${esc(nameOf(cur.cust))}</h2>
          <div class="small muted">${cur.qtyDel??cur.qty} ${esc(cur.type)} &middot; ${money(amt(cur))} &middot; ${esc(fmtDD(d))}</div></div>
        ${cur.photo&&!shot?'<span class="chip c-ok">Done</span>':""}
      </div>
      <label style="display:grid;gap:3px"><span class="lbl">Bill number &mdash; type it while it&rsquo;s in your hand</span>
        <input class="num" inputmode="numeric" id="bno" data-id="${cur.id}" value="${esc(cur.bill||"")}" placeholder="${nextBill()}" style="font-size:20px;padding:10px"></label>
      ${shot ? `
        <img class="bprev" src="${shot.fullUrl}" alt="">
        <div class="tny muted" style="text-align:center">${Math.round(shot.size/1024)} KB, down from ${(shot.orig/1048576).toFixed(1)} MB &middot; ${shot.w}&times;${shot.h}</div>
        <div class="twoup" style="gap:8px">
          <button class="btn big" data-act="bretake">Retake</button>
          <button class="btn big pri" data-act="bkeep">Keep &rarr; next</button>
        </div>`
      : S.bbusy ? `<div class="card pad" style="text-align:center">Cleaning up the photo&hellip;</div>`
      : `
        ${cur.photo&&S.thumbs[k]?`<img class="bprev" src="${S.fullPh[k]||S.thumbs[k]}" alt="" style="max-height:220px;object-fit:contain">`:""}
        <label class="shoot">${cur.photo?"Retake photo":"Take photo of bill"}<input type="file" accept="image/*" capture="environment" id="bcam"></label>
        <div class="row" style="justify-content:space-between">
          <span class="tny muted">Flat on the dashboard, fill the frame, flash off.</span>
          <button class="btn tny" style="padding:4px 9px" data-act="bskip">${cur.photo?"Next":"No bill here"} &rarr;</button>
        </div>`}
      <div class="tny muted" style="word-break:break-all">Files to: ${esc(drivePath(d, cur))}</div>
    </div>`;
  return `<div class="phone">
    <div class="dhead"><div><div class="lbl">End of day</div><h1>Bill photos</h1></div>
      <span class="chip ${done===q.length&&q.length?"c-ok":"c-em"}">${done} of ${q.length}</span></div>
    ${curCard}
    <div class="lbl" style="margin:4px 0 6px">Today&rsquo;s bills &mdash; tap any to jump to it</div>
    <div class="bstrip">${q.map(l=>{ const kk=phKey(d,l.id); return `
      <button class="bst ${l.id===S.bcur?"cur":""}" data-act="bpick" data-id="${l.id}">
        ${S.thumbs[kk]?`<img class="th" src="${S.thumbs[kk]}" alt="">`:`<span class="th">none</span>`}
        <span class="nm"><b>${esc(nameOf(l.cust))}</b><span>${l.qtyDel??l.qty} ${esc(l.type)}${l.bill?" &middot; #"+esc(l.bill):""}</span></span>
        ${l.photo?'<span class="chip c-ok tny">Photo</span>':'<span class="chip c-mute tny">To do</span>'}
      </button>`;}).join("")}</div>
  </div>
  ${driverBar()}`;
}
function driverBar(){
  return `<div class="addbar"><div>
    <button class="btn big" data-act="add">+ Add a stop</button>
    ${S.dview==="rest"
      ? `<button class="btn big" data-act="drrun">&larr; Today&rsquo;s run</button>`
      : `<button class="btn big" data-act="drrest">Restaurants</button>`}
  </div></div>`;
}
function driverOwing(){
  const by = {};
  oddUnpaid().forEach(l=>{ const k=acctOf(l.cust); (by[k]=by[k]||[]).push(l); });
  return by;
}
function viewDriverRest(){
  const owe = driverOwing();
  const nOwe = Object.keys(owe).length;
  const q = S.drq.trim().toLowerCase();
  let list = S.drTab==="unpaid"
    ? Object.keys(owe).map(id=>RESTS[id]).filter(Boolean)
    : RLIST.filter(c=>c.n90>0 || owe[c.id]);
  if(q) list = list.filter(c=>c.name.toLowerCase().includes(q)||(c.addr||"").toLowerCase().includes(q));
  list = list.slice().sort((a,b)=>(owe[b.id]?1:0)-(owe[a.id]?1:0) || a.name.localeCompare(b.name));
  const row = c => {
    const ob = (owe[c.id]||[]).slice().sort((a,b)=>a.date.localeCompare(b.date));
    const tot = ob.reduce((t,l)=>t+amt(l),0);
    const open = S.drOpen===c.id;
    const h = restHistory(c.id, 5);
    const sel = ob.filter(l=>S.dsel[pkey(l.date,l.id)]), selAmt = sel.reduce((t,l)=>t+amt(l),0);
    return `<div class="drow ${ob.length?"owe":""}">
      <button data-act="dropen" data-id="${c.id}">
        <span class="nm"><b>${esc(c.name)}</b><span>${esc(c.addr||"")}</span></span>
        ${ob.length?`<span class="owechip">${money(tot)}<small>${ob.length} bill${ob.length===1?"":"s"} unpaid</small></span>`:""}
      </button>
      ${open?`<div class="panel">
        <div><div class="lbl">Where</div>${esc(c.addr||"—")}${c.postal?" &middot; S"+esc(c.postal):""}
          ${c.tel?`<div><a href="tel:${esc(String(c.tel).replace(/\s/g,""))}">Call ${esc(c.tel)}</a></div>`:""}</div>
        <div><div class="lbl">Usually</div>${c.products.map(p=>`${p.avgQty||1} ${esc(p.type)} at ${money(priceFrom(p.id, TODAY))}`).join(" &middot; ")}${c.products[0].avgGap?` &middot; about every ${c.products[0].avgGap} days`:""}</div>
        ${ob.length?`<div class="hist" style="border-color:var(--warn)"><div class="lbl" style="color:var(--warn);padding-bottom:5px">Unpaid &mdash; tick what they pay you</div>
          ${ob.map(l=>{const k=pkey(l.date,l.id); return `<label style="display:flex;gap:9px;align-items:center;padding:6px 0;cursor:pointer">
            <input type="checkbox" class="pickbox" style="width:22px;height:22px" data-act="dsel" data-k="${k}" ${S.dsel[k]?"checked":""} ${l.claim?"disabled":""}>
            <span style="flex:1">${esc(fmtD(l.date))}${l.bill&&l.bill!=="-"?" &middot; #"+esc(l.bill):""}${l.claim?'<br><span class="tny" style="color:var(--acct)">You said: paid by bank &mdash; office checking</span>':""}</span>
            <span class="num">${l.qtyDel??l.qty} ${esc(l.type)} &middot; <b>${money(amt(l))}</b></span></label>`;}).join("")}
          ${sel.length?`<div style="display:grid;gap:7px;margin-top:8px">
            <button class="btn pri" style="padding:12px" data-act="drcash" data-id="${c.id}">Collected cash &mdash; ${sel.length} bill${sel.length===1?"":"s"}, ${money(selAmt)}</button>
            <button class="btn" data-act="drbank" data-id="${c.id}">They say they paid by bank</button>
            <div class="tny muted">Give them back their copy of the bill as usual. Cash goes in with today&rsquo;s cash for Kin.</div>
          </div>`:""}
        </div>`:""}
        ${h.length?`<div class="hist"><div class="lbl" style="padding-bottom:3px">Last deliveries</div>
          ${h.map(x=>`<div><span>${esc(fmtD(x.date))}</span><span class="num">${x.qtyDel??x.qty} ${esc(x.type)} @ ${money(x.price)}</span></div>`).join("")}</div>`:""}
      </div>`:""}
    </div>`;
  };
  return `<div class="phone">
    <div class="dhead"><div><div class="lbl">Look up</div><h1>Restaurants</h1></div></div>
    <div class="dseg">
      <button data-act="drtab" data-k="all" aria-pressed="${S.drTab==="all"}">All</button>
      <button data-act="drtab" data-k="unpaid" aria-pressed="${S.drTab==="unpaid"}">Unpaid${nOwe?" ("+nOwe+")":""}</button>
    </div>
    <input type="search" id="drq" placeholder="Name or street…" value="${esc(S.drq)}" autocomplete="off" style="margin-bottom:10px">
    ${S.drTab==="unpaid"?`<div class="tny muted" style="margin-bottom:8px">Only bills they owe you directly. Monthly-invoice accounts are handled by the office and don&rsquo;t show here.</div>`:""}
    ${list.map(row).join("") || `<div class="card empty">${S.drTab==="unpaid"?"Nobody owes anything right now.":"No match."}</div>`}
  </div>
  ${driverBar()}`;
}
function viewDriver(){
  if(S.dview==="rest") return viewDriverRest();
  const date = TODAY, day = S.days[date] || {status:"none", lines:{}};
  const ls = lines(date), L = loadList(date);
  const done = ls.filter(l=>l.status!=="pending").length;
  const cash = ls.filter(l=>l.payStatus==="cash"||l.payStatus==="paynow").reduce((s,l)=>s+amt(l),0);
  const processed = day.status==="processed";

  const statusChip = processed
    ? '<span class="chip c-ok">Sent to office</span>'
    : (done ? '<span class="chip c-em">'+done+' of '+ls.length+' done</span>'
            : '<span class="chip c-em">New list from Kin</span>');

  return `<div class="phone">
    <div class="dhead">
      <div><div class="lbl">Today&rsquo;s run</div><h1>${esc(fmtDD(date))}</h1></div>
      <div>${statusChip}</div>
    </div>

    <div class="prog"><i style="width:${ls.length?Math.round(done/ls.length*100):0}%"></i></div>
    <div class="row small muted" style="justify-content:space-between;margin-bottom:12px">
      <span>${done}/${ls.length} stops done</span><span>${ls.length-done} to go</span>
    </div>

    ${(()=>{
      const fresh = ls.filter(l=>l.fresh && l.status==="pending");
      if(!fresh.length) return "";
      return `<div class="newbar lm">
        <div><span class="blink"></span><b>${fresh.length} last-minute order${fresh.length===1?"":"s"} from Kin</b>
          <span class="small muted">&mdash; added after your list went out</span></div>
        <div class="small">${fresh.map(l=>`${l.qtyDel??l.qty} ${esc(l.type)} &middot; <b style="color:var(--ink)">${esc(nameOf(l.cust))}</b>`).join("<br>")}</div>
        <button class="btn" data-act="ackfresh">Got it</button>
      </div>`;})()}

    ${(()=>{
      const todo = routeSort(ls.filter(l=>l.status==="pending")),
            fin = ls.filter(l=>l.status!=="pending");
      const byArea = []; todo.forEach(l=>{ const a=areaOf(RM(l.cust)); const g=byArea[byArea.length-1];
        if(g && g.a===a) g.ls.push(l); else byArea.push({a, ls:[l]}); });
      const todoHtml = byArea.map(g=>`<div class="tny" style="margin:9px 2px 5px;font-weight:600;color:var(--ink2);display:flex;justify-content:space-between"><span>${AM[g.a].name}</span><span class="num">${g.ls.length}</span></div>${g.ls.map(stopCard).join("")}`).join("");
      const head = `<div class="colhead"><span style="flex:1">Restaurant</span><span class="nums"><span class="qt"><span class="c-q">Qty</span><span class="c-t">Type</span></span><span class="c-u">Unit</span><span class="c-a">Total</span></span></div>`;
      if(!ls.length) return '<div class="card empty">No stops sent yet today.</div>';
      let h = "";
      if(todo.length) h += `<div class="grp"><span class="dot" style="background:var(--ok)"></span><b>To deliver</b><span class="n">${todo.length} left</span></div>${head}${todoHtml}`;
      if(fin.length)  h += `<div class="grp"><span class="dot" style="background:var(--line2)"></span><b>Done</b><span class="n">${fin.length}</span></div>${head}${fin.map(stopCard).join("")}`;
      if(!todo.length) h += `<div class="card pad small" style="text-align:center;color:var(--ok);font-weight:600">All ${ls.length} stops done. Count the leftover below, then process the day.</div>`;
      return h;})()}

    ${S.adding ? addPanel() : ""}

    ${secLoad(date)}
    ${secLeft(date)}

    <div class="endzone">
      ${processed
        ? `<div class="card pad small" style="text-align:center;border-color:var(--ok)">
             <b style="color:var(--ok)">Sent to office ${esc(fmtT(day.processedAt))}</b>
             <div class="muted" style="margin-top:3px">You can still fix a mistake &mdash; tap any stop. Kin sees the change and the time you made it.</div>
           </div>`
        : `<div class="lbl" style="text-align:center;margin-bottom:8px">End of day</div>
           <button class="btn big pri" data-act="process" style="letter-spacing:.06em">SUBMIT ${esc(fmtDM(date).toUpperCase())}</button>
           <div class="tny muted" style="text-align:center;margin-top:7px">Check the load out and left over above before you send.</div>`}
    </div>
    ${S.confirm?confirmDialog():""}
  </div>
  ${driverBar()}`;
}

function confirmDialog(){
  const date=TODAY, ls=lines(date), day=S.days[date]||{};
  const pend=ls.filter(l=>l.status==="pending"), del=ls.filter(l=>l.status==="delivered"), skip=ls.filter(l=>l.status==="skipped");
  const cash=del.filter(l=>l.payStatus==="cash").reduce((s,l)=>s+amt(l),0);
  const pn=del.filter(l=>l.payStatus==="paynow").reduce((s,l)=>s+amt(l),0);
  const acct=del.filter(l=>l.payStatus==="account").reduce((s,l)=>s+amt(l),0);
  const owed=del.filter(l=>l.payStatus==="unpaid"||l.payStatus==="delayed").reduce((s,l)=>s+amt(l),0);
  const leftCounted=Object.keys(day.left||{}).length>0;
  const warn=[];
  if(pend.length) warn.push(`${pend.length} stop${pend.length>1?"s":""} still not updated: ${pend.slice(0,3).map(l=>nameOf(l.cust)).join(", ")}${pend.length>3?"…":""}`);
  if(!leftCounted) warn.push("Left over not counted yet.");
  else { const df=leftDiffs(date); if(df.length) warn.push("Left over different from expected: "+df.map(x=>`${x.t} ${x.d>0?"+":""}${x.d}`).join(", ")); }
  const noPh = del.filter(l=>(CM[l.cust]||{}).needPhoto && !l.scene);
  if(noPh.length) warn.push(`Delivery photo missing: ${noPh.map(l=>nameOf(l.cust)).join(", ")}`);
  return `<div class="ovl"><div class="dlg">
    <div><div class="lbl">Submit to office</div><h3>${esc(fmtDD(date))}</h3></div>
    <div>
      <div class="sumrow"><span>Delivered</span><b>${del.length} stop${del.length===1?"":"s"}</b></div>
      ${skip.length?`<div class="sumrow"><span>Could not deliver</span><b>${skip.length}</b></div>`:""}
      ${(()=>{const np=del.filter(l=>l.payStatus==="unpaid"||l.payStatus==="delayed").length;
        return np?`<div class="sumrow"><span style="color:var(--warn)">Not paid on the spot</span><b style="color:var(--warn)">${np} stop${np===1?"":"s"}</b></div>`:"";})()}
      <div class="sumrow"><span>Left over counted</span><b>${leftCounted?LOAD_ORDER.filter(t=>(day.left||{})[t]).map(t=>day.left[t]+" "+t).join(", ")||"none":"—"}</b></div>
    </div>
    ${warn.length?`<div class="note">${warn.map(w=>esc(w)).join("<br>")}</div>`:""}
    <div class="small muted">Once sent, the day goes into Kin&rsquo;s records. You can still fix a mistake afterwards &mdash; he sees the change and the time you made it.</div>
    <div class="opts">
      <button class="btn" style="flex:1" data-act="process-cancel">Go back</button>
      <button class="btn pri" style="flex:1" data-act="process-go">Yes, send it</button>
    </div>
  </div></div>`;
}

function stopCard(l){
  const c = CM[l.cust]||ALLCM[l.cust]||{name:l.cust,addr:""};
  const open = S.open===l.id;
  const done = l.status!=="pending";
  const sub = l.status==="skipped" ? '<span class="st" style="color:var(--bad)">Could not deliver</span>'
    : done ? `<span class="st" style="color:var(--${l.payStatus==="cash"||l.payStatus==="paynow"?"ok":l.payStatus==="account"?"acct":"warn"})">${drvLabel(l.payStatus)}${l.note?" &middot; "+esc(l.note):""}</span>` : "";
  const tot = money(amt(l)), q = String(l.qtyDel??l.qty);
  const lastMin = !done && !!(l.addedAt || l.fresh);
  const arrive = lastMin && l.fresh && !seenLastMin.has(l.id); if(lastMin && l.fresh) seenLastMin.add(l.id);
  const stopCls = l.status==="skipped" ? "skip" : done ? "done" : lastMin ? `lastmin${l.fresh?" unseen":""}${arrive?" arrive":""}` : "";
  return `<div class="stop ${stopCls}"${lastMin&&l.fresh?` style="--ph:-${((Date.now()%2400)/1000).toFixed(2)}s"`:""}>
    <button class="stopbar" data-act="open" data-id="${l.id}">
      <span class="who"><b>${esc(c.name)}${lastMin?(l.fresh?' <span class="chip c-last">NEW</span>':' <span class="chip c-last-q tny">Last minute</span>'):""}${l.late?' <span class="chip c-warn tny">fixed later</span>':""}${c.needPhoto&&!l.scene?' <span class="chip c-em tny">Photo needed</span>':""}</b>${sub||(lastMin&&l.addedAt?`<span class="st" style="color:var(--lastmin)">added ${esc(fmtT(l.addedAt))}</span>`:"")}</span>
      <span class="nums">
        <span class="qt"><span class="c-q${q.indexOf(".")>-1?" sm":""}">${q}</span><span class="c-t">${esc(l.type)}</span></span>
        <span class="c-u">${money(l.price)}</span>
        <span class="c-a${tot.length>4?" sm":""}">${tot}</span>
      </span>
    </button>
    ${open?stopPanel(l,c):""}
  </div>`;
}

function stopPanel(l,c){
  const h = restHistory(l.cust, 5).filter(x=>x.date!==TODAY).slice(0,4);
  const pick = drvPick(l);
  const pays = ["cash", (l.pay==="M"||pick==="account")?"account":null, pick==="paynow"?"paynow":null, "unpaid"].filter(Boolean);
  const sk = "s__"+phKey(TODAY, l.id);
  return `<div class="panel">
    <div><div class="lbl">Where</div>
      <div>${esc(c.addr||"—")}${c.postal?" &middot; S"+esc(c.postal):""}</div>
      ${c.tel?`<div class="small muted">Tel ${esc(c.tel)}</div>`:""}
    </div>
    ${c.needPhoto||l.scene ? `<div style="${c.needPhoto&&!l.scene?"border:2px solid var(--ember);border-radius:9px;padding:9px":""}">
      <div class="lbl" style="${c.needPhoto&&!l.scene?"color:var(--ember)":""}">Delivery photo${c.needPhoto?" &mdash; needed for this restaurant":""}</div>
      ${l.scene&&S.thumbs[sk]?`<img src="${S.thumbs[sk]}" class="bthumb" style="width:90px;height:auto;margin:6px 0" data-act="lb" data-k="${sk}" data-cap="${esc(c.name)}" alt="">
        <div class="tny muted">${Math.round(l.scene.size/1024)} KB, down from ${(l.scene.orig/1048576).toFixed(1)} MB</div>`:""}
      <label class="shoot" style="padding:12px;font-size:15px;margin-top:6px">${l.scene?"Retake photo":"Take delivery photo"}<input type="file" accept="image/*" capture="environment" data-scene="${l.id}"></label>
    </div>` : `<label class="tny" style="color:var(--ink2);cursor:pointer;text-decoration:underline">Add a photo of this delivery (optional)<input type="file" accept="image/*" capture="environment" data-scene="${l.id}" style="display:none"></label>`}
    <div>
      <div class="twoup">
        <div><div class="lbl">Bags delivered</div>
          <div class="steps">
            <button data-act="q-" data-id="${l.id}">&minus;</button>
            <span class="v">${l.qtyDel??l.qty}</span>
            <button data-act="q+" data-id="${l.id}">+</button>
          </div>
        </div>
        <div><div class="lbl">Unit price</div>
          <div class="steps">
            <button data-act="p-" data-id="${l.id}">&minus;</button>
            <span class="v">${money(l.price)}</span>
            <button data-act="p+" data-id="${l.id}">+</button>
          </div>
        </div>
      </div>
      <div class="calcline muted" style="margin-top:7px">${l.qtyDel??l.qty} &times; ${money(l.price)} = <b style="color:var(--ink)">${money(amt(l))}</b>
        ${(()=>{const p=lastDelivery(l.cust, TODAY);
          if(!p) return '<span class="tny"> &middot; first delivery on record</span>';
          return `<span class="tny"> &middot; last time ${money(p.price)} on ${esc(fmtD(p.date))}</span>`;})()}
      </div>
    </div>
    <div><div class="lbl">Payment &mdash; usually ${drvUsual(l.pay)}</div>
      <div class="opts" style="display:grid;grid-template-columns:${pays.length===4?"1fr 1fr":pays.length===3?"1fr 1fr 1fr":"1fr 1fr"}">${pays.map(p=>{
        return `<button class="opt ${p==="unpaid"?"":"ok"}" style="padding:11px 6px;font-size:15px" data-act="pay" data-id="${l.id}" data-p="${p}" aria-pressed="${pick===p}">${DRVPAY[p]}</button>`;}).join("")}</div>
      <div class="tny muted" style="margin-top:4px">Already picked from the restaurant&rsquo;s usual terms &mdash; change only if different today. Paying by PayNow or bank transfer? Choose <b>Not paid</b> &mdash; the office marks it once the money is in.</div>
    </div>
    <div><div class="lbl">Note for the office</div>
      <input type="text" data-act="note" data-id="${l.id}" value="${esc(l.note||"")}" placeholder="e.g. boss not around, collect next trip">
    </div>
    ${l.status==="pending"?`<div class="row tny muted" style="gap:6px">Route order:
      <button class="btn tny" style="padding:4px 9px" data-act="rmove" data-id="${l.id}" data-dir="-1">&uarr; Earlier</button>
      <button class="btn tny" style="padding:4px 9px" data-act="rmove" data-id="${l.id}" data-dir="1">Later &darr;</button>
      <span>remembered for next time</span></div>`:""}
    <div class="opts">
      <button class="btn pri" style="flex:1" data-act="done" data-id="${l.id}">&#10003; Delivered</button>
      <button class="btn" data-act="skip" data-id="${l.id}">Can&rsquo;t deliver</button>
    </div>
    ${h.length?`<div class="hist"><div class="lbl" style="padding-bottom:3px">Last times</div>
      ${h.map(x=>`<div><span>${esc(fmtD(x.date))}</span><span class="num">${x.qtyDel??x.qty} ${esc(x.type)} @ ${money(x.price)} &middot; ${drvLabel(x.payStatus)}</span></div>`).join("")}</div>`:""}
  </div>`;
}

function countTable(date, kind){
  const plan = loadList(date).acc, took = (S.days[date]||{}).load||{}, left = (S.days[date]||{}).left||{}, del = deliveredBy(date);
  const rows = LOAD_ORDER.map(t=>({t, plan:plan[t]||0, took:took[t], left:left[t], del:del[t]||0}));
  const isLoad = kind==="load", both = kind==="both", ex = leftExpected(date);
  if(both) return `<div class="scroll"><table class="ltab">
    <thead><tr><th>Type</th><th class="ta-r">On list</th><th class="ta-r">Took</th><th class="ta-r">Extra</th><th class="ta-r">Delivered</th><th class="ta-r">Left over</th><th class="ta-r">Unaccounted</th></tr></thead>
    <tbody>${rows.map(r=>{
      const empty = !r.plan && r.took==null && r.left==null;
      const tk = r.took!=null ? r.took : r.plan;
      const extra = r.took!=null ? Math.round((r.took-r.plan)*100)/100 : null;
      const gap = (r.took!=null || r.left!=null) ? Math.round((tk - r.del - (r.left||0))*100)/100 : null;
      return `<tr class="${empty?"zero":""}"><td><b>${r.t}</b></td>
        <td class="ta-r num">${r.plan||"—"}</td><td class="ta-r num">${r.took??"—"}</td>
        <td class="ta-r num">${extra?`<span class="extra">${extra>0?"+":""}${extra}</span>`:"—"}</td>
        <td class="ta-r num">${r.del||"—"}</td><td class="ta-r num">${r.left??"—"}</td>
        <td class="ta-r num">${gap?`<span class="extra">${gap}</span>`:(gap===0?"0":"—")}</td></tr>`;}).join("")}</tbody>
    <tfoot><tr><td>Lorry space</td><td class="ta-r num">${lorrySpace(plan)}</td><td class="ta-r num">${lorrySpace(took)||"—"}</td><td></td>
      <td class="ta-r num">${lorrySpace(del)||"—"}</td><td class="ta-r num">${lorrySpace(left)||"—"}</td><td></td></tr></tfoot>
  </table></div>`;
  return `<div class="scroll"><table class="ltab">
    <thead><tr><th>Type</th><th class="ta-r">On list</th>${isLoad?'<th class="ta-r">Took</th><th class="ta-r">Extra</th>'
      :'<th class="ta-r">Took</th><th class="ta-r">Delivered</th><th class="ta-r">Should be</th><th class="ta-r">Counted</th>'}</tr></thead>
    <tbody>${rows.map(r=>{
      const empty = !r.plan && r.took==null && r.left==null;
      const extra = (r.took!=null) ? Math.round((r.took-r.plan)*100)/100 : null;
      return `<tr class="${empty?"zero":""}">
        <td><b>${r.t}</b></td>
        <td class="ta-r num">${r.plan||"—"}</td>
        ${isLoad
          ? `<td class="ta-r"><input inputmode="decimal" data-act="took" data-d="${date}" data-t="${r.t}" value="${r.took??""}" placeholder="${r.plan||0}"></td>
             <td class="ta-r num">${extra?`<span class="extra">${extra>0?"+":""}${extra}</span>`:"—"}</td>`
          : `<td class="ta-r num">${r.took??(r.plan||"—")}</td>
             <td class="ta-r num">${r.del||"—"}</td>
             <td class="ta-r num" style="color:var(--ink2)">${ex[r.t]!=null?ex[r.t]:"—"}</td>
             <td class="ta-r"><input inputmode="decimal" data-act="left" data-d="${date}" data-t="${r.t}" value="${r.left??""}" placeholder="${ex[r.t]!=null?ex[r.t]:0}" style="${r.left!=null&&ex[r.t]!=null&&r.left!==ex[r.t]?"border-color:var(--bad);color:var(--bad)":""}"></td>`}
      </tr>`;}).join("")}</tbody>
    <tfoot><tr><td>Lorry space</td><td class="ta-r num">${lorrySpace(plan)}</td>
      ${isLoad?`<td class="ta-r num">${lorrySpace(took)||"—"}</td><td></td>`
              :`<td class="ta-r num">${lorrySpace(took)||"—"}</td><td class="ta-r num">${lorrySpace(del)||"—"}</td><td class="ta-r num">${lorrySpace(ex)||"—"}</td><td class="ta-r num">${lorrySpace(left)||"—"}</td>`}
    </tr></tfoot>
  </table></div>`;
}

function secLoad(date){
  const plan = loadList(date), took = (S.days[date]||{}).load||{};
  const any = Object.keys(took).length;
  const src = any?took:plan.acc;
  const sum = LOAD_ORDER.filter(t=>src[t]).map(t=>`${src[t]} ${t}`).join("  ·  ") || "nothing on the list";
  const open = S.sec==="load";
  return `<div class="sec" data-open="${open?1:0}">
    <button class="sechead" data-act="sec" data-k="load">
      <span class="lbl">Load out</span>
      <span class="sum">${esc(sum)}</span>
      <span class="chip c-orange num">${any?lorrySpace(took):plan.tot}</span>
      <span class="car">&#9656;</span>
    </button>
    ${open?`${countTable(date,"load")}<div class="pad tny muted">Type what you actually put on the lorry. Blank means you took exactly what the list says.</div>`:""}
  </div>`;
}

function secLeft(date){
  const left = (S.days[date]||{}).left||{};
  const any = Object.keys(left).length;
  const sum = any ? (leftDiffs(date).length ? "counted · "+leftDiffs(date).length+" different" : "matches · "+LOAD_ORDER.filter(t=>left[t]).map(t=>`${left[t]} ${t}`).join("  ·  ")) : "not counted yet";
  const open = S.sec==="left";
  return `<div class="sec" data-open="${open?1:0}">
    <button class="sechead" data-act="sec" data-k="left">
      <span class="lbl">Left over</span>
      <span class="sum">${esc(sum)}</span>
      ${any?`<span class="chip c-orange num">${lorrySpace(left)}</span>`:""}
      <span class="car">&#9656;</span>
    </button>
    ${open?`<div class="pad" style="display:grid;gap:6px;border-bottom:1px solid var(--orange-soft)">
        <button class="btn pri" data-act="leftok" data-d="${date}" style="padding:12px">&#10003; All match &mdash; use &ldquo;Should be&rdquo;</button>
        <div class="tny muted">Took minus delivered. If the lorry has exactly this, tap once. Otherwise type only the type that is different.</div>
      </div>${countTable(date,"left")}${(()=>{const df=leftDiffs(date); return df.length?`<div class="pad tny" style="color:var(--bad)">Different from expected: ${df.map(x=>`${x.t} ${x.d>0?"+":""}${x.d}`).join(", ")} &mdash; Kin will see this. Add a note on the stop if you know why.</div>`:"";})()}`:""}
  </div>`;
}

function addPanel(){
  const q = S.addQ.trim().toLowerCase();
  const hits = q ? CUSTOMERS.filter(c=>c.name.toLowerCase().includes(q)||(c.addr||"").toLowerCase().includes(q)).slice(0,8) : [];
  const ad = S.addDate || TODAY;
  const note = ad===TODAY ? "" : (ad<TODAY
    ? `<div class="tny" style="color:var(--warn);margin-top:4px">A day that has passed &mdash; only for a delivery you did but forgot to add.</div>`
    : `<div class="tny muted" style="margin-top:4px">Goes onto ${esc(fmtDD(ad))}&rsquo;s list, not today&rsquo;s. Kin sees it straight away.</div>`);
  return `<div class="card pad" style="margin-bottom:8px">
    <div class="lbl">Add a stop</div>
    <div class="row" style="gap:8px;margin-top:7px">
      <span class="small muted">For</span>
      <input type="date" id="adddate" value="${esc(ad)}" style="width:auto">
      ${ad!==TODAY?`<button class="btn tny" style="padding:4px 9px" data-act="addtoday">Today</button>`:""}
    </div>
    ${note}
    <input type="search" id="addq" placeholder="Type restaurant name…" value="${esc(S.addQ)}" autocomplete="off" style="margin:9px 0 7px">
    ${hits.map(c=>`<div class="sugg"><div class="g"><b>${esc(c.name)}</b><span class="tny muted">${esc(c.addr||"")}</span></div>
      <button class="btn" data-act="addpick" data-id="${c.id}">Add ${c.avgQty||1} ${esc(c.type)}</button></div>`).join("")}
    ${q&&!hits.length?'<div class="small muted" style="padding:8px 0">No match. Tell Kin to add this restaurant.</div>':""}
    <button class="btn" style="margin-top:8px" data-act="addcancel">Cancel</button>
  </div>`;
}

/* ===================== admin ===================== */
function viewAdmin(){
  const day = S.days[S.adminDate];
  const needBill = dayKeys().flatMap(d=>lines(d).filter(l=>l.status==="delivered"&&!l.bill).map(l=>({d,l}))).length;
  const tabs = [["wa","WA orders"],["today","Tabulate"],["master","Master grid"],["deliveries","Deliveries"],
                ["stock","Inventory"],["invoices","Invoices"],["unpaid","Unpaid"],["bills","Bills &amp; photos"],
                ["stats","Statistics"],["restaurants","Restaurants"],["activity","Activity"]];
  return `<div class="admin">
    <nav class="rail">
      ${tabs.map(([k,n])=>`<button data-act="tab" data-k="${k}" aria-selected="${S.tab===k}">${n}${k==="bills"&&needBill?`<span class="n">${needBill}</span>`:""}${k==="unpaid"&&oddUnpaid().length?`<span class="n">${oddUnpaid().length}</span>`:""}${k==="wa"&&waNew()?`<span class="n">${waNew()}</span>`:""}</button>`).join("")}
    </nav>
    <div class="pane">${({today:paneToday,master:paneMaster,deliveries:paneDeliveries,restaurants:paneRestaurants,
      wa:paneWA,stock:paneStock,invoices:paneInvoices,unpaid:paneUnpaid,bills:paneBills,stats:paneStats,activity:paneActivity})[S.tab]()}</div>
  </div>`;
}

function cashCard(){
  const rows = cashDays();
  const openAll = rows.filter(x=>x.st!=="done"), done = rows.filter(x=>x.st==="done").slice(0,5);
  const open = S.cashAll ? openAll : openAll.slice(0,3);
  const head = x => `<div class="row" style="justify-content:space-between"><b>${esc(fmtD(x.d))}</b><b class="num">${money(x.e.total)}</b></div>
    <div class="tny muted">${x.e.stops} cash stop${x.e.stops===1?"":"s"} ${money(x.e.stopAmt)}${x.e.debts?` + ${x.e.debts} old bill${x.e.debts===1?"":"s"} collected ${money(x.e.debtAmt)}`:""}</div>`;
  return `<div class="card" style="border-top:3px solid var(--ok)">
    <div class="pad" style="border-bottom:1px solid var(--line)">
      <div class="lbl" style="color:var(--ok)">Cash from driver</div>
      <div class="tny muted">Cash stops plus any old bills he collected. Count it, type what you actually got, tap Received. The driver never sees these totals.</div>
    </div>
    ${open.map(x=>{ const v=S.cashIn[x.d]||{};
      if(x.st==="wait") return `<div class="pad" style="border-bottom:1px solid var(--line);display:grid;gap:6px">${head(x)}
        <div class="row" style="gap:6px">
          <input type="text" inputmode="decimal" class="num" data-cashd="${x.d}" data-cashf="amt" value="${esc(v.amt!=null?v.amt:x.e.total)}" style="width:96px">
          <input type="text" data-cashd="${x.d}" data-cashf="remark" value="${esc(v.remark||"")}" placeholder="Remark (optional)" style="flex:1;min-width:0">
          <button class="btn pri" data-act="cashok" data-d="${x.d}">Received</button></div></div>`;
      const diff = Math.round((x.rec.amt-x.e.total)*100)/100;
      return `<div class="pad" style="border-bottom:1px solid var(--line);display:grid;gap:6px;background:var(--bad-soft)">${head(x)}
        <div class="small">${x.st==="changed"
          ? `Received ${money(x.rec.amt)} ${esc(fmtT(x.rec.at))} &mdash; <b style="color:var(--bad)">the day was changed afterwards</b>, now ${money(x.e.total)} (${diff<0?"short "+money(-diff):"over "+money(diff)})`
          : `Received <b>${money(x.rec.amt)}</b> &mdash; <b style="color:var(--bad)">${diff<0?"short "+money(-diff):"over "+money(diff)}</b>`}${x.rec.remark?` &middot; ${esc(x.rec.remark)}`:""}</div>
        <div class="row" style="gap:6px">
          <input type="text" data-cashd="${x.d}" data-cashf="remark" value="${esc(v.remark||"")}" placeholder="Why &mdash; e.g. driver pays back Friday" style="flex:1;min-width:0">
          <button class="btn" data-act="cashaccept" data-d="${x.d}">Accept</button>
          <button class="btn" data-act="cashredo" data-d="${x.d}">Re-enter</button></div></div>`;
    }).join("") || '<div class="pad small muted">All cash handed over.</div>'}
    ${openAll.length>3?`<div class="pad" style="border-bottom:1px solid var(--line)"><button class="btn tny" style="padding:4px 10px" data-act="cashall">${S.cashAll?"Show fewer":`Show all ${openAll.length} days waiting`}</button></div>`:""}
    ${done.length?`<div class="pad tny muted"><div class="lbl" style="margin-bottom:3px">Received</div>${done.map(x=>`${esc(fmtD(x.d))} &middot; ${money(x.rec.amt)}${x.rec.amt!==x.e.total?` <span style="color:var(--warn)">(difference ${money(x.rec.amt-x.e.total)} accepted${x.rec.okRemark?": "+esc(x.rec.okRemark):""})</span>`:""}`).join("<br>")}</div>`:""}
  </div>`;
}

function paneToday(){
  const date = S.adminDate, day = S.days[date];
  const ls = day?lines(date):[], L = day?loadList(date):{acc:{},tot:0};
  const sent = day && day.status!=="draft";
  // prediction: who is due
  const due = CUSTOMERS.filter(c=>c.last && c.avgGap>0 && c.n90>0).map(c=>{
    const since = Math.round((D(date)-D(c.last))/864e5);
    return {c, since, over: since - c.avgGap};
  }).filter(x=>x.over>=-1 && x.since<=45 && !ls.some(l=>l.cust===x.c.id))
    .sort((a,b)=>b.over-a.over).slice(0,12);

  return `<div class="ph"><h2>${esc(fmtDL(date))}</h2>
    <div class="row">
      <button class="btn pri" data-act="notoggle">${S.noOpen?"&times; Close":"+ New order"}</button>
      <input type="date" id="admdate" value="${date}" style="width:auto">
      ${sent?`<span class="chip ${day.status==="processed"?"c-ok":"c-em"}">${day.status==="processed"?"Processed":"With driver"}</span>`:'<span class="chip c-mute">Draft</span>'}
    </div></div>
  ${S.noOpen?newOrderPanel(date, sent):""}

  <div class="two">
    <div class="card">
      <div class="pad row" style="justify-content:space-between;border-bottom:1px solid var(--line)">
        <b class="disp" style="font-size:18px">Today&rsquo;s list &middot; ${ls.length} stops</b>
        <span class="small muted num">${money(ls.reduce((s,l)=>s+amt(l),0))}</span>
      </div>
      <div class="scroll"><table>
        <thead><tr><th>#</th><th>Restaurant</th><th class="ta-r">Qty</th><th>Type</th><th class="ta-r">Unit</th><th class="ta-r">Total</th><th>Pay</th><th>Status</th><th></th></tr></thead>
        <tbody>${routeSort(ls).map((l,i)=>`<tr>
          <td class="num muted">${i+1}</td>
          <td><b>${esc(nameOf(l.cust))}</b>${l.fresh?' <span class="chip c-new">NEW &mdash; driver not seen</span>':""}${l.late?' <span class="chip c-warn">edited after processing</span>':""}${l.note?`<div class="tny" style="color:var(--warn)">${esc(l.note)}</div>`:""}</td>
          <td class="ta-r num"><b>${l.qtyDel??l.qty}</b>${(l.qtyDel!=null&&l.qtyDel!==l.qty)?` <span class="tny strike">${l.qty}</span>`:""}</td>
          <td>${esc(l.type)}</td>
          <td class="ta-r num muted">${money(l.price)}</td>
          <td class="ta-r num">${money(amt(l))}</td>
          <td>${l.status==="pending"?'<span class="chip c-mute">—</span>':`<span class="chip ${PAYCLS[l.payStatus]||"c-mute"}">${PAYNAME[l.payStatus]||"—"}</span>`}</td>
          <td>${l.status==="delivered"?'<span class="chip c-ok">Delivered</span>':l.status==="skipped"?'<span class="chip c-warn">Skipped</span>':'<span class="chip c-mute">Pending</span>'}</td>
          <td>${sent?"":`<button class="btn small" style="padding:3px 8px" data-act="rmline" data-id="${l.id}">Remove</button>`}</td>
        </tr>`).join("") || '<tr><td colspan="9" class="empty">Nothing tabulated for this date yet.</td></tr>'}</tbody>
      </table></div>
    </div>

    <div style="display:grid;gap:14px">
      <div class="card" style="border-top:3px solid var(--orange)">
        <div class="pad" style="border-bottom:1px solid var(--line)">
          <div class="lbl" style="color:var(--orange)">Loading list</div>
          <div class="loadgrid" style="margin-top:8px">
            ${LOAD_ORDER.filter(t=>L.acc[t]).map(t=>`<span class="chip c-mute" style="font-size:13px"><b class="num">${L.acc[t]}</b> ${t}</span>`).join("")||'<span class="muted small">—</span>'}
            <span class="chip c-em" style="font-size:13px"><b class="num">${L.tot}</b> lorry space</span>
          </div>
        </div>
        ${day && (Object.keys(day.load||{}).length || Object.keys(day.left||{}).length)
          ? countTable(date,"both") + '<div class="pad tny muted">Took and Left over come from the driver. Unaccounted = took &minus; delivered &minus; left over &mdash; anything but zero is worth a question.</div>'
          : '<div class="pad tny muted">Once the driver loads out, what he actually took and what came back appear here against the list.</div>'}
        ${day && leftDiffs(date).length ? `<div class="pad small" style="color:var(--bad);border-top:1px solid var(--line)"><b>Leftover does not match:</b> ${leftDiffs(date).map(x=>`${x.t} should be ${x.ex}, counted ${x.got} (${x.d>0?"+":""}${x.d})`).join("; ")}</div>`:""}
        <div class="pad" style="border-top:1px solid var(--line)">
          ${sent ? `<div class="small muted">Sent to driver ${esc(fmtT(day.dispatchedAt))}.</div>`
                 : `<button class="btn pri big" data-act="tabulate" ${ls.length?"":"disabled"}>Tabulate ${esc(fmtD(date))} &rarr; send to driver</button>`}
        </div>
      </div>

      ${cashCard()}

      <div class="card">
        <div class="pad" style="border-bottom:1px solid var(--line)">
          <div class="lbl">Likely due &mdash; from their own pattern</div>
          <div class="tny muted">Median gap between past orders. Click to add at their usual quantity.</div>
        </div>
        <div class="list">${due.map(({c,over,since})=>`<div class="sugg">
          <div class="g"><b>${esc(c.name)}</b><span class="tny muted">last ${esc(fmtD(c.last))} &middot; every ~${c.avgGap}d &middot; ${since}d ago${over>0?` &middot; <span style="color:var(--ember)">${over}d over</span>`:""}</span></div>
          <button class="btn" data-act="addcust" data-id="${c.id}">+ ${c.avgQty||1} ${esc(c.type)}</button>
        </div>`).join("")||'<div class="empty small">Nobody flagged.</div>'}</div>
      </div>

    </div>
  </div>`;
}

function newOrderPanel(date, sent0){
  const sel = S.no.cust ? CM[S.no.cust] : null;
  const od = S.no.date || date;
  const oday = S.days[od];
  const sent = !!(oday && oday.status && oday.status!=="draft");
  const past = od < TODAY;
  const q = S.addQ.trim().toLowerCase();
  const hits = (!sel && q) ? CUSTOMERS.filter(c=>c.name.toLowerCase().includes(q)||(c.billing||"").toLowerCase().includes(q)).slice(0,7) : [];
  const last = sel ? lastDelivery(sel.id, od) : null;
  return `<div class="card" style="border-left:4px solid var(--ember)">
    <div class="pad" style="border-bottom:1px solid var(--line)">
      <div class="lbl" style="color:var(--ember)">New order &mdash; ${esc(fmtDM(od))}</div>
      <div class="tny muted">${past
        ? `<b style="color:var(--warn)">${esc(fmtDM(od))} has already been and gone</b> &mdash; use this only to record a delivery that happened but never got onto the list. It lands as a pending stop on that day for the driver to confirm.`
        : (sent
          ? "This day is already with the driver. The stop is pushed to his phone straight away and flagged <b>NEW</b> until he opens it."
          : "Goes onto the list before you send it.")} It becomes a normal record the moment you add it &mdash; master grid, invoices and stock all pick it up.</div>
    </div>
    ${!sel ? `<div class="pad filters" style="align-items:end">
        <label><span class="lbl">Deliver on</span><input type="date" id="nodate" value="${esc(od)}" style="width:auto"></label>
        <label style="flex:1"><span class="lbl">Restaurant</span><input type="search" id="admq" placeholder="Which restaurant? Search all ${CUSTOMERS.length}…" value="${esc(S.addQ)}" autocomplete="off" style="max-width:420px"></label>
      </div>
      ${hits.map(c=>`<div class="sugg"><div class="g"><b>${esc(c.name)}</b>
          <span class="tny muted">${esc(c.addr||"")} &middot; ${esc(c.type)} &middot; usually ${c.avgQty||1} at ${money(priceFrom(c.id,od))} &middot; last ${c.last?esc(fmtD(c.last)):"never"}</span></div>
        <button class="btn" data-act="nopick" data-id="${c.id}">Choose</button></div>`).join("")}
      ${q&&!hits.length?'<div class="pad small muted">No match.</div>':""}`
    : `<div class="pad filters" style="align-items:end">
        <label><span class="lbl">Deliver on</span><input type="date" id="nodate" value="${esc(od)}" style="width:auto"></label>
        <div style="min-width:200px">
          <span class="lbl">Restaurant</span>
          <div class="row" style="gap:8px"><b>${esc(sel.name)}</b>
            <button class="btn tny" style="padding:3px 8px" data-act="noclear">Change</button></div>
          <div class="tny muted">${esc(sel.addr||"")}</div>
        </div>
        <label><span class="lbl">Bags</span><input type="text" inputmode="decimal" id="noq" value="${esc(S.no.q)}" placeholder="${sel.avgQty||1}" style="width:90px"></label>
        <label><span class="lbl">Type</span><input type="text" value="${esc(sel.type)}" disabled style="width:80px"></label>
        <label><span class="lbl">Unit price</span><input type="text" inputmode="decimal" id="noprice" value="${esc(S.no.price)}" placeholder="${priceFrom(sel.id,od)}" style="width:100px"></label>
        <label><span class="lbl">Total</span><input type="text" value="${money((+S.no.q||0)*(+S.no.price||0))}" disabled style="width:100px"></label>
        <button class="btn pri" data-act="nosave">${past?`Record on ${esc(fmtDM(od))}`:(sent?"Add &amp; push to driver":`Add to ${esc(fmtDM(od))}`)}</button>
      </div>
      <div class="pad tny muted" style="padding-top:0">${PAYFULL[sel.pay]||sel.pay} &middot; ${last?`last delivery ${last.qtyDel??last.qty} ${esc(last.type)} at ${money(last.price)} on ${esc(fmtD(last.date))}`:"no delivery on record &mdash; price taken from their default"}</div>`}
  </div>`;
}

function paneMaster(){
  const dates = gridDates();
  const q = S.gridQ.trim().toLowerCase();
  let rows = CUSTOMERS.filter(c=>S.gridAll || c.n90>0 || dates.some(d=>lines(d).some(l=>l.cust===c.id)));
  if(q) rows = rows.filter(c=>c.name.toLowerCase().includes(q)||(c.billing||"").toLowerCase().includes(q));
  const cell = {};
  for(const d of dates) for(const l of lines(d)) cell[l.cust+"|"+d]=l;
  const hdr = d => {
    const dd = D(d), cls = d===TODAY?"today":(d<TODAY?"past":"fut");
    return `<th class="${cls}">${dd.toLocaleDateString("en-SG",{timeZone:TZ,weekday:"narrow"})}<br>${dd.toLocaleDateString("en-SG",{timeZone:TZ,day:"numeric",month:"short"})}</th>`;
  };
  return `<div class="ph"><h2>Master grid</h2>
    <div class="row">
      <input type="search" id="gridq" placeholder="Find restaurant…" value="${esc(S.gridQ)}" style="width:220px" autocomplete="off">
      <label class="row small"><input type="checkbox" id="gridall" ${S.gridAll?"checked":""} style="width:auto"> Show all ${CUSTOMERS.length}</label>
    </div></div>
  <div class="note">Same shape as your Excel: restaurants down, dates across, three weeks back and a week ahead. Past columns are read-only — a delivery that already happened is a record, and it gets corrected in <b>Deliveries</b> so the change is stamped. Today and future columns are typeable; anything you enter for today lands on the driver&rsquo;s list.</div>
  <div class="gwrap"><table class="grid">
    <thead><tr><th class="nm">Restaurant</th>${dates.map(hdr).join("")}</tr></thead>
    <tbody>${rows.map(c=>`<tr>
      <td class="nm" title="${esc(c.name)}">${esc(c.name)}<span>${esc(c.type)} &middot; ${c.price?money(c.price):"—"} &middot; ${PAYFULL[c.pay]||c.pay}</span></td>
      ${dates.map(d=>{
        const l = cell[c.id+"|"+d];
        if(d<TODAY){
          if(!l) return '<td class="c emptyc"></td>';
          const v = l.status==="skipped" ? `<span class="strike">${l.qty}</span>` : (l.qtyDel??l.qty);
          const dot = (l.status==="delivered"&&(l.payStatus==="unpaid"||l.payStatus==="delayed")) ? '<span class="dotu"></span>' : "";
          return `<td class="c pastc" title="${esc(nameOf(l.cust))} ${esc(fmtD(d))} — ${l.qtyDel??l.qty} ${esc(l.type)}, ${PAYNAME[l.payStatus]||""}${l.bill?(l.bill===NOBILL?", no physical bill":", bill "+esc(l.bill)):""}${l.note?" — "+esc(l.note):""}">${v}${dot}</td>`;
        }
        return `<td class="c ${l?"ed":""}"><input inputmode="decimal" data-act="cell" data-d="${d}" data-c="${c.id}" value="${l?(l.qty):""}"></td>`;
      }).join("")}
    </tr>`).join("")}</tbody>
    <tfoot><tr><td class="nm">Lorry space &middot; stops</td>
      ${dates.map(d=>{const L=loadList(d), n=lines(d).length; return `<td class="c">${n?L.tot+"<br>"+n:""}</td>`;}).join("")}
    </tr></tfoot>
  </table></div>
  <div class="row small muted"><span class="dotu"></span> not yet paid &nbsp;·&nbsp; <span class="strike">struck</span> could not deliver &nbsp;·&nbsp; hover any past cell for the full record</div>`;
}

function weeks5(){
  const out=[];
  for(let i=0;i<5;i++){
    const end = shiftDate(TODAY, -i*7), start = shiftDate(end, -6);
    out.push({n:i+1, start, end});
  }
  return out;
}
function weeklyDelivered(){
  const ws = weeks5(), acc = {};
  for(const t of LOAD_ORDER) acc[t] = ws.map(()=>0);
  for(const d of dayKeys()){
    const wi = ws.findIndex(w=>d>=w.start && d<=w.end);
    if(wi<0) continue;
    const del = deliveredBy(d);
    for(const t of LOAD_ORDER) if(del[t]) acc[t][wi] = Math.round((acc[t][wi]+del[t])*100)/100;
  }
  return {ws, acc};
}
function paneWeekly(){
  const {ws, acc} = weeklyDelivered();
  const eq = ws.map((w,i)=>{
    let v=0; for(const t of LOAD_ORDER) v += acc[t][i]/(DIV[t]||1);
    return Math.round(v*100)/100;
  });
  const rowTotal = t => Math.round(acc[t].reduce((a,b)=>a+b,0)*100)/100;
  const grand = Math.round(eq.reduce((a,b)=>a+b,0)*100)/100;
  const active = LOAD_ORDER.filter(t=>rowTotal(t)>0);
  const shown = active.length ? active : LOAD_ORDER;
  return `<div class="card">
    <div class="pad" style="border-bottom:1px solid var(--line)">
      <b class="disp" style="font-size:18px">What actually went out &mdash; last five weeks</b>
      <div class="tny muted">Bags delivered per week, newest on the left. The bottom row converts everything to 30&nbsp;kg equivalents, so one number tells you the real tonnage.</div>
    </div>
    <div class="scroll"><table>
      <thead><tr><th>Type</th>
        ${ws.map(w=>`<th class="ta-r">Wk ${w.n}<div class="tny" style="font-weight:400;text-transform:none;letter-spacing:0">${esc(fmtDM(w.start))}&ndash;${esc(fmtDM(w.end))}</div></th>`).join("")}
        <th class="ta-r">5-week total</th></tr></thead>
      <tbody>${shown.map(t=>`<tr>
        <td><b>${t}</b></td>
        ${acc[t].map(v=>`<td class="ta-r num">${v||'<span class="muted">—</span>'}</td>`).join("")}
        <td class="ta-r num"><b>${rowTotal(t)||'<span class="muted">—</span>'}</b></td>
      </tr>`).join("")}</tbody>
      <tfoot><tr><td><b>30 kg equivalent</b></td>
        ${eq.map(v=>`<td class="ta-r num"><b>${v||"—"}</b></td>`).join("")}
        <td class="ta-r num"><b>${grand||"—"}</b></td></tr></tfoot>
    </table></div>
    <div class="pad tny muted">Conversions come from your own lorry formula: 15&nbsp;kg counts as &frac12;, the 10&nbsp;kg new box as &#8531;, everything else as one. If any of those is wrong for weight rather than lorry space, tell me the right fraction and I will change it in one place.</div>
  </div>`;
}

function paneStock(){
  const rows = LOAD_ORDER.map(t=>({t, ...stockOf(t)}));
  const moves = invMoves();
  return `<div class="ph"><h2>Inventory</h2><span class="muted small">${moves.length} movements recorded</span></div>
  <div class="invgrid">${rows.map(r=>`<div class="invcard ${r.stock<=20?"low":""}">
    <span class="ty">${r.t}</span><b${r.stock<0?' style="color:var(--ember)"':""}>${r.stock}</b>
  </div>`).join("")}</div>

  ${paneWeekly()}

  <div style="display:grid;gap:14px">
    <div class="card">
      <div class="pad" style="border-bottom:1px solid var(--line)">
        <b class="disp" style="font-size:18px">Stock check</b>
        <div class="tny muted">One row per charcoal type. Type the count only for the types you actually counted &mdash; a blank field records nothing.
          The number you enter becomes the stock as at the end of that date, and everything before it stops mattering.
          <b>Goods coming in are not entered here</b> &mdash; record the container or lorry under <b>Statistics &rarr; Record a shipment</b> and the bags post themselves, carrying the container number with them.</div>
      </div>
      <div class="scroll"><table class="mvtab">
        <thead><tr><th>Type</th><th>Date counted</th><th class="ta-r">Counted on hand</th><th>Note</th></tr></thead>
        <tbody>${LOAD_ORDER.map((t,i)=>{
          const m = S.mv[t] || {};
          return `<tr>
            <td><b class="disp" style="font-size:17px">${t}</b></td>
            <td><div class="row" style="gap:6px">
              <input type="date" data-mv="date" data-t="${t}" value="${esc(m.date||TODAY)}">
              ${i===0?`<button class="btn tny" style="padding:4px 9px" data-act="mvsync">Sync all</button>`:""}
            </div></td>
            <td class="ta-r"><input class="n" inputmode="decimal" data-mv="cnt" data-t="${t}" value="${esc(m.cnt||"")}" placeholder="—"></td>
            <td><input type="text" data-mv="note" data-t="${t}" value="${esc(m.note||"")}" placeholder="${i===0?"who counted, anything odd":""}"></td>
          </tr>`;}).join("")}</tbody>
      </table></div>
      <div class="pad row" style="border-top:1px solid var(--line);gap:10px">
        <button class="btn pri" data-act="mvsave">Save stock check</button>
        <button class="btn" data-act="mvclear">Clear the form</button>
      </div>
    </div>
  </div>

  <div class="card scroll"><table>
    <thead><tr><th>Recorded</th><th>Effective date</th><th>What</th><th>Type</th><th class="ta-r">Qty</th><th>Where it came from</th><th>By</th></tr></thead>
    <tbody>${moves.map(m=>`<tr><td class="num tny">${esc(fmtT(m.at))}</td><td class="num">${esc(fmtD(m.date))}</td>
      <td><span class="chip ${m.kind==="in"?"c-ok":"c-acct"}">${m.kind==="in"?"Goods in":"Stock check"}</span></td>
      <td><b>${esc(m.type)}</b></td><td class="ta-r num">${m.kind==="in"?"+":"="}${m.qty}</td>
      <td class="tny">${esc(m.note||"")}</td><td class="tny muted">${esc(m.who||"")}</td></tr>`).join("")
      ||'<tr><td colspan="7" class="empty">No movements yet.</td></tr>'}</tbody>
  </table></div>`;
}

function filtered(){
  const out=[];
  for(const d of dayKeys()){
    if(d<S.filt.from || d>S.filt.to) continue;
    for(const l of lines(d)){
      if(S.filt.cust && l.cust!==S.filt.cust) continue;
      if(S.filt.pay && l.payStatus!==S.filt.pay) continue;
      if(S.filt.bill==="missing" && (l.bill||l.status!=="delivered")) continue;
      out.push({date:d, ...l});
    }
  }
  return out.reverse();
}

function paneDeliveries(){
  const rows = filtered();
  const val = rows.reduce((s,l)=>s+amt(l),0);
  const coll = rows.filter(l=>l.payStatus==="cash"||l.payStatus==="paynow").reduce((s,l)=>s+amt(l),0);
  const owed = rows.filter(l=>billable(l) && !l.settled).reduce((s,l)=>s+amt(l),0);
  const bags = rows.reduce((s,l)=>s+(l.status==="skipped"?0:(l.qtyDel??l.qty)),0);
  return `<div class="ph"><h2>Deliveries</h2><button class="btn" data-act="csv">Download CSV</button></div>
  <div class="note">Each delivery keeps its own quantity, unit price and total, stamped when the order was made. Editing a unit price here changes that one delivery and nothing else &mdash; past records never move when a restaurant&rsquo;s price changes.</div>
  <div class="card pad filters">
    <label><span class="lbl">From</span><input type="date" data-f="from" value="${S.filt.from}"></label>
    <label><span class="lbl">To</span><input type="date" data-f="to" value="${S.filt.to}"></label>
    <label><span class="lbl">Restaurant</span><select data-f="cust"><option value="">All</option>
      ${CUSTOMERS.filter(c=>c.n90>0).map(c=>`<option value="${c.id}" ${S.filt.cust===c.id?"selected":""}>${esc(c.name)}</option>`).join("")}</select></label>
    <label><span class="lbl">Payment</span><select data-f="pay"><option value="">All</option>
      ${Object.keys(PAYNAME).map(p=>`<option value="${p}" ${S.filt.pay===p?"selected":""}>${PAYNAME[p]}</option>`).join("")}</select></label>
    <label><span class="lbl">Bill no.</span><select data-f="bill"><option value="">All</option><option value="missing" ${S.filt.bill==="missing"?"selected":""}>Missing only</option></select></label>
  </div>
  <div class="tiles">
    <div class="tile em"><span class="lbl">Stops</span><b>${rows.length}</b></div>
    <div class="tile"><span class="lbl">Bags</span><b>${Math.round(bags*100)/100}</b></div>
    <div class="tile"><span class="lbl">Value</span><b>${money(val)}</b></div>
    <div class="tile ok"><span class="lbl">Collected</span><b>${money(coll)}</b></div>
    <div class="tile warn"><span class="lbl">Unpaid</span><b>${money(owed)}</b></div>
  </div>
  <div class="card scroll"><table>
    <thead><tr><th class="pk"><input type="checkbox" class="pickbox" data-act="pickall" data-keys="${rows.filter(l=>billable(l)).map(l=>pkey(l.date,l.id)).join(",")}"></th>
      <th>Date</th><th>Restaurant</th><th class="ta-r">Qty</th><th>Type</th><th class="ta-r">Unit</th><th class="ta-r">Total</th><th>Payment</th><th>Received</th><th>Bill no.</th><th>Note</th><th>Last touched</th></tr></thead>
    <tbody>${rows.map(l=>`<tr class="${l.settled?"settled":""}">
      <td class="pk">${billable(l)?`<input type="checkbox" class="pickbox" data-act="pick" data-k="${pkey(l.date,l.id)}" ${S.pick[pkey(l.date,l.id)]?"checked":""}>`:""}</td>
      <td class="num">${esc(fmtD(l.date))}</td>
      <td><button class="btn" style="padding:0;background:none;border:0;font-weight:600;text-align:left" data-act="cust" data-id="${l.cust}">${esc(nameOf(l.cust))}</button></td>
      <td class="ta-r num ${l.status==="skipped"?"strike":""}">${l.qtyDel??l.qty}</td>
      <td>${esc(l.type)}</td>
      <td class="ta-r"><input class="billin num" style="width:66px;text-align:right" data-act="unit" data-d="${l.date}" data-id="${l.id}" value="${l.price}"></td>
      <td class="ta-r num"><b>${money(amt(l))}</b></td>
      <td><span class="chip ${PAYCLS[l.payStatus]||"c-mute"}">${PAYNAME[l.payStatus]||"—"}</span></td>
      <td>${billable(l) ? (l.settled?`${paidChip(l)}<div class="tny">${esc(l.setRemark||"")}</div>`:'<span class="chip c-warn">Unpaid</span>') : '<span class="tny muted">at the door</span>'}</td>
      <td class="num">${S.thumbs["s__"+phKey(l.date,l.id)]?`<img class="bthumb" style="width:30px;height:24px;object-fit:cover;margin-right:4px" src="${S.thumbs["s__"+phKey(l.date,l.id)]}" data-act="lb" data-k="${"s__"+phKey(l.date,l.id)}" data-cap="${esc("Delivery · "+nameOf(l.cust)+" · "+fmtD(l.date))}" alt="">`:((CM[l.cust]||{}).needPhoto&&l.status==="delivered"?'<span class="chip c-em tny">no photo</span> ':"")}${billCell(l.bill)}${S.thumbs[phKey(l.date,l.id)]?` <img class="bthumb" style="width:22px;height:28px" src="${S.thumbs[phKey(l.date,l.id)]}" data-act="lb" data-k="${phKey(l.date,l.id)}" data-cap="${esc(nameOf(l.cust)+" · "+fmtD(l.date))}" alt="">`:""}</td>
      <td class="tny" style="max-width:180px">${esc(l.note||"")}</td>
      <td class="tny muted">${esc(l.by||"")} ${esc(fmtT(l.at))}${l.late?'<div><span class="chip c-warn">after processing</span></div>':""}</td>
    </tr>`).join("")||'<tr><td colspan="12" class="empty">Nothing in this range.</td></tr>'}</tbody>
  </table></div>`;
}

function custForm(){
  const f = S.cf, isNew = !f.id;
  const PAYOPT = [["C","Cash"],["M","Monthly invoice"],["PN","Bank (PayNow / transfer)"],["DC","Delayed cash"]];
  const live = f.products.filter(p=>!p.remove);
  const autoA = areaOf({postal:f.postal});
  return `<div class="card" style="border-left:4px solid var(--ember)">
    <div class="pad" style="border-bottom:1px solid var(--line)">
      <div class="lbl" style="color:var(--ember)">${isNew?"New restaurant":"Edit "+esc(f.name||"")}</div>
      <div class="tny muted">${isNew
        ? "Only the short name is required &mdash; that is what shows on the driver&rsquo;s list. Everything else can be filled in later."
        : "One restaurant = one invoice, one history, one unpaid list. The details at the top apply to every charcoal type below."}</div>
    </div>
    <div class="pad" style="display:grid;gap:11px">
      <div class="filters">
        <label><span class="lbl">Short name &mdash; driver sees this</span><input type="text" data-cf="name" value="${esc(f.name||"")}" style="width:220px"></label>
        <label><span class="lbl">Billing name &mdash; for invoices</span><input type="text" data-cf="billing" value="${esc(f.billing||"")}" style="width:260px"></label>
      </div>
      <div class="filters">
        <label style="flex:1"><span class="lbl">Also written on bills as &mdash; separate with commas</span>
          <input type="text" data-cf="aliasText" value="${esc(f.aliasText!=null?f.aliasText:(f.aliases||[]).join(", "))}" placeholder="Jaggi, JG, Race Course 34" style="min-width:320px"></label>
      </div>
      <div>
        <div class="lbl" style="margin-bottom:4px">People in charge &mdash; as many as you need</div>
        <div class="scroll"><table style="width:auto">
          <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>WhatsApp</th><th style="text-align:center">Invoice by<br>email</th><th style="text-align:center">Invoice by<br>WhatsApp</th><th></th></tr></thead>
          <tbody>${(f.contacts||[]).map((x,i)=>`<tr>
            <td><input type="text" data-cc="${i}:name" value="${esc(x.name||"")}" placeholder="Mr Ravi" style="width:130px"></td>
            <td><input type="text" data-cc="${i}:role" value="${esc(x.role||"")}" placeholder="Accounts / Boss / Chef" style="width:140px"></td>
            <td><input type="text" inputmode="email" data-cc="${i}:email" value="${esc(x.email||"")}" placeholder="accounts@rest.com" style="width:200px"></td>
            <td><input type="text" inputmode="tel" data-cc="${i}:wa" value="${esc(x.wa||"")}" placeholder="9123 4567" style="width:130px"></td>
            <td style="text-align:center"><input type="checkbox" data-ccb="${i}:invE" ${x.invE?"checked":""} style="width:auto"></td>
            <td style="text-align:center"><input type="checkbox" data-ccb="${i}:invW" ${x.invW?"checked":""} style="width:auto"></td>
            <td><button class="btn tny" style="padding:4px 9px" data-act="ccrm" data-i="${i}">Remove</button></td></tr>`).join("")
            || '<tr><td colspan="7" class="small muted" style="padding:8px 10px">Nobody added yet.</td></tr>'}</tbody>
        </table></div>
        <button class="btn" style="margin-top:6px" data-act="ccadd">+ Add a person</button>
        ${(f.waNums||[]).length?`<div class="tny muted" style="margin-top:5px">Order numbers learned from WA orders: ${(f.waNums||[]).map(n=>esc(fmtPhone(n))).join(", ")}</div>`:""}
      </div>
      <div class="filters">
        <label><span class="lbl">Billing cycle</span><select data-cf="cycle">
          <option value="monthly" ${(f.cycle||"monthly")==="monthly"?"selected":""}>Monthly</option>
          <option value="weeks" ${f.cycle==="weeks"?"selected":""}>Every N weeks</option>
          <option value="request" ${f.cycle==="request"?"selected":""}>Only when I say</option>
        </select></label>
        <label><span class="lbl">N weeks</span><input type="text" inputmode="numeric" data-cf="cycleWeeks" value="${esc(f.cycleWeeks==null||f.cycleWeeks===0?"":f.cycleWeeks)}" placeholder="6" style="width:80px"></label>
      </div>
      <div class="filters">
        <label style="flex:1"><span class="lbl">Address</span><input type="text" data-cf="addr" value="${esc(f.addr||"")}" style="min-width:280px"></label>
        <label><span class="lbl">Postal</span><input type="text" inputmode="numeric" data-cf="postal" value="${esc(f.postal||"")}" style="width:100px"></label>
        <label><span class="lbl">Tel</span><input type="text" inputmode="tel" data-cf="tel" value="${esc(f.tel||"")}" style="width:130px"></label>
        <label><span class="lbl">Route area</span><select data-cf="area">
          <option value="" ${!f.area?"selected":""}>Auto from postal${autoA!=="none"?" &mdash; "+AM[autoA].name:""}</option>
          ${AREAS.filter(a=>a.id!=="none").map(a=>`<option value="${a.id}" ${f.area===a.id?"selected":""}>${a.name}</option>`).join("")}</select></label>
      </div>
      <label class="row" style="gap:7px"><input type="checkbox" data-cfb="needPhoto" ${f.needPhoto?"checked":""} style="width:auto">
        <span class="small">Driver must photograph each delivery</span></label>
      <div>
        <div class="lbl" style="margin-bottom:4px">Charcoal types delivered &mdash; up to 4</div>
        <div class="scroll"><table style="width:auto">
          <thead><tr><th>Type</th><th>Unit price</th><th>Payment terms</th><th>Usual order</th><th>Every ~ days</th><th></th></tr></thead>
          <tbody>${f.products.map((p,i)=>p.remove?"":`<tr>
            <td><select data-cfp="${i}:type" style="width:90px">${TYPES.map(t=>`<option ${String(p.type||"KB").toUpperCase()===t?"selected":""}>${t}</option>`).join("")}</select></td>
            <td><input type="text" inputmode="decimal" data-cfp="${i}:price" value="${esc(p.price==null?"":p.price)}" style="width:90px"></td>
            <td><select data-cfp="${i}:pay" style="width:200px">${PAYOPT.map(([v,n])=>`<option value="${v}" ${(p.pay||"C")===v?"selected":""}>${n}</option>`).join("")}</select></td>
            <td><input type="text" inputmode="decimal" data-cfp="${i}:avgQty" value="${esc(p.avgQty==null?"":p.avgQty)}" style="width:80px"></td>
            <td><input type="text" inputmode="numeric" data-cfp="${i}:avgGap" value="${esc(p.avgGap==null?"":p.avgGap)}" style="width:80px"></td>
            <td>${live.length>1?`<button class="btn tny" style="padding:4px 9px" data-act="cfprm" data-i="${i}">Remove</button>`:""}</td>
          </tr>`).join("")}</tbody>
        </table></div>
        ${live.length<4?`<button class="btn" style="margin-top:6px" data-act="cfpadd">+ Add a charcoal type</button>`:""}
        <div class="tny muted" style="margin-top:5px">A price typed here starts from today. For an increase across many restaurants use <b>Price change</b>. Deliveries already made always keep their own price.</div>
      </div>
      <div class="row">
        <button class="btn pri" data-act="cfsave">${isNew?"Add restaurant":"Save changes"}</button>
        <button class="btn" data-act="cfcancel">Cancel</button>
        ${isNew?"":`<button class="btn" style="margin-left:auto;color:var(--bad)" data-act="cfretire">Retire &mdash; hide from lists</button>`}
      </div>
      <div class="tny muted">Usual order and &ldquo;every ~&rdquo; days drive the <b>Likely due</b> list on Tabulate. Leave them blank and that type simply never gets flagged.</div>
    </div>
  </div>`;
}

function priceCard(){
  const pc = S.pc;
  const all = CUSTOMERS.filter(p=>p.type===pc.type).map(p=>({p, cur:priceFrom(p.id, pc.from)}))
    .sort((a,b)=>(b.p.n90||0)-(a.p.n90||0) || String(a.p.name).localeCompare(String(b.p.name)));
  const list = all.filter(x=>pc.all || (x.p.n90||0)>0);
  const nv = x => (pc.val===""||isNaN(+pc.val)) ? null : (pc.mode==="add" ? Math.round((x.cur + +pc.val)*100)/100 : +pc.val);
  const on = x => pc.sel[x.p.id]!==false;
  const n = list.filter(on).length;
  return `<div class="card" style="border-left:4px solid var(--ember)">
    <div class="pad" style="border-bottom:1px solid var(--line)">
      <div class="lbl" style="color:var(--ember)">Price change</div>
      <div class="tny muted">From the start date, new stops for the ticked restaurants use the new price, and stops already on a list from that date that are not yet delivered are updated too. Deliveries already made keep their price. Every change is kept in the restaurant&rsquo;s price history.</div>
    </div>
    <div class="pad filters">
      <label><span class="lbl">Charcoal type</span><select data-pc="type">${TYPES.map(t=>`<option ${pc.type===t?"selected":""}>${t}</option>`).join("")}</select></label>
      <label><span class="lbl">How</span><select data-pc="mode">
        <option value="add" ${pc.mode==="add"?"selected":""}>Add to current price</option>
        <option value="set" ${pc.mode==="set"?"selected":""}>Set one fixed price</option></select></label>
      <label><span class="lbl">${pc.mode==="add"?"Amount, e.g. 2 or -1":"New price"}</span><input type="text" inputmode="decimal" data-pc="val" value="${esc(pc.val)}" style="width:100px"></label>
      <label><span class="lbl">Starts</span><input type="date" data-pc="from" value="${esc(pc.from)}" style="width:auto"></label>
      <label class="small" style="align-self:end;padding-bottom:9px;display:flex;align-items:center;gap:6px"><input type="checkbox" data-pcb="all" ${pc.all?"checked":""} style="width:auto"> Include restaurants with no orders in 90 days</label>
    </div>
    <div class="scroll" style="max-height:380px"><table>
      <thead><tr><th class="pk"><input type="checkbox" class="pickbox" data-act="pcall" ${list.length&&list.every(on)?"checked":""}></th><th>Restaurant</th><th>Terms</th><th class="ta-r">Now</th><th class="ta-r">From ${esc(fmtDM(pc.from))}</th></tr></thead>
      <tbody>${list.map(x=>{const v=nv(x); return `<tr>
        <td class="pk"><input type="checkbox" class="pickbox" data-act="pcsel" data-id="${x.p.id}" ${on(x)?"checked":""}></td>
        <td><b>${esc(x.p.name)}</b></td><td class="tny">${PAYFULL[x.p.pay]||x.p.pay}</td>
        <td class="ta-r num muted">${money(x.cur)}</td>
        <td class="ta-r num">${on(x)&&v!=null?`<b style="color:${v>x.cur?"var(--ok)":v<x.cur?"var(--bad)":"inherit"}">${money(v)}</b>`:"—"}</td></tr>`;}).join("")
        || '<tr><td colspan="5" class="empty">No restaurant takes this type.</td></tr>'}</tbody>
    </table></div>
    <div class="pad row" style="border-top:1px solid var(--line)">
      <button class="btn pri" data-act="pcgo" ${n&&pc.val!==""&&!isNaN(+pc.val)?"":"disabled"}>Apply to ${n} restaurant${n===1?"":"s"} from ${esc(fmtDM(pc.from))}</button>
      <span class="tny muted">${all.length-list.length?(all.length-list.length)+" quiet restaurant"+(all.length-list.length===1?"":"s")+" hidden":""}</span>
    </div>
  </div>`;
}

function ciParse(txt){
  return String(txt||"").split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map(l=>{
    const cells = (l.includes("\t") ? l.split("\t") : l.split(/\s*[,;]\s*/)).map(x=>x.trim());
    return cells; }).filter(c=>!/^restaurant$/i.test(c[0]||"")).map(cells=>{
    const rest = cells[0]||"", rest2 = cells.slice(1);
    const email = (rest2.find(x=>/@/.test(x))||"").toLowerCase();
    const wa = rest2.find(x=>!/@/.test(x) && x.replace(/\D/g,"").length>=8) || "";
    const byc = rest2.find(x=>/^(email|e-mail|wa|whatsapp|both)$/i.test(x)) || "";
    const by = /both/i.test(byc) ? "both" : /^(wa|whatsapp)$/i.test(byc) ? "wa" : (byc ? "email" : (email&&wa ? "email" : email ? "email" : "wa"));
    const name = rest2.find(x=>x && x!==email && x!==wa && x!==byc && !/@/.test(x)) || "";
    const lo = rest.toLowerCase();
    let r = RLIST.find(x=>String(x.name).toLowerCase()===lo || String(x.billing||"").toLowerCase()===lo);
    let how = r ? "exact" : "";
    if(!r){ const best = RLIST.map(x=>({x, s:nameSim(rest, x)})).sort((a,b)=>b.s-a.s)[0]; if(best && best.s>=0.6){ r=best.x; how="guess"; } }
    return {rest, rid:r?r.id:"", rname:r?r.name:"", how, name, email, wa:fmtPhone(wa), by};
  });
}
function ciCard(){
  const ci = S.ci;
  if(!ci.rows) return `<div class="card" style="border-left:4px solid var(--ember)">
    <div class="pad" style="border-bottom:1px solid var(--line)"><div class="lbl" style="color:var(--ember)">Import contacts &mdash; many restaurants at once</div>
      <div class="tny muted">Make a sheet in Excel with these columns, copy the rows, paste below. Columns can be empty; the app works out which cell is the email and which is the phone.</div></div>
    <div class="pad" style="display:grid;gap:8px">
      <div class="scroll"><table style="width:auto"><thead><tr><th>Restaurant</th><th>Person</th><th>Email</th><th>WhatsApp</th><th>Invoice by</th></tr></thead>
        <tbody><tr class="tny muted"><td>76 Anjappar</td><td>Mr Ravi</td><td>accounts@anjappar.sg</td><td>9123 4501</td><td>both</td></tr>
        <tr class="tny muted"><td>Eight Star Stall 69 KB</td><td>Ah Hock</td><td></td><td>9001 7788</td><td>wa</td></tr></tbody></table></div>
      <textarea id="citxt" rows="7" style="width:100%;font:inherit;padding:9px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--ink)" placeholder="Paste rows here">${esc(ci.text)}</textarea>
      <div class="row"><button class="btn pri" data-act="cicheck">Check</button><span class="tny muted">Nothing is saved until you confirm on the next step. "Invoice by": email, wa or both.</span></div>
    </div></div>`;
  const ok = ci.rows.filter(x=>x.rid && (x.email||x.wa)).length;
  return `<div class="card" style="border-left:4px solid var(--ember)">
    <div class="pad" style="border-bottom:1px solid var(--line)"><div class="lbl" style="color:var(--ember)">Check before saving &mdash; ${ok} of ${ci.rows.length} ready</div>
      <div class="tny muted">Orange = matched by a similar name, check it. Red = restaurant not found or no email/number; that row is skipped. People already on file are not added twice.</div></div>
    <div class="scroll"><table><thead><tr><th>You typed</th><th>Matched to</th><th>Person</th><th>Email</th><th>WhatsApp</th><th>Invoice by</th></tr></thead>
      <tbody>${ci.rows.map(x=>`<tr style="${!x.rid||(!x.email&&!x.wa)?"background:var(--bad-soft)":x.how==="guess"?"background:var(--warn-soft)":""}">
        <td>${esc(x.rest)}</td><td><b>${esc(x.rname||"— not found")}</b></td><td>${esc(x.name)}</td><td>${esc(x.email)}</td><td class="num">${esc(x.wa)}</td>
        <td>${x.by==="both"?"Email + WhatsApp":x.by==="wa"?"WhatsApp":"Email"}</td></tr>`).join("")}</tbody></table></div>
    <div class="pad row"><button class="btn pri" data-act="cisave" ${ok?"":"disabled"}>Save ${ok} contact${ok===1?"":"s"}</button>
      <button class="btn" data-act="ciback">&larr; Edit the pasted rows</button></div>
  </div>`;
}

function routeCard(){
  const ord = routeOrder(), cnt = {};
  RLIST.forEach(r=>{ if((r.n90||0)>0){ const a=areaOf(r); cnt[a]=(cnt[a]||0)+1; } });
  return `<div class="card">
    <div class="pad" style="border-bottom:1px solid var(--line)">
      <div class="lbl">Route order &mdash; areas in the order the driver goes</div>
      <div class="tny muted">The driver&rsquo;s list follows this, area by area. Inside an area he can move a stop earlier or later on his phone and it is remembered. A restaurant&rsquo;s area comes from its postal code unless you set one under Edit.</div>
    </div>
    ${ord.map((a,i)=>`<div class="sugg"><span class="num muted" style="width:22px">${i+1}</span>
      <div class="g"><b>${AM[a].name}</b><span class="tny muted">${cnt[a]||0} active restaurant${cnt[a]===1?"":"s"}</span></div>
      <button class="btn tny" style="padding:4px 10px" data-act="rarea" data-k="${a}" data-dir="-1" ${i?"":"disabled"}>&uarr;</button>
      <button class="btn tny" style="padding:4px 10px" data-act="rarea" data-k="${a}" data-dir="1" ${i<ord.length-1?"":"disabled"}>&darr;</button></div>`).join("")}
  </div>`;
}

function paneRestaurants(){
  if(S.cf) return `<div class="ph"><h2>Restaurants</h2></div>${custForm()}`;
  if(S.cust) return paneOneCust(S.cust);
  const q=S.addQ.trim().toLowerCase();
  const list = RLIST.filter(c=>!q||String(c.name).toLowerCase().includes(q)||(c.billing||"").toLowerCase().includes(q)||(c.aliases||[]).some(a=>a.toLowerCase().includes(q)));
  const multi = RLIST.filter(r=>r.products.length>1).length;
  const tom = shiftDate(TODAY,1);
  return `<div class="ph"><h2>Restaurants</h2>
    <div class="row"><button class="btn pri" data-act="cfnew">+ Add new</button>
      <button class="btn" data-act="pcopen">${S.pc?"&times; Close price change":"Price change"}</button>
      <button class="btn" data-act="routeopen">${S.routeOpen?"&times; Close route":"Route order"}</button>
      <button class="btn" data-act="ciopen">${S.ci?"&times; Close import":"Import contacts"}</button>
      <span class="muted small">${list.length} of ${RLIST.length} &middot; ${multi} take more than one type</span></div></div>
  ${S.pc?priceCard():""}
  ${S.routeOpen?routeCard():""}
  ${S.ci?ciCard():""}
  <div class="card pad"><input type="search" id="admq" placeholder="Search name, billing name or bill nickname…" value="${esc(S.addQ)}" autocomplete="off"></div>
  <div class="card scroll"><table>
    <thead><tr><th>Restaurant</th><th>Area</th><th>Charcoal &amp; price now</th><th>Terms</th><th>Last order</th><th class="ta-r">Owing</th><th></th></tr></thead>
    <tbody>${list.slice(0,150).map(c=>{const o=outstanding(c.id);return `<tr>
      <td><button style="font-weight:600;text-align:left" data-act="cust" data-id="${c.id}">${esc(c.name)}</button><div class="tny muted">${esc(c.addr||"")}</div></td>
      <td class="tny">${AM[areaOf(c)].name}</td>
      <td>${c.products.map(p=>`<span class="chip c-mute" style="margin:1px 2px 1px 0"><b>${esc(p.type)}</b> ${money(priceFrom(p.id,tom))}</span>`).join("")}</td>
      <td class="tny">${esc(c.terms)}</td>
      <td class="num">${c.last?esc(fmtD(c.last)):"—"}</td>
      <td class="ta-r num">${o?`<span style="color:var(--warn)">${money(o)}</span>`:"—"}</td>
      <td><button class="btn" style="padding:3px 9px;font-size:12px" data-act="cfedit" data-id="${c.id}">Edit</button></td>
    </tr>`}).join("")}</tbody>
  </table></div>`;
}

function paneOneCust(cid){
  const aid = acctOf(cid), c = RESTS[aid];
  if(!c) return `<div class="ph"><button class="btn" data-act="backcust">&larr; All restaurants</button></div><div class="card empty">Restaurant not found &mdash; it may have been retired.</div>`;
  const h = restHistory(aid), o = outstanding(aid), tot = h.reduce((s,l)=>s+amt(l),0), tom = shiftDate(TODAY,1);
  const ph = c.products.flatMap(p=>(p.prices||[]).map(x=>Object.assign({type:p.type}, x))).sort((a,b)=>String(b.from).localeCompare(String(a.from))||String(b.at).localeCompare(String(a.at)));
  return `<div class="ph"><div><button class="btn" data-act="backcust">&larr; All restaurants</button></div>
    <button class="btn" data-act="cfedit" data-id="${aid}">Edit details</button></div>
  <div class="card pad"><h2>${esc(c.name)}</h2>
    <div class="two" style="grid-template-columns:1fr 1fr;margin-top:10px">
      <dl class="kv">
        <dt>Billing</dt><dd>${esc(c.billing||c.name)}</dd>
        <dt>Address</dt><dd>${esc(c.addr||"—")} ${esc(c.postal||"")}</dd>
        <dt>Route area</dt><dd>${AM[areaOf(c)].name}</dd>
        <dt>Tel</dt><dd>${esc(c.tel||"—")}</dd>
        <dt>Invoicing</dt><dd>${esc(cycleOf(c).label)} &middot; ${esc(sendTo(c))}</dd>
      </dl>
      <div>
        <div class="lbl" style="margin-bottom:4px">Charcoal types</div>
        ${c.products.map(p=>`<div class="sumrow"><span><b>${esc(p.type)}</b> &middot; ${PAYFULL[p.pay]||p.pay} <span class="tny muted">usually ${p.avgQty||"—"} every ~${p.avgGap||"—"}d</span></span><b>${money(priceFrom(p.id,tom))}</b></div>`).join("")}
        ${ph.length?`<div class="lbl" style="margin:10px 0 3px">Price history</div>${ph.slice(0,8).map(x=>`<div class="tny">${esc(fmtD(x.from))} &middot; ${esc(x.type)} ${x.was!=null?money(x.was)+" &rarr; ":""}<b>${money(x.price)}</b> <span class="muted">set by ${esc(x.by||"")}</span></div>`).join("")}`:""}
      </div>
    </div>
  </div>
  <div class="tiles">
    <div class="tile em"><span class="lbl">Deliveries shown</span><b>${h.length}</b></div>
    <div class="tile"><span class="lbl">Value</span><b>${money(tot)}</b></div>
    <div class="tile warn"><span class="lbl">Outstanding</span><b>${money(o)}</b></div>
  </div>
  <div class="card scroll"><table>
    <thead><tr><th>Date</th><th class="ta-r">Qty</th><th>Type</th><th class="ta-r">Unit</th><th class="ta-r">Total</th><th>Payment</th><th>Received</th><th>Invoice</th><th>Bill no.</th><th>Note</th></tr></thead>
    <tbody>${h.map(l=>`<tr><td class="num">${esc(fmtD(l.date))}</td><td class="ta-r num">${l.qtyDel??l.qty}</td><td>${esc(l.type)}</td>
      <td class="ta-r num muted">${money(l.price)}</td><td class="ta-r num">${money(amt(l))}</td><td><span class="chip ${PAYCLS[l.payStatus]||"c-mute"}">${PAYNAME[l.payStatus]||"—"}</span></td>
      <td>${billable(l)?(l.settled?`${paidChip(l)}<div class="tny">${esc(l.setRemark||"")}</div>`:(l.claim?'<span class="chip c-acct">Says paid by bank</span>':'<span class="chip c-warn">Unpaid</span>')):'<span class="tny muted">at the door</span>'}</td>
      <td class="num tny">${l.inv?esc(l.inv):"—"}</td>
      <td class="num">${billCell(l.bill)}</td><td class="tny">${esc(l.note||"")}</td></tr>`).join("")
      ||'<tr><td colspan="10" class="empty">No deliveries recorded yet.</td></tr>'}</tbody>
  </table></div>`;
}

function paneInvoices(){
  if(S.invView) return paneInvoiceOne(S.invView);
  const m = S.month, months = [...new Set(dayKeys().map(d=>d.slice(0,7)))].sort().reverse();
  const mon = monthlyCusts(m), off = offCycle();
  const monTotal = mon.reduce((t,r)=>t+r.total,0);
  const toBill = mon.filter(r=>r.un.length);
  const offTotal = off.reduce((t,r)=>t+r.total,0);
  const mLabel = D(m+"-01").toLocaleDateString("en-SG",{timeZone:TZ,month:"long",year:"numeric"});
  return `<div class="ph"><h2>Invoices</h2>
    <div class="row">
      <label class="row small"><span class="lbl">Month</span><select id="mon" style="width:auto">
        ${months.map(x=>`<option value="${x}" ${x===m?"selected":""}>${D(x+"-01").toLocaleDateString("en-SG",{timeZone:TZ,month:"long",year:"numeric"})}</option>`).join("")}
      </select></label>
      <span class="row small"><span class="lbl">Next invoice</span>
        ${S.editNo
          ? `<input type="text" id="invnext" value="${esc(invNo(S.bills.next))}" style="width:110px" class="num" autocomplete="off">
             <button class="btn tny" style="padding:4px 9px" data-act="nolock">Lock</button>`
          : `<b class="num">${esc(invNo(S.bills.next))}</b>
             <button class="btn tny" style="padding:3px 8px" data-act="nounlock">Change</button>`}</span>
    </div></div>

  <div class="tiles">
    <div class="tile em"><span class="lbl">Monthly accounts, ${esc(mLabel)}</span><b>${mon.length}</b></div>
    <div class="tile"><span class="lbl">Month value</span><b>${money(monTotal)}</b></div>
    <div class="tile warn"><span class="lbl">Still to invoice</span><b>${toBill.length}</b></div>
    <div class="tile"><span class="lbl">Off-cycle owing</span><b>${money(offTotal)}</b></div>
  </div>

  <div class="note">Bill numbers are editable right here &mdash; type over any of them and it saves against that delivery, and onto the PDF. Restaurants on an odd cycle are further down as <b>statements</b>: you see what they owe and every line, but no invoice is generated until you ask for one.</div>

  <div class="ph" style="margin-top:4px"><h2 style="font-size:19px">Monthly accounts &mdash; ${esc(mLabel)}</h2></div>
  ${mon.map(r=>{
    const done = !r.un.length;
    return `<div class="card">
      <div class="pad row" style="justify-content:space-between;border-bottom:1px solid var(--line);gap:12px;flex-wrap:wrap">
        <div><b class="disp" style="font-size:18px">${esc(r.c.billing||r.c.name)}</b>
          <div class="tny muted">${esc(r.c.name)} &middot; ${r.rows.length} deliveries &middot; ${esc(sendTo(r.c))}</div></div>
        <div class="row">
          ${done
            ? r.invs.map(n=>`<button class="btn" style="padding:6px 12px" data-act="invpdf" data-id="${n}">${esc(n)} PDF</button>
                 <button class="btn tny" style="padding:4px 9px" data-act="invopen" data-id="${n}">View</button>`).join("")
            : `<button class="btn pri" style="padding:6px 12px" data-act="invissuem" data-id="${r.c.id}">Issue ${esc(invNo(S.bills.next))}</button>`}
        </div>
      </div>
      <div class="scroll"><table>
        <thead><tr><th class="pk"><input type="checkbox" class="pickbox" data-act="pickall" data-keys="${r.rows.map(l=>pkey(l.date,l.id)).join(",")}" ${r.rows.every(l=>S.pick[pkey(l.date,l.id)])?"checked":""}></th>
          <th>S/N</th><th>Date</th><th>Description</th><th>Bill no.</th><th class="ta-r">Unit price</th><th class="ta-r">Qty</th><th class="ta-r">Amount</th><th>Payment received</th></tr></thead>
        <tbody>${r.rows.slice().reverse().map((l,i)=>`<tr class="${l.settled?"settled":""}">
          <td class="pk"><input type="checkbox" class="pickbox" data-act="pick" data-k="${pkey(l.date,l.id)}" ${S.pick[pkey(l.date,l.id)]?"checked":""}></td>
          <td class="num muted">${i+1}</td>
          <td class="num">${esc(fmtD(l.date))}</td>
          <td>${esc(descOf(l.type))}${l.inv?` <span class="chip c-mute tny">${esc(l.inv)}</span>`:""}</td>
          <td><input class="billin num" data-act="bill" data-d="${l.date}" data-id="${l.id}" value="${esc(l.bill||"")}" placeholder="${nextBill()}"></td>
          <td class="ta-r num muted">${money(l.price)}</td>
          <td class="ta-r num">${l.qtyDel??l.qty}</td>
          <td class="ta-r num"><b>${money(amt(l))}</b></td>
          <td>${l.settled?`${paidChip(l)} <span class="tny">${esc(l.setRemark||"")}</span>`:'<span class="chip c-warn">Unpaid</span>'}</td>
        </tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="7" class="ta-r"><b>Amount Payable (SGD)</b></td><td class="ta-r num"><b>${money(r.total)}</b></td>
          <td>${(()=>{const u=r.rows.filter(l=>!l.settled); return u.length?`<span class="tny" style="color:var(--warn)">${money(u.reduce((t,l)=>t+amt(l),0))} still unpaid</span>`:'<span class="chip c-ok">Settled</span>';})()}</td></tr></tfoot>
      </table></div>
    </div>`;}).join("") || '<div class="card empty">No monthly-account deliveries in this month.</div>'}

  ${toBill.length?`<div class="card pad row" style="justify-content:space-between;gap:12px;flex-wrap:wrap;border-left:4px solid var(--ember);margin-top:2px">
    <div><b class="disp" style="font-size:17px">${toBill.length} account${toBill.length===1?"":"s"} still to invoice for ${esc(mLabel)}</b>
      <div class="tny muted">Checked every bill number above? This issues them all in one go, ${esc(invNo(S.bills.next))} onwards, in the order shown.</div></div>
    ${S.confirmAll
      ? `<div class="row"><button class="btn pri" data-act="invallgo">Yes, issue all ${toBill.length}</button>
           <button class="btn" data-act="invallno">Cancel</button></div>`
      : `<button class="btn pri" data-act="invall">Issue all ${toBill.length}</button>`}
  </div>`:""}

  <div class="ph" style="margin-top:14px"><h2 style="font-size:19px">Statements &mdash; not on monthly billing</h2>
    <span class="muted small">${off.length} restaurant${off.length===1?"":"s"} &middot; ${money(offTotal)} owing</span></div>
  <div class="card">
    <div class="scroll"><table>
      <thead><tr><th>Restaurant</th><th>Cycle</th><th>Oldest unbilled</th><th class="ta-r">Days</th><th class="ta-r">Deliveries</th><th class="ta-r">Owing</th><th>Status</th><th></th></tr></thead>
      <tbody>${off.map(r=>`<tr>
        <td><b>${esc(r.c.name)}</b><div class="tny muted">${esc(sendTo(r.c))}</div></td>
        <td><span class="chip c-mute">${esc(cycleOf(r.c).label)}</span></td>
        <td class="num">${esc(fmtD(r.oldest))}</td>
        <td class="ta-r num">${r.age}</td>
        <td class="ta-r num">${r.rows.length}</td>
        <td class="ta-r num"><b>${money(r.total)}</b></td>
        <td>${r.due?`<span class="chip c-em">Ready &middot; ${esc(r.why)}</span>`:`<span class="chip c-mute">${esc(r.why)}</span>`}</td>
        <td class="row" style="gap:6px"><button class="btn" style="padding:4px 10px" data-act="stview" data-id="${r.c.id}">${S.stView===r.c.id?"Hide":"Details"}</button>
          ${r.un.length?`<button class="btn" style="padding:4px 10px" data-act="invprep" data-id="${r.c.id}">Invoice it</button>`:""}</td>
      </tr>
      ${S.stView===r.c.id?`<tr><td colspan="8" style="background:var(--panel2);padding:0">
        <div class="pad tny muted" style="padding-bottom:4px">Tick the bills this payment covers &mdash; five out of eight is fine. Whatever you type in the bar below is written onto every line you ticked.</div>
        <table><thead><tr><th class="pk"><input type="checkbox" class="pickbox" data-act="pickall" data-keys="${r.rows.map(l=>pkey(l.date,l.id)).join(",")}" ${r.rows.every(l=>S.pick[pkey(l.date,l.id)])?"checked":""}></th>
          <th>Date</th><th>Description</th><th>Bill no.</th><th class="ta-r">Unit</th><th class="ta-r">Qty</th><th class="ta-r">Amount</th><th>Invoice</th><th>Payment received</th></tr></thead>
        <tbody>${r.rows.slice().reverse().map(l=>`<tr class="${l.settled?"settled":""}">
          <td class="pk"><input type="checkbox" class="pickbox" data-act="pick" data-k="${pkey(l.date,l.id)}" ${S.pick[pkey(l.date,l.id)]?"checked":""}></td>
          <td class="num">${esc(fmtD(l.date))}</td><td>${esc(descOf(l.type))}</td>
          <td><input class="billin num" data-act="bill" data-d="${l.date}" data-id="${l.id}" value="${esc(l.bill||"")}" placeholder="${nextBill()}"></td>
          <td class="ta-r num muted">${money(l.price)}</td><td class="ta-r num">${l.qtyDel??l.qty}</td><td class="ta-r num">${money(amt(l))}</td>
          <td class="num tny">${l.inv?esc(l.inv):'<span class="muted">—</span>'}</td>
          <td>${l.settled?`${paidChip(l)} <span class="tny">${esc(l.setRemark||"")}</span>`:'<span class="chip c-warn">Unpaid</span>'}</td></tr>`).join("")}</tbody>
        <tfoot><tr><td colspan="6" class="ta-r"><b>Owing</b></td><td class="ta-r num"><b>${money(r.total)}</b></td><td colspan="2"></td></tr></tfoot></table>
      </td></tr>`:""}`).join("") || '<tr><td colspan="8" class="empty">Nothing outstanding on the odd cycles.</td></tr>'}</tbody>
    </table></div>
  </div>

  ${S.invPick ? invPrepCard() : ""}

  <div class="ph" style="margin-top:14px"><h2 style="font-size:19px">Issued invoices</h2></div>
  <div class="card">
    <div class="scroll"><table>
      <thead><tr><th>No.</th><th>Restaurant</th><th>Period</th><th class="ta-r">Lines</th><th class="ta-r">Total</th><th>Issued</th><th>Sent</th><th></th></tr></thead>
      <tbody>${Object.keys(S.bills.map||{}).sort((x,y)=>String(y).localeCompare(String(x))).map(no=>liveInvoice(no)).map(r=>`<tr>
        <td class="num"><b>${esc(r.no)}</b></td>
        <td>${esc(r.short||r.name)}</td>
        <td class="tny">${esc(r.period||fmtD(r.from)+" – "+fmtD(r.to))}</td>
        <td class="ta-r num">${r.lines.length}</td>
        <td class="ta-r num">${money(r.total)}</td>
        <td class="tny muted">${esc(fmtT(r.issuedAt))}</td>
        <td>${r.status==="sent"?`<span class="chip c-ok">Sent</span>`:'<span class="chip c-warn">Not sent</span>'}</td>
        <td class="row" style="gap:6px"><button class="btn" style="padding:4px 10px" data-act="invpdf" data-id="${r.no}">PDF</button>
          <button class="btn" style="padding:4px 10px" data-act="invopen" data-id="${r.no}">View</button></td>
      </tr>`).join("") || '<tr><td colspan="8" class="empty">No invoices issued yet.</td></tr>'}</tbody>
    </table></div>
  </div>`;
}

function invPrepCard(){
  const cid = S.invPick, c = CM[cid]; if(!c) return "";
  const rows = unbilled(cid), cy = cycleOf(c);
  const cut = S.invCut || "";
  const take = cut ? rows.filter(l=>l.date<=cut) : rows;
  const total = take.reduce((t,l)=>t+amt(l),0);
  return `<div class="card" style="border-left:4px solid var(--ember)">
    <div class="pad" style="border-bottom:1px solid var(--line)">
      <div class="lbl" style="color:var(--ember)">Invoice this statement &mdash; ${esc(c.name)}</div>
      <div class="tny muted">${esc(cy.label)} &middot; ${esc(sendTo(c))}. Everything unbilled goes on one invoice unless you cut it off below.</div>
    </div>
    <div class="pad filters" style="align-items:end">
      <label><span class="lbl">Include up to</span><input type="date" id="invcut" value="${esc(cut||(take[0]?take[0].date:TODAY))}" style="width:auto"></label>
      <div><span class="lbl">Deliveries</span><div class="num" style="font-size:19px">${take.length}</div></div>
      <div><span class="lbl">Total</span><div class="num" style="font-size:19px">${money(total)}</div></div>
      <button class="btn pri" data-act="invissue" data-id="${cid}" ${take.length?"":"disabled"}>Issue ${esc(invNo(S.bills.next))}</button>
      <button class="btn" data-act="invcancel">Cancel</button>
    </div>
  </div>`;
}

function paneInvoiceOne(no){
  const r = liveInvoice(no); if(!r) return '<div class="card empty">Invoice not found.</div>';
  const to = String(r.emails||"").split(/[,;]+/).map(x=>x.trim()).filter(Boolean);
  return `<div class="ph"><div><button class="btn" data-act="invback">&larr; All invoices</button></div>
    <div class="row">
      <button class="btn" data-act="invpick" data-id="${r.no}">Select all lines for payment</button>
      <button class="btn" data-act="invpdf" data-id="${r.no}">Download PDF</button>
      <a class="btn pri" href="${mailtoFor(r)}" data-act="invmail" data-id="${r.no}">Email to ${to.length} address${to.length===1?"":"es"}</a>
    </div></div>
  ${to.length?"":'<div class="note">No email address on file. Add one under Restaurants &rarr; Edit and this button fills itself in.</div>'}
  <div class="card pad" style="max-width:760px">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div><b class="disp" style="font-size:20px">${esc(COMPANY.name)}</b>
        <div class="tny muted">Reg no : ${esc(COMPANY.reg)}</div></div>
      <div style="text-align:right"><b class="disp" style="font-size:20px">INVOICE</b>
        <div class="small"><b>${esc(String(r.period||"").toUpperCase())}</b></div></div>
    </div>
    <div class="row" style="justify-content:space-between;align-items:flex-start;margin-top:18px">
      <div><div class="lbl">To</div><b>${esc(r.name)}</b>
        <div class="small muted">${esc(r.addr||"")}</div>
        <div class="tny muted">${esc(to.join(", ")||"—")}</div></div>
      <dl class="kv"><dt>Date</dt><dd class="num">${esc(fmtD((r.issuedAt||"").slice(0,10)||TODAY))}</dd>
        <dt>Invoice #</dt><dd class="num"><b>${esc(r.no)}</b></dd></dl>
    </div>
    <div class="scroll" style="margin-top:16px"><table>
      <thead><tr><th>S/N</th><th>Date</th><th>Description &amp; Bill No.</th><th class="ta-r">Unit price</th><th class="ta-r">Qty</th><th class="ta-r">Amount</th></tr></thead>
      <tbody>${r.lines.map((l,i)=>`<tr><td class="num muted">${i+1}</td><td class="num">${esc(fmtD(l.date))}</td>
        <td>${esc(descOf(l.type))}${l.bill&&l.bill!==NOBILL?", #"+esc(l.bill):""}</td>
        <td class="ta-r num muted">${money(l.price)}</td><td class="ta-r num">${l.qty}</td><td class="ta-r num">${money(l.total)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="5" class="ta-r"><b>Amount Payable (SGD)</b></td><td class="ta-r num"><b style="font-size:16px">${money(r.total)}</b></td></tr></tfoot>
    </table></div>
    <div class="small muted" style="margin-top:16px;line-height:1.6">
      ${COMPANY.footer.map(esc).join("<br>")}</div>
  </div>
  <div class="note">Bill numbers shown here were locked in when the invoice was issued. To change one, edit it on the Invoices list before issuing &mdash; or reissue. <b>Download PDF</b> gives the real file; <b>Email</b> opens your mail app with the addresses filled in. On your own server the PDF is attached and sent automatically.</div>`;
}

function oddUnpaid(){
  const out=[];
  for(const d of dayKeys()) for(const l of lines(d)){
    if(!billable(l) || l.settled) continue;
    const c = RM(l.cust); if(!c) continue;
    if(cycleOf(c).kind==="monthly" && l.payStatus==="account") continue;
    out.push(Object.assign({date:d}, l));
  }
  return out.sort((a,b)=>b.date.localeCompare(a.date));
}
const BANDS = [
  {key:"one",  name:"Bill to bill",  hint:"One bill outstanding — they normally settle each delivery", test:n=>n===1},
  {key:"few",  name:"Two or three, then settle", hint:"2 to 4 bills waiting", test:n=>n>=2&&n<=4},
  {key:"long", name:"Long period, partial payments", hint:"5 or more bills accumulated — these are the ones that get paid in chunks", test:n=>n>=5}
];
function paneUnpaid(){
  const rows = oddUnpaid();
  const byCust = {};
  rows.forEach(l=>{ const k=acctOf(l.cust); (byCust[k]=byCust[k]||[]).push(l); });
  const groups = Object.keys(byCust).map(cid=>{
    const rs = byCust[cid].slice().sort((a,b)=>a.date.localeCompare(b.date));
    return {c:RESTS[cid], rs, total:rs.reduce((t,l)=>t+amt(l),0), oldest:rs[0].date, age:dayGap(rs[0].date, TODAY)};
  }).sort((a,b)=>b.rs.length-a.rs.length || b.age-a.age);
  const grand = groups.reduce((t,g)=>t+g.total,0);
  const oldestAge = groups.reduce((m,g)=>Math.max(m,g.age),0);
  const card = g => `<div class="card">
    <div class="pad row" style="justify-content:space-between;border-bottom:1px solid var(--line);gap:10px;flex-wrap:wrap">
      <div><b class="disp" style="font-size:17px">${esc(g.c.name)}</b>
        <div class="tny muted">${esc(cycleOf(g.c).label)} &middot; ${esc(g.c.terms)} &middot; oldest ${esc(fmtD(g.oldest))}, ${g.age} days</div></div>
      <div class="row"><b class="num" style="font-size:18px;color:var(--warn)">${money(g.total)}</b>
        <button class="btn" style="padding:4px 10px" data-act="pickall" data-keys="${g.rs.map(l=>pkey(l.date,l.id)).join(",")}">${g.rs.every(l=>S.pick[pkey(l.date,l.id)])?"Untick all":"Tick all "+g.rs.length}</button></div>
    </div>
    <div class="scroll"><table>
      <thead><tr><th class="pk"></th><th>Date</th><th>Description</th><th>Bill no.</th><th class="ta-r">Qty</th><th class="ta-r">Unit</th><th class="ta-r">Amount</th><th>Terms</th><th>Invoice</th></tr></thead>
      <tbody>${g.rs.map(l=>`<tr>
        <td class="pk"><input type="checkbox" class="pickbox" data-act="pick" data-k="${pkey(l.date,l.id)}" ${S.pick[pkey(l.date,l.id)]?"checked":""}></td>
        <td class="num">${esc(fmtD(l.date))}</td>
        <td>${esc(descOf(l.type))}${l.claim?`<div><span class="chip c-acct tny">Driver ${esc(fmtDM(l.claim.day||TODAY))}: says paid by bank &mdash; check</span></div>`:""}</td>
        <td><input class="billin num" data-act="bill" data-d="${l.date}" data-id="${l.id}" value="${esc(l.bill||"")}" placeholder="${nextBill()}"></td>
        <td class="ta-r num">${l.qtyDel??l.qty}</td>
        <td class="ta-r num muted">${money(l.price)}</td>
        <td class="ta-r num"><b>${money(amt(l))}</b></td>
        <td><span class="chip ${PAYCLS[l.payStatus]||"c-mute"}">${PAYNAME[l.payStatus]||"—"}</span></td>
        <td class="num tny">${l.inv?esc(l.inv):'<span class="muted">—</span>'}</td>
      </tr>`).join("")}</tbody>
    </table></div>
  </div>`;
  return `<div class="ph"><h2>Unpaid</h2><span class="muted small">${rows.length} bills &middot; ${groups.length} restaurants</span></div>
  <div class="note">Everything outstanding that will never appear on a monthly invoice: the odd-period accounts, the delayed-cash ones, and any single bill the driver marked not paid. Monthly accounts are deliberately absent &mdash; chase those from <b>Invoices</b>. Tick whatever a payment covers, type the remark once, and only those bills clear.</div>
  <div class="tiles">
    <div class="tile warn"><span class="lbl">Total unpaid</span><b>${money(grand)}</b></div>
    <div class="tile em"><span class="lbl">Bills</span><b>${rows.length}</b></div>
    <div class="tile"><span class="lbl">Restaurants</span><b>${groups.length}</b></div>
    <div class="tile"><span class="lbl">Oldest</span><b>${oldestAge}d</b></div>
    ${(()=>{const n=rows.filter(l=>l.claim).length; return n?`<div class="tile" style="border-left-color:var(--acct)"><span class="lbl">Says paid by bank</span><b>${n}</b><span class="tny muted">check your bank, then tick &amp; mark paid</span></div>`:"";})()}
  </div>
  ${BANDS.map(bd=>{
    const g = groups.filter(x=>bd.test(x.rs.length));
    if(!g.length) return "";
    const t = g.reduce((a,x)=>a+x.total,0);
    return `<div class="ph" style="margin-top:10px"><h2 style="font-size:18px">${esc(bd.name)}</h2>
      <span class="muted small">${g.length} restaurant${g.length===1?"":"s"} &middot; ${money(t)} &middot; ${esc(bd.hint)}</span></div>
      ${g.map(card).join("")}`;
  }).join("") || '<div class="card empty">Nothing outstanding outside the monthly accounts.</div>'}`;
}

function paneStats(){
  const lc = landedCost(), oh = overheads();
  const w30 = salesWindow(30), w90 = salesWindow(90);
  const asp = w30.bags ? Math.round(w30.rev/w30.bags*100)/100 : 0;
  const margin = asp && lc.per ? Math.round((asp-lc.per)*100)/100 : 0;
  const marginPct = asp ? Math.round(margin/asp*1000)/10 : 0;
  const gross = Math.round(margin*w30.bags*100)/100;
  const net = Math.round((gross-oh.total)*100)/100;
  const beBags = margin>0 ? Math.ceil(oh.total/margin) : 0;
  const gap = beBags ? beBags - Math.round(w30.bags) : 0;
  const perStop = w30.stops ? Math.round(w30.bags/w30.stops*100)/100 : 0;
  const cons = (()=>{ let t=0,n=0; for(const d of dayKeys()){ const c=consumption(d); let v=0; for(const k of LOAD_ORDER) v+=(c[k]||0)/(DIV[k]||1); if(v){t+=v;n++;} } return n?t/n:0; })();
  const stock30 = LOAD_ORDER.reduce((t,k)=>t+stockOf(k).stock/(DIV[k]||1),0);
  const cover = cons ? Math.round(stock30/cons) : 0;

  const thin = Object.entries(w90.custs).map(([cid,v])=>({c:CM[cid]||{name:cid}, ...v, per:v.bags/v.stops}))
    .filter(x=>x.stops>=2 && x.per<2).sort((a,b)=>b.stops-a.stops).slice(0,12);
  const quiet = CUSTOMERS.map(c=>{
    if(!c.last || !c.avgGap) return null;
    const since = dayGap(c.last, TODAY);
    if(since < Math.max(c.avgGap*2.5, 21)) return null;
    return {c, since};
  }).filter(Boolean).sort((a,b)=>a.since-b.since).slice(0,12);

  const ships = shipList();
  const box = ships.filter(x=>x.kind==="box" && (+x.qty||0)>0);
  const boxPer = box.length ? Math.round(box.reduce((t,x)=>t+shipTotal(x),0)/box.reduce((t,x)=>t+(+x.qty||0),0)*100)/100 : 0;

  return `<div class="ph"><h2>Statistics</h2>
    <label class="row small"><span class="lbl">Landed cost from last</span><select id="costwin" style="width:auto">
      ${[3,6,12,"all"].map(v=>`<option value="${v}" ${String(S.costWin)===String(v)?"selected":""}>${v==="all"?"all shipments":v+" shipments"}</option>`).join("")}
    </select></label></div>

  ${w30.days<20?`<div class="note"><b>Only ${w30.days} working days of history are loaded</b>, so every &ldquo;30 day&rdquo; figure below is about ${Math.round(w30.days/26*100)}% of a real month. Scale it up before drawing conclusions &mdash; at your usual pace the monthly volume lands near ${Math.round(w30.bags/Math.max(w30.days,1)*26)} bags.</div>`:""}

  <div class="tiles">
    <div class="tile"><span class="lbl">Landed cost / 30kg bag</span><b>${money(lc.per)}</b><span class="tny muted">${lc.n} shipments, ${lc.bags} bags</span></div>
    <div class="tile"><span class="lbl">Avg selling price, 30d</span><b>${money(asp)}</b><span class="tny muted">${w30.bags} bags delivered</span></div>
    <div class="tile ${margin>0?"ok":"em"}"><span class="lbl">Margin / bag</span><b>${money(margin)}</b><span class="tny muted">${marginPct}% of price</span></div>
    <div class="tile ${net>=0?"ok":"em"}"><span class="lbl">Net after overheads, 30d</span><b>${money(net)}</b><span class="tny muted">${money(gross)} gross &minus; ${money(oh.total)} fixed</span></div>
  </div>

  <div class="two">
    <div class="card">
      <div class="pad" style="border-bottom:1px solid var(--line)"><b class="disp" style="font-size:18px">Break-even</b>
        <div class="tny muted">Fixed costs divided by margin per bag. This is the volume that pays the rent, the lorry and the wages before you earn anything.</div></div>
      <div class="pad" style="display:grid;gap:9px">
        <div class="sumrow"><span>Fixed cost a month</span><b>${money(oh.total)}</b></div>
        <div class="sumrow"><span>Margin a bag</span><b>${money(margin)}</b></div>
        <div class="sumrow"><span>Bags a month to break even</span><b>${beBags||"—"}</b></div>
        <div class="sumrow"><span>Delivered last 30 days</span><b>${Math.round(w30.bags)}</b></div>
        <div class="sumrow"><span style="color:${gap>0?"var(--ember)":"var(--ok)"}">${gap>0?"Short by":"Above break-even by"}</span>
          <b style="color:${gap>0?"var(--ember)":"var(--ok)"}">${Math.abs(gap)} bags</b></div>
        <div class="tny muted">${gap>0
          ? `That is ${Math.ceil(gap/Math.max(perStop,1))} more stops a month at your current ${perStop} bags a stop &mdash; or ${money(Math.round(oh.total/Math.max(w30.bags,1)*100)/100)} more per bag on price.`
          : `You are clearing fixed costs. Every extra bag adds ${money(margin)} straight to the bottom line.`}</div>
      </div>
    </div>

    <div class="card">
      <div class="pad" style="border-bottom:1px solid var(--line)"><b class="disp" style="font-size:18px">Right now</b></div>
      <div class="pad" style="display:grid;gap:9px">
        <div class="sumrow"><span>Bags a stop, 30d</span><b>${perStop}</b></div>
        <div class="sumrow"><span>Stops a working day</span><b>${w30.days?Math.round(w30.stops/w30.days*10)/10:0}</b></div>
        <div class="sumrow"><span>Bags a working day</span><b>${w30.days?Math.round(w30.bags/w30.days*10)/10:0}</b></div>
        <div class="sumrow"><span>Stock on hand, 30kg equiv.</span><b>${Math.round(stock30)}</b></div>
        <div class="sumrow"><span>Days of cover left</span><b style="color:${cover<14?"var(--ember)":"var(--ink)"}">${cover||"—"}</b></div>
        <div class="tny muted">Cover uses what actually left the warehouse per working day. Under two weeks is when a container needs ordering, given shipping time.</div>
      </div>
    </div>
  </div>

  ${S.sf ? shipForm() : ""}

  ${(()=>{const oo = ships.filter(onOrder);
    if(!oo.length) return "";
    return `<div class="card" style="border-left:4px solid var(--warn)">
      <div class="pad" style="border-bottom:1px solid var(--line)"><b class="disp" style="font-size:18px">On order &mdash; not arrived yet</b>
        <div class="tny muted">Recorded when you placed it. Open it and fill in the unload date when it lands.</div></div>
      <div class="scroll"><table>
        <thead><tr><th>Name</th><th>Supplier</th><th>Ordered</th><th class="ta-r">Days waiting</th><th>Expected contents</th><th class="ta-r">Per ton</th><th></th></tr></thead>
        <tbody>${oo.map(x=>`<tr><td><b>${esc(x.name)}</b>${x.ref?`<div class="tny muted">${esc(x.ref)}</div>`:""}</td>
          <td>${esc(x.supplier||"—")}</td><td class="num">${esc(fmtD(x.ordered))}</td>
          <td class="ta-r num"><b style="color:var(--warn)">${dayGap(x.ordered,TODAY)}</b></td>
          <td class="tny">${esc(shipContents(x)||"—")}</td>
          <td class="ta-r num">${x.perTon?esc(x.ccy||"USD")+" "+x.perTon:"—"}</td>
          <td><button class="btn" style="padding:4px 10px" data-act="sfedit" data-id="${x.id}">Open</button></td></tr>`).join("")}</tbody>
      </table></div>
    </div>`;})()}

  <div class="card">
    <div class="pad row" style="justify-content:space-between;border-bottom:1px solid var(--line);gap:12px;flex-wrap:wrap">
      <div><b class="disp" style="font-size:18px">Container &amp; lorry log</b>
        <div class="tny muted">Every load in, what it cost, what was in it, and how long it took to arrive. Green rows feed the landed-cost figure above${boxPer?` &middot; box shipments average ${money(boxPer)} each`:""}.</div></div>
      <button class="btn pri" data-act="sfnew">+ Record a shipment</button>
    </div>
    <div class="scroll"><table>
      <thead><tr><th>Shipment</th><th>Supplier</th><th>Ordered</th><th>Unloaded</th><th class="ta-r">Lead</th><th>Contents</th><th class="ta-r">Goods</th><th class="ta-r">Freight &amp; GST</th><th class="ta-r">Unload</th><th class="ta-r">Total</th><th class="ta-r">Bags</th><th class="ta-r">Per bag</th><th>Stock</th><th></th></tr></thead>
      <tbody>${ships.filter(x=>!onOrder(x)).map(x=>`<tr${lc.used.some(u=>u.id===x.id)?' style="background:var(--ok-soft)"':''}>
        <td><b>${esc(x.name)}</b>${x.ref?`<div class="tny muted">${esc(x.ref)}</div>`:""}${x.note?`<div class="tny" style="color:var(--warn)">${esc(x.note)}</div>`:""}</td>
        <td class="tny">${esc(x.supplier||x.origin||"—")}</td>
        <td class="num tny">${x.ordered?esc(fmtD(x.ordered)):'<span class="muted">—</span>'}</td>
        <td class="num tny">${x.date?esc(fmtD(x.date)):'<span class="muted">not recorded</span>'}</td>
        <td class="ta-r num">${shipLead(x)!=null?shipLead(x)+"d":'<span class="muted">—</span>'}</td>
        <td class="tny">${esc(shipContents(x)||"—")}</td>
        <td class="ta-r num muted">${money(+x.cogs||0)}</td>
        <td class="ta-r num muted">${money((+x.fwdO||0)+(+x.fwdSG||0)+(+x.gst||0))}</td>
        <td class="ta-r num muted">${(+x.unload)?money(+x.unload):"—"}</td>
        <td class="ta-r num"><b>${money(shipTotal(x))}</b></td>
        <td class="ta-r num">${shipQty(x)}</td>
        <td class="ta-r num"><b>${money(shipPer(x))}</b></td>
        <td>${x.posted?'<span class="chip c-ok tny">In</span>':'<span class="chip c-mute tny">—</span>'}</td>
        <td><button class="btn" style="padding:4px 9px" data-act="sfedit" data-id="${x.id}">Edit</button></td>
      </tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="9" class="ta-r"><b>Weighted landed cost, green rows</b></td>
        <td class="ta-r num"><b>${money(lc.value)}</b></td><td class="ta-r num"><b>${lc.bags}</b></td>
        <td class="ta-r num"><b>${money(lc.per)}</b></td><td colspan="2"></td></tr></tfoot>
    </table></div>
  </div>

  <div class="two">
    <div class="card">
      <div class="pad" style="border-bottom:1px solid var(--line)"><b class="disp" style="font-size:18px">Monthly fixed costs</b>
        <div class="tny muted">Business only. These drive the break-even number above.</div></div>
      <div class="pad" style="display:grid;gap:8px">
        ${oh.items.map(([k,n])=>`<label class="row" style="justify-content:space-between;gap:12px">
          <span class="small">${n}</span>
          <input type="text" inputmode="decimal" data-oh="${k}" value="${esc(oh.vals[k]==null?"":oh.vals[k])}" style="width:110px;text-align:right" class="num"></label>`).join("")}
        <div class="sumrow" style="border-top:1px solid var(--line2);padding-top:8px"><b>Total a month</b><b>${money(oh.total)}</b></div>
        <button class="btn" data-act="ohsave">Save costs</button>
      </div>
    </div>

    <div class="card">
      <div class="pad" style="border-bottom:1px solid var(--line)"><b class="disp" style="font-size:18px">Thin stops &mdash; last 90 days</b>
        <div class="tny muted">Under 2 bags a visit. These are the drops where the diesel and the driver&rsquo;s half hour eat the margin.</div></div>
      <div class="scroll"><table>
        <thead><tr><th>Restaurant</th><th class="ta-r">Stops</th><th class="ta-r">Bags/stop</th><th class="ta-r">Revenue</th><th class="ta-r">Margin</th></tr></thead>
        <tbody>${thin.map(x=>`<tr><td>${esc(x.c.name)}</td><td class="ta-r num">${x.stops}</td>
          <td class="ta-r num"><b>${Math.round(x.per*10)/10}</b></td><td class="ta-r num">${money(Math.round(x.rev))}</td>
          <td class="ta-r num">${money(Math.round(x.bags*margin))}</td></tr>`).join("")
          || '<tr><td colspan="5" class="empty">No thin stops in the window.</td></tr>'}</tbody>
      </table></div>
    </div>
  </div>

  <div class="card">
    <div class="pad" style="border-bottom:1px solid var(--line)"><b class="disp" style="font-size:18px">Gone quiet</b>
      <div class="tny muted">Ordered regularly, then stopped &mdash; more than 2.5 times their usual gap. Worth a phone call before it becomes a lost customer.</div></div>
    <div class="scroll"><table>
      <thead><tr><th>Restaurant</th><th>Last order</th><th class="ta-r">Days ago</th><th class="ta-r">Usual gap</th><th class="ta-r">Usual order</th><th>Terms</th></tr></thead>
      <tbody>${quiet.map(x=>`<tr><td><button style="font-weight:600;text-align:left" data-act="cust" data-id="${x.c.id}">${esc(x.c.name)}</button></td>
        <td class="num">${esc(fmtD(x.c.last))}</td><td class="ta-r num"><b style="color:var(--warn)">${x.since}</b></td>
        <td class="ta-r num">${x.c.avgGap}d</td><td class="ta-r num">${x.c.avgQty} ${esc(x.c.type)}</td>
        <td><span class="chip c-mute">${PAYFULL[x.c.pay]||x.c.pay}</span></td></tr>`).join("")
        || '<tr><td colspan="6" class="empty">Nobody has gone quiet.</td></tr>'}</tbody>
    </table></div>
  </div>`;
}

function normName(x){
  return String(x||"").toLowerCase()
    .replace(/\b(restaurant|resturant|rest|pte|ltd|the|cafe|kitchen|singapore|sg|road|rd|street|st|stall)\b/g," ")
    .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function bigrams(x){ const t=" "+x+" ", o={}; for(let i=0;i<t.length-1;i++){ const g=t.slice(i,i+2); o[g]=(o[g]||0)+1; } return o; }
function dice(a,b){
  a=normName(a); b=normName(b); if(!a||!b) return 0;
  if(a===b) return 1;
  if(a.length>=3 && (b.includes(a)||a.includes(b))) return 0.85;
  const A=bigrams(a), B=bigrams(b); let inter=0, na=0, nb=0;
  for(const k in A){ na+=A[k]; if(B[k]) inter+=Math.min(A[k],B[k]); } for(const k in B) nb+=B[k];
  return (2*inter)/(na+nb);
}
function nameSim(written, c){
  if(!written) return 0;
  const opts=[c.name, c.billing, c.addr].concat(c.aliases||[]);
  return Math.max(...opts.map(o=>dice(written,o)));
}
function billCandidates(){
  const from = shiftDate(TODAY, -45), out=[];
  for(const d of dayKeys()){ if(d<from||d>TODAY) continue;
    for(const l of lines(d)) if(l.status==="delivered") out.push(Object.assign({date:d}, l)); }
  return out;
}
function scoreBill(r){
  const cands = billCandidates(), res=[];
  const ids = r.match_ids||[];
  for(const l of cands){
    const c = CM[l.cust]||{name:l.cust}; let sc=0; const why=[];
    if(r.bill_no && l.bill && String(l.bill)===String(r.bill_no)){ sc+=100; why.push(["y","bill no. matches"]); }
    else if(r.bill_no && l.bill && l.bill!=="-"){ sc-=15; why.push(["n","record has #"+l.bill]); }
    const mi = ids.indexOf(l.cust);
    const ns = nameSim(r.name_written, c);
    if(mi===0){ sc+=40; } else if(mi===1){ sc+=25; } else if(mi===2){ sc+=15; }
    sc += Math.round(ns*25);
    if(mi===0||ns>=0.6) why.push(["y","name ≈ “"+(r.name_written||"?")+"”"]);
    if(r.date){ const g=Math.abs(dayGap(r.date, l.date));
      if(g===0){ sc+=25; why.push(["y","same date"]); } else if(g===1){ sc+=12; why.push(["y","1 day off"]); }
      else if(g<=3){ sc+=4; why.push(["n",g+" days off"]); } else sc-=10; }
    else sc += Math.max(0, 8 - dayGap(l.date, TODAY)/3);
    const q=l.qtyDel??l.qty;
    if(r.qty!=null && +r.qty===+q){ sc+=10; why.push(["y",q+" bags"]); }
    if(r.type && String(r.type).toUpperCase()===String(l.type).toUpperCase()) sc+=4;
    if(r.amount!=null && Math.abs(+r.amount-amt(l))<0.5){ sc+=10; why.push(["y",money(amt(l))]); }
    if(l.photo){ sc-=20; why.push(["n","already has a photo"]); }
    res.push({l, sc:Math.round(sc), why});
  }
  res.sort((a,b)=>b.sc-a.sc);
  return res;
}
function bqConfident(b){
  if(!b.sugs||!b.sugs.length) return false;
  const a=b.sugs[0].sc, n=b.sugs[1]?b.sugs[1].sc:0;
  return a>=70 && a-n>=15 && !b.sugs[0].l.photo;
}
function aiCustomerList(){
  const from = shiftDate(TODAY,-60), seen={};
  for(const d of dayKeys()) if(d>=from) for(const l of lines(d)) seen[l.cust]=1;
  return Object.keys(seen).map(id=>{ const c=CM[id]||{}; return [id, c.name||"", c.billing||"", (c.aliases||[]).join(" / ")].join(" | "); }).join("\n");
}
async function aiRead(b){
  if(S.aiOk===false){ b.status="ready"; b.read={}; b.sugs=scoreBill(b.read).slice(0,3); return; }
  const prompt = `This photo shows one handwritten carbon-copy delivery bill from a charcoal wholesaler in Singapore. The paper may be crumpled and the carbon faint. Read what is written.

Reply with ONLY one JSON object:
{"bill_no": "the bill's running number, digits only, or null",
 "date": "delivery date written on the bill as YYYY-MM-DD, or null. Year is ${TODAY.slice(0,4)} unless written otherwise. Singapore writes day before month.",
 "name_written": "the customer or restaurant name exactly as written, or null",
 "qty": number of bags or null,
 "type": one of "KB","KK","NB","10KG","6KG","3KG","KB15","KK15","FS" or null,
 "amount": total dollar amount as a number, or null,
 "match_ids": ["up to 3 ids from the customer list below that this bill most likely belongs to, best first"],
 "notes": "one short line on anything you could not read"}

Bill numbers are running numbers, currently around ${nextBill()}. Names on bills are often abbreviated or informal.

Customer list (id | short name | billing name | also written as):
${aiCustomerList()}`;
  try{
    const fd = new FormData(); fd.append("image", b.shot.blob, "bill.jpg"); fd.append("prompt", prompt);
    const r = (await ctx.upload("/bill_reads", fd)).read;
    S.aiOk = true;
    b.read = {bill_no: r&&r.bill_no?String(r.bill_no).replace(/\D/g,"")||null:null, date:r&&/^\d{4}-\d{2}-\d{2}$/.test(r.date||"")?r.date:null,
      name_written:r&&r.name_written||null, qty:r&&r.qty!=null&&!isNaN(+r.qty)?+r.qty:null,
      type:r&&r.type||null, amount:r&&r.amount!=null&&!isNaN(+r.amount)?+r.amount:null,
      match_ids:Array.isArray(r&&r.match_ids)?r.match_ids.slice(0,3):[], notes:r&&r.notes||""};
    b.status="ready";
  }catch(e){
    b.read={}; b.status="ready";
    const code = e && e.data && e.data.code;
    b.err = code==="not_granted" ? "Automatic reading isn't set up on the server — fill in what you can see." :
            code==="rate_limited" ? "Too many at once — this one wasn't read. Fill in by hand or retry." :
            "Couldn't read this one automatically — fill in what you can see.";
    if(code==="not_granted") S.aiOk=false;
  }
  b.sugs = scoreBill(b.read).slice(0,3);
}
function bqPump(){
  while(S.bqRunning<2){
    const b = S.bq.find(x=>x.status==="queued"); if(!b) break;
    b.status="reading"; S.bqRunning++;
    aiRead(b).finally(()=>{ S.bqRunning--; render(); bqPump(); });
  }
  render();
}
async function splitAdd(files){
  for(const f of files){
    const key="sp"+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    const sp={key, busy:true, size:f.size}; S.splits.unshift(sp); render();
    try{
      const bmp = await loadBitmap(f);
      sp.bmp=bmp; sp.W=bmp.width; sp.H=bmp.height;
      const pv = await toColor(bmp, 900, 0.7); sp.preview=pv.url;
      const found = detectBills(bmp);
      if(found && found.length){ sp.boxes=found; sp.how="found"; }
      else { sp.boxes=gridBoxes(bmp,2,2); sp.how="grid"; sp.grid="2x2"; }
    }catch(e){ sp.err="That file couldn't be opened as a photo."; }
    sp.busy=false; render();
  }
}
async function splitConfirm(sp){
  const each = sp.size/Math.max(1,sp.boxes.length);
  for(const b of sp.boxes.slice().reverse()){
    const key="q"+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    const item={key, status:"processing", read:{}, sugs:[]}; S.bq.unshift(item);
    try{ item.shot = await processBillSrc(cropTo(sp.bmp, b), each); item.status="queued"; }
    catch(e){ item.status="failed"; item.err="Couldn't cut this one out."; }
  }
  S.splits = S.splits.filter(x=>x!==sp); render(); bqPump();
}
function splitCard(sp){
  if(sp.busy) return `<div class="pad muted small">Finding the bills in the photo&hellip;</div>`;
  if(sp.err) return `<div class="pad" style="color:var(--warn)">${esc(sp.err)} <button class="btn tny" data-act="spdrop" data-k="${sp.key}">Remove</button></div>`;
  const n=sp.boxes.length;
  return `<div class="pad" style="border-bottom:1px solid var(--line);display:grid;gap:10px">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <b>${sp.how==="found"?`Found ${n} bill${n===1?"":"s"}`:`Couldn&rsquo;t see separate bills &mdash; split as a ${esc(sp.grid)} grid`}</b>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <span class="tny muted">Wrong? Split as</span>
        ${["1x2","2x1","2x2","2x3","3x2"].map(g=>`<button class="btn tny" style="padding:3px 8px${sp.grid===g?";border-color:var(--ember)":""}" data-act="spgrid" data-k="${sp.key}" data-g="${g}">${g.replace("x","&times;")}</button>`).join("")}
        <button class="btn tny" style="padding:3px 8px" data-act="spone" data-k="${sp.key}">One bill</button>
        ${sp.how!=="found"&&detectBills?`<button class="btn tny" style="padding:3px 8px" data-act="spauto" data-k="${sp.key}">Auto</button>`:""}
      </div>
    </div>
    <div class="splitwrap"><img src="${sp.preview}" alt="">
      ${sp.boxes.map((b,i)=>`<div class="splitbox" style="left:${b.x/sp.W*100}%;top:${b.y/sp.H*100}%;width:${b.w/sp.W*100}%;height:${b.h/sp.H*100}%"><span>${i+1}</span></div>`).join("")}
    </div>
    <div class="row" style="gap:8px">
      <button class="btn pri" data-act="spok" data-k="${sp.key}">Looks right &mdash; read all ${n}</button>
      <button class="btn" data-act="spdrop" data-k="${sp.key}">Discard photo</button>
    </div>
  </div>`;
}
async function bqAdd(files){
  for(const f of files){
    const key = "q"+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
    const b = {key, status:"processing", read:{}, sugs:[]};
    S.bq.unshift(b); render();
    try{ b.shot = await processBill(f); b.status="queued"; }
    catch(e){ b.status="failed"; b.err="That file couldn't be opened as a photo."; }
  }
  bqPump();
}
async function bqAttach(b, d, id){
  const day=S.days[d]; if(!day||!day.lines[id]) return;
  const l=day.lines[id], c=CM[l.cust]||{};
  const r=b.read||{};
  let bill=l.bill;
  if(r.bill_no && (!l.bill || l.bill==="")) bill = r.bill_no;
  const conflict = r.bill_no && l.bill && l.bill!=="-" && String(l.bill)!==String(r.bill_no);
  S.thumbs[phKey(d,id)] = b.shot.thumb; S.fullPh[phKey(d,id)] = b.shot.fullUrl;
  if(!await uploadPhoto(d, id, "bill", b.shot)) return;
  const meta = {at:new Date().toISOString(), by:ME.name, size:b.shot.size, orig:b.shot.orig, w:b.shot.w, h:b.shot.h,
    path:drivePath(d, Object.assign({}, l, {bill})), read:{bill_no:r.bill_no||null, date:r.date||null, name:r.name_written||null}};
  await saveLine(d, Object.assign({}, l, {photo:meta, bill}),
    `${c.name||l.cust} ${fmtD(d)} — bill photo attached${bill&&bill!==l.bill?", bill no. "+bill+" read from photo":""}${conflict?" (photo shows #"+r.bill_no+", record keeps #"+l.bill+")":""}`);
  if(r.name_written && c.id && nameSim(r.name_written, Object.assign({}, c, {aliases:[]}))<0.6
     && !(c.aliases||[]).some(a=>normName(a)===normName(r.name_written))){
    await saveCust(c.id, {aliases:(c.aliases||[]).concat([String(r.name_written).trim()])},
      `Learned: bills written as “${r.name_written}” belong to ${c.name}`);
  }
  b.status="done"; b.attached={d, id, name:c.name||l.cust, conflict: conflict?r.bill_no:null};
  render();
}
function bqCard(b){
  if(b.status==="done"){ const a=b.attached; return `<div class="bqcard done">
    <img src="${b.shot.thumb}" data-act="lb" data-k="${phKey(a.d,a.id)}" data-cap="${esc(a.name+" · "+fmtD(a.d))}" alt="">
    <div><b>${esc(a.name)}</b> &middot; ${esc(fmtD(a.d))} <span class="chip c-ok tny">Attached</span>
      ${a.conflict?`<div class="tny" style="color:var(--warn)">Photo shows #${esc(a.conflict)} but the record already had a different number &mdash; record kept. Check it in the list below.</div>`:""}</div>
  </div>`; }
  const r=b.read||{};
  const img = b.shot ? `<img src="${b.shot.thumb}" data-act="bqzoom" data-k="${b.key}" alt="">` : `<div class="card empty tny">…</div>`;
  if(b.status==="processing"||b.status==="queued"||b.status==="reading") return `<div class="bqcard">${img}
    <div class="muted small">${b.status==="processing"?"Cleaning up the photo…":b.status==="queued"?"Waiting to be read…":"Reading the bill… (usually 10–30 seconds)"}</div></div>`;
  if(b.status==="failed") return `<div class="bqcard">${img}<div style="color:var(--warn)">${esc(b.err||"Failed")}
    <div><button class="btn tny" data-act="bqdrop" data-k="${b.key}">Remove</button></div></div></div>`;
  const conf = bqConfident(b);
  const all = billCandidates().sort((x,y)=>y.date.localeCompare(x.date)||nameOf(x.cust).localeCompare(nameOf(y.cust)));
  return `<div class="bqcard">
    ${img}
    <div style="display:grid;gap:9px;min-width:0">
      <div class="bqread">
        <label><span class="lbl">Bill no.</span><input class="num" data-bq="bill_no" data-k="${b.key}" value="${esc(r.bill_no||"")}"></label>
        <label><span class="lbl">Date on bill</span><input type="date" data-bq="date" data-k="${b.key}" value="${esc(r.date||"")}" style="width:auto"></label>
        <label><span class="lbl">Name as written</span><input data-bq="name_written" data-k="${b.key}" value="${esc(r.name_written||"")}" style="width:170px"></label>
        <label><span class="lbl">Bags</span><input class="num" data-bq="qty" data-k="${b.key}" value="${esc(r.qty==null?"":r.qty)}" style="width:60px"></label>
        <label><span class="lbl">$</span><input class="num" data-bq="amount" data-k="${b.key}" value="${esc(r.amount==null?"":r.amount)}" style="width:80px"></label>
        <button class="btn tny" data-act="bqdrop" data-k="${b.key}" style="margin-left:auto">Discard</button>
      </div>
      ${b.err?`<div class="tny" style="color:var(--warn)">${esc(b.err)}</div>`:r.notes?`<div class="tny muted">Reader&rsquo;s note: ${esc(r.notes)}</div>`:""}
      <div class="lbl">${conf?'Suggested &mdash; <span style="color:var(--ok)">confident</span>':"Suggested &mdash; check before attaching"}</div>
      ${(b.sugs||[]).map((x,i)=>`<div class="sug ${i===0&&conf?"top":""}">
        <div class="g"><b>${esc(nameOf(x.l.cust))}</b> &middot; ${esc(fmtD(x.l.date))} &middot; ${x.l.qtyDel??x.l.qty} ${esc(x.l.type)} &middot; ${money(amt(x.l))}${x.l.bill&&x.l.bill!=="-"?" &middot; #"+esc(x.l.bill):""}
          <div class="why">${x.why.map(([k,t])=>`<span class="${k}">${esc(t)}</span>`).join(" &middot; ")||"weak match"}</div></div>
        <span class="sc">${x.sc}</span>
        <button class="btn ${i===0?"pri":""}" style="padding:5px 12px" data-act="bqattach" data-k="${b.key}" data-d="${x.l.date}" data-id="${x.l.id}">Attach</button>
      </div>`).join("") || '<div class="tny muted">No likely delivery found in the last 45 days.</div>'}
      <div class="row" style="gap:8px">
        <select data-bqpick="${b.key}" style="max-width:420px"><option value="">Or pick another delivery…</option>
          ${all.map(l=>`<option value="${l.date}|${l.id}">${esc(fmtD(l.date))} &middot; ${esc(nameOf(l.cust))} &middot; ${l.qtyDel??l.qty} ${esc(l.type)}${l.bill&&l.bill!=="-"?" #"+esc(l.bill):""}${l.photo?" (has photo)":""}</option>`).join("")}</select>
      </div>
    </div>
  </div>`;
}
function paneBillPhotos(){
  const open = S.bq.filter(b=>b.status!=="done");
  const conf = S.bq.filter(b=>b.status==="ready" && bqConfident(b));
  const busy = S.bq.filter(b=>["processing","queued","reading"].includes(b.status)).length;
  return `<div class="card">
    <div class="pad row" style="justify-content:space-between;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line)">
      <div><b class="disp" style="font-size:18px">Photograph a stack of bills</b>
        <div class="tny muted">Any order, any day &mdash; a bill from last Tuesday is fine. Each photo is cleaned up, read, and matched to its delivery. On a phone it opens the camera; on a laptop you can pick many photos at once.</div></div>
      <div class="row">
        ${conf.length?`<button class="btn pri" data-act="bqall">Attach all ${conf.length} confident</button>`:""}
        <label class="btn ${conf.length?"":"pri"}" style="cursor:pointer">+ Add bill photos<input type="file" accept="image/*" multiple id="bqfiles" style="display:none"></label>
      </div>
    </div>
    <div class="pad row" style="gap:10px;flex-wrap:wrap;border-bottom:1px solid var(--line)">
      <div class="dseg" style="margin:0;min-width:320px">
        <button data-act="bqmode" data-k="glass" aria-pressed="${S.bqMode==="glass"}">Several bills per photo</button>
        <button data-act="bqmode" data-k="one" aria-pressed="${S.bqMode==="one"}">One bill per photo</button>
      </div>
      <span class="tny muted" style="flex:1;min-width:220px">${S.bqMode==="glass"
        ? "Lay 2&ndash;6 bills on a <b>dark surface</b> under the glass, not touching. Shoot straight down, and switch off any light directly overhead to avoid glare. Each bill is cut out and read separately."
        : "One bill fills the frame. Use this for a bill that is hard to read, or when you only have one or two."}</span>
    </div>
    ${S.splits.map(splitCard).join("")}
    ${S.aiOk===false?`<div class="pad tny" style="color:var(--warn)">Automatic reading isn&rsquo;t available in this view. Type the bill number, date or name into each card and the suggestions update as you type.</div>`:""}
    ${busy?`<div class="pad tny muted">${busy} photo${busy===1?"":"s"} still being read&hellip;</div>`:""}
    ${S.bq.length?S.bq.map(bqCard).join(""):`<div class="empty small">No photos in this batch yet.</div>`}
  </div>`;
}

function paneBills(){
  const rows = dayKeys().slice().reverse().flatMap(d=>lines(d).filter(l=>l.status==="delivered").map(l=>({date:d,...l})));
  const missing = rows.filter(l=>!l.bill);
  return `<div class="ph"><h2>Bills &amp; photos</h2><span class="chip ${missing.length?"c-warn":"c-ok"}">${missing.length} bill no. missing</span></div>
  ${paneBillPhotos()}
  <div class="note">Where the driver photographed the bill, the photo sits beside the box &mdash; click it to enlarge and key the number from the screen instead of the paper. Key the running number off the handwritten bill. Type it and press Enter &mdash; it saves against that exact delivery, so the paper and the record can never drift apart.
  For a restaurant you don&rsquo;t write a physical bill for, type a dash or tap <b>No bill</b> &mdash; the delivery is then settled and stops showing up as missing.</div>
  <div class="card scroll"><table>
    <thead><tr><th>Photo</th><th>Date</th><th>Restaurant</th><th class="ta-r">Qty</th><th>Type</th><th class="ta-r">Unit</th><th class="ta-r">Total</th><th>Payment</th><th>Bill no.</th></tr></thead>
    <tbody>${(missing.length?missing:rows).slice(0,80).map(l=>`<tr>
      <td>${S.thumbs[phKey(l.date,l.id)]?`<img class="bthumb" src="${S.thumbs[phKey(l.date,l.id)]}" data-act="lb" data-k="${phKey(l.date,l.id)}" data-cap="${esc(nameOf(l.cust)+" · "+fmtD(l.date))}" alt="">`:'<span class="tny muted">—</span>'}</td>
      <td class="num">${esc(fmtD(l.date))}</td><td>${esc(nameOf(l.cust))}</td><td class="ta-r num">${l.qtyDel??l.qty}</td><td>${esc(l.type)}</td>
      <td class="ta-r num muted">${money(l.price)}</td><td class="ta-r num">${money(amt(l))}</td><td><span class="chip ${PAYCLS[l.payStatus]||"c-mute"}">${PAYNAME[l.payStatus]||"—"}</span></td>
      <td><div class="row" style="gap:6px">
        <input class="billin num" data-act="bill" data-d="${l.date}" data-id="${l.id}" value="${esc(l.bill||"")}" placeholder="${nextBill()}">
        ${l.bill?"":`<button class="btn tny" style="padding:4px 8px" data-act="nobill" data-d="${l.date}" data-id="${l.id}">No bill</button>`}
      </div></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function paneActivity(){
  const all=[];
  for(const d of Object.keys(S.audit)) for(const [id,e] of Object.entries(S.audit[d].entries||{})) all.push({d,id,...e});
  all.sort((a,b)=>String(b.at).localeCompare(String(a.at)));
  return `<div class="ph"><h2>Activity log</h2><span class="muted small">${all.length} entries</span></div>
  <div class="note">This is the trail that replaces &ldquo;the driver cannot remember&rdquo;. Every change is stamped with who, what and when &mdash; and it is never edited, only added to.</div>
  <div class="card scroll"><table><thead><tr><th>When</th><th>Who</th><th>What changed</th><th>Run date</th></tr></thead>
  <tbody>${all.map(e=>`<tr><td class="num tny">${esc(fmtT(e.at))}</td><td><span class="chip ${e.role==="driver"?"c-em":"c-acct"}">${esc(e.who)}</span></td>
    <td>${esc(e.what)}</td><td class="num tny muted">${esc(fmtD(e.d))}</td></tr>`).join("")
    ||'<tr><td colspan="4" class="empty">Nothing logged yet. Change something on the driver side and watch it land here.</td></tr>'}</tbody></table></div>`;
}

/* ===================== render + events ===================== */
function renderBar(){
  const host = $("#bar"); if(!host) return;
  const prev = document.getElementById("payremark");
  const pos = prev ? prev.selectionStart : null, had = prev === document.activeElement;
  host.innerHTML = ((S.role==="admin") ? payBar() : "") + lightbox();
  const now = document.getElementById("payremark");
  if(now && had){ now.focus(); if(pos!=null) now.setSelectionRange(pos,pos); }
}
function softRender(){
  const a = document.activeElement;
  if(a && a.closest && a.closest("#app,#bar") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){ pendingRender = true; return; }
  render();
}
function render(){
  if(!$("#app")) return;
  pendingRender = false;
  const g = document.querySelector(".gwrap");
  const sx = g?g.scrollLeft:null, sy = g?g.scrollTop:null;
  const tD=$("#tabDriver"), tA=$("#tabAdmin");
  if(tD) tD.setAttribute("aria-selected", S.role==="driver");
  if(tA) tA.setAttribute("aria-selected", S.role==="admin");
  $("#app").innerHTML = S.role==="driver" ? viewDriver() : viewAdmin();
  const g2 = document.querySelector(".gwrap");
  if(g2){ if(sx!=null){ g2.scrollLeft=sx; g2.scrollTop=sy; } else { g2.scrollLeft = g2.scrollWidth; } }
  renderBar();
}

const onClick = async e=>{
  if(e.target.classList && e.target.classList.contains("ovl")){ S.confirm=false; render(); return; }
  const t = e.target.closest("[data-act]");
  if(e.target.classList && e.target.classList.contains("lightbox")){ S.lb=null; renderBar(); return; }
  if(e.target.id==="tabDriver"){ S.role="driver"; S.open=null; S.dview="run"; render(); return; }
  if(e.target.id==="tabAdmin"){ if(ME.staff){ S.role="admin"; render(); } return; }
  if(!t) return;
  const a = t.dataset.act, id = t.dataset.id, date = S.role==="driver"?TODAY:S.adminDate;
  const day = S.days[date];
  const line = day && id ? day.lines[id] : null;

  if(a==="open"){ S.open = S.open===id?null:id; render(); }
  else if(a==="p+"||a==="p-"){
    let v = Math.round(((line.price||0) + (a==="p+"?1:-1))*100)/100;
    if(v<0) v=0;
    saveLine(date, {...line, price:v, by:"Driver", at:new Date().toISOString()},
      `${nameOf(line.cust)} — unit price set to ${money(v)} on this delivery`);
  }
  else if(a==="q+"||a==="q-"){
    const step = (line.qty%1) ? 0.1 : 1;
    let v = Math.round(((line.qtyDel??line.qty) + (a==="q+"?step:-step))*10)/10;
    if(v<0) v=0;
    saveLine(date, {...line, qtyDel:v, by:"Driver", at:new Date().toISOString()},
      `${nameOf(line.cust)} — quantity set to ${v} ${line.type}`);
  }
  else if(a==="pay"){
    S.dpick[line.id] = t.dataset.p;
    render();
  }
  else if(a==="done"){
    const p = drvPick(line);
    delete S.dpick[line.id];
    S.open=null;
    saveLine(date, {...line, status:"delivered", payStatus:p, collected:(p==="cash"||p==="paynow")?amt(line):0, by:"Driver", at:new Date().toISOString()},
      `${nameOf(line.cust)} — delivered ${line.qtyDel??line.qty} ${line.type}, ${PAYNAME[p]}${(p==="cash"||p==="paynow")?" "+money(amt(line)):""}`);
    toast((CM[line.cust]||{}).needPhoto && !line.scene ? "Delivered — photo still needed" : "Delivered");
  }
  else if(a==="skip"){
    delete S.dpick[line.id];
    S.open=null;
    saveLine(date, {...line, status:"skipped", qtyDel:0, payStatus:"unpaid", collected:0, by:"Driver", at:new Date().toISOString()},
      `${nameOf(line.cust)} — could not deliver`);
    toast("Marked not delivered");
  }
  else if(a==="sec"){ S.sec = S.sec===t.dataset.k ? null : t.dataset.k; render(); }
  else if(a==="leftok"){ const d=t.dataset.d, ex=leftExpected(d);
    await saveDay(d, {left:ex}, `Leftover counted — matches what should be left (${LOAD_ORDER.filter(x=>ex[x]!=null).map(x=>ex[x]+" "+x).join(", ")||"nothing"})`);
    toast("Leftover saved"); }
  else if(a==="rmove"){
    const dir=+t.dataset.dir, r=RM(line.cust); if(!r) return;
    const ar=areaOf(r), order=[];
    routeSort(lines(TODAY).filter(l=>l.status==="pending")).forEach(l=>{ const rr=RM(l.cust); if(rr && areaOf(rr)===ar && !order.includes(rr)) order.push(rr); });
    const i=order.indexOf(r), j=i+dir;
    if(j<0||j>=order.length){ toast(dir<0?"Already first in this area":"Already last in this area"); return; }
    const nb=order[j];
    const vals = order.map(rposOf).sort((x,y)=>x-y).map((v,k)=>Math.round((v+k*0.0001)*10000)/10000);
    [order[i],order[j]]=[order[j],order[i]];
    const writes={}; order.forEach((rr,k)=>{ if(rposOf(rr)!==vals[k]) rr.products.forEach(p=>{ writes[p.id]={rpos:vals[k]}; }); });
    await saveCustMany(writes, `Route — ${r.name} moved ${dir<0?"before":"after"} ${nb.name} (driver)`);
    toast(dir<0?"Moved earlier":"Moved later");
  }
  else if(a==="dsel"){ const k=t.dataset.k; if(S.dsel[k]) delete S.dsel[k]; else S.dsel[k]=true; render(); }
  else if(a==="drcash"||a==="drbank"){
    const ob=(driverOwing()[id]||[]).filter(l=>S.dsel[pkey(l.date,l.id)]); if(!ob.length) return;
    const at=new Date().toISOString(), byDate={};
    ob.forEach(l=>{ (byDate[l.date]=byDate[l.date]||[]).push(l.id); });
    const ups=[];
    for(const d of Object.keys(byDate)){ const dy=S.days[d]; if(!dy) continue;
      byDate[d].forEach(lid=>{ const l=dy.lines[lid]; if(!l) return;
        if(a==="drcash"){ Object.assign(l, {settled:true, setAt:at, setBy:"Driver", setMethod:"cash", setDay:TODAY, setRemark:"Cash collected by driver"}); delete l.claim;
          ups.push({id:l.id, settled:true, setAt:at, setMethod:"cash", setDay:TODAY, setRemark:"Cash collected by driver", claim:null}); }
        else { l.claim={at, by:"Driver", day:TODAY}; ups.push({id:l.id, claim:l.claim}); } }); }
    const tot=ob.reduce((x,l)=>x+amt(l),0), nm=(RESTS[id]||{}).name||"";
    S.dsel={}; render();
    await bulkLines(ups, a==="drcash" ? `Driver collected cash — ${nm}: ${ob.length} old bill${ob.length===1?"":"s"}, ${money(tot)}`
                              : `Driver: ${nm} says ${ob.length} bill${ob.length===1?"":"s"} (${money(tot)}) paid by bank — office to check`, TODAY);
    toast(a==="drcash" ? "Marked paid — hand the cash to Kin" : "Sent to the office to check");
  }
  else if(a==="drbills"){ S.dview="bills"; S.bshot=null; S.bcur=null; window.scrollTo(0,0); render(); }
  else if(a==="bpick"){ S.bcur=id; S.bshot=null; window.scrollTo(0,0); render(); }
  else if(a==="bretake"){ S.bshot=null; render(); }
  else if(a==="bkeep"){
    const shot=S.bshot; S.bshot=null;
    if(shot){ await saveBillPhoto(TODAY, S.bcur, shot); }
    const q=billQueue(TODAY), nx=q.find(l=>!l.photo && l.id!==S.bcur);
    S.bcur = nx?nx.id:S.bcur; window.scrollTo(0,0); render();
    toast(nx?"Saved — next bill":"All bills photographed");
  }
  else if(a==="bskip"){
    const q=billQueue(TODAY), i=q.findIndex(l=>l.id===S.bcur);
    const nx = q.slice(i+1).find(l=>!l.photo) || q.find(l=>!l.photo && l.id!==S.bcur);
    S.bcur = nx?nx.id:S.bcur; S.bshot=null; render();
  }
  else if(a==="lb"){ openLB(t.dataset.k, t.dataset.cap); }
  else if(a==="bqmode"){ S.bqMode=t.dataset.k; render(); }
  else if(a==="spok"){ const sp=S.splits.find(x=>x.key===t.dataset.k); if(sp) await splitConfirm(sp); }
  else if(a==="spdrop"){ S.splits=S.splits.filter(x=>x.key!==t.dataset.k); render(); }
  else if(a==="spgrid"){ const sp=S.splits.find(x=>x.key===t.dataset.k); if(sp){ const [r,c]=t.dataset.g.split("x").map(Number);
    sp.boxes=gridBoxes(sp.bmp,r,c); sp.how="grid"; sp.grid=t.dataset.g; render(); } }
  else if(a==="spone"){ const sp=S.splits.find(x=>x.key===t.dataset.k); if(sp){ sp.boxes=[{x:0,y:0,w:sp.W,h:sp.H}]; sp.how="grid"; sp.grid="1x1"; render(); } }
  else if(a==="spauto"){ const sp=S.splits.find(x=>x.key===t.dataset.k); if(sp){ const f=detectBills(sp.bmp);
    if(f&&f.length){ sp.boxes=f; sp.how="found"; sp.grid=null; } else toast("No separate bills found — use a grid"); render(); } }
  else if(a==="bqzoom"){ const b=S.bq.find(x=>x.key===t.dataset.k); if(b&&b.shot){ S.fullPh["bq_"+b.key]=b.shot.fullUrl; openLB("bq_"+b.key, "Unattached photo"); } }
  else if(a==="bqdrop"){ S.bq=S.bq.filter(x=>x.key!==t.dataset.k); render(); }
  else if(a==="bqattach"){ const b=S.bq.find(x=>x.key===t.dataset.k); if(b){ await bqAttach(b, t.dataset.d, id); toast("Attached to "+nameOf(S.days[t.dataset.d].lines[id].cust)); } }
  else if(a==="bqall"){
    const list=S.bq.filter(b=>b.status==="ready" && bqConfident(b)); let n=0;
    for(const b of list){ const x=b.sugs[0]; await bqAttach(b, x.l.date, x.l.id); n++; }
    toast(n+" attached — check the rest by hand");
  }
  else if(a==="lbclose"){ S.lb=null; renderBar(); }
  else if(a==="drrest"){ S.dview="rest"; S.adding=false; window.scrollTo(0,0); render(); }
  else if(a==="drrun"){ S.dview="run"; window.scrollTo(0,0); render(); }
  else if(a==="drtab"){ S.drTab=t.dataset.k; S.drOpen=null; render(); }
  else if(a==="dropen"){ S.drOpen = S.drOpen===id?null:id; render(); }
  else if(a==="add"){ S.dview="run"; S.adding=true; S.addQ=""; S.addDate=""; render(); setTimeout(()=>$("#addq")&&$("#addq").focus(),0); }
  else if(a==="addcancel"){ S.adding=false; S.addQ=""; S.addDate=""; render(); }
  else if(a==="addpick"||a==="addcust"){
    const c = CM[id];
    const od = (S.role==="driver" && a==="addpick") ? (S.addDate||TODAY) : date;
    S.adding=false; S.addQ=""; S.addDate="";
    await addOrder(od, c.id, c.avgQty||1, "");
    toast(od===TODAY ? "Added "+c.name : "Added "+c.name+" for "+fmtDM(od));
  }
  else if(a==="addtoday"){ S.addDate=""; render(); }
  else if(a==="notoggle"){ S.noOpen=!S.noOpen; S.no={cust:"",q:"",price:"",date:S.adminDate}; S.addQ=""; render();
    if(S.noOpen) setTimeout(()=>{const n=$("#admq"); if(n) n.focus();},0); }
  else if(a==="nopick"){ const c=CM[id], od=S.no.date||date;
    S.no={cust:c.id, q:String(c.avgQty||1), price:String(priceFrom(c.id,od)), date:od}; S.addQ=""; render(); }
  else if(a==="noclear"){ S.no={cust:"",q:"",price:"",date:S.no.date||date}; S.addQ=""; render(); }
  else if(a==="nosave"){
    const c=CM[S.no.cust]; if(!c) return;
    const od = S.no.date || date;
    const wasSent = S.days[od] && S.days[od].status && S.days[od].status!=="draft";
    await addOrder(od, c.id, S.no.q||c.avgQty||1, S.no.price);
    S.no={cust:"",q:"",price:"",date:od}; S.noOpen=false; render();
    toast(wasSent ? ("Pushed to driver — flagged NEW ("+fmtDM(od)+")") : ("Added to "+fmtDM(od)));
  }
  else if(a==="ackfresh"){ await ackFresh(TODAY); toast("Thanks — flags cleared"); }
  else if(a==="rmline"){
    const nm = nameOf((day.lines[id]||{}).cust);
    delete day.lines[id]; render();
    await safe(api("/lines/"+id, {method:"DELETE", body:{log:`Removed ${nm} from the ${fmtD(date)} list`}}));
    localLog(date, `Removed ${nm} from the ${fmtD(date)} list`);
  }
  else if(a==="tabulate"){
    await saveDay(date, {status:"dispatched", dispatchedAt:new Date().toISOString()},
      `Tabulated ${lines(date).length} stops and sent to driver`);
    toast("Sent to driver");
  }
  else if(a==="process"){ S.confirm=true; render(); }
  else if(a==="process-cancel"){ S.confirm=false; render(); }
  else if(a==="process-go"){
    const ls=lines(TODAY);
    const cash=cashExpected(TODAY).total;
    S.confirm=false;
    await saveDay(TODAY, {status:"processed", processedAt:new Date().toISOString()},
      `Processed day — ${ls.length} stops, ${money(cash)} collected`);
    toast("Sent to office. Kin has it.");
  }
  else if(a==="tab"){ S.tab=t.dataset.k; S.cust=null; S.addQ=""; render(); }
  else if(a==="cust"){ S.role="admin"; S.tab="restaurants"; S.cust=id; render(); }
  else if(a==="backcust"){ S.cust=null; render(); }
  else if(a==="sfnew"){ S.sf={mode:"container", kind:"bag30", ccy:"USD", types:{}}; render(); }
  else if(a==="sfedit"){ S.sf=Object.assign({id}, ((S.costs||{}).shipments||{})[id], {types:Object.assign({}, (((S.costs||{}).shipments||{})[id]||{}).types)}); render(); }
  else if(a==="sfcancel"){ S.sf=null; render(); }
  else if(a==="sfsave"){ await saveShip(); }
  else if(a==="ohsave"){
    const vals = Object.assign({}, (S.costs||{}).overheads);
    Object.keys(S.ohDraft||{}).forEach(k=>{ vals[k] = +S.ohDraft[k]||0; });
    const tot = Object.values(vals).reduce((t,v)=>t+(+v||0),0);
    await saveOverheads(vals, `Monthly fixed costs updated — ${money(tot)} a month`);
    S.ohDraft=null; toast("Saved");
  }
  else if(a==="mvsync"){
    const d = (S.mv[LOAD_ORDER[0]]||{}).date || TODAY;
    LOAD_ORDER.forEach(t=>{ S.mv[t] = Object.assign({}, S.mv[t], {date:d}); });
    render(); toast("All dates set to "+fmtD(d));
  }
  else if(a==="mvclear"){ S.mv={}; render(); }
  else if(a==="mvsave"){
    const list=[];
    LOAD_ORDER.forEach(t=>{
      const m = S.mv[t]; if(!m) return;
      const d = m.date || TODAY, note = String(m.note||"").trim();
      const cv = String(m.cnt==null?"":m.cnt).trim();
      if(cv!=="" && !isNaN(+cv)) list.push({kind:"check", type:t, qty:+cv, date:d, note});
    });
    if(!list.length){ toast("Nothing counted — nothing recorded"); return; }
    const n = await addMoves(list);
    S.mv={}; render(); toast(n+" count"+(n===1?"":"s")+" recorded");
  }
  else if(a==="nobill"){
    const d=t.dataset.d, l=S.days[d].lines[t.dataset.id];
    saveLine(d, {...l, bill:NOBILL}, `${nameOf(l.cust)} ${fmtD(d)} — marked no physical bill`);
    toast("Marked: no physical bill");
  }
  else if(a==="invpick"){
    const rows=[]; for(const d of dayKeys()) for(const l of lines(d)) if(l.inv===id) rows.push({d,l});
    const allOn = rows.every(x=>S.pick[pkey(x.d,x.l.id)]);
    rows.forEach(x=>{ const k=pkey(x.d,x.l.id); if(allOn) delete S.pick[k]; else S.pick[k]=true; });
    render();
  }
  else if(a==="paygo"){ await applyPaid(true); }
  else if(a==="payundo"){ await applyPaid(false); }
  else if(a==="payclear"){ S.pick={}; S.remark=""; render(); }
  else if(a==="pickall"){
    const ks = String(t.dataset.keys||"").split(",").filter(Boolean);
    const allOn = ks.every(k=>S.pick[k]);
    ks.forEach(k=>{ if(allOn) delete S.pick[k]; else S.pick[k]=true; });
    render();
  }
  else if(a==="nounlock"){ S.editNo=true; render(); }
  else if(a==="nolock"){ S.editNo=false; render(); }
  else if(a==="invall"){ S.confirmAll=true; render(); }
  else if(a==="invallno"){ S.confirmAll=false; render(); }
  else if(a==="invallgo"){
    S.confirmAll=false;
    const m=S.month, label = D(m+"-01").toLocaleDateString("en-SG",{timeZone:TZ,month:"long",year:"numeric"});
    const list = monthlyCusts(m).filter(r=>r.un.length);
    let n=0;
    for(const r of list){ const rec = await issueInvoice(r.c.id, monthRows(r.c.id,m).filter(l=>!l.inv), label); if(rec) n++; }
    render(); toast(n+" invoice"+(n===1?"":"s")+" issued");
  }
  else if(a==="stview"){ S.stView = S.stView===id?null:id; render(); }
  else if(a==="invissuem"){
    const m=S.month, rows = monthRows(id, m).filter(l=>!l.inv);
    const label = D(m+"-01").toLocaleDateString("en-SG",{timeZone:TZ,month:"long",year:"numeric"});
    const rec = await issueInvoice(id, rows, label);
    if(rec){ S.invView=rec.no; render(); toast("Invoice "+rec.no+" issued"); }
  }
  else if(a==="invprep"){ S.invPick=id; S.invCut=""; render(); }
  else if(a==="invcancel"){ S.invPick=null; S.invCut=""; render(); }
  else if(a==="invissue"){
    const rows0 = unbilled(id), rows = S.invCut ? rows0.filter(l=>l.date<=S.invCut) : rows0;
    const label = rows.length ? (fmtD(rows[rows.length-1].date)+" – "+fmtD(rows[0].date)) : "";
    const rec = await issueInvoice(id, rows, label);
    S.invPick=null; S.invCut="";
    if(rec){ S.invView=rec.no; render(); toast("Invoice "+rec.no+" issued"); }
  }
  else if(a==="invopen"){ S.invView=id; render(); }
  else if(a==="invback"){ S.invView=null; render(); }
  else if(a==="invpdf"){ downloadInvoice(id); }
  else if(a==="invmail"){ markSent(id); }
  else if(a==="cfnew"){ S.cf={id:null, cycle:"monthly", contacts:[], products:[{type:"KB", pay:"C", avgQty:1}]}; S.cust=null; S.pc=null; render(); }
  else if(a==="cfedit"){
    const r = RESTS[acctOf(id)]; if(!r) return;
    const tom = shiftDate(TODAY,1);
    S.cf = {id:r.id, name:r.name, billing:r.billing, addr:r.addr, postal:r.postal, tel:r.tel, emails:r.emails,
      contacts:JSON.parse(JSON.stringify(r.contacts||[])), waNums:r.waNums||[],
      cycle:r.cycle||"monthly", cycleWeeks:r.cycleWeeks, needPhoto:r.needPhoto, aliases:r.aliases||[], area:r.area||"",
      products:r.products.map(p=>{ const cur=priceFrom(p.id,tom); return {id:p.id, type:p.type, price:cur, orig:cur, pay:p.pay, avgQty:p.avgQty, avgGap:p.avgGap}; })};
    S.cust=null; S.pc=null; render();
  }
  else if(a==="cfcancel"){ S.cf=null; render(); }
  else if(a==="ccadd"){ const f=S.cf; if(!f) return; f.contacts=f.contacts||[]; f.contacts.push({name:"", role:"", email:"", wa:"", invE:true, invW:false}); render(); }
  else if(a==="ccrm"){ const f=S.cf; if(!f) return; f.contacts.splice(+t.dataset.i,1); render(); }
  else if(a==="ciopen"){ S.ci = S.ci ? null : {text:"", rows:null}; S.cf=null; S.pc=null; render(); }
  else if(a==="cicheck"){ S.ci.text = ($("#citxt")||{}).value||""; S.ci.rows = ciParse(S.ci.text); render(); }
  else if(a==="ciback"){ S.ci.rows=null; render(); }
  else if(a==="cisave"){
    const ok = (S.ci.rows||[]).filter(x=>x.rid && (x.email||x.wa)); if(!ok.length) return;
    const by = {}; ok.forEach(x=>{ (by[x.rid]=by[x.rid]||[]).push(x); });
    const writes = {}; let added = 0;
    Object.keys(by).forEach(rid=>{ const r=RESTS[rid]; const cur=(r.contacts||[]).slice();
      by[rid].forEach(x=>{ if(cur.some(c=>(x.email&&c.email===x.email)||(x.wa&&phoneKey(c.wa)===phoneKey(x.wa)))) return;
        cur.push({name:x.name, role:"", email:x.email, wa:x.wa, invE:!!x.email&&x.by!=="wa", invW:!!x.wa&&(x.by==="wa"||x.by==="both")}); added++; });
      const em = cur.filter(c=>c.invE&&c.email).map(c=>c.email).join(", ");
      r.products.forEach(p=>{ writes[p.id] = {contacts:cur, emails:em}; }); });
    S.ci=null;
    await saveCustMany(writes, `Imported ${added} contact${added===1?"":"s"} for ${Object.keys(by).length} restaurant${Object.keys(by).length===1?"":"s"}`);
    toast(`${added} contact${added===1?"":"s"} saved`);
  }
  else if(a==="cfpadd"){ const f=S.cf; if(!f) return; f.products.push({type:"KB", pay:(f.products.find(p=>!p.remove)||{}).pay||"C", avgQty:1}); render(); }
  else if(a==="cfprm"){ const f=S.cf, i=+t.dataset.i; if(!f) return; if(f.products[i].id) f.products[i].remove=true; else f.products.splice(i,1); render(); }
  else if(a==="cfsave"){
    const f=S.cf;
    if(!String(f.name||"").trim()){ toast("A short name is needed"); return; }
    const live = f.products.filter(p=>!p.remove);
    if(!live.length){ toast("Keep at least one charcoal type"); return; }
    const types = live.map(p=>String(p.type||"KB").toUpperCase());
    if(new Set(types).size!==types.length){ toast("Each charcoal type only once"); return; }
    const shared = {name:String(f.name).trim(), billing:f.billing||"", addr:f.addr||"", postal:f.postal||"", tel:f.tel||"",
      needPhoto:!!f.needPhoto, cycle:f.cycle||"monthly", cycleWeeks:+f.cycleWeeks||0, area:f.area||"",
      aliases:(f.aliasText!=null ? String(f.aliasText).split(",").map(x=>x.trim()).filter(Boolean) : (f.aliases||[]))};
    const cts = (f.contacts||[]).map(x=>({name:String(x.name||"").trim(), role:String(x.role||"").trim(), email:String(x.email||"").trim().toLowerCase(),
      wa:fmtPhone(x.wa), invE:!!x.invE, invW:!!x.invW})).filter(x=>x.name||x.email||x.wa);
    const badE = cts.find(x=>x.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.email));
    if(badE){ toast("Check this email: "+badE.email); return; }
    shared.contacts = cts; shared.emails = cts.filter(x=>x.invE&&x.email).map(x=>x.email).join(", ");
    const rid = f.id || ("n"+Date.now().toString(36)), now = new Date().toISOString(), writes = {};
    f.products.forEach(p=>{ if(p.remove && p.id) writes[p.id] = {retired:true}; });
    const ids = live.map((p,i)=> p.id || ((!f.id && i===0) ? rid : rid+"t"+Date.now().toString(36)+i));
    const prim = ids.includes(rid) ? rid : ids[0];
    live.forEach((p,i)=>{
      const pid = ids[i];
      const w = Object.assign({}, shared, {acct:prim, type:types[i], price:+p.price||0, pay:p.pay||"C", avgQty:+p.avgQty||1, avgGap:+p.avgGap||0});
      if(!p.id) w.n90 = 1;
      if(p.id && p.orig!=null && +p.price!==+p.orig)
        w.prices = (((CM[pid]||{}).prices)||[]).concat([{from:TODAY, price:+p.price, was:+p.orig, at:now, by:"Admin"}]);
      writes[pid] = w;
    });
    S.cf=null;
    await saveCustMany(writes, `${f.id?"Updated":"Added"} restaurant: ${shared.name} — ${live.map((p,i)=>`${types[i]} ${money(+p.price||0)} ${PAYFULL[p.pay]||p.pay}`).join(", ")}`);
    toast(f.id?"Saved":"Restaurant added");
  }
  else if(a==="cfretire"){
    const f=S.cf; S.cf=null; const r=RESTS[f.id]; if(!r) return;
    await saveCustMany(Object.fromEntries(r.products.map(p=>[p.id,{retired:true}])), `Retired restaurant: ${f.name}`);
    toast("Retired — hidden from lists");
  }
  else if(a==="pcopen"){ S.pc = S.pc ? null : {type:"KB", mode:"add", val:"", from:TODAY, all:false, sel:{}}; S.cf=null; render(); }
  else if(a==="pcsel"){ S.pc.sel[id] = S.pc.sel[id]===false; render(); }
  else if(a==="pcall"){
    const pc=S.pc, list=CUSTOMERS.filter(p=>p.type===pc.type && (pc.all||(p.n90||0)>0));
    const allOn=list.every(p=>pc.sel[p.id]!==false); list.forEach(p=>{ pc.sel[p.id] = !allOn ? true : false; }); render();
  }
  else if(a==="pcgo"){
    const pc=S.pc, now=new Date().toISOString(), writes={}, newp={};
    CUSTOMERS.filter(p=>p.type===pc.type && (pc.all||(p.n90||0)>0) && pc.sel[p.id]!==false).forEach(p=>{
      const cur = priceFrom(p.id, pc.from), v = pc.mode==="add" ? Math.round((cur + +pc.val)*100)/100 : +pc.val;
      if(isNaN(v) || v===cur) return;
      newp[p.id] = v;
      writes[p.id] = {price:v, prices:(p.prices||[]).concat([{from:pc.from, price:v, was:cur, at:now, by:"Admin"}])};
    });
    const n = Object.keys(writes).length; if(!n){ toast("Nothing changes"); return; }
    let upd = 0; const ups = [];
    for(const d of dayKeys()){ if(d<pc.from) continue; const day=S.days[d];
      Object.values(day.lines).forEach(l=>{ if(l.status==="pending" && newp[l.cust]!=null && l.price!==newp[l.cust]){ l.price=newp[l.cust]; freeze(l); ups.push({id:l.id, price:l.price}); upd++; } }); }
    if(ups.length) await bulkLines(ups, "", TODAY);
    S.pc=null;
    await saveCustMany(writes, `Price change from ${fmtD(pc.from)} — ${pc.type} ${pc.mode==="add"?((+pc.val>0?"+":"")+money(+pc.val)):"set to "+money(+pc.val)} for ${n} restaurant${n===1?"":"s"}${upd?`, ${upd} stop${upd===1?"":"s"} already on a list updated`:""}`);
    toast(`New price for ${n} restaurant${n===1?"":"s"} from ${fmtDM(pc.from)}`);
  }
  else if(a==="routeopen"){ S.routeOpen=!S.routeOpen; render(); }
  else if(a==="rarea"){ const ord=routeOrder(), i=ord.indexOf(t.dataset.k), j=i+(+t.dataset.dir);
    if(j<0||j>=ord.length) return; [ord[i],ord[j]]=[ord[j],ord[i]]; await saveRoute(ord); logIt(TODAY, `Route order — ${AM[t.dataset.k].name} moved ${+t.dataset.dir<0?"earlier":"later"}`); }
  else if(a==="cashok"){ const d=t.dataset.d, v=S.cashIn[d]||{}, e=cashExpected(d);
    const amtIn = v.amt!=null && v.amt!=="" ? +String(v.amt).replace(/[^\d.\-]/g,"") : e.total;
    if(isNaN(amtIn)){ toast("Type the amount you received"); return; }
    await saveCash(d, amtIn, v.remark||""); delete S.cashIn[d];
    toast(amtIn===e.total ? "Cash received — matches" : "Saved — difference flagged"); }
  else if(a==="cashaccept"){ const d=t.dataset.d, v=S.cashIn[d]||{}; await saveCash(d, 0, v.remark||"", true); delete S.cashIn[d]; toast("Difference accepted"); }
  else if(a==="wapick"){ const f=waForm(S.wa.msgs[id]?Object.assign({id},S.wa.msgs[id]):{id}); const r=RESTS[t.dataset.k]; if(!r) return;
    f.rid=r.id; f.picked=true; f.q=""; f.qty=waQtyFor(r, f.parsed||{qty:{}}); if(!Object.keys(f.qty).length) f.qty={[r.products[0].id]:String(r.products[0].avgQty||1)}; render(); }
  else if(a==="warclear"){ const f=S.waf[id]; if(f){ f.rid=""; f.qty={}; f.picked=false; } render(); }
  else if(a==="waign"){ const m=S.wa.msgs[id]; await saveWA(id, Object.assign({}, m, {status:"ignored", doneAt:new Date().toISOString(), doneBy:ME.name}), "WA message marked not an order"); toast("Moved to Handled"); }
  else if(a==="wareopen"){ const m=S.wa.msgs[id]; delete S.waf[id];
    await saveWA(id, Object.assign({}, m, {status:"new", doneAt:null}));
    toast(m.status==="done"?"Reopened — the order it made is still on the list":"Reopened"); }
  else if(a==="wanewrest"){ const m=S.wa.msgs[id]; S.tab="restaurants"; S.cust=null;
    S.cf={id:null, cycle:"monthly", name:m.push||"", tel:m.from||"", contacts:m.from?[{name:m.push||"", role:"", email:"", wa:m.from, invE:false, invW:false}]:[], products:[{type:"KB", pay:"C", avgQty:1}]}; render(); }
  else if(a==="waadd"){
    const m=Object.assign({id}, S.wa.msgs[id]), f=waForm(m), r=RESTS[f.rid]; if(!r) return;
    const added=[];
    for(const p of r.products){ const q=+f.qty[p.id]; if(!(q>0)) continue;
      const l = await addOrder(f.date, p.id, q, ""); if(l) added.push({date:f.date, lineId:l.id, pid:p.id, qty:q, type:p.type}); }
    if(!added.length){ toast("Type how many bags"); return; }
    const k=phoneKey(m.from);
    if(k.length>=8 && !(r.waNums||[]).some(n=>phoneKey(n)===k))
      await saveCustMany(Object.fromEntries(r.products.map(p=>[p.id,{waNums:(r.waNums||[]).concat([m.from])}])), `WhatsApp number ${m.from} saved for ${r.name}`);
    delete S.waf[id];
    await saveWA(id, Object.assign({}, S.wa.msgs[id], {status:"done", rid:r.id, added, doneAt:new Date().toISOString(), doneBy:ME.name}));
    logIt(f.date, `WA order — ${r.name}: ${added.map(x=>x.qty+" "+x.type).join(" + ")} for ${fmtD(f.date)} (from ${m.push||m.from})`);
    toast(`Added ${r.name} — ${fmtDM(f.date)}`);
  }
  else if(a==="wapaste"){ S.waPaste=!S.waPaste; render(); }
  else if(a==="wapastego"){ const v=($("#wapastetxt")||{}).value||""; const ms=waParsePaste(v); if(!ms.length){ toast("Nothing to add"); return; }
    const r = await safe(api("/wa_messages", {method:"POST", body:{messages:ms}}));
    if(r) r.messages.forEach(m=>{ S.wa.msgs[m.id]=m; });
    S.waPaste=false; render(); if(r) toast(ms.length+" message"+(ms.length===1?"":"s")+" added"); }
  else if(a==="cashall"){ S.cashAll=!S.cashAll; render(); }
  else if(a==="cashredo"){ const d=t.dataset.d; await saveDay(d, {cashIn:null}, `Cash ${fmtD(d)} — re-entering the amount received`); }
  else if(a==="csv"){ downloadCSV(); }
};

const onInput = e=>{
  const el=e.target;
  if(el.id==="addq"||el.id==="admq"){ S.addQ=el.value; const p=el.selectionStart; render();
    const n=$("#"+el.id); if(n){n.focus(); n.setSelectionRange(p,p);} }
  else if(el.id==="gridq"){ S.gridQ=el.value; const p=el.selectionStart; render(); const n=$("#gridq"); if(n){n.focus(); n.setSelectionRange(p,p);} }
  else if(el.id==="gridall"){ S.gridAll=el.checked; render(); }
  else if(el.id==="invcut"){ S.invCut=el.value; render(); }
  else if(el.id==="payremark"){ S.remark=el.value; }
  else if(el.id==="costwin"){ S.costWin = el.value==="all"?"all":+el.value; render(); }
  else if(el.id==="mon"){ S.month=el.value; S.stView=null; render(); }
  else if(el.id==="invnext"){ const v=+String(el.value).replace(/\D/g,""); if(v>0){ S.bills.next=v; clearTimeout(invNextT);
      invNextT=setTimeout(()=>safe(api("/settings/invoice_next", {method:"PUT", body:{value:v, log:"Next invoice number set to "+invNo(v)}})), 600); } }
  else if(el.dataset.cf){ if(S.cf) S.cf[el.dataset.cf]=el.value; if(el.dataset.cf==="postal"&&S.cf){ /* area hint refreshes on next render */ } }
  else if(el.dataset.cc){ const [i,k]=el.dataset.cc.split(":"); if(S.cf && S.cf.contacts[+i]) S.cf.contacts[+i][k]=el.value; }
  else if(el.dataset.cfp){ const [i,k]=el.dataset.cfp.split(":"); if(S.cf && S.cf.products[+i]) S.cf.products[+i][k]=el.value; }
  else if(el.dataset.pc){ if(!S.pc) return; const k=el.dataset.pc; S.pc[k]=el.value; if(k==="type") S.pc.sel={};
    const pos=el.selectionStart; render(); const n=document.querySelector(`[data-pc="${k}"]`); if(n){ n.focus(); try{ if(pos!=null) n.setSelectionRange(pos,pos); }catch(_){} } }
  else if(el.dataset.wq){ const f=S.waf[el.dataset.wq]; if(f){ f.q=el.value; const pos=el.selectionStart; render();
      const n=document.querySelector(`[data-wq="${el.dataset.wq}"]`); if(n){ n.focus(); try{ n.setSelectionRange(pos,pos); }catch(_){} } } }
  else if(el.dataset.waq){ const f=S.waf[el.dataset.waq]; if(f){ f.qty[el.dataset.k]=el.value;
      const b=document.querySelector(`[data-act="waadd"][data-id="${el.dataset.waq}"]`); if(b){ const r=RESTS[f.rid]; b.disabled=!(r&&r.products.some(p=>+f.qty[p.id]>0)); } } }
  else if(el.dataset.wad){ const f=S.waf[el.dataset.wad]; if(f){ f.date=el.value||TODAY; render(); } }
  else if(el.dataset.cashd){ const d=el.dataset.cashd; S.cashIn[d]=Object.assign({}, S.cashIn[d], {[el.dataset.cashf]:el.value}); }
  else if(el.id==="paymethod"){ S.payMethod=el.value; }
  else if(el.id==="drq"){ S.drq=el.value; const p=el.selectionStart; render(); const n=$("#drq"); if(n){n.focus(); n.setSelectionRange(p,p);} }
  else if(el.id==="bno"){ /* saved on change */ }
  else if(el.id==="adddate"){ S.addDate=el.value; render(); }
  else if(el.id==="nodate"){ S.no.date=el.value; render();
    const n=$("#nodate"); if(n) n.focus(); }
  else if(el.id==="noq"||el.id==="noprice"){
    S.no[el.id==="noq"?"q":"price"]=el.value;
    const t=document.querySelectorAll('.filters input[disabled]');
    if(t.length>1) t[1].value = money((+S.no.q||0)*(+S.no.price||0));
  }
  else if(el.dataset.f){ S.filt[el.dataset.f]=el.value; render(); }
  else if(el.id==="admdate"){ S.adminDate=el.value; render(); }
};
const onChange = e=>{
  const el=e.target;
  if(el.id==="bqfiles" && el.files && el.files.length){ const fs=Array.from(el.files); el.value="";
    if(S.bqMode==="glass") splitAdd(fs); else bqAdd(fs); return; }
  if(el.dataset.scene && el.files && el.files[0]){
    const id=el.dataset.scene, f=el.files[0]; toast("Saving photo…");
    processScene(f).then(sh=>saveScenePhoto(TODAY, id, sh).then(()=>toast(`Photo saved — ${Math.round(sh.size/1024)} KB`)))
      .catch(()=>toast("Could not read that photo — try again"));
    return; }
  if(el.dataset.cfb){ if(S.cf) S.cf[el.dataset.cfb]=el.checked; return; }
  if(el.dataset.ccb){ const [i,k]=el.dataset.ccb.split(":"); if(S.cf && S.cf.contacts[+i]) S.cf.contacts[+i][k]=el.checked; return; }
  if(el.dataset.pcb){ if(S.pc){ S.pc[el.dataset.pcb]=el.checked; render(); } return; }
  if(el.dataset.bqpick){ const v=el.value; if(!v) return; const b=S.bq.find(x=>x.key===el.dataset.bqpick);
    const i=v.indexOf("|"); if(b) bqAttach(b, v.slice(0,i), v.slice(i+1)); return; }
  if(el.dataset.bq){ const b=S.bq.find(x=>x.key===el.dataset.k); if(!b) return;
    const f=el.dataset.bq, v=el.value.trim();
    b.read=Object.assign({}, b.read, {[f]: v===""?null:((f==="qty"||f==="amount")?+v:v)});
    if(f==="name_written") b.read.match_ids=[];
    b.sugs=scoreBill(b.read).slice(0,3); render(); return; }
  if(el.id==="bcam" && el.files && el.files[0]){
    S.bbusy=true; render();
    processBill(el.files[0]).then(sh=>{ S.bshot=sh; S.bbusy=false; render(); })
      .catch(()=>{ S.bbusy=false; render(); toast("Could not read that photo — try again"); });
    return;
  }
  if(el.id==="bno"){
    const l=S.days[TODAY] && S.days[TODAY].lines[el.dataset.id]; if(!l) return;
    const v=normBill(el.value); if(v===(l.bill||"")) return;
    saveLine(TODAY, Object.assign({}, l, {bill:v}), `${nameOf(l.cust)} ${fmtD(TODAY)} — bill no. ${v} typed by driver`);
    return;
  }
  if(el.dataset.ship==="kind"){
    const s = S.costs.shipments[el.dataset.id]; if(!s) return;
    saveShipRec(el.dataset.id, {kind:el.value}, `${s.name} counted as ${el.value==="bag30"?"30kg bags":el.value==="box"?"boxes":"quote only"}`);
    return;
  }
  if(el.dataset.act==="pick"){ const k=el.dataset.k; if(el.checked) S.pick[k]=true; else delete S.pick[k]; renderBar(); return; }
  if(el.dataset.act==="note"){
    const d=S.role==="driver"?TODAY:S.adminDate, l=S.days[d].lines[el.dataset.id];
    saveLine(d, {...l, note:el.value}, `${nameOf(l.cust)} — note: “${el.value}”`);
  }
  if(el.dataset.act==="cell"){ upsertCell(el.dataset.d, el.dataset.c, el.value, true); return; }
  if(el.dataset.sf){ if(S.sf){ S.sf[el.dataset.sf]=el.value; if(el.dataset.sf==="ordered"||el.dataset.sf==="date") render(); else sfCalc(); } return; }
  if(el.dataset.sfq){ if(S.sf){ S.sf.types=Object.assign({}, S.sf.types, {[el.dataset.sfq]:el.value}); sfCalc(); } return; }
  if(el.dataset.oh){ S.ohDraft = Object.assign({}, S.ohDraft, {[el.dataset.oh]: el.value}); 
    S.costs.overheads = Object.assign({}, S.costs.overheads, {[el.dataset.oh]: +el.value||0}); return; }
  if(el.dataset.mv){ const t=el.dataset.t; S.mv[t]=Object.assign({}, S.mv[t], {[el.dataset.mv]:el.value}); return; }
  if(el.dataset.act==="took"||el.dataset.act==="left"){
    saveCount(el.dataset.d, el.dataset.act==="took"?"load":"left", el.dataset.t, el.value);
    toast("Saved");
  }
  if(el.dataset.act==="unit"){
    const d=el.dataset.d, l=S.days[d].lines[el.dataset.id], old=l.price;
    const v=+el.value; if(isNaN(v)){ render(); return; }
    saveLine(d, {...l, price:v}, `${nameOf(l.cust)} ${fmtD(d)} — unit price ${money(old)} → ${money(v)} on this delivery only`);
    toast("Unit price updated for this delivery");
  }
  if(el.dataset.act==="bill"){
    const d=el.dataset.d, l=S.days[d].lines[el.dataset.id], v=normBill(el.value);
    saveLine(d, {...l, bill:v}, `${nameOf(l.cust)} ${fmtD(d)} — ${v===NOBILL?"marked no physical bill":"bill no. "+v}`);
    toast(v===NOBILL?"Marked: no physical bill":("Bill "+v+" saved"));
  }
};

function downloadCSV(){
  const rows=filtered();
  const head=["Date","Restaurant","Billing name","Qty ordered","Qty delivered","Type","Unit price","Amount","Payment","Bill no","Note","Updated by","Updated at"];
  const body=rows.map(l=>{const c=CM[l.cust]||{};
    return [l.date,c.name||l.cust,c.billing||"",l.qty,l.qtyDel??l.qty,l.type,l.price,amt(l),PAYNAME[l.payStatus]||"",l.bill||"",l.note||"",l.by||"",l.at||""];});
  const csv=[head,...body].map(r=>r.map(v=>`"${String(v==null?"":v).replace(/"/g,'""')}"`).join(",")).join("\n");
  saveBlob(new Blob(["\ufeff"+csv], {type:"text/csv"}), `deliveries_${S.filt.from}_to_${S.filt.to}.csv`);
  toast("CSV downloaded ("+rows.length+" rows)");
}



/* ===================== sync with the server ===================== */
let since = null, syncTimer = null, syncing = false, stopped = false;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

async function sync(){
  if(syncing || stopped) return;
  syncing = true;
  let changed = false;
  try{
    const r = await api("/sync", {params: since ? {since} : {}});
    if(stopped) return;
    if(r.full){ changed = true; }
    since = r.now;
    if(r.today && r.today !== TODAY){ TODAY = r.today; changed = true; }

    if(r.full) SERVER_CUSTOMERS = r.customers;
    else if(r.customers.length){ mergeCustomers(r.customers); changed = true; }

    r.days.forEach(d=>{ const cur=S.days[d.date]; const {lines, ...rest} = cur||{};
      if(!cur || !same(Object.assign({}, rest), Object.assign({}, rest, d))){ applyDay(d); changed = true; } });
    r.lines.forEach(l=>{ const cur = S.days[l.date] && S.days[l.date].lines && S.days[l.date].lines[l.id];
      if(!cur || !same(cur, l)){ applyLine(l); changed = true; } });
    (r.deleted && r.deleted.lines || []).forEach(id=>{
      for(const d of Object.keys(S.days)) if(S.days[d].lines && S.days[d].lines[id]){ delete S.days[d].lines[id]; changed = true; } });
    (r.photos||[]).forEach(p=>{ if(S.thumbs[p.key]!==p.thumb || S.photoIds[p.key]!==p.id){
      S.thumbs[p.key]=p.thumb; S.photoIds[p.key]=p.id; delete S.fullPh[p.key]; changed = true; } });

    const st = r.settings || {};
    if(st.route && !same(st.route, S.custEdits.route)){ S.custEdits.route = st.route; changed = true; }
    if(st.invoice_next!=null && st.invoice_next!==S.bills.next && !S.editNo){ S.bills.next = st.invoice_next; changed = true; }
    if(st.overheads && !same(st.overheads, S.costs.overheads) && !S.ohDraft){ S.costs.overheads = st.overheads; changed = true; }

    (r.invoices||[]).forEach(i=>{ if(!same(S.bills.map[i.no], i)){ S.bills.map[i.no]=i; changed = true; } });
    (r.shipments||[]).forEach(x=>{ if(!same(S.costs.shipments[x.id], x)){ S.costs.shipments[x.id]=x; changed = true; } });
    (r.moves||[]).forEach(m=>{ if(!same(S.inv.moves[m.id], m)){ S.inv.moves[m.id]=m; changed = true; } });
    (r.wa||[]).forEach(m=>{ if(!same(S.wa.msgs[m.id], m)){ S.wa.msgs[m.id]=m; changed = true; } });
    if(r.audit && r.audit.length){
      // server entries replace the ones we added locally while waiting
      Object.values(S.audit).forEach(a=>Object.keys(a.entries).forEach(k=>{ if(k.startsWith("local")) delete a.entries[k]; }));
      r.audit.forEach(e=>{ S.audit[e.date] = S.audit[e.date] || {date:e.date, entries:{}}; S.audit[e.date].entries[e.id] = e; });
      changed = true;
    }

    if(changed){ rebuildCustomers(); r.full ? render() : softRender(); }
    if(ctx.onStatus) ctx.onStatus("ok");
  }catch(e){
    if(ctx.onStatus) ctx.onStatus(e && e.status===401 ? "signedout" : "offline");
  }finally{
    syncing = false;
    scheduleSync();
  }
}
function scheduleSync(ms){
  clearTimeout(syncTimer);
  if(stopped) return;
  syncTimer = setTimeout(sync, ms!=null ? ms : (document.hidden ? 60000 : 8000));
}
const onVisible = () => { if(!document.hidden) scheduleSync(0); };
const onFocusOut = () => { setTimeout(()=>{ if(pendingRender){ const a=document.activeElement;
  if(!(a && a.closest && a.closest("#app,#bar") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) render(); } }, 0); };

S.wa = {msgs:{}};
S.bills = {next:2779, map:{}};

return {
  start(){
    stopped = false;
    document.addEventListener("click", onClick);
    document.addEventListener("input", onInput);
    document.addEventListener("change", onChange);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("focusout", onFocusOut);
    rebuildCustomers();
    $("#app").innerHTML = '<div class="empty">Loading&hellip;</div>';
    sync();
  },
  stop(){
    stopped = true; clearTimeout(syncTimer);
    document.removeEventListener("click", onClick);
    document.removeEventListener("input", onInput);
    document.removeEventListener("change", onChange);
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("focusout", onFocusOut);
  },
  setRole(role){ if(role==="admin" && !ME.staff) return; S.role = role; S.open = null; S.dview = "run"; render(); },
  syncNow(){ scheduleSync(0); },
};
}
