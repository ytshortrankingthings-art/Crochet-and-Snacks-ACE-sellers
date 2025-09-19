const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');

const app = express();
const DATA_PATH = path.join(__dirname, 'data.json');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to read data.json', e);
    return { accounts: [], items: [], orders: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function nextId(array) {
  if (!array.length) return 1;
  return Math.max(...array.map(a => a.id || 0)) + 1;
}

// Ensure admin has a passwordHash on first run (demo convenience).
// This sets a default password hash if an admin exists without passwordHash.
// IMPORTANT: You can change admin password by editing data.json manually or adding an endpoint.
(function ensureAdminPassword() {
  const data = loadData();
  const admin = data.accounts.find(a => a.username && a.username.toLowerCase() === 'admin');
  if (admin && !admin.passwordHash) {
    try {
      // DEMO default password - hashed; not printed to UI.
      const defaultPass = 'GoofyGuy1!';
      admin.passwordHash = bcrypt.hashSync(defaultPass, 10);
      saveData(data);
      console.log('Admin password initialized on first run (demo).');
    } catch (e) {
      console.error('Failed to initialize admin password', e);
    }
  }
})();

// New: ensure employees have a password hash (default "employee") so employee1/employee2 can log in.
// This fixes "Invalid password for account" for employee accounts created in data.json without a valid bcrypt hash.
(function ensureEmployeePasswords() {
  try {
    const data = loadData();
    let changed = false;
    data.accounts.forEach(acc => {
      if (acc && acc.role === 'employee') {
        try {
          // If missing or not a bcrypt-style string, re-initialize
          if (!acc.passwordHash || typeof acc.passwordHash !== 'string' || !acc.passwordHash.startsWith('$2')) {
            throw new Error('invalid-hash-format');
          }
          // If the hash exists but does not verify against default "employee" (likely placeholder), re-init.
          // Use try/catch because compareSync can throw on malformed hashes.
          const ok = bcrypt.compareSync('employee', acc.passwordHash);
          if (!ok) throw new Error('hash-does-not-verify');
          // if ok, leave as-is (may be a real custom password or already default)
        } catch (err) {
          // initialize to default "employee"
          acc.passwordHash = bcrypt.hashSync('employee', 10);
          changed = true;
          console.log(`Initialized/normalized password for employee account: ${acc.username}`);
        }
      }
    });
    if (changed) saveData(data);
  } catch (e) {
    console.error('Failed to initialize employee passwords', e);
  }
})();

// API routes

app.get('/api/items', (req, res) => {
  const data = loadData();
  const items = data.items.filter(i => i.active !== false);
  res.json({ items });
});

// Create account or login existing (password required).
// Accepts { username, password, fullName? }
// - If account exists: verify password, return account info.
// - If not exists: require fullName, create account (hash password) and return account.
app.post('/api/create-account', async (req, res) => {
  const { username, password, fullName } = req.body || {};
  if (!username || typeof username !== 'string') {
    return res.status(400).json({ error: 'Invalid username' });
  }
  if (!password || typeof password !== 'string' || password.length < 4) {
    return res.status(400).json({ error: 'Password required (min length 4)' });
  }

  const data = loadData();
  const exists = data.accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
  if (exists) {
    // verify password for existing account
    if (!exists.passwordHash || !bcrypt.compareSync(password, exists.passwordHash)) {
      return res.status(400).json({ error: 'Invalid password for existing account' });
    }
    const account = {
      username: exists.username,
      fullName: exists.fullName || '',
      createdAt: exists.createdAt,
      isAdmin: !!exists.isAdmin
    };
    return res.json({ account });
  }

  // creating new account - need fullName
  if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
    return res.status(400).json({ error: 'Full name required for new accounts' });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const account = {
    username,
    fullName,
    createdAt: new Date().toISOString(),
    isAdmin: username.toLowerCase() === 'admin',
    passwordHash: hashed
  };
  data.accounts.push(account);
  saveData(data);
  const ret = {
    username: account.username,
    fullName: account.fullName,
    createdAt: account.createdAt,
    isAdmin: account.isAdmin
  };
  res.json({ account: ret });
});

// Order creation
// Accepts: { username='guest', buyerFullName (required for guest), itemId, quantity=1 }
// Decrements stock on order.
app.post('/api/order', (req, res) => {
  const { username = 'guest', buyerFullName, itemId, quantity = 1 } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'No itemId provided' });
  const data = loadData();
  const item = data.items.find(it => it.id === Number(itemId) && it.active !== false);
  if (!item) return res.status(400).json({ error: 'Item not found' });
  if (item.stock < quantity) return res.status(400).json({ error: 'Not enough stock' });

  // determine buyer name
  let buyerName = 'guest';
  if (username && username.toLowerCase() !== 'guest') {
    const acc = data.accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
    if (acc) buyerName = acc.fullName || acc.username;
    else buyerName = username;
  } else {
    if (!buyerFullName || typeof buyerFullName !== 'string' || buyerFullName.trim().length < 2) {
      return res.status(400).json({ error: 'Full name required for guest purchases' });
    }
    buyerName = buyerFullName.trim();
  }

  // decrement stock (reserve)
  item.stock -= Number(quantity);

  const order = {
    id: nextId(data.orders),
    itemId: item.id,
    itemName: item.name,
    username: (username && username.toLowerCase() !== 'guest') ? username : 'guest',
    buyerName,
    quantity: Number(quantity),
    amount: +(item.price * quantity).toFixed(2),
    status: 'processing',
    arrivalDate: null,
    createdAt: new Date().toISOString()
  };

  // generate and store cancel token for guest orders so guest can cancel later
  if (!order.username || order.username.toLowerCase() === 'guest') {
    order.cancelToken = generateCancelToken();
  }

  data.orders.push(order);
  saveData(data);
  res.json({ order });
});

