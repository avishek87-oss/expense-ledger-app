# Home Dashboard Summary — Design (Group 4 of 4)

## Roadmap context

This is Group 4 of the four-part improvement roadmap for the household ledger app:

1. **Group 1 — CC Statement Upload & Reconciliation** (shipped, v2.6.0)
2. **Group 2 — Data Safety & Trust** (shipped, v2.7.0/v2.8.0): soft-delete trash, activity log, biometric/PIN app-lock
3. **Group 4 — Home Dashboard Summary** (this document): single at-a-glance screen (month spend, CC dues, Neha balance, budget status)
4. **Group 3 — Expense Entry Friction** (still deferred): vendor→category autocomplete, receipt photo attachment

This continues the cross-group design conventions established in Group 1's spec (`2026-07-07-cc-statement-upload-reconciliation-design.md`) and reaffirmed in Group 2's (`2026-07-07-data-safety-trust-design.md`): new state is additive-only, navigation returns to the most specific relevant view, new UI reuses existing visual primitives (`.hero`, `.cc-card`, `.cc-cyc`, `.add-btn`).

## Problem

The four numbers a person actually wants when they open this app — this month's spend, what's owed on each credit card, Neha's bank balance, and whether any budget category is over cap — are scattered across four different places today:

- Month spend/paid/pending: visible on the **Ledger** tab's hero (`render()`, `www/index.html:2917`), but folded into per-category editing rows, not a summary.
- CC dues: only visible after Hamburger → **Credit Card Payments** (`menuView === 'cc'`, `ccSectionHtml()`, `www/index.html:2270`).
- Neha's balance: only visible after Hamburger → **Neha Bank Balance** (`menuView === 'neha'`, `nehaBankSectionHtml()`, `www/index.html:2314`).
- Budget status: only visible after Hamburger → **Budgets** (`menuView === 'budgets'`, `budgetsSectionHtml()`, `www/index.html:2367`).

That's three hamburger taps plus a mental note of the Ledger hero to answer "how are we doing this month?" — the exact friction Group 4 is meant to remove.

## Design

### Where it lives: a new fourth top-level tab, not a drawer view or a rework of Ledger

Two placements were considered:

1. **A new hamburger drawer view** (`menuView === 'dashboard'`), following the exact pattern of `trends`/`budgets`/`cc`/`neha`. Lowest risk, zero changes to the tab bar — but it fails the "at a glance" requirement: it would be one more tap behind a menu, no better than today's Budgets/CC/Neha views individually.
2. **A reworked default landing view** replacing the Ledger tab's role as the boot-time screen. Rejected as too invasive: the Ledger tab's hero/body already has real editing behavior (`swipe` gestures gated on `currentTab === 'ledger'` at `www/index.html:2141`, the quick-add FAB gated on `tab==='ledger'`) that a dashboard shouldn't inherit or fight with.
3. **A new top-level tab** (`switchTab('home')`), alongside Ledger/Outstanding/Payments — chosen. Each existing tab already independently renders its own `#summary` hero + `#app-body` detail via a dedicated `render*()` function (`renderOutstanding()` at `www/index.html:3149`, `renderPayments()` at `www/index.html:3080`); adding `renderHome()` following that exact precedent is a natural, additive fit, not a new architecture. Placing it first in the tab bar and making it the boot-time default tab is what actually satisfies "single at-a-glance screen" — it's the first thing the user sees, with zero taps.

`.tab-btn` is `flex:0 0 auto` (`www/index.html:76`), not evenly-split, so a fourth short label ("Home") fits the existing tab bar without a layout rework.

### Part A — Tab wiring

**File:** `www/index.html`

1. HTML tab bar (`www/index.html:504-508`): add a new first button, move `active` off `tab-ledger` onto it:
   ```html
   <button id="tab-home"       class="tab-btn active" onclick="switchTab('home')">Home</button>
   <button id="tab-ledger"     class="tab-btn"        onclick="switchTab('ledger')">Ledger</button>
   <button id="tab-outstanding" class="tab-btn"        onclick="switchTab('outstanding')">Outstanding</button>
   <button id="tab-payments"    class="tab-btn"        onclick="switchTab('payments')">Payments</button>
   ```
