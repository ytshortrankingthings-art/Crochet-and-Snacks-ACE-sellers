/*
  Complete front-end SPA script (password-required accounts, logout, admin support).
  - Login/Create require password (create also requires full name)
  - Stores username/password/fullname in localStorage for demo convenience
  - Sends password to server for create/login and admin endpoints
  - Logout button wired
  - Polls /api/items and /api/orders periodically for near-real-time updates
  - Guest ordering requires full name; guest order IDs saved locally so guests can view them
  - Admin panel stays visible only for admin user and uses credentials for admin actions
*/

const el = q => document.querySelector(q);
const els = q => Array.from(document.querySelectorAll(q));

const GUEST_ORDERS_KEY = 'cs_guest_orders';
const POLL_INTERVAL_MS = 5000;
const WISHLIST_KEY = 'cs_wishlist';

const state = {
  currentUser: null,
  currentPassword: null,
  currentFullName: null,
  items: [],
  orders: [],
  acctMode: 'login', // 'login' or 'create'
  pollHandle: null
};

// ---- Helpers ----
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}

function toLocalDatetime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// New: format ISO date to "Month Day, Year" e.g. "September 30, 2025"
function formatDateLong(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const opts = { year: 'numeric', month: 'long', day: 'numeric' };
  return d.toLocaleDateString(undefined, opts);
}

function showNotification(text, longer=false) {
  const container = el('#notifications');
  if (!container) { alert(text); return; }
  const div = document.createElement('div');
  div.className = 'notice';
  div.textContent = text;
  container.prepend(div);
  setTimeout(() => div.remove(), longer ? 12000 : 7000);
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...(opts || {})
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({ error: 'Unknown' }));
    throw new Error(json.error || 'API error');
  }
  return res.json();
}

// ---- Auth / persistence ----
function setUser(username, password, fullName) {
  state.currentUser = username || null;
  state.currentPassword = password || null;
  state.currentFullName = fullName || null;

  if (username) localStorage.setItem('cs_user', username);
  else localStorage.removeItem('cs_user');

  if (password) localStorage.setItem('cs_pass', password);
  else localStorage.removeItem('cs_pass');

  if (fullName) localStorage.setItem('cs_fullname', fullName);
  else localStorage.removeItem('cs_fullname');

  renderUser();

  // show/hide logout
  const logoutBtn = el('#logoutBtn');
  if (logoutBtn) {
    if (state.currentUser) logoutBtn.classList.remove('hidden');
    else logoutBtn.classList.add('hidden');
  }

  // admin panel toggle
  if (state.currentUser && state.currentUser.toLowerCase() === 'admin') showAdminPanel();
  else hideAdminPanel();

  // employee tab toggle
  const empTab = el('#employeeTab');
  if (empTab) {
    if (state.currentUser && (state.currentUser.toLowerCase() === 'employee1' || state.currentUser.toLowerCase() === 'employee2')) {
      empTab.classList.remove('hidden');
    } else {
      empTab.classList.add('hidden');
    }
  }

  // fetch fresh data immediately on account change
  fetchItems().catch(()=>{});
  fetchOrders().catch(()=>{});
}

function logout() {
  state.currentUser = null;
  state.currentPassword = null;
  state.currentFullName = null;
  localStorage.removeItem('cs_user');
  localStorage.removeItem('cs_pass');
  localStorage.removeItem('cs_fullname');
  renderUser();
  const logoutBtn = el('#logoutBtn');
  if (logoutBtn) logoutBtn.classList.add('hidden');
  hideAdminPanel();
  showNotification('Logged out');
}

function renderUser() {
  const cu = el('#currentUser');
  if (!cu) return;
  if (state.currentUser) cu.textContent = `Signed in as ${state.currentUser}`;
  else cu.textContent = 'Not signed in';
}