app.get('/api/orders', (req, res) => {
  const data = loadData();
  res.json({ orders: data.orders });
});

// Add helper to generate simple cancel tokens
function generateCancelToken() {
  // 24-char safe token
  return [...Array(24)].map(() => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random()*36)]).join('');
}

// Cancel order endpoint
app.post('/api/cancel-order', (req, res) => {
  const { orderId, username = '', password = '', cancelToken } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId required' });
  const data = loadData();
  const ord = data.orders.find(o => o.id === Number(orderId));
  if (!ord) return res.status(400).json({ error: 'Order not found' });
  if (ord.status === 'canceled') return res.status(400).json({ error: 'Order already canceled' });

  // Authorization:
  // - Admin (username=admin + valid password) can cancel any order
  // - Registered user can cancel their own order (username matches order.username and not 'guest')
  // - Guest can cancel only with matching cancelToken
  let authorized = false;
  // admin check
  if (username && password && username.toLowerCase() === 'admin' && checkAdminCredentials(username, password)) {
    authorized = true;
  } else if (username && ord.username && ord.username.toLowerCase() !== 'guest' && username.toLowerCase() === ord.username.toLowerCase()) {
    // registered owner cancelling (no password required here because front-end sends username only for registered user flow;
    // if you want to enforce password for registered users, extend checkAdminCredentials or add proper auth)
    authorized = true;
  } else if (cancelToken && ord.cancelToken && cancelToken === ord.cancelToken) {
    // guest cancellation by token
    authorized = true;
  }

  if (!authorized) {
    return res.status(403).json({ error: 'Not authorized to cancel this order' });
  }

  // perform cancellation and restore stock if item exists
  const item = data.items.find(i => i.id === Number(ord.itemId));
  if (item) {
    item.stock = Number(item.stock || 0) + Number(ord.quantity || 0);
  }
  ord.status = 'canceled';
  ord.canceledAt = new Date().toISOString();

  saveData(data);
  res.json({ order: ord });
});

// Admin auth check using username & password in body/query
function checkAdminCredentials(username, password) {
  if (!username || !password) return false;
  if (username.toLowerCase() !== 'admin') return false;
  const data = loadData();
  const admin = data.accounts.find(a => a.username && a.username.toLowerCase() === 'admin');
  if (!admin || !admin.passwordHash) return false;
  return bcrypt.compareSync(password, admin.passwordHash);
}