2. `switchTab()` (`www/index.html:1082`) previously did all its DOM chrome updates (active-tab classes, `#month-nav` hide toggle, FAB hide toggle) inline, and was the *only* place that ran them. That was fine while `currentTab` defaulted to `'ledger'`, because the FAB's default un-hidden HTML state happened to already match what Ledger wants. Making Home the default tab (next point) exposed the latent bug: `boot()` calls `render()` directly, never `switchTab()`, so on cold start the FAB stayed visible on Home. Fix: extract that chrome logic into a new `applyTabChrome()` function, called from the top of `render()` itself (so it runs on every render, including the very first one) as well as being the only thing `switchTab()` now does before delegating to `render()`. Same conditions as before (`#month-nav` hidden only for `outstanding`; FAB hidden for every tab but `ledger`), just applied unconditionally on every render rather than only on manual tab taps.
3. Default landing tab (`www/index.html:738`): change `let currentTab = 'ledger';` to `let currentTab = 'home';`. `boot()` (`www/index.html:3377`) calls `render()` directly with whatever `currentTab` is set to, and (per the point above) `render()` now applies the correct tab chrome on that first call too.
4. `render()` (`www/index.html:2802`): add a `currentTab === 'home'` branch before the existing `outstanding`/`payments` early-returns, calling a new `renderHome()`, mirroring those two exactly (`renderOutstanding()`/`renderPayments()` write to `#summary` then `#app-body` and return early before the Ledger-specific body below).

### Part B — `renderHome()`

New function, placed near `renderPayments()`/`renderOutstanding()`. Reuses `monthCategoryTotals(currentMonth)` (`www/index.html:1999`) and `collectPaidItems(currentMonth)` (`www/index.html:3046`) — both already used by other tabs for the exact same "this month" math, so Home's numbers are guaranteed consistent with Ledger/Payments rather than a second parallel calculation.

**Hero** (`#summary`), same markup shape as the other three tabs' heroes:
```js
function renderHome() {
  const t = monthCategoryTotals(currentMonth);
  const paidTot = collectPaidItems(currentMonth).reduce((s,it)=>s+it.amount,0);
  const pendingTot = t.total - paidTot;
  const pct = t.total>0 ? Math.round(paidTot/t.total*100) : 0;

  document.getElementById('summary').innerHTML = `
<div class="hero">
  <div class="hero-row">
    <div class="hero-lead">
      <div class="hero-lbl">Month spend</div>
      <div class="hero-num">₹${inr(t.total)}</div>
    </div>
    <div class="hero-stats">
      <div class="hstat"><div class="k">Paid</div><div class="v g">₹${inr(paidTot)}</div></div>
      <div class="hstat"><div class="k">Pending</div><div class="v">₹${inr(pendingTot)}</div></div>
    </div>
  </div>
  <div class="hero-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
  <div class="hero-foot"><span><span class="mono">${pct}%</span> settled</span><span>${monthLabel(currentMonth)}</span></div>
  ${heroSpendsHtml(currentMonth)}
