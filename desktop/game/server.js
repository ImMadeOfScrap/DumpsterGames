'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { Server } = require('socket.io');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DD_DATA_DIR || path.join(__dirname, 'data');
// Keep login tokens stable across restarts without shipping a universal hard-coded secret.
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretPath = path.join(DATA_DIR, 'jwt-secret.txt');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {}
  const generated = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretPath, generated, { mode: 0o600 });
  return generated;
}
const JWT_SECRET = loadJwtSecret();
const MAX_PLAYERS = 1; // Desktop release is single-player; the online socket server is disabled for other players.
const PENNY_INTERVAL = 15 * 60 * 1000;
const WORLD_X = 22;
const WORLD_Z = 112;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false }, maxHttpBufferSize: 1e5 });
const users = new Map();
const online = new Map();
const socketsByUser = new Map();
const searchCooldown = new Map();
const dumpsterCooldown = new Map();
const pendingTrades = new Map();
const trades = new Map();
let pool = null;

const allowedSkins = ['#f2c879', '#b1e3ff', '#c4ff4d', '#ff7777', '#d5a5ff', '#f0f0ee', '#ff9d38'];
const allowedShirts = ['#ff784f', '#59d6ff', '#b5ee65', '#c58aff', '#f5d75e', '#f0f0ee', '#292e42'];
const allowedHats = ['none', 'cap', 'bucket', 'crown', 'cone'];
const world = {
  bounds: { x: WORLD_X, z: WORLD_Z },
  dumpsters: [
    { id: 'dumpster-01', x: -19, z: -10 }, { id: 'dumpster-02', x: 19, z: -25 },
    { id: 'dumpster-03', x: -19, z: -42 }, { id: 'dumpster-04', x: 19, z: -59 },
    { id: 'dumpster-05', x: -19, z: -80 }, { id: 'dumpster-06', x: 19, z: -101 },
    { id: 'dumpster-07', x: 19, z: 4 }, { id: 'dumpster-08', x: -19, z: 20 },
    { id: 'dumpster-09', x: 19, z: 39 }, { id: 'dumpster-10', x: -19, z: 58 },
    { id: 'dumpster-11', x: 19, z: 78 }, { id: 'dumpster-12', x: -19, z: 97 }
  ],
  npcs: [
    { id: 'npc-scrappy', name: 'Scrappy', job: 'JUNK DEALER', x: -13, z: -18, color: '#c4ff4d' },
    { id: 'npc-mara', name: 'Mara', job: 'PAWN SHOP', x: 13, z: -52, color: '#ff8d59' },
    { id: 'npc-gus', name: 'Old Gus', job: 'COLLECTOR', x: -13, z: 30, color: '#d0a0ff' },
    { id: 'npc-tess', name: 'Tess', job: 'TRADER', x: 13, z: 78, color: '#59d6ff' }
  ]
};
const itemTypes = [
  { name: 'Bent Spoon', kind: 'JUNK', price: 2, rarity: 'common', color: '#c6c9cf' },
  { name: 'Mystery Can', kind: 'JUNK', price: 3, rarity: 'common', color: '#71d2b1' },
  { name: 'One Shoe', kind: 'JUNK', price: 4, rarity: 'common', color: '#be8a62' },
  { name: 'Old Toy Robot', kind: 'TOY', price: 8, rarity: 'uncommon', color: '#67c7ff' },
  { name: 'Cracked Gamepad', kind: 'ELECTRONICS', price: 12, rarity: 'uncommon', color: '#a7a8ff' },
  { name: 'Shiny Bottlecap', kind: 'COLLECTIBLE', price: 15, rarity: 'uncommon', color: '#ffcf67' },
  { name: 'Retro Handheld', kind: 'ELECTRONICS', price: 28, rarity: 'rare', color: '#a9ee70' },
  { name: 'Golden Duck', kind: 'COLLECTIBLE', price: 45, rarity: 'rare', color: '#ffdb4e' },
  { name: 'Legendary Arcade Chip', kind: 'COLLECTIBLE', price: 90, rarity: 'legendary', color: '#ff72d2' }
];

