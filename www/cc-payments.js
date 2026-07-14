'use strict';
// ── Outstanding calculation ────────────────────────────────────────────────
function getOutstandingItems() {
  const end = todayMonthKey();
  const result = [];
  let mk = MIN_MONTH;
  while (mk <= end) {
    if (appState.months[mk]) {
      const md  = getMDFor(mk);
      const dim = daysInMonth(mk);
      const due = [];
      const chk = (label, amount, paidKey, sub) => {
        if (isDiscontinued(paidKey, mk)) return;
        if (amount > 0 && !md.paid[paidKey])
          due.push({ label, sub:sub||'', amount, toggleType:'fixed', toggleKey:paidKey, toggleIdx:-1 });
      };

      MAIDS.forEach(m => {
        const lv   = md.maidLeaves[m.key] ?? 2;
        const base = effectiveBase(mk, m.key, m.base);
        const amt  = maidPayout(base, lv, dim);
        chk(m.label, amt, m.key, `base ₹${inr(base)} · ${lv} leave${lv===1?'':'s'}`);
      });
      const japaActive = mk>='2026-08' && mk<='2026-10';
      if (japaActive) {
        const days = md.japaDaysPresent ?? defaultJapaDays(mk);
        chk('Japa Maid', (28000/dim)*days, 'japaMaid', `${days}/${dim} days`);
      }

      const tu=schoolTuition(mk), tf=schoolTermFee(mk), bf=schoolBusFee(mk);
      const schoolMo = parseInt(mk.split('-')[1]);
      const schoolSublbl = [
        tu ? `tuition ₹${inr(tu)}${schoolMo===1?' (Jan+Feb+Mar)':''}` : null,
        tf ? `term ₹${inr(tf)}` : null,
        bf ? `bus ₹${inr(bf)}` : null,
      ].filter(Boolean).join(' + ');
      chk('PG Garodia School', tu+tf+bf, 'schoolFees', schoolSublbl);
      chk('Bizone (snacks)', bizoneFee(mk), 'bizone', 'term fee');
      chk('English (Sheetal)', englishFee(mk), 'english', 'installment');
      if (md.swimmingAttended)     chk('Swimming',     effectiveBase(mk,'swimming',4000),     'swimming',     'attended');
      if (md.bharatnatyamAttended) chk('Bharatnatyam', effectiveBase(mk,'bharatnatyam',1500), 'bharatnatyam', 'attended');
      const chessRate_ = effectiveBase(mk, 'chessRate', 500);
      const chessAmt = (md.chessDates||[]).length * chessRate_;
      if (chessAmt) chk('Chess', chessAmt, 'chess', `${(md.chessDates||[]).length} classes @ ₹${inr(chessRate_)}`);
      const skateRate_ = effectiveBase(mk, 'skatingRate', 375);
      const skateAmt = (md.skatingDates||[]).length * skateRate_;
      if (skateAmt) chk('Skating', skateAmt, 'skating', `${(md.skatingDates||[]).length} classes @ ₹${inr(skateRate_)}`);

      (md.aaviaMisc||[]).forEach((it,i) => { if (!it.paid) due.push({ label:'Aavia — '+it.text, sub:it.date||'', amount:it.amount, toggleType:'item', toggleKey:'aaviaMisc', toggleIdx:i }); });

      chk('Sukanya Samriddhi', sukanyaFee(mk), 'sukanya', 'flat');
      chk('Car EMI', carEmiFee(mk), 'carEmi', 'Aug 2022–Jul 2027');
      const rentBase = effectiveBase(mk, 'rent', rentFee(mk));
      chk('Rent', rentBase, 'rent', `₹${inr(rentBase)}/mo`);

      ['maids','aavia','fixed','household','neha','avishek'].forEach(section => {
        activeCustomItems(mk, section).forEach(it => chk(it.label, customItemAmount(mk, it.key, it), it.key, 'custom'));
      });

      (md.groceries||[]).forEach((g,i) => { if (!g.paid) due.push({ label:`${g.vendor} (${g.category})`, sub:g.date||'', amount:g.amount, toggleType:'item', toggleKey:'groceries', toggleIdx:i }); });
      (md.householdGroceries||[]).forEach((it,i) => { if (!it.paid) due.push({ label:'HH Groceries — '+it.text, sub:it.date||'', amount:it.amount, toggleType:'item', toggleKey:'householdGroceries', toggleIdx:i }); });
      (md.householdMisc||[]).forEach((it,i)      => { if (!it.paid) due.push({ label:'HH Misc — '+it.text,      sub:it.date||'', amount:it.amount, toggleType:'item', toggleKey:'householdMisc',      toggleIdx:i }); });
      (md.nehaMisc||[]).forEach((it,i)    => { if (!it.paid) due.push({ label:'Neha — '+it.text,    sub:it.date||'', amount:it.amount, toggleType:'item', toggleKey:'nehaMisc',    toggleIdx:i }); });
      (md.avishekMisc||[]).forEach((it,i) => { if (!it.paid) due.push({ label:'Avishek — '+it.text, sub:it.date||'', amount:it.amount, toggleType:'item', toggleKey:'avishekMisc', toggleIdx:i }); });

      if (due.length) result.push({ mk, label: monthLabel(mk), items: due });
    }
    mk = addMonths(mk, 1);
  }
  return result;
}

// ── Toggle outstanding item paid ───────────────────────────────────────────
function toggleOutItem(mk, type, key, idx, amount) {
  if (type === 'fixed') {
    startPayment('outFixed', mk, key, amount);
  } else {
    startPayment('outItem', mk, key, idx);
  }
}

