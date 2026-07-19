'use strict';
// ── HTML builders ──────────────────────────────────────────────────────────
function paidChip(key, paid) {
  if (!paid) return '';
  const method = (getMD().payMethod || {})[key];
  return pmChip(method);
}
// editSpec = { baseKey, baseDefault, nameEditable, amountEditable } drives the pencil
// button's edit sheet; pass null to skip the pencil for a row (rare — see call sites).
function ledgerRow(key, label, sub, amount, paid, controls='', editSpec=null, isFixed=false) {
  const pd = (getMD().payDate||{})[key] || '';
  const es = editSpec || {};
  const amountEditable = es.amountEditable !== false;
  const pencil = editSpec
    ? `<button class="base-edit-btn" title="Edit" onclick="openFixedItemEdit('${key}','${esc(label)}','${es.baseKey||key}',${es.baseDefault ?? amount},${!!es.nameEditable},${amountEditable})">✎</button>`
    : '';
  return `
<div class="lrow${isFixed?' lrow-fixed':''}" data-key="${key}" data-amount="${amount}" data-paid="${!!paid}">
  <div class="lrow-main">
    <div class="lrow-left">
      <div class="lrow-label">${esc(label)}</div>
      ${sub?`<div class="lrow-sub">${sub}</div>`:''}
      ${dateLabel(pd)}
    </div>
    <div class="lrow-right">
      <div class="lrow-amt-col">
        <span class="lrow-amt">₹${inr(amount)}</span>
        ${paidChip(key, paid)}
      </div>
      ${pencil}
    </div>
  </div>
  ${controls?`<div class="lrow-ctrl">${controls}</div>`:''}
</div>`;
}
function stepper(onMinus, onPlus, val) {
  return `<div class="stepper">
    <button class="sbtn" onclick="${onMinus}" aria-label="decrease">−</button>
    <span class="sval">${val}</span>
    <button class="sbtn" onclick="${onPlus}" aria-label="increase">+</button>
  </div>`;
}
const DOW_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function dateChips(mk, dim, dates, onclickFor) {
  const [y,m] = mk.split('-').map(Number);
  const leadBlanks = new Date(y, m-1, 1).getDay(); // 0=Sun..6=Sat — matches header column order
  const header = DOW_SHORT.map(d => `<div class="chip-hdr">${d}</div>`).join('');
  const blanks = Array.from({length:leadBlanks}, () => `<div class="chip-blank"></div>`).join('');
  const days = Array.from({length:dim},(_,i)=>i+1).map(day=>{
    const on = dates.includes(day);
    return `<button class="chip${on?' on':''}" onclick="${onclickFor(day)}">${day}</button>`;
  }).join('');
  return `<div class="chips">${header}${blanks}${days}</div>`;
}
// ── Custom fixed items: per-type row rendering ──────────────────────────────
// "Stop tracking" (formerly a 🗑 button on every row) now lives inside the
// pencil's edit sheet instead — see openFixedItemEdit()/deleteItemFromEdit().
function customItemsSectionHtml(mk, section, md, dim) {
  const isFixed = section === 'fixed';
  return activeCustomItems(mk, section).map(it => {
    const amount = customItemAmount(mk, it.key, it);
    if (it.type === 'leaveProrated') {
      const base = effectiveBase(mk, it.key, it.amount);
      const leaves = md.maidLeaves[it.key] ?? 0;
      return ledgerRow(it.key, it.label, `base ₹${inr(base)} · ${leaves} leave${leaves===1?'':'s'} this month`, amount, !!md.paid[it.key],
        `<div class="field"><span class="field-lbl">Leaves taken</span>${stepper(`changeLeaves('${it.key}',-1)`,`changeLeaves('${it.key}',1)`,leaves)}</div>`,
        { baseKey:it.key, baseDefault:base, nameEditable:true }, isFixed);
    }
    if (it.type === 'attendance') {
      const attended = !!(md.customAttended||{})[it.key];
      const base = effectiveBase(mk, it.key, it.amount);
      return ledgerRow(it.key, it.label, `₹${inr(base)} flat if attended this month`, amount, !!md.paid[it.key],
        `<label class="chk-row"><input type="checkbox" ${attended?'checked':''} onchange="toggleCustomAttended('${it.key}')"> Attended this month</label>`,
        { baseKey:it.key, baseDefault:base, nameEditable:true }, isFixed);
    }
    if (it.type === 'perClassDate') {
      const rate = effectiveBase(mk, it.key+'Rate', it.rate);
      const dates = (md.customClassDates||{})[it.key] || [];
      const chips = dateChips(mk, dim, dates, day => `toggleCustomClassDate('${it.key}',${day})`);
      return ledgerRow(it.key, it.label, `₹${inr(rate)} × ${dates.length} class${dates.length===1?'':'es'}`, amount, !!md.paid[it.key],
        chips,
        { baseKey:it.key+'Rate', baseDefault:rate, nameEditable:true }, isFixed);
    }
    return ledgerRow(it.key, it.label, 'flat, custom', amount, !!md.paid[it.key], '',
      { baseKey:it.key, baseDefault:effectiveBase(mk, it.key, it.amount), nameEditable:true }, isFixed);
  }).join('');
}
// Sorts items for display (newest date first) while keeping each item's original
// array index, since onclick handlers on the row must reference the real index.
function byDateDesc(items) {
  return (items||[]).map((it,i)=>({it,i})).sort((a,b)=>(b.it.date||'').localeCompare(a.it.date||''));
}
function miscItemList(cat, items) {
  const total = (items||[]).reduce((s,it)=>s+Number(it.amount||0),0);
  let html = '';
  if ((items||[]).length) {
    html += byDateDesc(items).map(({it,i})=>`
    <div class="mitem" data-cat="${cat}" data-idx="${i}" data-paid="${!!it.paid}">
      <div class="mitem-left">
        <div class="mitem-txt">${esc(it.text)}</div>
        ${dateLabel(it.date)}
      </div>
      <div class="mitem-right">
        <div class="mitem-amt-col">
          <span class="mitem-amt">₹${inr(it.amount)}</span>
          ${it.paid ? pmChip(it.payMethod) : ''}
        </div>
        <button class="base-edit-btn" title="Edit" onclick="openMiscEdit('${cat}',${i})">✎</button>
      </div>
    </div>`).join('');
  } else {
    html += `<div class="cc-empty">Nothing yet — add one with the + button</div>`;
  }
  html += `<div class="mtotal">
    <span class="mtotal-lbl">Section total</span>
    <span class="mtotal-val">₹${inr(total)}</span>
  </div>`;
  return html;
}
// ── Ledger tab: category button grid + drill-down detail page ─────────────
function ledgerCategoryButtonGrid(defs) {
  // defs: [[id, title, amount, paid], ...] in display order
  return `<div class="ledger-grid">` + defs.map(([id, title, amount, paid]) => {
    const pending = Math.max(0, amount - paid);
    const settled = amount > 0.5 && pending <= 0.5;
    let sub;
    if (amount <= 0.5)  sub = `<span class="tag-none">Nothing due</span>`;
    else if (settled)   sub = `<span class="tag-ok">Settled</span>`;
    else                sub = `<span class="tag-due">₹${inr(pending)} due</span>`;
    return `<button class="ledger-cat-btn" onclick="openLedgerCategory('${id}')">
      <span class="lcb-title">${esc(title)}</span>
      <span class="lcb-sub">${sub}</span>
      <span class="lcb-amt">₹${inr(amount)}</span>
    </button>`;
  }).join('') + `</div>`;
}
function ledgerCategoryDetailHtml(id, title, amount, paid, bodyHtml) {
  const pct = amount > 0 ? Math.min(100, Math.round(paid/amount*100)) : 0;
  return `<div class="ledger-detail" data-sec="${id}">
    <button class="ledger-back-btn" onclick="closeLedgerDrilldown()" aria-label="Back">‹ Back</button>
    <div class="ledger-detail-hd">
      <span class="hd-title">${esc(title)}</span>
      <span class="hd-amt">₹${inr(amount)}</span>
    </div>
    <div class="hd-bar"><i style="width:${pct}%"></i></div>
    ${budgetNote(id, amount)}
    <div class="ledger-detail-body">${bodyHtml}</div>
  </div>`;
}
// Over-budget indicator for a Ledger section, shown only when a cap is set for it.
function budgetNote(cat, spent) {
  const cap = getBudgets()[cat] || 0;
  if (!(cap > 0)) return '';
  const over = spent > cap;
  return `<div class="budget-note${over?' over':''}">${over
    ? `Over budget by ₹${inr(spent-cap)} <span>cap ₹${inr(cap)}</span>`
    : `₹${inr(spent)} of ₹${inr(cap)} budget`}</div>`;
}
// Lightweight collapsible card for the Payments/Outstanding tabs (defaults open).
function collapsibleCard(id, title, subHtml, amountHtml, bodyHtml, barHtml) {
  const open = isOpen(id, 1);
  return `<section class="card${open?' open':''}" data-sec="${id}" aria-expanded="${open?'true':'false'}" style="margin-bottom:14px">
    <button class="card-hd" onclick="toggleCollapse('${id}')">
      <span class="chev" aria-hidden="true">›</span>
      <span class="hd-main"><span class="hd-title">${title}</span><span class="hd-sub">${subHtml||''}</span></span>
      <span class="hd-amt">${amountHtml||''}</span>
    </button>
    ${barHtml||''}
    <div class="card-body-wrap"><div class="card-body" style="padding-bottom:8px">${bodyHtml}</div></div>
  </section>`;
}