const BADGES = [
  { id: 'fresh_diver', name: 'Fresh Diver', icon: '🗑️', description: 'Create your first diver account.', reward: 10 },
  { id: 'bin_rookie', name: 'Bin Rookie', icon: '🥫', description: 'Search your first dumpster.', reward: 15 },
  { id: 'dumpster_dynamo', name: 'Dumpster Dynamo', icon: '🔎', description: 'Search 10 dumpsters.', reward: 40 },
  { id: 'first_sale', name: 'First Sale', icon: '¢', description: 'Sell your first item to a dealer.', reward: 15 },
  { id: 'trash_tycoon', name: 'Trash Tycoon', icon: '💰', description: 'Earn 100 Pennys from sales.', reward: 50 },
  { id: 'style_icon', name: 'Style Icon', icon: '🧢', description: 'Change your diver’s look.', reward: 20 },
  { id: 'rare_recycler', name: 'Rare Recycler', icon: '✨', description: 'Find a rare or legendary item.', reward: 30 },
  { id: 'penny_pile', name: 'Penny Pile', icon: '🪙', description: 'Save up 100 Pennys.', reward: 35 }
];
function awardBadge(user, id) {
  if (!Array.isArray(user.badges)) user.badges = [];
  if (!user.badges.includes(id)) {
    const badge = BADGES.find(b => b.id === id);
    if (!badge) return false;
    user.badges.push(id);
    user.pennies = Math.max(0, Number(user.pennies) || 0) + badge.reward;
    return true;
  }
  return false;
}
function updateBadges(user) {
  const stats = user.stats || (user.stats = { dumpstersSearched: 0, itemsSold: 0, salesTotal: 0, rareFinds: 0, avatarChanges: 0 });
  const before = (user.badges || []).length;
  if (stats.dumpstersSearched >= 1) awardBadge(user, 'bin_rookie');
  if (stats.dumpstersSearched >= 10) awardBadge(user, 'dumpster_dynamo');
  if (stats.itemsSold >= 1) awardBadge(user, 'first_sale');
  if (stats.salesTotal >= 100) awardBadge(user, 'trash_tycoon');
  if (stats.avatarChanges >= 1) awardBadge(user, 'style_icon');
  if (stats.rareFinds >= 1) awardBadge(user, 'rare_recycler');
  if (user.pennies >= 100) awardBadge(user, 'penny_pile');
  return (user.badges || []).length > before;
}
function badgeCatalog() { return BADGES; }