// ── Multi-select "pay together" on Outstanding ─────────────────────────────
function outItemKey(mk, type, key, idx) { return mk+'|'+type+'|'+key+'|'+idx; }
function toggleOutSelect(selKey) {
  if (selectedOutKeys.has(selKey)) selectedOutKeys.delete(selKey); else selectedOutKeys.add(selKey);
  renderOutstanding();
}
function clearOutSelection() { selectedOutKeys.clear(); renderOutstanding(); }
function startBatchPay() {
  const keys = [...selectedOutKeys];
  if (!keys.length) return;
  // Exclude CC methods if any selected fixed item is CC-restricted (mirrors startPayment's per-item rule).
  const anyNoCC = keys.some(k => { const [,itype,ikey] = k.split('|'); return itype==='fixed' && NO_CC_KEYS.has(ikey); });
  const methods = anyNoCC ? PAY_METHODS.filter(m => m.key !== 'axisCC' && m.key !== 'scapiaCC') : PAY_METHODS;
  pendingPay = { type:'batch', args:[keys] };
  document.getElementById('pay-methods').innerHTML =
    methods.map(m => `<button class="pmth-btn" onclick="confirmPay('${m.key}')">${m.label}</button>`).join('');
  document.getElementById('pay-overlay').classList.remove('hidden');
}

// ── Base override UI ───────────────────────────────────────────────────────
let baseEditKey = null;
function startBaseEdit(key) { baseEditKey = key; render(); }
function cancelBaseEdit()   { baseEditKey = null; render(); }
function saveBase(key) {
  const inp = document.getElementById('base-inp-' + key);
  if (!inp) return;
  const val = Math.round(Number(inp.value));
  baseEditKey = null;
  if (val > 0) {
    const md = getMD();
    updateMonth({ bases: { ...(md.bases||{}), [key]: val } }, `set ${fixedLabel(key)} base to ₹${val}`);
  } else { render(); }
}
function baseEditControl(key, currentBase, label) {
  const lbl = label || 'Base';
  if (baseEditKey === key) {
    return `<div class="base-row">
      <span class="base-lbl">${lbl} ₹</span>
      <input id="base-inp-${key}" class="base-inp" type="number" value="${currentBase}">
      <button class="base-ok" onclick="saveBase('${key}')">Save</button>
      <button class="base-cancel" onclick="cancelBaseEdit()">✕</button>
    </div>`;
  }
  return `<div class="base-row">
    <button class="base-edit-btn" onclick="startBaseEdit('${key}')" title="Edit base for this month onwards">✎</button>
    <span class="base-lbl">${lbl} ₹${inr(currentBase)}</span>
  </div>`;
}

// Opening-balance inline edit for Neha Bank (flat one-off value, not a per-month base).
function startNehaBalanceEdit()  { nehaEditingBalance = true;  renderMenu(); }
function cancelNehaBalanceEdit() { nehaEditingBalance = false; renderMenu(); }
function saveNehaBalance() {
  const inp = document.getElementById('neha-bal-inp');
  if (!inp) return;
  nehaEditingBalance = false;
  setNehaInitialBalance(inp.value);
}
function nehaBalanceEditControl(currentBalance) {
  if (nehaEditingBalance) {
    return `<div class="base-row">
      <span class="base-lbl">Opening ₹</span>
      <input id="neha-bal-inp" class="base-inp" type="number" value="${currentBalance}">
      <button class="base-ok" onclick="saveNehaBalance()">Save</button>
      <button class="base-cancel" onclick="cancelNehaBalanceEdit()">✕</button>
    </div>`;
  }
  return `<div class="base-row">
    <button class="base-edit-btn" onclick="startNehaBalanceEdit()" title="Edit opening balance">✎</button>
    <span class="base-lbl">Opening ₹${inr(currentBalance)}</span>
  </div>`;
}