// ---- Guest order id storage (so guests can view orders they placed) ----
function loadGuestOrderIds() {
  try { return JSON.parse(localStorage.getItem(GUEST_ORDERS_KEY) || '[]'); }
  catch(e) { return []; }
}
function saveGuestOrderId(id) {
  if (!id) return;
  const arr = loadGuestOrderIds();
  if (!arr.find(x => Number(x) === Number(id))) {
    arr.push(Number(id));
    localStorage.setItem(GUEST_ORDERS_KEY, JSON.stringify(arr));
  }
}
function removeGuestOrderId(id) {
  const arr = loadGuestOrderIds().filter(x => Number(x) !== Number(id));
  localStorage.setItem(GUEST_ORDERS_KEY, JSON.stringify(arr));
}

// ---- Polling ----
function startPolling() {
  if (state.pollHandle) clearInterval(state.pollHandle);
  state.pollHandle = setInterval(async () => {
    await fetchItems().catch(()=>{});
    await fetchOrders().catch(()=>{});
  }, POLL_INTERVAL_MS);
}
function stopPolling() {
  if (state.pollHandle) {
    clearInterval(state.pollHandle);
    state.pollHandle = null;
  }
}

// ---- Fetch data ----
async function fetchItems() {
  try {
    const data = await api('/items');
    state.items = data.items || [];
    renderItems();
    renderAdminItems();
    renderMyOrders();
  } catch (err) {
    console.error('fetchItems', err);
  }
}

async function fetchOrders() {
  try {
    const data = await api('/orders');
    state.orders = data.orders || [];
    renderAdminOrders();
    renderMyOrders();
    // check for arrival reminders once orders are available
    checkArrivalReminders();
    return state.orders;
  } catch (err) {
    console.error('fetchOrders', err);
  }
}

// ---- Items / buy ----
function renderItems() {
  const container = el('#itemsList');
  if (!container) return;
  container.innerHTML = '';
  if (!state.items.length) {
    container.innerHTML = '<div class="card">No items yet.</div>';
    return;
  }
  state.items.forEach(item => {
    const inWishlist = loadWishlist().includes(Number(item.id));
    const node = document.createElement('div');
    node.className = 'item';
    node.innerHTML = `
      <img src="${escapeHtml(item.image || 'https://via.placeholder.com/96?text=No+Image')}" alt="${escapeHtml(item.name)}" />
      <div class="meta">
        <h4>${escapeHtml(item.name)}</h4>
        <p>${escapeHtml(item.description || 'No description')}</p>
        <div class="small">Price: $${Number(item.price).toFixed(2)} • Stock: ${item.stock}</div>
      </div>
      <div class="actions">
        <button class="btn buyBtn" data-id="${item.id}" ${item.stock<=0 ? 'disabled' : ''}>Buy</button>
        <button class="btn wishlistBtn ${inWishlist ? 'wishlistActive' : ''}" data-id="${item.id}">${inWishlist ? 'Wishlisted' : 'Wishlist'}</button>
      </div>
    `;
    container.appendChild(node);
  });

  container.querySelectorAll('.buyBtn').forEach(b => {
    b.removeEventListener && b.removeEventListener('click', onBuyClick);
    b.addEventListener('click', onBuyClick);
  });
  container.querySelectorAll('.wishlistBtn').forEach(b => {
    b.removeEventListener && b.removeEventListener('click', () => {});
    b.addEventListener('click', (ev) => toggleWishlist(ev.currentTarget.dataset.id));
  });
}

function onBuyClick(ev) {
  const id = ev.currentTarget.dataset.id;
  const qty = 1;
  const username = state.currentUser || 'guest';

  if (!state.currentUser || state.currentUser.toLowerCase() === 'guest') {
    const buyerFullName = prompt('Please enter your full name for this purchase (required):');
    if (!buyerFullName || !buyerFullName.trim()) {
      showNotification('Full name required for guest purchase.');
      return;
    }
    placeOrder('guest', id, qty, buyerFullName.trim());
  } else {
    placeOrder(username, id, qty, null);
  }
}

async function placeOrder(username, itemId, quantity = 1, buyerFullName = null) {
  try {
    const res = await fetch('/api/order', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username, itemId, quantity, buyerFullName })
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Order failed');

    // for guests, save id locally so they can view it later
    if (!state.currentUser || state.currentUser.toLowerCase() === 'guest') {
      saveGuestOrderId(json.order.id);
      const token = json.order.cancelToken || '';
      alert(`Order placed!\nOrder ID: ${json.order.id}\nPlease save the cancel token (if provided) to be able to cancel: ${token}`);
    } else {
      showNotification(`Order placed for ${json.order.itemName}. Status: ${json.order.status}`);
    }

    await fetchItems();
    await fetchOrders();
  } catch (err) {
    showNotification('Order failed: ' + err.message);
  }
}