function keyName(username) { return String(username || '').trim().toLowerCase(); }
function randomId() { return crypto.randomBytes(8).toString('hex'); }
function safeUser(u) {
  return {
    username: u.username,
    pennies: u.pennies,
    lastPennyAt: u.lastPennyAt,
    avatar: u.avatar,
    unlocks: Array.isArray(u.unlocks) ? u.unlocks : ['skin:#f2c879', 'shirt:#59d6ff', 'hat:none', 'hat:cap'],
    inventory: u.inventory,
    friends: u.friends,
    friendRequests: u.friendRequests,
    joinedAt: u.joinedAt,
    badges: Array.isArray(u.badges) ? u.badges : [],
    stats: u.stats || { dumpstersSearched: 0, itemsSold: 0, salesTotal: 0, rareFinds: 0, avatarChanges: 0 }
  };
}
function newUser(username, passwordHash) {
  const now = Date.now();
  return {
    username, passwordHash, pennies: 10, lastPennyAt: now,
    avatar: { skin: '#f2c879', shirt: '#59d6ff', hat: 'cap' },
    unlocks: ['skin:#f2c879', 'shirt:#59d6ff', 'hat:none', 'hat:cap'],
    inventory: [], friends: [], friendRequests: [], joinedAt: now,
    badges: [], stats: { dumpstersSearched: 0, itemsSold: 0, salesTotal: 0, rareFinds: 0, avatarChanges: 0 }
  };
}
function syncPennies(user) {
  const now = Date.now();
  const elapsed = now - Number(user.lastPennyAt || now);
  const earned = Math.floor(elapsed / PENNY_INTERVAL);
  if (earned > 0) {
    user.pennies += earned;
    user.lastPennyAt = Number(user.lastPennyAt || now) + earned * PENNY_INTERVAL;
  }
}
function persistJson() {
  const file = path.join(DATA_DIR, 'users.json');
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(users), null, 2));
  fs.renameSync(tmp, file);
}
async function saveUser(user) {
  users.set(keyName(user.username), user);
  if (pool) {
    await pool.query(
      'INSERT INTO dumpster_users (username, data) VALUES ($1, $2::jsonb) ON CONFLICT (username) DO UPDATE SET data = EXCLUDED.data',
      [keyName(user.username), JSON.stringify(user)]
    );
  } else {
    persistJson();
  }
}
async function initializeStorage() {
  if (process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: 5
    });
    await pool.query('CREATE TABLE IF NOT EXISTS dumpster_users (username TEXT PRIMARY KEY, data JSONB NOT NULL)');
    const result = await pool.query('SELECT username, data FROM dumpster_users');
    for (const row of result.rows) users.set(row.username, row.data);
    console.log(`Connected to PostgreSQL; loaded ${users.size} account(s).`);
  } else {
    const file = path.join(DATA_DIR, 'users.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, '{}');
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, value] of Object.entries(stored)) users.set(key, value);
    } catch (error) {
      console.error('Could not read data/users.json:', error.message);
      throw error;
    }
    console.log(`Using local JSON save; loaded ${users.size} account(s).`);
  }
  for (const [key, user] of users) {
    if (!Array.isArray(user.unlocks)) user.unlocks = ['skin:#f2c879', 'shirt:#59d6ff', 'hat:none', 'hat:cap'];
    if (!Array.isArray(user.badges)) user.badges = [];
    if (!user.stats) user.stats = { dumpstersSearched: 0, itemsSold: 0, salesTotal: 0, rareFinds: 0, avatarChanges: 0 };
    updateBadges(user);
    if (user.avatar) { user.unlocks.push(`skin:${user.avatar.skin}`, `shirt:${user.avatar.shirt}`, `hat:${user.avatar.hat}`); }
    user.unlocks = [...new Set(user.unlocks)];
    users.set(key, user);
  }
}
function createToken(user) {
  return jwt.sign({ sub: keyName(user.username), username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function authHttp(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'Please log in first.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = users.get(keyName(payload.username));
    if (!user) return res.status(401).json({ error: 'Account not found. Please log in again.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Your login expired. Please log in again.' });
  }
}
function distance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function findDump(id) { return world.dumpsters.find(d => d.id === id); }
function findNpc(id) { return world.npcs.find(n => n.id === id); }
function pushUserProfile(username) {
  const user = users.get(keyName(username));
  const socketId = socketsByUser.get(keyName(username));
  if (user && socketId) io.to(socketId).emit('profile:update', safeUser(user));
}
function isItemLocked(itemId) {
  for (const trade of trades.values()) {
    if (trade.offers[trade.users[0]].includes(itemId) || trade.offers[trade.users[1]].includes(itemId)) return true;
  }
  return false;
}
function publicPlayer(p) {
  return { username: p.username, x: p.x, z: p.z, avatar: p.avatar, moving: Boolean(p.moving), sprinting: Boolean(p.sprinting) };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use('/vendor', express.static(path.resolve(__dirname, '../node_modules/three/build')));
app.use(express.static(path.join(__dirname, 'public')));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts. Wait a few minutes and try again.' } });

app.get('/api/health', (req, res) => res.json({ ok: true, game: 'Dumpster Divers', online: online.size, maxPlayers: MAX_PLAYERS }));
app.get('/api/world', (req, res) => res.json(world));
app.get('/api/badges', (req, res) => res.json({ badges: badgeCatalog() }));
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–16 characters: letters, numbers, and underscores only.' });
    if (password.length < 8 || password.length > 96) return res.status(400).json({ error: 'Password must be 8–96 characters long.' });
    const key = keyName(username);
    if (users.has(key)) return res.status(409).json({ error: 'That username is already taken.' });
    const hash = await bcrypt.hash(password, 12);
    const user = newUser(username, hash);
    awardBadge(user, 'fresh_diver');
    await saveUser(user);
    res.status(201).json({ token: createToken(user), user: safeUser(user) });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Could not create account right now.' });
  }
});
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = users.get(keyName(username));
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Incorrect username or password.' });
    syncPennies(user);
    updateBadges(user);
    await saveUser(user);
    res.json({ token: createToken(user), user: safeUser(user) });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Could not log in right now.' });
  }
});
app.get('/api/me', authHttp, async (req, res) => {
  syncPennies(req.user);
  updateBadges(req.user);
  await saveUser(req.user);
  res.json({ user: safeUser(req.user), serverTime: Date.now() });
});
app.put('/api/avatar', authHttp, async (req, res) => {
  const { skin, shirt, hat } = req.body || {};
  if (!allowedSkins.includes(skin) || !allowedShirts.includes(shirt) || !allowedHats.includes(hat)) return res.status(400).json({ error: 'That avatar style is not available.' });
  req.user.unlocks = Array.isArray(req.user.unlocks) ? req.user.unlocks : ['skin:#f2c879', 'shirt:#59d6ff', 'hat:none', 'hat:cap'];
  if (![ `skin:${skin}`, `shirt:${shirt}`, `hat:${hat}` ].every(key => req.user.unlocks.includes(key))) return res.status(403).json({ error: 'Buy that cosmetic with Pennys before equipping it.' });
  const avatarChanged = req.user.avatar.skin !== skin || req.user.avatar.shirt !== shirt || req.user.avatar.hat !== hat;
  req.user.avatar = { skin, shirt, hat };
  if (avatarChanged) { req.user.stats = req.user.stats || {}; req.user.stats.avatarChanges = (req.user.stats.avatarChanges || 0) + 1; }
  updateBadges(req.user);
  await saveUser(req.user);
  pushUserProfile(req.user.username);
  res.json({ user: safeUser(req.user) });
});
app.post('/api/avatar/purchase', authHttp, async (req, res) => {
  const kind = String(req.body.kind || '');
  const value = String(req.body.value || '');
  const valid = kind === 'skin' ? allowedSkins.includes(value) : kind === 'shirt' ? allowedShirts.includes(value) : kind === 'hat' ? allowedHats.includes(value) : false;
  if (!valid) return res.status(400).json({ error: 'That cosmetic is not available.' });
  const key = `${kind}:${value}`;
  req.user.unlocks = Array.isArray(req.user.unlocks) ? req.user.unlocks : ['skin:#f2c879', 'shirt:#59d6ff', 'hat:none', 'hat:cap'];
  if (req.user.unlocks.includes(key)) return res.status(409).json({ error: 'You already own that cosmetic.' });
  let price = 0;
  if (kind === 'skin') price = value === '#f2c879' ? 0 : 5;
  if (kind === 'shirt') price = value === '#59d6ff' ? 0 : 8;
  if (kind === 'hat') price = ({ none: 0, cap: 0, bucket: 20, cone: 35, crown: 100 })[value];
  if (req.user.pennies < price) return res.status(400).json({ error: `You need ${price} Pennys for that item. You have ${req.user.pennies}.` });
  req.user.pennies -= price;
  req.user.unlocks.push(key);
  await saveUser(req.user);
  pushUserProfile(req.user.username);
  res.json({ user: safeUser(req.user), price, unlocked: key });
});
app.post('/api/friends/request', authHttp, async (req, res) => {
  const wanted = String(req.body.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(wanted)) return res.status(400).json({ error: 'Enter a valid username.' });
  if (keyName(wanted) === keyName(req.user.username)) return res.status(400).json({ error: 'You cannot add yourself.' });
  const target = users.get(keyName(wanted));
  if (!target) return res.status(404).json({ error: 'No account with that username was found.' });
  if (req.user.friends.includes(keyName(target.username))) return res.status(409).json({ error: 'You are already friends.' });
  if (target.friendRequests.includes(keyName(req.user.username))) return res.status(409).json({ error: 'Your request is already waiting.' });
  if (req.user.friendRequests.includes(keyName(target.username))) return res.status(409).json({ error: 'They already sent you a request. Accept it in your friends panel.' });
  target.friendRequests.push(keyName(req.user.username));
  await saveUser(target);
  res.json({ ok: true, message: `Friend request sent to ${target.username}.` });
});
app.post('/api/friends/accept', authHttp, async (req, res) => {
  const fromKey = keyName(req.body.username);
  const other = users.get(fromKey);
  if (!other || !req.user.friendRequests.includes(fromKey)) return res.status(404).json({ error: 'That friend request is no longer available.' });
  req.user.friendRequests = req.user.friendRequests.filter(name => name !== fromKey);
  if (!req.user.friends.includes(fromKey)) req.user.friends.push(fromKey);
  const meKey = keyName(req.user.username);
  if (!other.friends.includes(meKey)) other.friends.push(meKey);
  await saveUser(req.user);
  await saveUser(other);
  res.json({ ok: true, user: safeUser(req.user), message: `You are now friends with ${other.username}.` });
});
app.post('/api/friends/remove', authHttp, async (req, res) => {
  const otherKey = keyName(req.body.username);
  const other = users.get(otherKey);
  req.user.friends = req.user.friends.filter(name => name !== otherKey);
  if (other) { other.friends = other.friends.filter(name => name !== keyName(req.user.username)); await saveUser(other); }
  await saveUser(req.user);
  res.json({ ok: true, user: safeUser(req.user) });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Please log in before joining the street.'));
    const payload = jwt.verify(token, JWT_SECRET);
    const user = users.get(keyName(payload.username));
    if (!user) return next(new Error('Account not found. Please log in again.'));
    socket.userKey = keyName(user.username);
    socket.username = user.username;
    if (online.size >= MAX_PLAYERS && !online.has(socket.userKey)) return next(new Error('SERVER_FULL'));
    next();
  } catch { next(new Error('Your login expired. Please log in again.')); }
});