// ── Payment picker ─────────────────────────────────────────────────────────
function pmChip(method) {
  const pm = PAY_METHODS.find(m => m.key === method);
  return pm ? `<span class="pay-chip">via ${pm.short}</span>` : '';
}
function startPayment(type, ...args) {
  // Determine the item key for restriction lookups (fixed items only)
  const key = (type === 'fixed' || type === 'itemEdit') ? args[0] : (type === 'outFixed') ? args[1] : null;

  // Auto-confirm items with exactly one valid method — no picker needed
  if (key && FIXED_METHOD[key]) {
    pendingPay = { type, args };
    confirmPay(FIXED_METHOD[key]);
    return;
  }

  // Filter methods: no CC for maids/classes
  const methods = (type === 'fixed' || type === 'outFixed' || type === 'itemEdit') && key && NO_CC_KEYS.has(key)
    ? PAY_METHODS.filter(m => m.key !== 'axisCC' && m.key !== 'scapiaCC')
    : PAY_METHODS;

  pendingPay = { type, args };
  document.getElementById('pay-methods').innerHTML =
    methods.map(m => `<button class="pmth-btn" onclick="confirmPay('${m.key}')">${m.label}</button>`).join('');
  const overlay = document.getElementById('pay-overlay');
  overlay.classList.remove('hidden');
  attachOverlayBackHandler('pay-overlay', cancelPay);
}
function confirmPay(method) {
  if (!pendingPay) return;
  const { type, args } = pendingPay;
  pendingPay = null;
  doHaptic();
  document.getElementById('pay-overlay').classList.add('hidden');

  const methodLabel = PAY_METHODS.find(m=>m.key===method)?.label || method;

  if (type === 'fixed') {
    const [key, amt] = args;
    const md = getMD();
    updateMonth({ paid:{...md.paid,[key]:true}, payMethod:{...(md.payMethod||{}),[key]:method}, payDate:{...(md.payDate||{}),[key]:today()} },
      `paid ₹${amt} ${fixedLabel(key)} via ${methodLabel}`);
  } else if (type === 'misc') {
    const [cat, idx] = args;
    captureMiscDraft(cat);
    const md = getMD();
    const item = (md[cat]||[])[idx];
    updateMonth({ [cat]:(md[cat]||[]).map((x,i)=>i===idx?{...x,paid:true,payMethod:method}:x) },
      item && `paid ₹${item.amount} ${cat} (${item.text}) via ${methodLabel}`);
  } else if (type === 'grocery') {
    const [idx] = args;
    captureGroceryDraft();
    const md = getMD();
    const item = (md.groceries||[])[idx];
    updateMonth({ groceries:(md.groceries||[]).map((x,i)=>i===idx?{...x,paid:true,payMethod:method}:x) },
      item && `paid ₹${item.amount} groceries (${item.vendor}) via ${methodLabel}`);
  } else if (type === 'outFixed') {
    const [mk, key, amt] = args;
    const md = getMDFor(mk);
    updateMonthFor(mk, { paid:{...md.paid,[key]:true}, payMethod:{...(md.payMethod||{}),[key]:method}, payDate:{...(md.payDate||{}),[key]:today()} },
      `paid ₹${amt} ${fixedLabel(key)} via ${methodLabel} (${monthLabel(mk)})`);
  } else if (type === 'outItem') {
    const [mk, cat, idx] = args;
    const md = getMDFor(mk);
    const item = (md[cat]||[])[idx];
    updateMonthFor(mk, { [cat]:(md[cat]||[]).map((it,i)=>i===idx?{...it,paid:true,payMethod:method}:it) },
      item && `paid ₹${item.amount} ${cat} (${item.text||item.vendor}) via ${methodLabel} (${monthLabel(mk)})`);
  } else if (type === 'quickAdd') {
    const [mk, bucket, entry] = args;
    const tmd = getMDFor(mk);
    const paidEntry = { ...entry, paid:true, payMethod:method };
    updateMonthFor(mk, { [bucket]: [...(tmd[bucket]||[]), paidEntry] },
      `added ₹${entry.amount} ${bucket} (${entry.vendor||entry.text}) via ${methodLabel}`);
    closeQuickAdd();
  } else if (type === 'itemEdit') {
    // Don't commit yet — just remember the chosen method; saveItemEdit() commits
    // everything (date/name/amount/paid) together when the edit sheet is saved.
    if (pendingItemEdit) {
      pendingItemEdit.chosenMethod = method;
      const lbl = document.getElementById('ie-paid-method');
      if (lbl) lbl.textContent = 'via ' + methodLabel;
    }
  } else if (type === 'batch') {
    const [keys] = args;
    const byMonth = {};
    keys.forEach(k => {
      const [mk, itype, ikey, idxStr] = k.split('|');
      (byMonth[mk] = byMonth[mk] || []).push({ itype, ikey, idx: Number(idxStr) });
    });
    pushUndo('Paid ' + keys.length + ' items together');
    suppressUndo = true;
    Object.keys(byMonth).forEach(mk => {
      const md = getMDFor(mk);
      const paid = { ...(md.paid||{}) };
      const payMethod = { ...(md.payMethod||{}) };
      const payDate = { ...(md.payDate||{}) };
      const arrIdx = {}; // category -> Set of indices to mark paid
      byMonth[mk].forEach(({itype, ikey, idx}) => {
        if (itype === 'fixed') {
          paid[ikey] = true; payMethod[ikey] = method; payDate[ikey] = today();
        } else {
          (arrIdx[ikey] = arrIdx[ikey] || new Set()).add(idx);
        }
      });
      const patch = { paid, payMethod, payDate };
      Object.keys(arrIdx).forEach(cat => {
        const idxSet = arrIdx[cat];
        patch[cat] = (md[cat]||[]).map((it,i) => idxSet.has(i) ? {...it, paid:true, payMethod:method} : it);
      });
      updateMonthFor(mk, patch, null, true);
    });
    suppressUndo = false;
    selectedOutKeys.clear();
    logActivity(`paid ${keys.length} items via ${methodLabel}`);
  }
}
function cancelPay() {
  const wasType = pendingPay && pendingPay.type;
  pendingPay = null;
  document.getElementById('pay-overlay').classList.add('hidden');
  // Cancelling the picker mid-edit shouldn't leave "Paid" checked with no method chosen.
  if (wasType === 'itemEdit' && pendingItemEdit && !pendingItemEdit.chosenMethod) {
    const chk = document.getElementById('ie-paid');
    if (chk && chk.dataset.wasPaid !== '1') chk.checked = false;
  }
}