// ---- Account modal (password-required) ----
function initAccount() {
  const accountBtn = el('#accountBtn');
  if (accountBtn) accountBtn.addEventListener('click', () => {
    el('#accountModal').classList.remove('hidden');
    setAcctMode('login');
    const savedUser = localStorage.getItem('cs_user') || '';
    const savedFull = localStorage.getItem('cs_fullname') || '';
    const savedPass = localStorage.getItem('cs_pass') || '';
    if (savedUser) el('#acctUsername').value = savedUser;
    if (savedFull) el('#acctFullName').value = savedFull;
    if (savedPass) el('#acctPassword').value = savedPass;
  });

  const closeBtn = el('#closeAcct');
  if (closeBtn) closeBtn.addEventListener('click', () => el('#accountModal').classList.add('hidden'));

  els('.acctTab').forEach(btn => btn.addEventListener('click', () => setAcctMode(btn.dataset.mode)));

  const form = el('#accountForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (el('#acctUsername').value || '').trim();
    const password = (el('#acctPassword').value || '');
    const fullName = (el('#acctFullName').value || '').trim();

    if (!username || !password) {
      showNotification('Username and password required.');
      return;
    }
    if (state.acctMode === 'create' && (!fullName || fullName.length < 2)) {
      showNotification('Full name required for new accounts (min 2 chars).');
      return;
    }

    try {
      const res = await fetch('/api/create-account', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ username, password, fullName: state.acctMode === 'create' ? fullName : undefined })
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Account error');

      setUser(json.account.username, password, json.account.fullName || fullName || null);
      el('#accountModal').classList.add('hidden');
      showNotification(`Signed in as ${json.account.username}`);
      await fetchItems();
      await fetchOrders();
    } catch (err) {
      showNotification('Account error: ' + err.message);
    }
  });

  const logoutBtn = el('#logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);
}

function setAcctMode(mode) {
  state.acctMode = mode === 'create' ? 'create' : 'login';
  els('.acctTab').forEach(t => t.classList.toggle('active', t.dataset.mode === state.acctMode));
  const full = el('#acctFullName');
  if (!full) return;
  if (state.acctMode === 'create') full.classList.remove('hidden');
  else full.classList.add('hidden');
}

// ---- Admin UI ----
// New helper: format currency
function formatCurrency(n) {
  return '$' + Number(n || 0).toFixed(2);
}

// New: render admin stats (items, orders, revenue, low stock)
function renderAdminStats() {
  const statsEl = el('#adminStats');
  if (!statsEl) return;
  const totalItems = (state.items || []).length;
  const activeItems = (state.items || []).filter(i => i.active !== false).length;
  const lowThresh = Number((el('#lowStockThreshold') && el('#lowStockThreshold').value) || 3);
  const lowStockCount = (state.items || []).filter(i => i.stock <= lowThresh).length;
  const orders = state.orders || [];
  const totalOrders = orders.length;
  const processing = orders.filter(o => o.status === 'processing').length;
  const scheduled = orders.filter(o => o.status === 'scheduled').length;
  const canceled = orders.filter(o => o.status === 'canceled').length;
  // Only count non-canceled orders toward revenue so cancellations reduce revenue
  const revenue = orders.filter(o => o.status !== 'canceled').reduce((s,o) => s + Number(o.amount || 0), 0);

  statsEl.innerHTML = `
    <div class="adminStat"><div class="val">${totalItems}</div><div class="label">Total items</div></div>
    <div class="adminStat"><div class="val">${activeItems}</div><div class="label">Active items</div></div>
    <div class="adminStat"><div class="val lowStock">${lowStockCount}</div><div class="label">Items ≤ ${lowThresh}</div></div>
    <div class="adminStat"><div class="val">${totalOrders}</div><div class="label">Orders</div></div>
    <div class="adminStat"><div class="val">${processing}</div><div class="label">Processing</div></div>
    <div class="adminStat"><div class="val">${scheduled}</div><div class="label">Scheduled</div></div>
    <div class="adminStat"><div class="val">${canceled}</div><div class="label">Canceled</div></div>
    <div class="adminStat"><div class="val">${formatCurrency(revenue)}</div><div class="label">Total revenue</div></div>
  `;
}