io.on('connection', socket => {
  const userKey = socket.userKey;
  const user = users.get(userKey);
  const previousSocket = socketsByUser.get(userKey);
  if (previousSocket && previousSocket !== socket.id) {
    const oldSocket = io.sockets.sockets.get(previousSocket);
    if (oldSocket) oldSocket.disconnect(true);
  }
  const oldPlayer = online.get(userKey);
  const player = oldPlayer || { username: user.username, x: (Math.random() - 0.5) * 2, z: 0, avatar: user.avatar, moving: false, sprinting: false, lastMoveAt: Date.now(), lastSearchAt: 0 };
  player.avatar = user.avatar;
  online.set(userKey, player);
  socketsByUser.set(userKey, socket.id);

  socket.emit('world:state', { world, players: [...online.entries()].filter(([key]) => key !== userKey).map(([, p]) => publicPlayer(p)), me: publicPlayer(player), count: online.size, maxPlayers: MAX_PLAYERS });
  socket.broadcast.emit('player:joined', publicPlayer(player));
  io.emit('server:count', { count: online.size, maxPlayers: MAX_PLAYERS });

  socket.on('player:move', data => {
    const p = online.get(userKey);
    if (!p || !data || !Number.isFinite(data.x) || !Number.isFinite(data.z)) return;
    const now = Date.now();
    const dt = clamp((now - p.lastMoveAt) / 1000, 0.03, 0.5);
    const maxMove = 13 * dt + 1.25;
    let dx = clamp(data.x, -WORLD_X, WORLD_X) - p.x;
    let dz = clamp(data.z, -WORLD_Z, WORLD_Z) - p.z;
    const length = Math.hypot(dx, dz);
    if (length > maxMove) { dx *= maxMove / length; dz *= maxMove / length; }
    p.x = clamp(p.x + dx, -WORLD_X, WORLD_X);
    p.z = clamp(p.z + dz, -WORLD_Z, WORLD_Z);
    p.moving = Boolean(data.moving);
    p.sprinting = Boolean(data.sprinting);
    p.lastMoveAt = now;
    socket.broadcast.emit('player:moved', publicPlayer(p));
  });

  socket.on('dumpster:search', async data => {
    const p = online.get(userKey);
    const dump = data && findDump(data.id);
    if (!p || !dump) return;
    if (distance(p, dump) > 5.5) return socket.emit('toast', { type: 'error', text: 'Get closer to the dumpster first.' });
    const cdKey = `${userKey}:${dump.id}`;
    const now = Date.now();
    if ((searchCooldown.get(cdKey) || 0) > now) return socket.emit('toast', { type: 'error', text: 'You already searched this dumpster. Try another one!' });
    if ((dumpsterCooldown.get(dump.id) || 0) > now) return socket.emit('toast', { type: 'info', text: 'Someone just rummaged through this dumpster. Come back soon.' });
    searchCooldown.set(cdKey, now + 9000);
    dumpsterCooldown.set(dump.id, now + 3200);
    const roll = Math.random();
    const poolItems = roll > 0.985 ? itemTypes.filter(i => i.rarity === 'legendary') : roll > 0.88 ? itemTypes.filter(i => i.rarity === 'rare' || i.rarity === 'uncommon') : roll > 0.56 ? itemTypes.filter(i => i.rarity === 'uncommon' || i.rarity === 'common') : itemTypes.filter(i => i.rarity === 'common');
    const chosen = poolItems[Math.floor(Math.random() * poolItems.length)];
    const item = { id: randomId(), ...chosen, foundAt: now };
    user.inventory.push(item);
    user.stats = user.stats || { dumpstersSearched: 0, itemsSold: 0, salesTotal: 0, rareFinds: 0, avatarChanges: 0 };
    user.stats.dumpstersSearched = (user.stats.dumpstersSearched || 0) + 1;
    if (item.rarity === 'rare' || item.rarity === 'legendary') user.stats.rareFinds = (user.stats.rareFinds || 0) + 1;
    updateBadges(user);
    await saveUser(user);
    socket.emit('dumpster:found', { item, user: safeUser(user) });
    pushUserProfile(user.username);
  });

  socket.on('npc:sell', async data => {
    const p = online.get(userKey);
    const npc = data && findNpc(data.npcId);
    if (!p || !npc) return;
    if (distance(p, npc) > 5.8) return socket.emit('toast', { type: 'error', text: 'Walk closer to the dealer before selling.' });
    const wantedId = String(data.itemId || '');
    const toSell = wantedId === 'ALL' ? user.inventory.filter(item => !isItemLocked(item.id)) : user.inventory.filter(item => item.id === wantedId && !isItemLocked(item.id));
    if (!toSell.length) return socket.emit('toast', { type: 'info', text: wantedId === 'ALL' ? 'No sellable items in your bag.' : 'That item is unavailable or locked in a trade.' });
    const sellIds = new Set(toSell.map(item => item.id));
    const total = toSell.reduce((sum, item) => sum + item.price, 0);
    user.inventory = user.inventory.filter(item => !sellIds.has(item.id));
    user.pennies += total;
    user.stats = user.stats || { dumpstersSearched: 0, itemsSold: 0, salesTotal: 0, rareFinds: 0, avatarChanges: 0 };
    user.stats.itemsSold = (user.stats.itemsSold || 0) + toSell.length;
    user.stats.salesTotal = (user.stats.salesTotal || 0) + total;
    updateBadges(user);
    await saveUser(user);
    socket.emit('npc:sold', { count: toSell.length, total, npc: npc.name, user: safeUser(user) });
    pushUserProfile(user.username);
  });

  socket.on('chat:send', message => {
    const text = String(message || '').trim().slice(0, 140);
    if (!text) return;
    io.emit('chat:message', { username: user.username, text, time: Date.now() });
  });

  socket.on('trade:request', data => {
    const targetKey = keyName(data && data.username);
    const targetPlayer = online.get(targetKey);
    const fromPlayer = online.get(userKey);
    const targetSocket = socketsByUser.get(targetKey);
    if (!targetPlayer || !targetSocket || targetKey === userKey) return socket.emit('toast', { type: 'error', text: 'That player is not online.' });
    if (distance(fromPlayer, targetPlayer) > 10) return socket.emit('toast', { type: 'error', text: 'Move closer to that player to trade.' });
    pendingTrades.set(targetKey, { from: userKey, at: Date.now() });
    io.to(targetSocket).emit('trade:incoming', { username: user.username });
    socket.emit('toast', { type: 'info', text: `Trade request sent to ${targetPlayer.username}.` });
  });
  socket.on('trade:accept', data => {
    const fromKey = keyName(data && data.username);
    const pending = pendingTrades.get(userKey);
    const a = online.get(fromKey), b = online.get(userKey);
    if (!pending || pending.from !== fromKey || Date.now() - pending.at > 30000 || !a || !b || distance(a, b) > 12) return socket.emit('toast', { type: 'error', text: 'That trade request expired or you are too far apart.' });
    pendingTrades.delete(userKey);
    const id = randomId();
    const trade = { id, users: [fromKey, userKey], offers: { [fromKey]: [], [userKey]: [] }, ready: { [fromKey]: false, [userKey]: false } };
    trades.set(id, trade);
    for (const key of trade.users) {
      const sid = socketsByUser.get(key);
      if (sid) io.to(sid).emit('trade:open', { id, other: users.get(key === fromKey ? userKey : fromKey).username, user: safeUser(users.get(key)), otherInventory: users.get(key === fromKey ? userKey : fromKey).inventory });
    }
    emitTradeUpdate(trade);
  });
  socket.on('trade:offer', data => {
    const trade = trades.get(String(data && data.id || ''));
    if (!trade || !trade.users.includes(userKey)) return;
    const itemId = String(data.itemId || '');
    const offered = trade.offers[userKey];
    if (offered.includes(itemId)) trade.offers[userKey] = offered.filter(id => id !== itemId);
    else {
      const itemExists = user.inventory.some(i => i.id === itemId);
      if (!itemExists || offered.length >= 10) return socket.emit('toast', { type: 'error', text: 'You can offer up to 10 items you own.' });
      offered.push(itemId);
    }
    trade.ready[trade.users[0]] = false;
    trade.ready[trade.users[1]] = false;
    emitTradeUpdate(trade);
  });
  socket.on('trade:ready', data => {
    const trade = trades.get(String(data && data.id || ''));
    if (!trade || !trade.users.includes(userKey)) return;
    trade.ready[userKey] = Boolean(data.ready);
    emitTradeUpdate(trade);
    if (!trade.ready[trade.users[0]] || !trade.ready[trade.users[1]]) return;
    const [aKey, bKey] = trade.users;
    const a = users.get(aKey), b = users.get(bKey);
    if (!a || !b) return finishTrade(trade, 'One player left the game.');
    const aItems = trade.offers[aKey].map(id => a.inventory.find(i => i.id === id)).filter(Boolean);
    const bItems = trade.offers[bKey].map(id => b.inventory.find(i => i.id === id)).filter(Boolean);
    const aIdSet = new Set(aItems.map(i => i.id)), bIdSet = new Set(bItems.map(i => i.id));
    a.inventory = a.inventory.filter(i => !aIdSet.has(i.id)).concat(bItems);
    b.inventory = b.inventory.filter(i => !bIdSet.has(i.id)).concat(aItems);
    saveUser(a).then(() => saveUser(b)).then(() => {
      for (const key of trade.users) {
        const sid = socketsByUser.get(key);
        if (sid) io.to(sid).emit('trade:complete', { user: safeUser(users.get(key)), text: 'Trade completed!' });
      }
      trades.delete(trade.id);
    }).catch(err => { console.error(err); finishTrade(trade, 'Could not save the trade.'); });
  });
  socket.on('trade:cancel', () => {
    for (const trade of trades.values()) if (trade.users.includes(userKey)) finishTrade(trade, 'Trade cancelled.');
  });

  socket.on('disconnect', () => {
    if (socketsByUser.get(userKey) === socket.id) {
      socketsByUser.delete(userKey);
      online.delete(userKey);
      io.emit('player:left', { username: user.username });
      io.emit('server:count', { count: online.size, maxPlayers: MAX_PLAYERS });
      for (const trade of trades.values()) if (trade.users.includes(userKey)) finishTrade(trade, `${user.username} left the street.`);
      for (const [target, request] of pendingTrades.entries()) if (target === userKey || request.from === userKey) pendingTrades.delete(target);
    }
  });
});

function emitTradeUpdate(trade) {
  const payload = { id: trade.id, offers: {}, ready: trade.ready, names: {} };
  for (const key of trade.users) {
    const u = users.get(key);
    payload.names[key] = u ? u.username : key;
    payload.offers[key] = trade.offers[key].map(id => {
      const item = u && u.inventory.find(i => i.id === id);
      return item ? { id: item.id, name: item.name, price: item.price, rarity: item.rarity } : null;
    }).filter(Boolean);
  }
  for (const key of trade.users) { const sid = socketsByUser.get(key); if (sid) io.to(sid).emit('trade:update', payload); }
}
function finishTrade(trade, text) {
  for (const key of trade.users) { const sid = socketsByUser.get(key); if (sid) io.to(sid).emit('trade:closed', { text }); }
  trades.delete(trade.id);
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API route not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => { if (err) next(err); });
});

async function main() {
  if (!process.env.JWT_SECRET) console.log('Using a private, locally generated token secret in data/jwt-secret.txt.');
  await initializeStorage();
  server.listen(PORT, HOST, () => console.log(`Dumpster Divers is running on http://${HOST}:${PORT}`));
}
main().catch(error => { console.error('Startup failed:', error); process.exit(1); });

module.exports = { server, app, io };