// ── Unified item edit (pencil) ──────────────────────────────────────────────
// One edit sheet (date / name / amount / paid) for grocery items, misc items
// (all 6 buckets), and Fixed-section rows (built-in + custom). Checking "Paid"
// stacks the existing pay-via picker (#pay-overlay) on top without closing this
// sheet — confirmPay's 'itemEdit' branch just remembers the chosen method;
// saveItemEdit() commits everything together.
let pendingItemEdit = null;
function openItemEditOverlay() {
  document.getElementById('item-edit-overlay').classList.remove('hidden');
  attachOverlayBackHandler('item-edit-overlay', cancelItemEdit);
}
function cancelItemEdit() {
  pendingItemEdit = null;
  document.getElementById('item-edit-overlay').classList.add('hidden');
}
function ieShowGroceryFields(isGrocery) {
  document.getElementById('ie-name').style.display = isGrocery ? 'none' : 'block';
  document.getElementById('ie-grocery-row').style.display = isGrocery ? 'flex' : 'none';
}
function openGroceryEdit(i) {
  const md = getMD();
  const it = (md.groceries||[])[i];
  if (!it) return;
  pendingItemEdit = { kind:'grocery', idx:i, chosenMethod:null };
  document.getElementById('ie-title').textContent = 'Edit grocery item';
  ieShowGroceryFields(true);
  document.getElementById('ie-vendor').value = it.vendor;
  document.getElementById('ie-cat').value = it.category;
  document.getElementById('ie-date').value = it.date || '';
  const amtInput = document.getElementById('ie-amount');
  amtInput.value = Math.round(it.amount); amtInput.disabled = false;
  const chk = document.getElementById('ie-paid');
  chk.checked = !!it.paid; chk.dataset.wasPaid = it.paid ? '1' : '0';
  document.getElementById('ie-paid-method').textContent = '';
  openItemEditOverlay();
}
function openMiscEdit(cat, i) {
  const md = getMD();
  const it = (md[cat]||[])[i];
  if (!it) return;
  pendingItemEdit = { kind:'misc', cat, idx:i, chosenMethod:null };
  document.getElementById('ie-title').textContent = 'Edit item';
  ieShowGroceryFields(false);
  const nameInput = document.getElementById('ie-name');
  nameInput.value = it.text || ''; nameInput.disabled = false;
  document.getElementById('ie-date').value = it.date || '';
  const amtInput = document.getElementById('ie-amount');
  amtInput.value = Math.round(it.amount); amtInput.disabled = false;
  const chk = document.getElementById('ie-paid');
  chk.checked = !!it.paid; chk.dataset.wasPaid = it.paid ? '1' : '0';
  document.getElementById('ie-paid-method').textContent = '';
  openItemEditOverlay();
}
// amountEditable is false for the handful of fixed items whose "amount" isn't a
// single overridable base (Japa Maid's payout is day-prorated; School Fees has
// two base values of its own, edited separately) — those still get date+paid.
function openFixedItemEdit(key, label, baseKey, baseDefault, nameEditable, amountEditable) {
  const md = getMD();
  const amount = amountEditable ? effectiveBase(currentMonth, baseKey, baseDefault) : baseDefault;
  pendingItemEdit = { kind:'fixed', key, baseKey, label, nameEditable, amountEditable, chosenMethod:null };
  document.getElementById('ie-title').textContent = 'Edit ' + label;
  ieShowGroceryFields(false);
  const nameInput = document.getElementById('ie-name');
  nameInput.value = label; nameInput.disabled = !nameEditable;
  document.getElementById('ie-date').value = (md.payDate||{})[key] || '';
  const amtInput = document.getElementById('ie-amount');
  amtInput.value = Math.round(amount); amtInput.disabled = !amountEditable;
  const paid = !!md.paid[key];
  const chk = document.getElementById('ie-paid');
  chk.checked = paid; chk.dataset.wasPaid = paid ? '1' : '0';
  document.getElementById('ie-paid-method').textContent = '';
  openItemEditOverlay();
}
function iePaidChanged() {
  const chk = document.getElementById('ie-paid');
  if (chk.checked && chk.dataset.wasPaid !== '1' && pendingItemEdit && !pendingItemEdit.chosenMethod) {
    startPayment('itemEdit', pendingItemEdit.kind === 'fixed' ? pendingItemEdit.key : undefined);
  }
}
// Applies a full field patch to an array item, re-filing it into a different
// month's array if the edited date crosses a month boundary (same mechanics as
// moveDatedItem's cross-month branch, extended to carry the other field edits).
function applyItemPatch(cat, idx, patch, newDate, logMsg) {
  const fromMk = currentMonth;
  const toMk = clampMonth(monthKeyOf(newDate));
  const fmd = getMD();
  if (toMk === fromMk) {
    updateMonth({ [cat]: (fmd[cat]||[]).map((x,i)=>i===idx?patch:x) }, logMsg);
    return;
  }
  const tmd = getMDFor(toMk);
  pushUndo(logMsg || 'Edit item');
  appState = { ...appState, months: { ...appState.months,
    [fromMk]: { ...fmd, [cat]: (fmd[cat]||[]).filter((_,i)=>i!==idx) },
    [toMk]:   { ...tmd, [cat]: [...(tmd[cat]||[]), patch] } } };
  saveLocal(); render(); if (IN_GAS) scheduleSync();
  logActivity(logMsg || 'edited item');
}
function saveItemEdit() {
  const pe = pendingItemEdit;
  if (!pe) return;
  const date = document.getElementById('ie-date').value;
  const paidChecked = document.getElementById('ie-paid').checked;
  // Date is the transaction date for grocery/misc items (also drives which month
  // they file into) — required. For Fixed rows it's just an optional due-date note.
  if (!date && pe.kind !== 'fixed') { alert('Date is required'); return; }
  if (paidChecked && !pe.chosenMethod && document.getElementById('ie-paid').dataset.wasPaid !== '1') {
    alert('Choose a payment method'); return;
  }

  if (pe.kind === 'grocery' || pe.kind === 'misc') {
    const amount = Math.round(Number(document.getElementById('ie-amount').value)||0);
    if (!(amount > 0)) { alert('Amount is required'); return; }
    const cat = pe.kind === 'grocery' ? 'groceries' : pe.cat;
    const md = getMD();
    const it = (md[cat]||[])[pe.idx];
    if (!it) { cancelItemEdit(); return; }
    const payMethod = paidChecked ? (pe.chosenMethod || it.payMethod || null) : null;
    let patch, logName;
    if (pe.kind === 'grocery') {
      const vendor = document.getElementById('ie-vendor').value;
      const category = document.getElementById('ie-cat').value;
      patch = { ...it, vendor, category, amount, date, paid:paidChecked, payMethod };
      logName = vendor;
    } else {
      const text = (document.getElementById('ie-name').value||'').trim();
      if (!text) { alert('Name is required'); return; }
      patch = { ...it, text, amount, date, paid:paidChecked, payMethod };
      logName = text;
    }
    applyItemPatch(cat, pe.idx, patch, date, `edited ₹${amount} ${cat} (${logName})`);
  } else if (pe.kind === 'fixed') {
    const md = getMD();
    const payMethod = paidChecked ? (pe.chosenMethod || (md.payMethod||{})[pe.key] || null) : null;
    const patch = {
      payDate: { ...(md.payDate||{}), [pe.key]: date },
      paid: { ...md.paid, [pe.key]: paidChecked },
      payMethod: { ...(md.payMethod||{}), [pe.key]: payMethod },
    };
    if (pe.amountEditable) {
      const amount = Math.round(Number(document.getElementById('ie-amount').value)||0);
      if (!(amount > 0)) { alert('Amount is required'); return; }
      patch.bases = { ...(md.bases||{}), [pe.baseKey]: amount };
    }
    const rename = pe.nameEditable ? (document.getElementById('ie-name').value||'').trim() : '';
    if (rename && rename !== pe.label) {
      pushUndo(`renamed ${pe.label} to ${rename}`);
      suppressUndo = true;
      saveCustomFixedItems({ ...(appState.customFixedItems||{}), [pe.key]: { ...(appState.customFixedItems||{})[pe.key], label: rename } });
      updateMonth(patch, `edited ${rename}`);
      suppressUndo = false;
    } else {
      updateMonth(patch, `edited ${pe.label}`);
    }
  }
  cancelItemEdit();
}