// ── Main render ────────────────────────────────────────────────────────────
let prevRenderedTab = null; // used only to detect a fresh tab entry vs. a same-tab re-render
function render() {
  const scrollY = window.scrollY;
  const enteringHome = currentTab === 'home' && prevRenderedTab !== 'home';
  prevRenderedTab = currentTab;
  applyTabChrome();

  const ml = monthLabel(currentMonth);
  const parts = ml.split(' ');
  document.getElementById('month-lbl').innerHTML =
    parts.length===2 ? `${parts[0]} <span class="yr">${parts[1]}</span>` : ml;

  const navBtns = document.querySelectorAll('#month-nav .nav-btn');
  if (navBtns[0]) navBtns[0].style.opacity = currentMonth <= navMinMonth() ? '0.3' : '1';
  if (navBtns[1]) navBtns[1].style.opacity = currentMonth >= todayMonthKey() ? '0.3' : '1';

  const todayBtn = document.getElementById('today-jump');
  if (todayBtn) todayBtn.classList.toggle('hidden', currentMonth === todayMonthKey());

  if (currentTab === 'home') {
    renderHome(enteringHome);
    window.scrollTo(0, scrollY);
    setSyncState(IN_GAS ? 'ok' : 'off');
    return;
  }
  if (currentTab === 'outstanding') {
    renderOutstanding();
    window.scrollTo(0, scrollY);
    setSyncState(IN_GAS ? 'ok' : 'off');
    return;
  }
  if (currentTab === 'payments') {
    renderPayments();
    window.scrollTo(0, scrollY);
    setSyncState(IN_GAS ? 'ok' : 'off');
    return;
  }

  const md  = getMD();
  const dim = daysInMonth(currentMonth);

  // --- Maids ---
  const activeMaids = MAIDS.filter(m => !isDiscontinued(m.key, currentMonth));
  const maidAmounts = activeMaids.map(m => {
    const base   = effectiveBase(currentMonth, m.key, m.base);
    const leaves = md.maidLeaves[m.key]??2;
    return { ...m, base, leaves, amount: maidPayout(base, leaves, dim) };
  });
  const japaActive = currentMonth>='2026-08' && currentMonth<='2026-10';
  const japaDiscontinued = isDiscontinued('japaMaid', currentMonth);
  const japaDays   = md.japaDaysPresent==null ? defaultJapaDays(currentMonth) : md.japaDaysPresent;
  const japaAmt    = japaDiscontinued ? 0 : japaMaidPayout(currentMonth, md.japaDaysPresent);

  // --- Aavia ---
  const tuition  = schoolTuition(currentMonth);
  const termFee  = schoolTermFee(currentMonth);
  const busFee   = schoolBusFee(currentMonth);
  const schoolDiscontinued = isDiscontinued('schoolFees', currentMonth);
  const schoolTot= schoolDiscontinued ? 0 : tuition + termFee + busFee;
  const bizoneDiscontinued = isDiscontinued('bizone', currentMonth);
  const bizone   = bizoneDiscontinued ? 0 : bizoneFee(currentMonth);
  const curMo    = parseInt(currentMonth.split('-')[1]);
  const isJanPay = curMo === 1;
  const isFebMar = curMo === 2 || curMo === 3;
  const isTermMo = curMo === 4 || curMo === 10;
  const schoolRateBase = effectiveBase(currentMonth, 'schoolRate', 10357);
  const busBase        = effectiveBase(currentMonth, 'schoolBus',  25150);
  const bizoneBase     = effectiveBase(currentMonth, 'bizone',     12285);
  const swimBase  = effectiveBase(currentMonth, 'swimming', 4000);
  const swimDiscontinued = isDiscontinued('swimming', currentMonth);
  const swimAmt   = (!swimDiscontinued && md.swimmingAttended) ? swimBase : 0;
  const bharatBase= effectiveBase(currentMonth, 'bharatnatyam', 1500);
  const bharatDiscontinued = isDiscontinued('bharatnatyam', currentMonth);
  const bharatAmt = (!bharatDiscontinued && md.bharatnatyamAttended) ? bharatBase : 0;
  const chessRate = effectiveBase(currentMonth, 'chessRate', 500);
  const skateRate = effectiveBase(currentMonth, 'skatingRate', 375);
  const chessDiscontinued = isDiscontinued('chess', currentMonth);
  const skateDiscontinued = isDiscontinued('skating', currentMonth);
  const chessAmt  = chessDiscontinued ? 0 : (md.chessDates||[]).length * chessRate;
  const skateAmt  = skateDiscontinued ? 0 : (md.skatingDates||[]).length * skateRate;
  const englishDiscontinued = isDiscontinued('english', currentMonth);
  const english   = englishDiscontinued ? 0 : englishFee(currentMonth);
  const aaviaMiscTot  = (md.aaviaMisc||[]).reduce((s,it)=>s+Number(it.amount||0),0);
  const aaviaMiscPaid = (md.aaviaMisc||[]).reduce((s,it)=>it.paid?s+Number(it.amount||0):s,0);
  const aaviaTot  = schoolTot+bizone+swimAmt+bharatAmt+chessAmt+skateAmt+english+aaviaMiscTot+customSectionTotal(currentMonth,'aavia');
  const aaviaPaid =
    (md.paid.schoolFees?schoolTot:0)+(md.paid.bizone?bizone:0)+
    (md.paid.swimming?swimAmt:0)+(md.paid.bharatnatyam?bharatAmt:0)+
    (md.paid.chess?chessAmt:0)+(md.paid.skating?skateAmt:0)+
    (md.paid.english?english:0)+aaviaMiscPaid+customSectionPaid(currentMonth,'aavia');

  // --- Fixed ---
  const carEmiDiscontinued = isDiscontinued('carEmi', currentMonth);
  const carEmi    = carEmiDiscontinued ? 0 : carEmiFee(currentMonth);
  const rentDiscontinued = isDiscontinued('rent', currentMonth);
  const rent      = rentDiscontinued ? 0 : effectiveBase(currentMonth, 'rent', rentFee(currentMonth));
  const sukanyaDiscontinued = isDiscontinued('sukanya', currentMonth);
  const sukanyaAmt = sukanyaDiscontinued ? 0 : sukanyaFee(currentMonth);
  const fixedTot  = sukanyaAmt + carEmi + rent + customSectionTotal(currentMonth,'fixed');
  const fixedPaid = (md.paid.sukanya?sukanyaAmt:0)+(md.paid.carEmi?carEmi:0)+(md.paid.rent?rent:0)+customSectionPaid(currentMonth,'fixed');

  // --- Household ---
  const hhGrocTot   = (md.householdGroceries||[]).reduce((s,it)=>s+Number(it.amount||0),0);
  const hhGrocPaid  = (md.householdGroceries||[]).reduce((s,it)=>it.paid?s+Number(it.amount||0):s,0);
  const hhMiscTot   = (md.householdMisc||[]).reduce((s,it)=>s+Number(it.amount||0),0);
  const hhMiscPaid  = (md.householdMisc||[]).reduce((s,it)=>it.paid?s+Number(it.amount||0):s,0);
  const hhTot       = hhGrocTot + hhMiscTot + customSectionTotal(currentMonth,'household');
  const hhPaid      = hhGrocPaid + hhMiscPaid + customSectionPaid(currentMonth,'household');

  // --- Neha / Avishek ---
  const nehaTot  = (md.nehaMisc||[]).reduce((s,it)=>s+Number(it.amount||0),0) + customSectionTotal(currentMonth,'neha');
  const avishTot = (md.avishekMisc||[]).reduce((s,it)=>s+Number(it.amount||0),0) + customSectionTotal(currentMonth,'avishek');
  const nehaPaid = (md.nehaMisc||[]).reduce((s,it)=>it.paid?s+Number(it.amount||0):s,0) + customSectionPaid(currentMonth,'neha');
  const avishPd  = (md.avishekMisc||[]).reduce((s,it)=>it.paid?s+Number(it.amount||0):s,0) + customSectionPaid(currentMonth,'avishek');

  // --- Grand totals ---
  const maidsTot   = maidAmounts.reduce((s,m)=>s+m.amount,0) + customSectionTotal(currentMonth,'maids');
  const maidsPaid  = maidAmounts.reduce((s,m)=>s+(md.paid[m.key]?m.amount:0),0) + (md.paid.japaMaid?japaAmt:0) + customSectionPaid(currentMonth,'maids');
  const maidsSecTot = maidsTot + japaAmt;
  const grandTot   = maidsTot+japaAmt+aaviaTot+fixedTot+hhTot+nehaTot+avishTot;
  const paidTot    = maidsPaid + aaviaPaid + fixedPaid + hhPaid + nehaPaid + avishPd;
  const pendingTot = grandTot - paidTot;
  const pct = grandTot>0 ? Math.round(paidTot/grandTot*100) : 0;

  // --- School sub-label ---
  const schoolSub = isFebMar
    ? 'included in January payment'
    : [
        tuition > 0 ? `tuition ₹${inr(tuition)}${isJanPay?' (Jan+Feb+Mar)':''}` : null,
        termFee ? `term ₹${inr(termFee)}` : null,
        busFee  ? `bus ₹${inr(busFee)}` : null,
      ].filter(Boolean).join(' + ');

  // ── Hero ────────────────────────────────────────────────────────────
  document.getElementById('summary').innerHTML = `
<div class="hero">
  <div class="hero-row">
    <div class="hero-lead">
      <div class="hero-lbl">Still to pay</div>
      <div class="hero-num ${pendingTot>0.5?'':'g'}">₹${inr(pendingTot)}</div>
    </div>
    <div class="hero-stats">
      <div class="hstat"><div class="k">Owed</div><div class="v">₹${inr(grandTot)}</div></div>
      <div class="hstat"><div class="k">Paid</div><div class="v g">₹${inr(paidTot)}</div></div>
    </div>
  </div>
  <div class="hero-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
  <div class="hero-foot">
    <span><span class="mono">${pct}%</span> settled</span>
    <span>${pendingTot<=0.5?'All cleared 🎉':`<span class="mono">₹${inr(paidTot)}</span><span>&nbsp;of&nbsp;</span><span class="mono">₹${inr(grandTot)}</span>`}</span>
  </div>
</div>`;

  // ── Section bodies ──────────────────────────────────────────────────
  // Maids
  let maidsBody = '';
  maidAmounts.forEach(m => {
    maidsBody += ledgerRow(m.key, m.label,
      `base ₹${inr(m.base)} · ${m.leaves} leave${m.leaves===1?'':'s'} this month`,
      m.amount, !!md.paid[m.key],
      `<div class="field"><span class="field-lbl">Leaves taken</span>${stepper(`changeLeaves('${m.key}',${-maidLeafStep(m.key)})`,`changeLeaves('${m.key}',${maidLeafStep(m.key)})`,m.leaves)}</div>`,
      { baseKey:m.key, baseDefault:m.base }
    );
  });
  if (!japaDiscontinued) {
    maidsBody += ledgerRow('japaMaid','Japa Maid',
      japaActive ? `live-in · flat ₹28,000/mo, prorated · ${japaDays} of ${dim} days` : 'not in service this month',
      japaAmt, !!md.paid.japaMaid,
      (japaActive ? `<div class="field"><span class="field-lbl">Days present</span>${stepper('changeJapaDays(-1)','changeJapaDays(1)',japaDays)}</div>` : ''),
      { amountEditable:false } // day-prorated total, not a single overridable base
    );
  }
  maidsBody += customItemsSectionHtml(currentMonth, 'maids', md, dim);

  // Aavia
  let aaviaBody = `<div class="sublbl">School</div>`;
  if (!schoolDiscontinued) {
    aaviaBody += ledgerRow('schoolFees','P G Garodia School', schoolSub, schoolTot, !!md.paid.schoolFees,
      baseEditControl('schoolRate', schoolRateBase, 'Tuition Base') +
      (isTermMo ? baseEditControl('schoolBus', busBase, 'Bus Base') : ''),
      { amountEditable:false } // two separate base values (tuition + bus), edited above instead
    );
  }
  if (!bizoneDiscontinued) {
    aaviaBody += ledgerRow('bizone','Bizone (snacks)',
      bizone ? `₹${inr(bizone)} this term` : 'nothing due this month',
      bizone, !!md.paid.bizone, '',
      { baseKey:'bizone', baseDefault:bizoneBase });
  }
  aaviaBody += `<div class="sublbl">Classes</div>`;
  if (!englishDiscontinued) {
    aaviaBody += ledgerRow('english','English (Sheetal)', english?'lump-sum installment due':'no payment due this month', english, !!md.paid.english, '',
      { baseKey:'english', baseDefault:english });
  }
  if (!swimDiscontinued) {
    aaviaBody += ledgerRow('swimming','Swimming',`₹${inr(swimBase)} flat if attended this month`, swimAmt, !!md.paid.swimming,
      `<label class="chk-row"><input type="checkbox" ${md.swimmingAttended?'checked':''} onchange="toggleSwimming()"> Attended this month</label>`,
      { baseKey:'swimming', baseDefault:swimBase });
  }
  if (!bharatDiscontinued) {
    aaviaBody += ledgerRow('bharatnatyam','Bharatnatyam',`₹${inr(bharatBase)} flat if attended this month`, bharatAmt, !!md.paid.bharatnatyam,
      `<label class="chk-row"><input type="checkbox" ${md.bharatnatyamAttended?'checked':''} onchange="toggleBharatnatyam()"> Attended this month</label>`,
      { baseKey:'bharatnatyam', baseDefault:bharatBase });
  }
  if (!chessDiscontinued) {
    aaviaBody += ledgerRow('chess','Chess',
      `₹${inr(chessRate)} × ${(md.chessDates||[]).length} class${(md.chessDates||[]).length===1?'':'es'}`,
      chessAmt, !!md.paid.chess,
      dateChips(currentMonth, dim, md.chessDates||[], day => `toggleChessDate(${day})`),
      { baseKey:'chessRate', baseDefault:chessRate });
  }
  if (!skateDiscontinued) {
    aaviaBody += ledgerRow('skating','Skating',
      `₹${inr(skateRate)} × ${(md.skatingDates||[]).length} class${(md.skatingDates||[]).length===1?'':'es'}`,
      skateAmt, !!md.paid.skating,
      dateChips(currentMonth, dim, md.skatingDates||[], day => `toggleSkatingDate(${day})`),
      { baseKey:'skatingRate', baseDefault:skateRate });
  }
  aaviaBody += `<div class="sublbl">Miscellaneous</div>${miscItemList('aaviaMisc', md.aaviaMisc)}`;
  aaviaBody += customItemsSectionHtml(currentMonth, 'aavia', md, dim);

  // Fixed
  let fixedBody = '';
  if (!sukanyaDiscontinued) fixedBody += ledgerRow('sukanya','Sukanya Samriddhi','flat, indefinite',sukanyaAmt,!!md.paid.sukanya, '', { baseKey:'sukanya', baseDefault:sukanyaAmt }, true);
  if (!carEmiDiscontinued) fixedBody += ledgerRow('carEmi','Car EMI', carEmi?'Aug 2022 – Jul 2027':'outside loan tenure', carEmi, !!md.paid.carEmi, '', { baseKey:'carEmi', baseDefault:carEmi }, true);
  if (!rentDiscontinued) fixedBody += ledgerRow('rent','Rent', `₹${inr(rent)}/mo`, rent, !!md.paid.rent, '', { baseKey:'rent', baseDefault:rent }, true);
  fixedBody += customItemsSectionHtml(currentMonth, 'fixed', md, dim);

  // Household
  let hhBody = `<div class="sublbl">Household Groceries</div>${miscItemList('householdGroceries', md.householdGroceries)}`;
  hhBody += `<div class="sublbl">Household Miscellaneous</div>${miscItemList('householdMisc', md.householdMisc)}`;
  hhBody += customItemsSectionHtml(currentMonth, 'household', md, dim);

  // Neha / Avishek
  const nehaBody  = miscItemList('nehaMisc', md.nehaMisc) + customItemsSectionHtml(currentMonth, 'neha', md, dim);
  const avishBody = miscItemList('avishekMisc', md.avishekMisc) + customItemsSectionHtml(currentMonth, 'avishek', md, dim);

  // ── Assemble ────────────────────────────────────────────────────────
  // Display order: Household, Neha, Aavia, Avishek, Maids, Fixed.
  const secDefs = [
    ['household', 'Household', hhTot,       hhPaid,    hhBody],
    ['neha',      'Neha',      nehaTot,     nehaPaid,  nehaBody],
    ['aavia',     'Aavia',     aaviaTot,    aaviaPaid, aaviaBody],
    ['avishek',   'Avishek',   avishTot,    avishPd,   avishBody],
    ['maids',     'Maids',     maidsSecTot, maidsPaid, maidsBody],
    ['fixed',     'Fixed',     fixedTot,    fixedPaid, fixedBody],
  ];
  let html;
  const found = ledgerDrilldown && secDefs.find(([id]) => id === ledgerDrilldown);
  if (found) {
    const [id, title, amount, paid, bodyHtml] = found;
    html = ledgerCategoryDetailHtml(id, title, amount, paid, bodyHtml);
  } else {
    ledgerDrilldown = null; // stale/invalid id guard
    html = ledgerCategoryButtonGrid(secDefs.map(([id, title, amount, paid]) => [id, title, amount, paid]));
  }

  document.getElementById('app-body').innerHTML = html;
  window.scrollTo(0, scrollY);
  setSyncState(IN_GAS ? 'ok' : 'off');
}