function checkAdmin(req, res) {
  const username = (req.body.username || req.query.username || '').toString();
  const password = (req.body.password || req.query.password || '').toString();
  if (!checkAdminCredentials(username, password)) {
    res.status(403).json({ error: 'Admin authentication required (username & password)' });
    return false;
  }
  return true;
}

// Update stock
app.post('/api/admin/update-stock', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { itemId, newStock } = req.body;
  const data = loadData();
  const item = data.items.find(i => i.id === Number(itemId));
  if (!item) return res.status(400).json({ error: 'Item not found' });
  item.stock = Number(newStock);
  saveData(data);
  res.json({ item });
});

// Update arrival date for an order
app.post('/api/admin/update-arrival', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { orderId, arrivalDate } = req.body;
  const data = loadData();
  const ord = data.orders.find(o => o.id === Number(orderId));
  if (!ord) return res.status(400).json({ error: 'Order not found' });
  ord.arrivalDate = arrivalDate || null;
  ord.status = arrivalDate ? 'scheduled' : 'processing';
  saveData(data);
  res.json({ order: ord });
});

// Create item (JSON) - admin only
app.post('/api/admin/create-item', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { name, description = '', price = 0, stock = 0, image = '' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Item name required' });
  const data = loadData();
  const newItem = {
    id: nextId(data.items),
    name,
    description,
    price: Number(price),
    stock: Number(stock),
    image: image || '',
    active: true,
    createdAt: new Date().toISOString()
  };
  data.items.push(newItem);
  saveData(data);
  res.json({ item: newItem });
});

// Take down item (set active=false)
app.post('/api/admin/takedown-item', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { itemId } = req.body;
  const data = loadData();
  const item = data.items.find(i => i.id === Number(itemId));
  if (!item) return res.status(400).json({ error: 'Item not found' });
  item.active = false;

  // Cancel related orders and restore stock for those orders
  let canceledCount = 0;
  data.orders.forEach(o => {
    if (o.itemId === item.id && o.status !== 'canceled') {
      // restore stock
      item.stock = Number(item.stock || 0) + Number(o.quantity || 0);
      o.status = 'canceled';
      o.canceledAt = new Date().toISOString();
      canceledCount++;
    }
  });

  saveData(data);
  res.json({ success: true, canceledOrders: canceledCount });
});

// Add helper to check general user credentials (not only admin)
function checkUserCredentials(username, password) {
  if (!username || !password) return false;
  const data = loadData();
  const acc = data.accounts.find(a => a.username && a.username.toLowerCase() === username.toLowerCase());
  if (!acc || !acc.passwordHash) return false;
  return bcrypt.compareSync(password, acc.passwordHash);
}

// Get wishlist for a user (requires username & password for non-guest)
app.get('/api/wishlist', (req, res) => {
  const username = (req.query.username || '').toString();
  const password = (req.query.password || '').toString();
  if (!username || username.toLowerCase() === 'guest') {
    // Guests use client-side localStorage
    return res.json({ wishlist: [] });
  }
  if (!checkUserCredentials(username, password)) {
    return res.status(403).json({ error: 'Authentication required' });
  }
  const data = loadData();
  const acc = data.accounts.find(a => a.username && a.username.toLowerCase() === username.toLowerCase());
  res.json({ wishlist: acc && Array.isArray(acc.wishlist) ? acc.wishlist : [] });
});

// Save wishlist for user (body: { username, password, wishlist: [ids] })
app.post('/api/wishlist', (req, res) => {
  const { username, password, wishlist } = req.body || {};
  if (!username || username.toLowerCase() === 'guest') {
    return res.status(400).json({ error: 'Invalid username for server-side wishlist' });
  }
  if (!checkUserCredentials(username, password)) {
    return res.status(403).json({ error: 'Authentication required' });
  }
  const data = loadData();
  const acc = data.accounts.find(a => a.username && a.username.toLowerCase() === username.toLowerCase());
  if (!acc) return res.status(400).json({ error: 'Account not found' });
  acc.wishlist = Array.from(new Set((Array.isArray(wishlist) ? wishlist.map(n => Number(n)) : [])));
  saveData(data);
  res.json({ wishlist: acc.wishlist });
});

// fallback to index.html for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});