// Opens the bottom sheet for paying a specific CC billing cycle.
function openCcPaySheet(cardKey, cycleKey, label, remaining) {
  pendingCcPay = { cardKey, cycleKey };
  document.getElementById('cc-pay-title').textContent = label + ' · ₹' + inr(Math.max(0,remaining)) + ' due';
  document.getElementById('cc-pay-amt').value = Math.max(0, Math.round(remaining));
  document.getElementById('cc-pay-date').value = today();
  const overlay = document.getElementById('cc-pay-overlay');
  overlay.classList.remove('hidden');
  attachOverlayBackHandler('cc-pay-overlay', cancelCcPay);
}
function confirmCcPay() {
  if (!pendingCcPay) return;
  const { cardKey, cycleKey } = pendingCcPay;
  const amt  = Number((document.getElementById('cc-pay-amt')||{}).value);
  const date = (document.getElementById('cc-pay-date')||{}).value || today();
  if (!(amt > 0)) return;
  pendingCcPay = null;
  document.getElementById('cc-pay-overlay').classList.add('hidden');
  addCcPayment(cardKey, cycleKey, amt, date);
}
function cancelCcPay() {
  pendingCcPay = null;
  document.getElementById('cc-pay-overlay').classList.add('hidden');
}

// ── Overlay back button close handler ──────────────────────────────────────
function attachOverlayBackHandler(overlayId, onClose) {
  const overlay = document.getElementById(overlayId);
  if (!overlay) return;
  const backHandler = (e) => {
    if (overlay.classList.contains('hidden')) return;
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };
  document.addEventListener('keydown', backHandler);
  const App = getNativePlugin('App');
  if (App) {
    try {
      App.addListener('backButton', () => {
        if (!overlay.classList.contains('hidden')) onClose();
      });
    } catch(e){}
  }
  return backHandler;
}

// ── CC Cycle Review (show & edit transactions before payment) ──────────────
let pendingCycleReview = null;
let cycleBackHandler = null;