// Enhance admin items rendering: highlight low stock, quick stock edit
function renderAdminItems() {
  const container = el('#adminItems');
  if (!container) return;
  const search = (el('#adminSearch') && el('#adminSearch').value || '').toLowerCase();
  const lowThresh = Number((el('#lowStockThreshold') && el('#lowStockThreshold').value) || 3);
  container.innerHTML = '';
  const items = state.items.slice().filter(item => {
    if (!search) return true;
    return (item.name || '').toLowerCase().includes(search) || (item.description||'').toLowerCase().includes(search);
  });
  if (!items.length) {
    container.innerHTML = '<div class="small">No items found.</div>';
    return;
  }
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'adminItem';
    const lowCls = item.stock <= lowThresh ? 'lowStock' : '';
    div.innerHTML = `
      <div class="meta">
        <div class="name">${escapeHtml(item.name)}</div>
        <div class="small">${escapeHtml(item.description || '')}</div>
        <div style="margin-top:6px">
          <span class="badge">${formatCurrency(item.price)}</span>
          <span class="badge ${lowCls}">Stock: <span class="stockVal">${item.stock}</span></span>
          <span class="badge">${item.active === false ? 'Inactive' : 'Active'}</span>
        </div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <input class="newStock inlineInput" type="number" min="0" value="${item.stock}" style="width:88px" />
        <button class="btn updateStock" data-id="${item.id}">Update</button>
        <button class="btn takedown" data-id="${item.id}" style="background:#fff;border:1px solid #f3f4f6">Take down</button>
      </div>
    `;
    container.appendChild(div);
  });

  // rebind events (existing logic reused)
  container.querySelectorAll('.updateStock').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = btn.parentElement.querySelector('.newStock');
      const newStock = Number(input.value);
      try {
        const body = { username: state.currentUser || '', password: state.currentPassword || '', itemId: id, newStock };
        const res = await fetch('/api/admin/update-stock', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Update failed');
        showNotification(`Stock updated for ${json.item.name} -> ${json.item.stock}`);
        await fetchItems();
        renderAdminStats();
      } catch (err) {
        showNotification('Update failed: ' + err.message);
      }
    });
  });

  container.querySelectorAll('.takedown').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Take down this item? This will cancel related orders.')) return;
      try {
        const body = { username: state.currentUser || '', password: state.currentPassword || '', itemId: id };
        const res = await fetch('/api/admin/takedown-item', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Takedown failed');
        showNotification('Item taken down and related orders canceled.');
        await fetchItems();
        await fetchOrders();
        renderAdminStats();
      } catch (err) {
        showNotification('Takedown failed: ' + err.message);
      }
    });
  });
}