</div>`;

  document.getElementById('app-body').innerHTML =
    homeCcCardHtml() + homeNehaCardHtml() + homeBudgetCardHtml();
}
```
The category/source breakdown (`heroSpendsHtml()`, `www/index.html:2019`) is appended **unconditionally** (not behind the Ledger hero's tap-to-expand `heroSpendsOpen` toggle) — Home's whole point is showing everything without an extra tap, and the function is reused as-is rather than duplicated, since its `.hspend-row`/`.hspend-h` styling is light-on-dark and already designed for the hero's dark background (`www/index.html:112-115`).

**Body** (`#app-body`), three light `.cc-card` sections, each ending in `.cc-cyc` drill-down rows (same clickable-row primitive `ccSectionHtml()` already uses for cycle rows) rather than a novel card-tap pattern:

```js
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
```

Reused as-is, no new state or math: `ccBuildCycles()` (`www/index.html:1943`), `CC_CYCLES` (`www/index.html:715`), `nehaBankBalance()` (`www/index.html:914`), `getBudgets()`/`BUDGET_CATS` (`www/index.html:920-921`), `monthCategoryTotals()` (`www/index.html:1999`).

### Part C — `openMenuTo(view)`: drill-down from Home into the hamburger drawer

Tapping a Home dashboard row needs to open the hamburger drawer directly to a specific view (CC/Neha/Budgets), not just set `menuView` on an already-open drawer the way `setMenuView()` does. `openMenu()` (`www/index.html:2045`) already does "set a view, render it, show the overlay, attach the back-handler" but hardcodes `menuView = 'home'`. Refactor:

```js
function openMenu() { openMenuTo('home'); }
function openMenuTo(view) {
  menuView = view;
  renderMenu();
  document.getElementById('menu-overlay').classList.remove('hidden');
  menuBackHandler = attachOverlayBackHandler('menu-overlay', closeMenu);
}
```
Behavior of `openMenu()` (called from the hamburger `☰` button) is unchanged; `openMenuTo('cc'|'neha'|'budgets')` is the new entry point Home's rows use. Each of those drawer views' own "← Home" back button (`www/index.html:2196/2201/2206`) already returns to `menuView==='home'` — the drawer's own root list — unchanged; this is the same behavior as reaching those views via the hamburger menu directly, so no new back-navigation special-casing is needed.

## Error handling

- No new state, no new sync payload, no new error surface: every number on the Home tab is read from data that Ledger/Payments/CC/Neha/Budgets already compute and validate today. If `appState.months`, `appState.ccPayments`, `appState.nehaBank`, or `appState.budgets` are empty/absent, the existing helpers already default safely (`getMDFor`'s `{...emptyMonth(), ...}` spread, `getCcPayments()`'s `{axisCC:[], scapiaCC:[]}` default, `getBudgets()`'s `{}` fallback) — Home's cards render their existing empty states (`₹0`, "No budgets set yet", "Paid up") rather than crashing.
- `homeBudgetCardHtml()` explicitly handles the zero-budgets-configured case with a call-to-action row instead of an empty card.

## Testing / verification

- Fresh boot: confirm the app lands on the new **Home** tab (not Ledger), with the tab bar showing Home/Ledger/Outstanding/Payments in that order and Home marked active.
- Home hero: confirm "Month spend" matches the Ledger tab's "Owed" (`grandTot`) for the same month, "Paid"/"Pending" match Payments tab's totals, and the appended category/source breakdown matches what tapping the Ledger hero's chevron shows.
- Page months via the month-nav arrows while on Home: confirm all four cards update to that month's data (Ledger and Payments do the same).
- Credit Cards card: confirm combined "owed" matches the sum shown across both cards in Hamburger → Credit Card Payments; tap a card row → confirm it opens the drawer directly to Credit Card Payments (not the drawer's home list first).
- Neha Bank card: confirm balance matches Hamburger → Neha Bank Balance; tap the row → confirm it opens directly to that view.
- Budgets card: with no caps set, confirm the "Set up budgets" prompt; set a cap and exceed it, confirm the card shows "N over" and the row turns "Over"; tap a row → confirm it opens directly to Budgets.
- Confirm Outstanding tab's toolbar-gap fix and Ledger tab's swipe-to-delete/FAB behavior are unaffected: Ledger shows the FAB and month-nav, Outstanding hides both, Payments hides only the FAB — verified on cold boot (Home) and after switching to each tab and back.
- Confirm the hamburger `☰` button still opens to the drawer's own home (link list) as before — `openMenu()`'s behavior is unchanged after the `openMenuTo()` refactor.