function openCcCycleReview(cardKey, cycleKey, label, total) {
  pendingCycleReview = { cardKey, cycleKey, label, total };
  const html = ccCycleTransactionsHtml(cardKey, cycleKey, label, total);
  document.getElementById('cc-cyc-review-content').innerHTML = html;
  document.getElementById('cc-cyc-review-overlay').classList.remove('hidden');
  cycleBackHandler = attachOverlayBackHandler('cc-cyc-review-overlay', closeCycleReview);
}
function closeCycleReview() {
  pendingCycleReview = null;
  document.getElementById('cc-cyc-review-overlay').classList.add('hidden');
  if (cycleBackHandler) {
    document.removeEventListener('keydown', cycleBackHandler);
    cycleBackHandler = null;
  }
}
function confirmCycleReview() {
  if (!pendingCycleReview) return;
  const { cardKey, cycleKey, label, total } = pendingCycleReview;
  // Recalculate cycle total in case items were edited
  const cyc = ccBuildCycles(cardKey).cycles.find(c => c.key === cycleKey);
  const finalTotal = cyc ? cyc.total : total;
  closeCycleReview();
  openCcPaySheet(cardKey, cycleKey, label, finalTotal);
}
function ccCycleTransactionsHtml(cardKey, cycleKey, label, total) {
  const cycleWindow = ccCycleOf(cardKey, cycleKey);
  const cycleStart = cycleWindow.start, cycleEnd = cycleWindow.end;
  const txns = [];
  const fixedAmt = { schoolFees:mk=>schoolTuition(mk)+schoolTermFee(mk)+schoolBusFee(mk), bizone:mk=>bizoneFee(mk), english:mk=>englishFee(mk) };
  const fixedLabels = { schoolFees:'School Fees', bizone:'Bizone Fee', english:'English Classes' };
  // Merge in any custom fixed items so ones paid via credit card show up here too —
  // paid-history is intentionally never re-checked against a later discontinuation
  // (same reasoning as collectPaidItems: already-paid months stay true forever).
  Object.entries(appState.customFixedItems||{}).forEach(([key, item]) => {
    fixedAmt[key] = mk => customItemAmount(mk, key, item);
    fixedLabels[key] = item.label;
  });
  // Collect array-based transactions (editable)
  Object.keys(appState.months||{}).forEach(mk => {
    const md = getMDFor(mk);
    ['groceries','householdGroceries','householdMisc','aaviaMisc','nehaMisc','avishekMisc'].forEach(cat => {
      (md[cat]||[]).forEach((it, i) => {
        if (it.paid && it.payMethod === cardKey) {
          const txnDate = new Date(it.date);
          if (txnDate >= cycleStart && txnDate <= cycleEnd) {
            txns.push({ mk, type:'item', cat, i, date: it.date, text: it.text||it.vendor||'', amount: Number(it.amount||0), desc: it.text||it.vendor||(cat.includes('Grocery')?'Grocery':'Item'), editable: true });
          }
        }
      });
    });
    // Collect fixed amount transactions (non-editable)
    Object.keys(fixedAmt).forEach(key => {
      if (md.paid[key] && (md.payMethod||{})[key] === cardKey) {
        const amt = fixedAmt[key](mk);
        const txnDate = new Date((md.payDate||{})[key] || (mk+'-15'));
        if (txnDate >= cycleStart && txnDate <= cycleEnd) {
          txns.push({ mk, type:'fixed', key, date: (md.payDate||{})[key] || (mk+'-15'), amount: amt, desc: fixedLabels[key], editable: false });
        }
      }
    });
  });
  txns.sort((a, b) => new Date(b.date) - new Date(a.date)); // newest first
  const cycleTotal = txns.reduce((s, t) => s + t.amount, 0);
  let html = `<div class="cc-cyc-review-header" style="display:flex;justify-content:space-between;align-items:center"><div><span class="cc-cyc-review-title">${esc(label)}</span><span class="cc-cyc-review-total">₹${inr(cycleTotal)}</span></div><button onclick="openCycleAddForm('${cardKey}')" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12px;cursor:pointer;font-weight:500">+ Add</button></div>`;
  if (txns.length) {
    html += `<div style="border:1px solid var(--line);border-radius:8px;overflow:hidden">`;
    txns.forEach(t => {
      const rowBg = t.editable ? '' : 'background:rgba(0,0,0,0.1)';
      html += `<div class="cc-cyc-txn-row" style="display:flex;gap:8px;align-items:center;padding:10px;border-bottom:1px solid var(--line);font-size:13px;${rowBg}">
        <span style="flex:0 0 55px;color:var(--muted);font-size:12px">${fmtDMY(new Date(t.date))}</span>
        <span style="flex:1;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:${t.editable?'1':'0.6'}">${esc(t.desc.substring(0,40))}${t.editable?'':'  (fixed)'}</span>
        <span style="flex:0 0 70px;text-align:right;font-family:var(--mono);font-weight:500;color:var(--ink)">₹${inr(t.amount)}</span>
        ${t.editable ? `<button class="cc-cyc-edit-btn" onclick="openCycleEditForm('${t.mk}','${t.cat}',${t.i})" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;padding:0;min-width:32px;-webkit-tap-highlight-color:transparent">✎</button>
        <button class="del-btn" onclick="deleteCycleTransaction('${t.mk}','${t.cat}',${t.i})" style="background:none;border:none;color:var(--faint);font-size:18px;cursor:pointer;padding:0;min-width:32px;-webkit-tap-highlight-color:transparent">×</button>` : '<span style="flex:0 0 64px"></span>'}
      </div>`;
    });
    html += `</div>`;
  } else {
    html += `<div class="cc-empty">No transactions in this cycle</div>`;
  }
  html += `<div class="cc-cyc-review-actions"><button class="add-btn" style="width:100%;margin-top:10px" onclick="confirmCycleReview()">Confirm & Pay</button><button class="pay-cancel" onclick="closeCycleReview()">Cancel</button></div>`;
  return html;
}
let pendingCycleEdit = null;
function openCycleEditForm(mk, cat, i) {
  const tmd = getMDFor(mk);
  const it = (tmd[cat]||[])[i];
  if (!it) return;
  pendingCycleEdit = { mk, cat, i, type:'item', cardKey: pendingCycleReview.cardKey, cycleKey: pendingCycleReview.cycleKey };
  const dateField = document.getElementById('cc-cyc-edit-date');
  const descField = document.getElementById('cc-cyc-edit-desc');
  const amtField = document.getElementById('cc-cyc-edit-amount');
  const catField = document.getElementById('cc-cyc-edit-cat');
  dateField.disabled = false; descField.disabled = false; amtField.disabled = false; catField.disabled = false;
  dateField.value = it.date;
  descField.value = it.text || it.vendor || '';
  amtField.value = Math.round(it.amount);
  catField.value = cat;
  document.getElementById('cc-cyc-edit-title').textContent = 'Edit Transaction';
  const overlay = document.getElementById('cc-cyc-edit-overlay');
  overlay.classList.remove('hidden');
  attachOverlayBackHandler('cc-cyc-edit-overlay', cancelCycleEdit);
}
function cancelCycleEdit() {
  pendingCycleEdit = null;
  document.getElementById('cc-cyc-edit-overlay').classList.add('hidden');
}
function saveCycleEdit() {
  if (!pendingCycleEdit) return;
  const newDate = document.getElementById('cc-cyc-edit-date').value;
  const newDesc = document.getElementById('cc-cyc-edit-desc').value.trim();
  const newAmount = Math.round(Number(document.getElementById('cc-cyc-edit-amount').value)||0);
  const newCat = document.getElementById('cc-cyc-edit-cat').value;
  if (!newDate || !newDesc || newAmount <= 0) { alert('All fields required'); return; }
  if (pendingCycleEdit.type === 'add') {
    const mk = clampMonth(monthKeyOf(newDate));
    const newItem = { date: newDate, text: newDesc, amount: newAmount, paid: true, payMethod: pendingCycleEdit.cardKey };
    const md = getMDFor(mk);
    updateMonthFor(mk, { [newCat]: [...(md[newCat]||[]), newItem] },
      `added ₹${newAmount} ${newDesc} (${newCat}) via CC cycle`);
  } else {
    const { mk, cat, i, cardKey } = pendingCycleEdit;
    const tmd = getMDFor(mk);
    const it = (tmd[cat]||[])[i];
    if (!it) return;
    const patch = { ...it, date: newDate, text: newDesc, amount: newAmount, paid: true, payMethod: cardKey };
    const newMkForDate = clampMonth(monthKeyOf(newDate));
    const updates = {};
    const editMsg = `edited CC cycle transaction: ${newDesc} · ₹${newAmount}`;
    if (newCat === cat && newMkForDate === mk) {
      updates[cat] = (tmd[cat]||[]).map((x, idx) => idx === i ? patch : x);
      updateMonthFor(mk, updates, editMsg);
    } else {
      updates[cat] = (tmd[cat]||[]).filter((_, idx) => idx !== i);
      updateMonthFor(mk, updates, editMsg);
      const newMd = getMDFor(newMkForDate);
      const newUpdates = {};
      newUpdates[newCat] = [...(newMd[newCat]||[]), patch];
      updateMonthFor(newMkForDate, newUpdates, editMsg, true);
    }
  }
  cancelCycleEdit();
  if (pendingCycleReview) {
    const html = ccCycleTransactionsHtml(pendingCycleReview.cardKey, pendingCycleReview.cycleKey, pendingCycleReview.label, pendingCycleReview.total);
    document.getElementById('cc-cyc-review-content').innerHTML = html;
  }
}
function deleteCycleTransaction(mk, cat, i) {
  if (!confirm('Delete this transaction from the Ledger?')) return;
  const tmd = getMDFor(mk);
  const item = (tmd[cat]||[])[i];
  if (item) moveToTrash({ kind:'month', mk, cat, item });
  updateMonthFor(mk, { [cat]: (tmd[cat]||[]).filter((_,idx) => idx!==i) },
    item ? `deleted ₹${item.amount} ${item.text||item.vendor} (${cat})` : 'deleted a CC cycle transaction');
  // Re-render cycle review
  if (pendingCycleReview) {
    const html = ccCycleTransactionsHtml(pendingCycleReview.cardKey, pendingCycleReview.cycleKey, pendingCycleReview.label, pendingCycleReview.total);
    document.getElementById('cc-cyc-review-content').innerHTML = html;
  }
}
function openCycleAddForm(cardKey) {
  pendingCycleEdit = { type:'add', cardKey, cycleKey: pendingCycleReview.cycleKey };
  const dateField = document.getElementById('cc-cyc-edit-date');
  const descField = document.getElementById('cc-cyc-edit-desc');
  const amtField = document.getElementById('cc-cyc-edit-amount');
  const catField = document.getElementById('cc-cyc-edit-cat');
  dateField.disabled = false; descField.disabled = false; amtField.disabled = false; catField.disabled = false;
  dateField.value = today();
  descField.value = '';
  amtField.value = '';
  catField.value = 'householdMisc';
  document.getElementById('cc-cyc-edit-title').textContent = 'Add Transaction';
  document.getElementById('cc-cyc-edit-overlay').classList.remove('hidden');
}