// Enhance admin orders rendering: filter, search, export support
function renderAdminOrders() {
  const container = el('#adminOrders');
  if (!container) return;
  const search = (el('#adminSearch') && el('#adminSearch').value || '').toLowerCase();
  const filter = (el('#adminOrderFilter') && el('#adminOrderFilter').value) || 'all';
  container.innerHTML = '';
  let orders = (state.orders || []).slice().reverse();
  if (filter !== 'all') orders = orders.filter(o => o.status === filter);
  if (search) {
    orders = orders.filter(o => {
      return (String(o.id).includes(search) ||
              (o.itemName||'').toLowerCase().includes(search) ||
              (o.buyerName||'').toLowerCase().includes(search) ||
              (o.username||'').toLowerCase().includes(search));
    });
  }
  if (!orders.length) {
    container.innerHTML = '<div class="small">No orders found.</div>';
    return;
  }

  orders.forEach(ord => {
    const div = document.createElement('div');
    div.className = 'order';
    div.innerHTML = `
      <div class="orderTop">
        <div>
          <strong>Order #${ord.id}</strong> • ${escapeHtml(ord.itemName)} x ${ord.quantity} • ${formatCurrency(ord.amount)}
          <div class="orderMeta">By: ${escapeHtml(ord.buyerName || ord.username)} • Created: ${new Date(ord.createdAt).toLocaleString()}</div>
        </div>
        <div style="text-align:right">
          <div class="small">Status: <strong>${escapeHtml(ord.status)}</strong></div>
          <div class="small">Arrival: <span class="arrivalVal">${escapeHtml(ord.arrivalDate ? formatDateLong(ord.arrivalDate) : 'processing')}</span></div>
        </div>
      </div>
      <div class="orderActions">
        <input class="arrivalInput inlineInput" type="datetime-local" value="${ord.arrivalDate ? toLocalDatetime(ord.arrivalDate) : ''}" />
        <button class="btn setArrival" data-id="${ord.id}">Set arrival</button>
        <button class="btn cancelOrder" data-id="${ord.id}" style="background:#fff;border:1px solid #f3f4f6">Cancel</button>
      </div>
    `;
    container.appendChild(div);
  });

  // existing wiring for setArrival and cancelOrder (reuse code from earlier)
  container.querySelectorAll('.setArrival').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id;
      const input = b.parentElement.querySelector('.arrivalInput');
      const val = input.value;
      if (!val) {
        if (!confirm('Clear arrival date (set back to processing)?')) return;
      }
      try {
        const body = { username: state.currentUser || '', password: state.currentPassword || '', orderId: id, arrivalDate: val || null };
        const res = await fetch('/api/admin/update-arrival', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Update failed');
        showNotification(`Order ${json.order.id} updated. Arrival: ${json.order.arrivalDate || 'processing'}`);
        await fetchOrders();
        renderAdminStats();
      } catch (err) {
        showNotification('Failed to update: ' + err.message);
      }
    });
  });

  container.querySelectorAll('.cancelOrder').forEach(b => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id;
      if (!confirm('Cancel this order?')) return;
      try {
        const body = { orderId: id };
        // admin cancel includes credentials
        if (state.currentUser && state.currentUser.toLowerCase() === 'admin') {
          body.username = state.currentUser;
          body.password = state.currentPassword || '';
        } else {
          body.username = state.currentUser || '';
        }
        const res = await fetch('/api/cancel-order', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Cancel failed');
        showNotification(`Order ${json.order.id} canceled.`);
        await fetchOrders();
        await fetchItems();
        renderAdminStats();
      } catch (err) {
        showNotification('Cancel failed: ' + err.message);
      }
    });
  });
}