// Every paid item for a month as {label, amount, method, date}. Shared by the
// Payments tab and the drawer's "Source of spends" view.
function collectPaidItems(mk) {
  const md = getMDFor(mk), dim = daysInMonth(mk);
  const out = [];
  const addFixed = (label, amount, key) => {
    if (md.paid[key] && amount > 0)
      out.push({ label, amount, method:(md.payMethod||{})[key]||null, date:(md.payDate||{})[key]||'' });
  };
  MAIDS.forEach(m => addFixed(m.label, maidPayout(effectiveBase(mk,m.key,m.base), md.maidLeaves[m.key]??2, dim), m.key));
  if (mk >= '2026-08' && mk <= '2026-10') addFixed('Japa Maid', japaMaidPayout(mk, md.japaDaysPresent), 'japaMaid');
  const schoolTot = schoolTuition(mk)+schoolTermFee(mk)+schoolBusFee(mk);
  if (schoolTot) addFixed('PG Garodia School', schoolTot, 'schoolFees');
  const bz = bizoneFee(mk); if (bz) addFixed('Bizone', bz, 'bizone');
  const en = englishFee(mk); if (en) addFixed('English (Sheetal)', en, 'english');
  if (md.swimmingAttended)     addFixed('Swimming',     effectiveBase(mk,'swimming',4000),     'swimming');
  if (md.bharatnatyamAttended) addFixed('Bharatnatyam', effectiveBase(mk,'bharatnatyam',1500), 'bharatnatyam');
  const chessAmt = (md.chessDates||[]).length * effectiveBase(mk,'chessRate',500);
  if (chessAmt)  addFixed('Chess',   chessAmt,  'chess');
  const skateAmt = (md.skatingDates||[]).length * effectiveBase(mk,'skatingRate',375);
  if (skateAmt)  addFixed('Skating', skateAmt, 'skating');
  addFixed('Sukanya Samriddhi', sukanyaFee(mk), 'sukanya');
  const ce = carEmiFee(mk); if (ce) addFixed('Car EMI', ce, 'carEmi');
  addFixed('Rent', effectiveBase(mk,'rent',rentFee(mk)), 'rent');
  const pushItems = (arr, labelFn) => (arr||[]).filter(it=>it.paid).forEach(it =>
    out.push({ label:labelFn(it), amount:Number(it.amount||0), method:it.payMethod||null, date:it.date||'' }));
  pushItems(md.aaviaMisc,          it=>'Aavia — '+it.text);
  pushItems(md.householdGroceries, it=>'HH Groceries — '+it.text);
  pushItems(md.householdMisc,      it=>'HH Misc — '+it.text);
  pushItems(md.nehaMisc,           it=>'Neha — '+it.text);
  pushItems(md.avishekMisc,        it=>'Avishek — '+it.text);
  return out;
}