// Opens the bottom sheet for a Neha Bank <-> Avishek Bank transfer.
function openNehaXferSheet(direction) {
  pendingNehaXfer = { direction };
  document.getElementById('neha-xfer-title').textContent = direction === 'in' ? 'Avishek → Neha' : 'Neha → Avishek';
  document.getElementById('neha-xfer-amt').value = '';
  document.getElementById('neha-xfer-date').value = today();
  const overlay = document.getElementById('neha-xfer-overlay');
  overlay.classList.remove('hidden');
  attachOverlayBackHandler('neha-xfer-overlay', cancelNehaXfer);
}
function confirmNehaXfer() {
  if (!pendingNehaXfer) return;
  const { direction } = pendingNehaXfer;
  const amt  = Number((document.getElementById('neha-xfer-amt')||{}).value);
  const date = (document.getElementById('neha-xfer-date')||{}).value || today();
  if (!(amt > 0)) return;
  pendingNehaXfer = null;
  document.getElementById('neha-xfer-overlay').classList.add('hidden');
  addNehaTransfer(direction, amt, date);
}
function cancelNehaXfer() {
  pendingNehaXfer = null;
  document.getElementById('neha-xfer-overlay').classList.add('hidden');
}

// ── Credit-card cycles ─────────────────────────────────────────────────────
function isoOf(dt){ return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; }
function fmtDM(dt){ return dt.getDate() + ' ' + dt.toLocaleDateString('en-IN',{month:'short'}); }
function fmtDMY(dt){ return dt.getDate() + ' ' + dt.toLocaleDateString('en-IN',{month:'short',year:'2-digit'}); }
// Display an ISO date string (YYYY-MM-DD) as DD-MMM (e.g. 05-Jul). Blank-safe.
function fmtDate(dateStr){
  if (!dateStr) return '';
  const [y,m,d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return '';
  return String(d).padStart(2,'0') + '-' + new Date(y, m-1, d).toLocaleDateString('en-IN',{month:'short'});
}
function monthKeyOf(dateStr){ return (dateStr||'').slice(0,7); }
// Editable date shown as a DD-MMM chip: a transparent native date input overlays
// the label, so tapping opens the picker while it reads as DD-MMM.
function dateChip(cur, onchangeAttr) {
  return `<span class="date-chip"><span class="date-chip-lbl">${cur?fmtDate(cur):'set date'}</span>`
       + `<input class="date-chip-inp" type="date" value="${esc(cur||'')}" ${onchangeAttr} title="Spend date"></span>`;
}
// Read-only date display (date is now edited via the pencil/edit sheet, not inline).
function dateLabel(cur) {
  return `<span class="date-lbl">${cur?fmtDate(cur):'no date'}</span>`;
}

// The billing cycle window that contains a given date.
function ccCycleOf(cardKey, dateStr) {
  const cfg = CC_CYCLES[cardKey];
  const [y,m,d] = dateStr.split('-').map(Number);
  const startM = (d < cfg.startDay) ? m-1 : m;            // day before startDay belongs to previous cycle
  const start = new Date(y, startM-1, cfg.startDay);
  const end   = new Date(start.getFullYear(), start.getMonth()+1, cfg.endDay);
  const due   = new Date(end.getFullYear(),   end.getMonth()+1,   cfg.dueDay);
  return { start, end, due, key: isoOf(end) };
}

// All charges booked to a card across every month.
function ccChargesFor(cardKey) {
  const charges = [];
  const arrays = ['aaviaMisc','groceries','householdGroceries','householdMisc','nehaMisc','avishekMisc'];
  const fixedAmt = {
    schoolFees: mk => schoolTuition(mk)+schoolTermFee(mk)+schoolBusFee(mk),
    bizone:     mk => bizoneFee(mk),
    english:    mk => englishFee(mk),
  };
  Object.entries(appState.customFixedItems||{}).forEach(([key, item]) => {
    fixedAmt[key] = mk => customItemAmount(mk, key, item);
  });
  Object.keys(appState.months||{}).forEach(mk => {
    const md = getMDFor(mk);
    arrays.forEach(cat => (md[cat]||[]).forEach(it => {
      if (it.paid && it.payMethod === cardKey) charges.push({ amount:Number(it.amount||0), date: it.date || (mk+'-15') });
    }));
    Object.keys(fixedAmt).forEach(key => {
      if (md.paid[key] && (md.payMethod||{})[key] === cardKey)
        charges.push({ amount: fixedAmt[key](mk), date: (md.payDate||{})[key] || (mk+'-15') });
    });
  });
  return charges;
}

// Group charges into billing cycles and allocate bill payments.
// Payments tagged with a cycleKey settle that cycle directly; untagged (legacy)
// payments fall back to draining the remaining balance oldest-cycle-first.
function ccBuildCycles(cardKey) {
  const charges = ccChargesFor(cardKey);
  const map = {};
  charges.forEach(ch => {
    const cyc = ccCycleOf(cardKey, ch.date);
    (map[cyc.key] = map[cyc.key] || { cyc, total:0 }).total += ch.amount;
  });
  const asc = Object.values(map).sort((a,b) => a.cyc.end - b.cyc.end);
  const totalCharged = charges.reduce((s,c) => s+c.amount, 0);
  const pays = getCcPayments()[cardKey];
  const totalPaid = pays.reduce((s,p) => s+Number(p.amount||0), 0);
  const directPaid = {};
  let pool = 0;
  pays.forEach(p => {
    if (p.cycleKey) directPaid[p.cycleKey] = (directPaid[p.cycleKey]||0) + Number(p.amount||0);
    else pool += Number(p.amount||0);
  });
  const now = new Date(); now.setHours(0,0,0,0);
  const out = asc.map(({cyc,total}) => {
    const afterDirect = total - (directPaid[cyc.key]||0);
    const poolPaidTo = Math.min(pool, Math.max(0, afterDirect)); pool -= poolPaidTo;
    const remaining = afterDirect - poolPaidTo;
    const paidSoFar = total - remaining;
    const left = paidSoFar > 0 ? ` · ₹${inr(remaining)} left` : '';
    let statusClass, statusLabel;
    if (cyc.end >= now)        { statusClass='cur';  statusLabel='Current · closes ' + fmtDate(isoOf(cyc.end)); }
    else if (remaining <= 0)   { statusClass='ok';   statusLabel='Paid'; }
    else if (now > cyc.due)    { statusClass='over'; statusLabel='Overdue · was due ' + fmtDate(isoOf(cyc.due)) + left; }
    else                       { statusClass='due';  statusLabel='Due ' + fmtDate(isoOf(cyc.due)) + left; }
    return { key: cyc.key, label: fmtDate(isoOf(cyc.start))+' – '+fmtDate(isoOf(cyc.end)), total, remaining, statusClass, statusLabel };
  });
  out.reverse(); // most recent first
  return { cycles: out, outstanding: totalCharged - totalPaid };
}

function saveCcPayments(next, logMsg) {
  pushUndo('Credit card payment change');
  appState = { ...appState, ccPayments: next };
  saveLocal(); renderMenu(); if (IN_GAS) scheduleSync();
  logActivity(logMsg || 'updated a CC payment');
}
function addCcPayment(cardKey, cycleKey, amount, date) {
  const amt = Math.round(Number(amount));
  if (!(amt > 0)) return;
  const cur = getCcPayments();
  saveCcPayments({ ...cur, [cardKey]: [...cur[cardKey], { amount:amt, date: date||today(), cycleKey }] },
    `paid ₹${amt} on ${CC_CYCLES[cardKey]?.label || cardKey}`);
}
function deleteCcPayment(cardKey, idx) {
  const cur = getCcPayments();
  const item = cur[cardKey][idx];
  if (item) moveToTrash({ kind:'ccPayment', cardKey, item });
  saveCcPayments({ ...cur, [cardKey]: cur[cardKey].filter((_,i) => i!==idx) }, 'deleted a CC payment');
}