// Export orders CSV (client-side)
function exportOrdersCSV() {
  const orders = state.orders || [];
  const cols = ['id','itemId','itemName','username','buyerName','quantity','amount','status','arrivalDate','createdAt'];
  const rows = [cols.join(',')].concat(orders.map(o => cols.map(c => {
    const v = o[c] === undefined || o[c] === null ? '' : String(o[c]).replace(/"/g,'""');
    return `"${v}"`;
  }).join(',')));
  const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `orders_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Wire admin controls (search, export, refresh, threshold)
function initAdminControls() {
  const search = el('#adminSearch');
  const filter = el('#adminOrderFilter');
  const threshold = el('#lowStockThreshold');
  const exportBtn = el('#exportOrdersBtn');
  const refreshBtn = el('#refreshAdminBtn');

  if (search) {
    search.addEventListener('input', () => { renderAdminItems(); renderAdminOrders(); });
  }
  if (filter) {
    filter.addEventListener('change', () => renderAdminOrders());
  }
  if (threshold) {
    threshold.addEventListener('change', () => { renderAdminItems(); renderAdminStats(); });
  }
  if (exportBtn) exportBtn.addEventListener('click', exportOrdersCSV);
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    await fetchItems();
    await fetchOrders();
    renderAdminStats();
  });
}

// Ensure admin UI is initialized/shown when admin panel is opened
function showAdminPanel() {
  const panel = el('#adminPanel');
  if (!panel) return;
  panel.classList.remove('hidden');
  fetchAdminData();
  initAdminControls();
  renderAdminStats();
}
function hideAdminPanel() {
  const panel = el('#adminPanel');
  if (!panel) return;
  panel.classList.add('hidden');
}

async function fetchAdminData() {
  await fetchItems();
  await fetchOrders();
  renderAdminStats();
}

// ---- My Orders (Buy tab) ----
function renderMyOrders() {
  const wrap = el('#myOrders');
  if (!wrap) return;
  wrap.innerHTML = '';

  // signed-in registered user (non-guest)
  if (state.currentUser && state.currentUser.toLowerCase() !== 'guest') {
    const my = (state.orders || []).filter(o => o.username && o.username.toLowerCase() === state.currentUser.toLowerCase());
    if (!my.length) {
      wrap.innerHTML = '<div class="small">No orders yet.</div>';
      return;
    }
    my.slice().reverse().forEach(ord => wrap.appendChild(orderRowElement(ord)));
    return;
  }

  // guest: use locally stored ids and match against server orders
  const guestIds = loadGuestOrderIds();
  if (!guestIds.length) {
    wrap.innerHTML = '<div class="small">No orders yet.</div>';
    return;
  }
  const ordersById = (state.orders || []).reduce((acc, o) => { acc[o.id] = o; return acc; }, {});
  guestIds.slice().reverse().forEach(id => {
    const ord = ordersById[id] || { id, itemName: 'Unknown', amount: 0, status: 'processing', arrivalDate: null, username: 'guest' };
    wrap.appendChild(orderRowElement(ord, /*isGuestLocal*/true));
  });
}

function orderRowElement(ord, isGuestLocal=false) {
  const div = document.createElement('div');
  div.className = 'order';
  div.style.marginBottom = '8px';
  const arrivalText = ord.arrivalDate ? formatDateLong(ord.arrivalDate) : 'processing';
  div.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div>
        <strong>Order #${ord.id}</strong> • ${escapeHtml(ord.itemName)} x ${ord.quantity || 1} • $${Number(ord.amount || 0).toFixed(2)}
        <div class="small">By: ${escapeHtml(ord.buyerName || ord.username)} • Created: ${new Date(ord.createdAt || Date.now()).toLocaleString()}</div>
      </div>
      <div style="text-align:right">
        <div class="small">Status: <strong>${escapeHtml(ord.status)}</strong></div>
        <div class="small">Arrival: <span class="arrivalVal">${escapeHtml(arrivalText)}</span></div>
      </div>
    </div>
  `;
  const actions = document.createElement('div');
  actions.style.marginTop = '8px';
  actions.style.display = 'flex';
  actions.style.gap = '8px';
  actions.style.alignItems = 'center';

  if (ord.status !== 'canceled') {
    const isAdmin = state.currentUser && state.currentUser.toLowerCase() === 'admin';
    const isOwnerRegistered = state.currentUser && state.currentUser.toLowerCase() !== 'guest' && ord.username && ord.username.toLowerCase() === state.currentUser.toLowerCase();
    const isGuestLocalOrder = isGuestLocal || (ord.username === 'guest');

    if (isAdmin || isOwnerRegistered || isGuestLocalOrder) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn';
      cancelBtn.textContent = 'Cancel order';
      cancelBtn.addEventListener('click', async () => {
        if (!confirm('Cancel this order?')) return;
        try {
          const payload = { orderId: ord.id };
          if (isAdmin || isOwnerRegistered) {
            payload.username = state.currentUser || '';
            if (isAdmin) payload.password = state.currentPassword || '';
          } else if (isGuestLocalOrder) {
            const token = prompt('Enter cancel token (given when you placed the order):');
            if (!token) {
              showNotification('Cancel token required for guest order cancellation.');
              return;
            }
            payload.cancelToken = token.trim();
          }
          const res = await fetch('/api/cancel-order', {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(payload)
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Cancel failed');
          showNotification(`Order ${json.order.id} canceled.`);
          if (isGuestLocalOrder) removeGuestOrderId(ord.id);
          await fetchOrders();
          await fetchItems();
          renderMyOrders();
        } catch (err) {
          showNotification('Cancel failed: ' + err.message);
        }
      });
      actions.appendChild(cancelBtn);

      const receiptBtn = document.createElement('button');
      receiptBtn.className = 'btn';
      receiptBtn.textContent = 'Receipt';
      receiptBtn.addEventListener('click', () => downloadReceipt(ord));
      actions.appendChild(receiptBtn);
    }
  }

  div.appendChild(actions);
  return div;
}

// ---- Create item (admin) ----
function initCreateItem() {
  const form = el('#createItemForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = form.querySelector('input[type="file"][name="imageFile"]');
    const hasFile = fileInput && fileInput.files && fileInput.files.length;
    if (hasFile) {
      const fd = new FormData(form);
      fd.append('username', state.currentUser || '');
      if (state.currentPassword) fd.append('password', state.currentPassword);
      try {
        const res = await fetch('/api/admin/create-item', { method: 'POST', body: fd });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Create failed');
        showNotification(`Item created: ${json.item.name}`);
        form.reset();
        await fetchItems();
      } catch (err) {
        showNotification('Create failed: ' + err.message);
      }
      return;
    }

    const fd = new FormData(form);
    const payload = {
      username: state.currentUser || '',
      password: state.currentPassword || '',
      name: fd.get('name'),
      price: fd.get('price') || 0,
      stock: fd.get('stock') || 0,
      image: fd.get('image') || ''
    };
    try {
      const res = await fetch('/api/admin/create-item', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Create failed');
      showNotification(`Item created: ${json.item.name}`);
      form.reset();
      await fetchItems();
    } catch (err) {
      showNotification('Create failed: ' + err.message);
    }
  });
}

// ---- Tabs, bootstrapping ----
function initTabs() {
  els('.tab').forEach(t => {
    t.addEventListener('click', () => {
      els('.tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      const tab = t.dataset.tab;
      els('.page').forEach(p => p.classList.remove('active'));
      const target = el('#' + tab);
      if (target) target.classList.add('active');
+     if (tab === 'employee') renderEmployeeMenu();
      if (tab === 'buy') {
        fetchItems();
        fetchOrders();
        renderMyOrders();
      }
    });
  });
}

// New: arrival reminders (day before arrival)
// Shows a prompt once per order (stored in localStorage) asking user to confirm/enter
// the amount of money they will bring to school for this item and confirm the item name.
function checkArrivalReminders() {
  try {
    const notifiedKey = 'cs_arrival_notified';
    const notified = JSON.parse(localStorage.getItem(notifiedKey) || '[]');
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowMid = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()).getTime();

    (state.orders || []).forEach(ord => {
      if (!ord || !ord.arrivalDate) return;
      if (ord.status === 'canceled') return;
      const a = new Date(ord.arrivalDate);
      const aMid = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
      if (aMid !== tomorrowMid) return;
      if (notified.includes(ord.id)) return;

      // Prompt the user (day-before reminder)
      try {
        const defaultAmount = Number(ord.amount || 0).toFixed(2);
        const amountResp = prompt(
          `Reminder: Order #${ord.id} (${ord.itemName}) arrives on ${formatDateLong(ord.arrivalDate)}.\nPlease enter the amount of money you will bring to school for this item (suggested: $${defaultAmount}):`,
          defaultAmount
        );
        if (amountResp !== null) {
          showNotification(`Noted you'll bring $${amountResp} to school for "${ord.itemName}"`, true);
        }

        const itemResp = prompt(
          `Please confirm the item name you purchased for Order #${ord.id}:`,
          ord.itemName || ''
        );
        if (itemResp !== null) {
          showNotification(`Item confirmed: ${itemResp}`, true);
        }
      } catch (e) {
        // ignore prompt errors
      }

      notified.push(ord.id);
    });

    localStorage.setItem(notifiedKey, JSON.stringify(notified));
  } catch (e) {
    console.error('checkArrivalReminders error', e);
  }
}

// ---- Bootstrapping ----
async function boot() {
  // restore user
  const saved = localStorage.getItem('cs_user');
  const pass = localStorage.getItem('cs_pass');
  const full = localStorage.getItem('cs_fullname');
  if (saved) setUser(saved, pass || null, full || null);
  else renderUser();

  initTabs();
  initAccount();
  initCreateItem();
  initAdminControls();
  initFeedback();
  await fetchItems();
  await fetchOrders();
  startPolling();
}

boot();