// ── Home dashboard render ───────────────────────────────────────────────────
// Single at-a-glance screen: month spend, CC dues, Neha balance, budget status.
// Every number here is read via the same helpers Ledger/Payments/CC/Neha/Budgets
// already use — no new math, no new state, just a consolidated view.
function renderHome() {
  document.getElementById('summary').innerHTML = homeTwoPaneHtml();
  document.getElementById('app-body').innerHTML = '';
}
function homeTwoPaneHtml() {
  return `<div class="home-pane">
    <div class="home-sidebar">${homeSidebarHtml()}</div>
    <div class="home-content">${homeTileContentHtml()}</div>
  </div>`;
}
function homeSidebarHtml() {
  const tiles = [
    { id: 'summary', label: 'Summary',        icon: svgSummary() },
    { id: 'cc',      label: 'Credit\nCards',  icon: svgCreditCard() },
    { id: 'neha',    label: 'Neha\nBank',     icon: svgBank() },
    { id: 'trends',  label: 'Trends',         icon: svgTrends() },
    { id: 'budgets', label: 'Budgets',        icon: svgBudget() },
    { id: 'daily',   label: 'Daily\nExpenses', icon: svgDaily() },
  ];
  return tiles.map(t => `
    <button class="home-tile${currentHomeTile===t.id?' active':''}" onclick="setHomeTile('${t.id}')">
      <span class="home-tile-icon">${t.icon}</span>
      <span class="home-tile-label">${t.label}</span>
    </button>`).join('');
}
function homeTileContentHtml() {
  switch (currentHomeTile) {
    case 'cc':      return ccSectionHtml();
    case 'neha':    return nehaBankSectionHtml();
    case 'trends':  return trendsSectionHtml();
    case 'budgets': return budgetsSectionHtml();
    case 'daily':   return dailyExpensesSectionHtml();
    default:        return homeSummaryContentHtml();
  }
}
function homeSummaryContentHtml() {
  const t = monthCategoryTotals(currentMonth);
  const paidTot = collectPaidItems(currentMonth).reduce((s,it)=>s+it.amount,0);
  const pendingTot = t.total - paidTot;
  const pct = t.total>0 ? Math.round(paidTot/t.total*100) : 0;
  return `<div class="hero">
  <div class="hero-row">
    <div class="hero-lead">
      <div class="hero-lbl">Month spend</div>
      <div class="hero-num">₹${inr(t.total)}</div>
    </div>
    <div class="hero-stats">
      <div class="hstat tap" onclick="switchTab('ledger')"><div class="k">Paid</div><div class="v g">₹${inr(paidTot)}</div></div>
      <div class="hstat tap" onclick="switchTab('outstanding')"><div class="k">Pending</div><div class="v">₹${inr(pendingTot)}</div></div>
    </div>
  </div>
  <div class="hero-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
  <div class="hero-foot">
    <span><span class="mono">${pct}%</span> settled</span>
    <span>${monthLabel(currentMonth)}</span>
  </div>
  ${heroSpendsHtml(currentMonth)}
</div>`;
}
function svgSummary() {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>`;
}
function svgCreditCard() {
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/></svg>`;
}
function svgBank() {
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 9 12 3 21 9"/><rect x="3" y="9" width="18" height="11"/><line x1="3" y1="20" x2="21" y2="20"/><line x1="9" y1="13" x2="9" y2="16"/><line x1="15" y1="13" x2="15" y2="16"/></svg>`;
}
function svgTrends() {
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`;
}
function svgBudget() {
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2 A10 10 0 0 1 22 12 L12 12 Z" fill="currentColor" stroke="none"/><line x1="12" y1="12" x2="6.3" y2="19.1"/></svg>`;
}
function svgDaily() {
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/></svg>`;
}
// Expenses for one specific calendar day (variable/misc items only — fixed
// recurring items have no true per-item date, so they're excluded here).
function dailyExpensesSectionHtml() {
  const mk = monthKeyOf(currentDailyDate);
  const md = getMDFor(mk);
  const cats = ['householdGroceries','householdMisc','aaviaMisc','nehaMisc','avishekMisc'];
  const items = [];
  cats.forEach(cat => (md[cat]||[]).forEach((it,i) => {
    if (it.date === currentDailyDate) items.push({ cat, i, ...it });
  }));
  const total = items.reduce((s,it)=>s+Number(it.amount||0),0);
  const dateLbl = currentDailyDate === today() ? 'Today' : fmtDate(currentDailyDate);
  const rows = items.length ? items.map(it => `
    <div class="mitem" data-paid="${!!it.paid}">
      <div class="mitem-left">
        <div class="mitem-txt">${esc(it.text)}</div>
        <div class="mitem-date">${SEARCH_CATS[it.cat]}</div>
      </div>
      <div class="mitem-right">
        <div class="mitem-amt-col">
          <span class="mitem-amt">₹${inr(it.amount)}</span>
          ${it.paid ? pmChip(it.payMethod) : ''}
        </div>
      </div>
    </div>`).join('') : `<div class="cc-empty">No expenses this day</div>`;
  return `<section class="cc-card">
    <div class="cc-head">
      <span class="cc-name">Daily Expenses</span>
      <span class="cc-out"><small>₹${inr(total)}</small></span>
    </div>
    <div class="daily-nav">
      <button class="nav-btn" onclick="shiftDailyDate(-1)" aria-label="Previous day">‹</button>
      <span class="daily-nav-lbl">${dateLbl}</span>
      <button class="nav-btn" onclick="shiftDailyDate(1)" aria-label="Next day">›</button>
    </div>
    ${rows}
  </section>`;
}
function homeCcCardHtml() {
  const cards = Object.keys(CC_CYCLES).map(cardKey => {
    const b = ccBuildCycles(cardKey);
    return { label: CC_CYCLES[cardKey].label, outstanding: Math.max(0, b.outstanding),
      overdue: b.cycles.some(c => c.statusClass === 'over') };
  });
  const totalDue = cards.reduce((s,c)=>s+c.outstanding,0);
  const rows = cards.map(c => `<div class="cc-cyc" onclick="openMenuTo('cc')">
    <div class="cc-cyc-l"><div class="cc-cyc-win">${c.label}</div><div class="cc-cyc-sub ${c.overdue?'over':(c.outstanding>0?'due':'ok')}">${c.overdue?'Overdue':(c.outstanding>0?'Outstanding':'Paid up')}</div></div>
    <div class="cc-cyc-amt">₹${inr(c.outstanding)}</div>
  </div>`).join('');
  return `<section class="cc-card">
    <div class="cc-head"><span class="cc-name">Credit Cards</span><span class="cc-out ${totalDue>0?'due':'ok'}">₹${inr(totalDue)} <small>owed</small></span></div>
    ${rows}
  </section>`;
}
function homeNehaCardHtml() {
  const balance = nehaBankBalance();
  return `<section class="cc-card">
    <div class="cc-head"><span class="cc-name">Neha Bank</span><span class="cc-out ${balance>=0?'ok':'due'}">₹${inr(balance)} <small>balance</small></span></div>
    <div class="cc-cyc" onclick="openMenuTo('neha')"><div class="cc-cyc-l"><div class="cc-cyc-win">View transfers &amp; history</div></div><div class="cc-cyc-amt">›</div></div>
  </section>`;
}
function homeBudgetCardHtml() {
  const budgets = getBudgets();
  const t = monthCategoryTotals(currentMonth);
  const capped = BUDGET_CATS.filter(([cat]) => budgets[cat] > 0);
  if (!capped.length) {
    return `<section class="cc-card">
      <div class="cc-head"><span class="cc-name">Budgets</span></div>
      <div class="cc-empty" style="padding-top:0">No budgets set yet.</div>
      <div class="cc-cyc" onclick="openMenuTo('budgets')"><div class="cc-cyc-l"><div class="cc-cyc-win">Set up budgets</div></div><div class="cc-cyc-amt">›</div></div>
    </section>`;
  }
  const overCats = capped.filter(([cat]) => (t[cat]||0) > budgets[cat]);
  const rows = capped.map(([cat,label]) => {
    const cap = budgets[cat], spent = t[cat]||0, over = spent > cap;
    return `<div class="cc-cyc" onclick="openMenuTo('budgets')">
      <div class="cc-cyc-l"><div class="cc-cyc-win">${label}</div><div class="cc-cyc-sub ${over?'over':'ok'}">₹${inr(spent)} of ₹${inr(cap)}</div></div>
      <div class="cc-cyc-amt">${over?'Over':'OK'}</div>
    </div>`;
  }).join('');
  return `<section class="cc-card">
    <div class="cc-head"><span class="cc-name">Budgets</span><span class="cc-out ${overCats.length?'due':'ok'}">${overCats.length ? overCats.length+' over' : 'On track'}</span></div>
    ${rows}
  </section>`;
}

// ── Payments render ────────────────────────────────────────────────────────
function renderPayments() {
  const allPaid = collectPaidItems(currentMonth);
  allPaid.sort((a,b) => (a.date||'').localeCompare(b.date||''));
  const byMethod = {};
  const unknown  = [];
  allPaid.forEach(it => it.method ? ((byMethod[it.method] = byMethod[it.method]||[]).push(it)) : unknown.push(it));
  const totalPaid = allPaid.reduce((s,it) => s+it.amount, 0);

  document.getElementById('summary').innerHTML = `
<div class="hero">
  <div class="hero-row">
    <div class="hero-lead">
      <div class="hero-lbl">Paid this month</div>
      <div class="hero-num g">₹${inr(totalPaid)}</div>
    </div>
    <div class="hero-stats">
      ${PAY_METHODS.filter(m=>byMethod[m.key]?.length).map(m=>{
        const tot=(byMethod[m.key]||[]).reduce((s,it)=>s+it.amount,0);
        return `<div class="hstat"><div class="k">${m.short}</div><div class="v g">₹${inr(tot)}</div></div>`;
      }).join('')}
    </div>
  </div>
  <div class="hero-foot" style="margin-top:14px"><span>${allPaid.length} payment${allPaid.length===1?'':'s'} recorded</span><span></span></div>
</div>`;

  if (!allPaid.length) {
    document.getElementById('app-body').innerHTML =
      `<div class="empty-state"><div class="big">💳</div><div class="msg">No payments yet</div><div class="sub">Mark items paid in the Ledger tab to see them here.</div></div>`;
    return;
  }

  const itemRows = items => items.map(it=>`
    <div class="out-item">
      <div class="lrow-left">
        <div class="out-item-name">${esc(it.label)}</div>
        ${it.date ? `<div class="out-item-sub">${fmtDate(it.date)}</div>` : ''}
      </div>
      <div class="out-item-right"><span class="out-amt" style="color:var(--green)">₹${inr(it.amount)}</span></div>
    </div>`).join('');

  const cardIds = PAY_METHODS.filter(pm => byMethod[pm.key]?.length).map(pm => 'pay-'+pm.key);
  if (unknown.length) cardIds.push('pay-none');
  let html = collapseToolbar(cardIds);

  PAY_METHODS.forEach(pm => {
    const items = byMethod[pm.key];
    if (!items?.length) return;
    const total = items.reduce((s,it)=>s+it.amount,0);
    const body = itemRows(items) +
      `<div class="pmth-total-row"><span class="pmth-total-lbl">${pm.label} total</span><span class="pmth-total-val">₹${inr(total)}</span></div>`;
    html += collapsibleCard('pay-'+pm.key, pm.label,
      `<span class="tag-ok">${items.length} item${items.length===1?'':'s'}</span>`, '₹'+inr(total), body);
  });

  if (unknown.length) {
    const total = unknown.reduce((s,it)=>s+it.amount,0);
    html += collapsibleCard('pay-none', 'Method not recorded',
      `<span class="tag-none">pre-existing paid data</span>`, '₹'+inr(total), itemRows(unknown));
  }

  document.getElementById('app-body').innerHTML = html;
}
// Single expand/collapse-all toggle for a set of default-open cards.
function anyOpenDefault(ids) { return ids.some(id => uiPrefs.collapsed[id] !== true); }
function collapseToolbar(ids) {
  const open = anyOpenDefault(ids);
  return `<div class="toolbar"><button class="tbtn" onclick="setAllCollapsed(${open})">${open?'Collapse all':'Expand all'}</button></div>`;
}

// ── Outstanding render ─────────────────────────────────────────────────────
function renderOutstanding() {
  const groups    = getOutstandingItems();
  const grandDue  = groups.reduce((s,g) => s + g.items.reduce((ss,it) => ss+it.amount, 0), 0);
  const monthCount = groups.length;
  const oldest = groups.length ? monthShort(groups[0].mk) : '—';
  const maxTotal = groups.reduce((mx,g)=>Math.max(mx, g.items.reduce((s,it)=>s+it.amount,0)),0);

  document.getElementById('summary').innerHTML = `
<div class="hero">
  <div class="hero-row">
    <div class="hero-lead">
      <div class="hero-lbl">Total outstanding</div>
      <div class="hero-num ${grandDue>0.5?'':'g'}">₹${inr(grandDue)}</div>
    </div>
    <div class="hero-stats">
      <div class="hstat"><div class="k">Months</div><div class="v">${monthCount}</div></div>
      <div class="hstat"><div class="k">Oldest</div><div class="v" style="font-size:14px">${oldest}</div></div>
    </div>
  </div>
  <div class="hero-foot" style="margin-top:14px"><span>Dues carried since March 2026</span><span></span></div>
</div>`;

  if (!groups.length) {
    document.getElementById('app-body').innerHTML =
      `<div class="empty-state"><div class="big">🎉</div><div class="msg">All settled</div><div class="sub">No outstanding dues since March 2026.</div></div>`;
    return;
  }

  let html = collapseToolbar(groups.map(g => 'out-'+g.mk));
  let selTotal = 0;
  groups.forEach(g => {
    const mTotal = g.items.reduce((s,it) => s+it.amount, 0);
    const w = maxTotal>0 ? Math.round(mTotal/maxTotal*100) : 0;
    let items = '';
    g.items.forEach(it => {
      const selKey = outItemKey(g.mk, it.toggleType, it.toggleKey, it.toggleIdx);
      const batchable = !FIXED_METHOD[it.toggleKey]; // rent/sukanya/carEmi auto-settle, no method choice to batch
      const checked = selectedOutKeys.has(selKey);
      if (batchable && checked) selTotal += it.amount;
      items += `<div class="out-item">
        <div class="lrow-left" style="display:flex;align-items:center;gap:10px">
          ${batchable ? `<input type="checkbox" class="out-chk" ${checked?'checked':''} onchange="toggleOutSelect('${selKey}')">` : ''}
          <div style="min-width:0">
            <div class="out-item-name">${esc(it.label)}</div>
            ${it.sub ? `<div class="out-item-sub">${esc(it.sub)}</div>` : ''}
          </div>
        </div>
        <div class="out-item-right">
          <span class="out-amt">₹${inr(it.amount)}</span>
          <button class="pbtn act sm" onclick="toggleOutItem('${g.mk}','${it.toggleType}','${it.toggleKey}',${it.toggleIdx},${it.amount})">Mark paid</button>
        </div>
      </div>`;
    });
    const bar = `<div class="hd-bar"><i style="width:${w}%;background:var(--maroon-soft)"></i></div>`;
    html += collapsibleCard('out-'+g.mk, esc(g.label),
      `<span class="tag-due">${g.items.length} item${g.items.length===1?'':'s'} due</span>`,
      '₹'+inr(mTotal), items, bar);
  });

  if (selectedOutKeys.size) {
    html += `<div class="out-sel-bar">
      <span class="out-sel-info">${selectedOutKeys.size} selected · ₹${inr(selTotal)}</span>
      <button class="out-sel-clear" onclick="clearOutSelection()">Clear</button>
      <button class="add-btn" onclick="startBatchPay()">Pay together</button>
    </div>`;
  }

  document.getElementById('app-body').innerHTML = html;
}

