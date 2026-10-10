'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const PENNY_MS = 15 * 60 * 1000;
  const skins = ['#f2c879', '#b1e3ff', '#c4ff4d', '#ff7777', '#d5a5ff', '#f0f0ee', '#ff9d38'];
  const shirts = ['#ff784f', '#59d6ff', '#b5ee65', '#c58aff', '#f5d75e', '#f0f0ee', '#292e42'];
  const hats = [{id:'none',label:'No Hat'}, {id:'cap',label:'Street Cap'}, {id:'bucket',label:'Bucket Hat'}, {id:'crown',label:'Scrap Crown'}, {id:'cone',label:'Traffic Cone'}];
  const itemSymbols = {JUNK:'⌁', TOY:'♟', ELECTRONICS:'▣', COLLECTIBLE:'✦'};
  let token = localStorage.getItem('diversToken') || '';
  let profile = null;
  let authMode = 'login';
  let socket = null;
  let worldData = null;
  let localPlayer = {x:0, z:0, moving:false, sprinting:false, username:''};
  let others = new Map();
  let scene, camera, renderer, localMesh, localNameSprite, animationId;
  let modelMeshes = new Map();
  let dumpsterMeshes = new Map();
  let npcMeshes = new Map();
  let target = null;
  let lastFrameAt = 0, lastSocketMove = 0, pennyPollAt = 0, toastTimer = null;
  let selectedAvatar = null;
  let tradeContext = null;
  let badgeCatalog = [];
  let badgeCountBeforeAction = 0;
  let incomingTradeFrom = '';
  const keys = new Set();
  const mobileKeys = new Set();
  const clock = {value:0};

  const api = async (path, options = {}) => {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { ...options, headers });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) {
      if (response.status === 401 && token) logout(false);
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  };

  function toast(message, type = 'good', timeout = 3300) {
    const stack = $('#toast-stack');
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'bad' : type === 'info' ? 'info' : ''}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => el.remove(), timeout);
  }
  function gameToast(message, type = 'good', timeout = 3000) {
    const el = $('#game-toast');
    el.textContent = message;
    el.className = `game-toast ${type === 'error' ? 'error' : type === 'info' ? 'info' : ''}`;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), timeout);
  }
  function setAuthMessage(message, good = false) {
    const el = $('#auth-message'); el.textContent = message; el.classList.toggle('good', good);
  }
  function hideBoot() { $('#boot-screen').classList.add('hidden'); }
  function showAuth() { hideBoot(); $('#auth-screen').classList.remove('hidden'); $('#app').classList.add('hidden'); }
  function showApp() { hideBoot(); $('#auth-screen').classList.add('hidden'); $('#app').classList.remove('hidden'); showScreen('menu-screen'); updateProfileUI(); }
  function showScreen(id) {
    ['menu-screen','avatar-screen','friends-screen'].forEach(name => $(`#${name}`).classList.toggle('hidden', name !== id));
    if (id === 'menu-screen') updateProfileUI();
  }
  function showAuthMode(mode) {
    authMode = mode;
    $('#login-tab').classList.toggle('active', mode === 'login');
    $('#register-tab').classList.toggle('active', mode === 'register');
    $('#auth-heading').textContent = mode === 'login' ? 'Welcome back, diver.' : 'Make your street name.';
    $('#auth-copy').textContent = mode === 'login' ? 'Your next big find is out there.' : 'Start with empty pockets. The bins are full.';
    $('#auth-submit').innerHTML = mode === 'login' ? 'ENTER THE STREET <span>→</span>' : 'CREATE MY DIVER <span>→</span>';
    $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-hint').textContent = mode === 'login' ? 'Your account is stored on this game server.' : 'Username: 3–16 letters, numbers or underscores. Password: 8+ characters.';
    setAuthMessage('');
  }
  async function handleAuth(event) {
    event.preventDefault();
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const submit = $('#auth-submit'); submit.disabled = true; submit.textContent = authMode === 'login' ? 'CHECKING...' : 'MAKING ACCOUNT...';
    try {
      const data = await api(`/api/${authMode === 'login' ? 'login' : 'register'}`, { method:'POST', body: JSON.stringify({ username, password }) });
      token = data.token; localStorage.setItem('diversToken', token); profile = data.user;
      $('#auth-password').value = '';
      showApp();
      toast(authMode === 'login' ? `Welcome back, ${profile.username}!` : `Account created. Welcome to the street, ${profile.username}!`);
    } catch (error) { setAuthMessage(error.message); }
    finally { submit.disabled = false; showAuthMode(authMode); }
  }
  function logout(showToast = true) {
    if (socket) { socket.disconnect(); socket = null; }
    stopGame();
    destroyScene();
    token = ''; profile = null; localStorage.removeItem('diversToken');
    closeAllModals();
    showAuth();
    if (showToast) setAuthMessage('You have been logged out.', true);
  }
  async function refreshProfile() {
    if (!token) return;
    try {
      const data = await api('/api/me');
      profile = data.user;
      updateProfileUI();
    } catch (error) { if (token) toast(error.message, 'error'); }
  }
  function updateProfileUI() {
    if (!profile) return;
    $('#top-username').textContent = profile.username;
    $('#top-pennies').textContent = profile.pennies;
    $('#menu-pennies').textContent = profile.pennies;
    $('#game-pennies').textContent = profile.pennies;
    $('#menu-bag-count').textContent = `${profile.inventory.length} ITEM${profile.inventory.length === 1 ? '' : 'S'}`;
    $('#game-bag-count').textContent = profile.inventory.length;
    $('#menu-friend-count').textContent = profile.friends.length;
    $('#friends-count').textContent = `${profile.friends.length} FRIEND${profile.friends.length === 1 ? '' : 'S'}`;
    $('#request-count').textContent = profile.friendRequests.length;
    $('#menu-badge-count').textContent = (profile.badges || []).length;
    $('#top-avatar').style.background = profile.avatar.shirt;
    $('#top-avatar').style.color = '#11141d';
    $('#top-avatar').textContent = profile.avatar.hat === 'crown' ? '♛' : profile.username.slice(0,1).toUpperCase();
    $('#avatar-display-name').textContent = profile.username.toUpperCase();
    updatePennyClock();
    if ($('#bag-modal') && !$('#bag-modal').classList.contains('hidden')) renderBag();
    if (!$('#npc-modal').classList.contains('hidden')) renderDealerItems();
  }
  function updatePennyClock() {
    if (!profile) return;
    const passed = Math.max(0, Date.now() - Number(profile.lastPennyAt || Date.now()));
    const elapsedInCycle = passed % PENNY_MS;
    const remaining = passed > 0 && elapsedInCycle < 1000 ? 0 : Math.max(0, PENNY_MS - elapsedInCycle);
    const minutes = Math.floor(remaining / 60000).toString().padStart(2,'0');
    const seconds = Math.floor((remaining % 60000) / 1000).toString().padStart(2,'0');
    $('#penny-countdown').textContent = `${minutes}:${seconds}`;
    $('#penny-progress-bar').style.width = `${Math.min(100, (passed % PENNY_MS) / PENNY_MS * 100)}%`;
  }

  $('#login-tab').addEventListener('click', () => showAuthMode('login'));
  $('#register-tab').addEventListener('click', () => showAuthMode('register'));
  $('#auth-form').addEventListener('submit', handleAuth);
  $('#logout-button').addEventListener('click', () => logout(true));
  $('#brand-home').addEventListener('click', () => { stopGame(); showScreen('menu-screen'); });
  $('#play-button').addEventListener('click', startGame);
  $('#avatar-button').addEventListener('click', () => { selectedAvatar = structuredClone(profile.avatar); showScreen('avatar-screen'); renderAvatarEditor(); });
  $('#friends-button').addEventListener('click', async () => { showScreen('friends-screen'); await renderFriends(); });
  $('#badges-button').addEventListener('click', async () => { await renderBadges(); $('#badges-modal').classList.remove('hidden'); });
  $('#bag-button').addEventListener('click', openBag);
  $('#game-bag-button').addEventListener('click', openBag);
  $$('[data-back]').forEach(button => button.addEventListener('click', () => showScreen('menu-screen')));
  $$('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));
  $('#save-avatar').addEventListener('click', saveAvatar);
  $('#friend-form').addEventListener('submit', sendFriendRequest);
  $('#leave-street').addEventListener('click', () => { stopGame(); showScreen('menu-screen'); });
  $('#auth-password').addEventListener('keydown', e => { if(e.key === 'Enter') $('#auth-submit').click(); });
  $('#sell-all-button').addEventListener('click', sellAllFromBag);
  $('#dealer-sell-all').addEventListener('click', () => {
    if (!socket || !socket.connected || target?.type !== 'npc') return gameToast('Walk close to a dealer to sell.', 'error');
    socket.emit('npc:sell', { npcId: target.id, itemId: 'ALL' });
  });
  $('#chat-form').addEventListener('submit', e => { e.preventDefault(); sendChat(); });
  $('#chat-input').addEventListener('focus', () => { keys.clear(); mobileKeys.clear(); });
  $('#accept-trade').addEventListener('click', () => { if (socket && incomingTradeFrom) socket.emit('trade:accept', { username: incomingTradeFrom }); $('#incoming-trade-modal').classList.add('hidden'); });
  $('#decline-trade').addEventListener('click', () => { incomingTradeFrom = ''; $('#incoming-trade-modal').classList.add('hidden'); });
  $('#cancel-trade').addEventListener('click', () => { if (socket) socket.emit('trade:cancel'); closeModal('trade'); });
  $('#ready-trade').addEventListener('click', () => {
    if (!socket || !tradeContext) return;
    tradeContext.ready = !tradeContext.ready;
    socket.emit('trade:ready', { id: tradeContext.id, ready: tradeContext.ready });
    $('#ready-trade').textContent = tradeContext.ready ? 'WAITING FOR THEM…' : 'READY TO SWAP ✓';
  });
  $('#mobile-interact').addEventListener('click', interact);

  function hasCosmetic(kind, value) {
    return Array.isArray(profile?.unlocks) && profile.unlocks.includes(`${kind}:${value}`);
  }
  async function purchaseCosmetic(kind, value) {
    const status = $('#avatar-status'); status.textContent = 'CHECKING YOUR PENNYS…';
    try {
      const data = await api('/api/avatar/purchase', { method:'POST', body:JSON.stringify({ kind, value }) });
      profile = data.user; selectedAvatar[kind] = value; updateProfileUI(); renderAvatarEditor();
      toast(`UNLOCKED! Spent ¢${data.price} Pennys.`);
    } catch (error) { status.textContent = error.message; toast(error.message, 'error'); }
  }
  function renderAvatarEditor() {
    if (!selectedAvatar) return;
    const skinWrap = $('#skin-options'); skinWrap.replaceChildren();
    skins.forEach(color => {
      const unlocked = hasCosmetic('skin', color); const price = color === '#f2c879' ? 0 : 5;
      const button = document.createElement('button'); button.className = `swatch ${selectedAvatar.skin === color ? 'selected' : ''} ${unlocked ? '' : 'locked'}`; button.style.background = color; button.title = unlocked ? color : `Unlock for ${price} Pennys`; button.setAttribute('aria-label', unlocked ? `Skin ${color}` : `Unlock skin for ${price} Pennys`); button.dataset.color = color;
      if (!unlocked) { const tag=document.createElement('span');tag.className='swatch-price';tag.textContent=`¢${price}`;button.appendChild(tag); }
      button.addEventListener('click', () => { if (unlocked) { selectedAvatar.skin = color; renderAvatarEditor(); } else purchaseCosmetic('skin', color); }); skinWrap.appendChild(button);
    });
    const shirtWrap = $('#shirt-options'); shirtWrap.replaceChildren();
    shirts.forEach(color => {
      const unlocked = hasCosmetic('shirt', color); const price = color === '#59d6ff' ? 0 : 8;
      const button = document.createElement('button'); button.className = `swatch ${selectedAvatar.shirt === color ? 'selected' : ''} ${unlocked ? '' : 'locked'}`; button.style.background = color; button.title = unlocked ? color : `Unlock for ${price} Pennys`; button.setAttribute('aria-label', unlocked ? `Hoodie ${color}` : `Unlock hoodie for ${price} Pennys`);
      if (!unlocked) { const tag=document.createElement('span');tag.className='swatch-price';tag.textContent=`¢${price}`;button.appendChild(tag); }
      button.addEventListener('click', () => { if (unlocked) { selectedAvatar.shirt = color; renderAvatarEditor(); } else purchaseCosmetic('shirt', color); }); shirtWrap.appendChild(button);
    });
    const hatWrap = $('#hat-options'); hatWrap.replaceChildren();
    const hatPrices = { none:0, cap:0, bucket:20, crown:100, cone:35 };
    hats.forEach(hat => {
      const unlocked = hasCosmetic('hat', hat.id); const price = hatPrices[hat.id] || 0;
      const button = document.createElement('button'); button.className = `hat-choice ${selectedAvatar.hat === hat.id ? 'selected' : ''} ${unlocked ? '' : 'locked'}`; button.textContent = unlocked ? hat.label : `${hat.label} · ¢${price}`;
      button.addEventListener('click', () => { if (unlocked) { selectedAvatar.hat = hat.id; renderAvatarEditor(); } else purchaseCosmetic('hat', hat.id); }); hatWrap.appendChild(button);
    });
    $('#avatar-preview .avatar-head').style.background = selectedAvatar.skin;
    $('#avatar-preview .avatar-body').style.background = selectedAvatar.shirt;
    const hatEl = $('#avatar-preview .avatar-hat');
    const hatStyle = {none:{display:'none'},cap:{background:'#c4ff4d',height:'17px',width:'54px',left:'15px',top:'5px'},bucket:{background:'#ff8d59',height:'12px',width:'57px',left:'14px',top:'8px'},crown:{background:'#f5d75e',height:'20px',width:'46px',left:'19px',top:'0px',clipPath:'polygon(0 100%,0 35%,18% 35%,27% 0,42% 35%,58% 35%,72% 0,82% 35%,100% 35%,100% 100%)'},cone:{background:'#ff784f',height:'25px',width:'27px',left:'29px',top:'-6px',clipPath:'polygon(50% 0,100% 100%,0 100%)'}};
    Object.assign(hatEl.style, {display:'block', transform:'rotate(-5deg)', ...hatStyle[selectedAvatar.hat]});
    $('#avatar-status').textContent = 'LOCKED COSMETICS COST PENNYS';
  }
  async function saveAvatar() {
    const button = $('#save-avatar'); button.disabled = true; button.textContent = 'SAVING…';
    try { const data = await api('/api/avatar',{method:'PUT',body:JSON.stringify(selectedAvatar)}); profile=data.user; updateProfileUI(); renderAvatarEditor(); toast('Fit saved. Looking extremely street.'); }
    catch(error){ $('#avatar-status').textContent=error.message; }
    finally { button.disabled=false; button.textContent='SAVE LOOK ↗'; }
  }

  async function renderFriends() {
    if (!profile) return;
    $('#friend-username').value = '';
    const requests = $('#friend-requests'); requests.replaceChildren();
    if (!profile.friendRequests.length) { requests.textContent = 'No requests. Your fan club is still forming.'; requests.className='friend-list empty-state'; }
    else {
      requests.className='friend-list';
      profile.friendRequests.forEach(username => {
        const row = document.createElement('div'); row.className='friend-row';
        const avatar = document.createElement('div'); avatar.className='friend-row-avatar'; avatar.textContent=username.slice(0,1).toUpperCase();
        const info = document.createElement('div'); info.className='friend-row-info'; const strong=document.createElement('strong'); strong.textContent=username; const small=document.createElement('small'); small.textContent='WANTS TO JOIN YOUR CREW'; info.append(strong,small);
        const accept=document.createElement('button'); accept.className='button button-primary'; accept.textContent='ACCEPT'; accept.addEventListener('click', async()=>{try{const data=await api('/api/friends/accept',{method:'POST',body:JSON.stringify({username})});profile=data.user;await renderFriends();updateProfileUI();toast(`${username} added to your crew.`)}catch(e){toast(e.message,'error')}});
        row.append(avatar,info,accept); requests.appendChild(row);
      });
    }
    const friendList = $('#friends-list'); friendList.replaceChildren();
    if (!profile.friends.length) { friendList.textContent='Nobody in your crew yet. Add a friend by username.'; friendList.className='friend-list empty-state'; }
    else {
      friendList.className='friend-list';
      profile.friends.forEach(username => {
        const displayName=username;
        const row=document.createElement('div');row.className='friend-row';
        const avatar=document.createElement('div');avatar.className='friend-row-avatar';avatar.textContent=displayName.slice(0,1).toUpperCase();
        const info=document.createElement('div');info.className='friend-row-info';const strong=document.createElement('strong');strong.textContent=displayName;const small=document.createElement('small');small.textContent='FRIEND';info.append(strong,small);
        const remove=document.createElement('button');remove.className='button button-outline';remove.textContent='REMOVE';remove.addEventListener('click',async()=>{try{const data=await api('/api/friends/remove',{method:'POST',body:JSON.stringify({username:displayName})});profile=data.user;await renderFriends();updateProfileUI()}catch(e){toast(e.message,'error')}});
        row.append(avatar,info,remove);friendList.appendChild(row);
      });
    }
    renderOnlineFriends();
  }
  async function sendFriendRequest(event) {
    event.preventDefault(); const username=$('#friend-username').value.trim(); const note=$('#friend-message'); note.textContent='SENDING...';
    try { const data=await api('/api/friends/request',{method:'POST',body:JSON.stringify({username})});note.textContent=data.message;note.classList.add('good');$('#friend-username').value=''; }
    catch(error){note.textContent=error.message;note.classList.remove('good')}
  }
  function renderOnlineFriends() {
    const wrap=$('#online-friends-list'); wrap.replaceChildren();
    const onlineFriends=[...others.values()].filter(p=>profile?.friends.includes(p.username.toLowerCase()));
    if (!socket || !socket.connected || !onlineFriends.length) { wrap.className='friend-list empty-state';wrap.textContent='No friends in this live session right now.';return; }
    wrap.className='friend-list';
    onlineFriends.forEach(p=>{const row=document.createElement('div');row.className='friend-row';const av=document.createElement('div');av.className='friend-row-avatar';av.style.background=p.avatar.shirt;av.textContent=p.username[0].toUpperCase();const info=document.createElement('div');info.className='friend-row-info';const s=document.createElement('strong');s.textContent=p.username;const sm=document.createElement('small');sm.textContent='ONLINE ON DUMPSTER STREET';info.append(s,sm);const b=document.createElement('button');b.className='button button-primary';b.textContent='TRADE';b.addEventListener('click',()=>requestTrade(p.username));row.append(av,info,b);wrap.appendChild(row)});
  }

  async function renderBadges() {
    if (!profile) return;
    try { if (!badgeCatalog.length) badgeCatalog = (await api('/api/badges')).badges || []; } catch {}
    const wrap = $('#badges-grid'); wrap.replaceChildren();
    const unlocked = new Set(profile.badges || []);
    let rewardTotal = 0;
    badgeCatalog.forEach(b => { const has = unlocked.has(b.id); if (has) rewardTotal += b.reward; const card=document.createElement('article'); card.className=`badge-card ${has?'unlocked':'locked'}`; const ico=document.createElement('div'); ico.className='badge-icon'; ico.textContent=b.icon; const body=document.createElement('div'); const title=document.createElement('h3'); title.textContent=b.name; const desc=document.createElement('p'); desc.textContent=b.description; const reward=document.createElement('div'); reward.className='badge-reward'; reward.textContent=`+${b.reward} PENNYS`; const status=document.createElement('div'); status.className='badge-lock'; status.textContent=has?'✓ UNLOCKED':'🔒 LOCKED'; body.append(title,desc,reward,status); card.append(ico,body); wrap.appendChild(card); });
    $('#badge-total-reward').textContent = `${unlocked.size} / ${badgeCatalog.length} unlocked · ¢${rewardTotal} earned from badges`;
  }
  function openBag() { if (!profile) return; renderBag(); $('#bag-modal').classList.remove('hidden'); }
  function renderBag() {
    if (!profile) return;
    const items=$('#bag-items');items.replaceChildren();
    let total=0; profile.inventory.forEach(item=>{total+=item.price;items.appendChild(makeItemRow(item,{sell:true,offered:false}))});
    $('#bag-item-count').textContent=`${profile.inventory.length} ITEM${profile.inventory.length===1?'':'S'}`;
    $('#bag-value').textContent=`TOTAL VALUE: ¢${total}`;
    const canSell=target?.type==='npc' && socket?.connected;
    $('#bag-sale-hint').textContent=canSell?`You're near ${target.name}. Sell to this dealer.`:'Visit a dealer on the street to sell your finds.';
    $('#sell-all-button').disabled=!canSell || !profile.inventory.length;
    if (!profile.inventory.length) { const empty=document.createElement('div');empty.className='empty-state';empty.textContent='Your bag is tragically empty. Go rummage in a dumpster!';items.appendChild(empty); }
  }
  function makeItemRow(item, options={}) {
    const row=document.createElement('div');row.className=`item-row rarity-${item.rarity||'common'} ${options.offered?'offered':''}`;
    const icon=document.createElement('div');icon.className=`item-icon rarity-${item.rarity||'common'}`;icon.style.color=item.color||'#c4ff4d';icon.textContent=itemSymbols[item.kind]||'✦';
    const info=document.createElement('div');info.className='item-info';const name=document.createElement('strong');name.textContent=item.name;const meta=document.createElement('small');meta.className=`rarity-text-${item.rarity||'common'}`;meta.textContent=`${String(item.rarity||'common').toUpperCase()} • ${item.kind||'JUNK'}`;info.append(name,meta);
    const price=document.createElement('div');price.className='item-price';price.textContent=`¢${item.price}`;row.append(icon,info,price);
    if (options.sell) { const sell=document.createElement('button');sell.className='button button-outline';sell.textContent='SELL';const canSell=target?.type==='npc'&&socket?.connected;sell.disabled=!canSell;sell.title=canSell?'Sell to nearby dealer':'Get close to an NPC dealer to sell';sell.addEventListener('click',()=>{if(!canSell)return toast('Walk up to a dealer to sell items.','info');socket.emit('npc:sell',{npcId:target.id,itemId:item.id})});row.appendChild(sell); }
    if (options.trade) { const offer=document.createElement('button');offer.className=`button ${options.offered?'button-primary':'button-outline'}`;offer.textContent=options.offered?'REMOVE':'OFFER';offer.disabled=tradeContext?.ready===true;offer.addEventListener('click',()=>{if(socket&&tradeContext)socket.emit('trade:offer',{id:tradeContext.id,itemId:item.id})});row.appendChild(offer); }
    return row;
  }
  function sellAllFromBag() {
    if (!socket || !socket.connected) return toast('Join the street first.','error');
    if (target?.type!=='npc') return toast('You need to be close to a dealer to sell.','info');
    socket.emit('npc:sell',{npcId:target.id,itemId:'ALL'});
  }
  function renderDealerItems() {
    if (!profile || target?.type!=='npc') return;
    const wrap=$('#dealer-items');wrap.replaceChildren();const total=profile.inventory.reduce((sum,i)=>sum+i.price,0);
    $('#dealer-total-value').textContent=`¢${total}`;
    $('#dealer-sell-all').disabled=!profile.inventory.length;
    if (!profile.inventory.length){const empty=document.createElement('div');empty.className='empty-state';empty.textContent='No loot yet. Go see what the bins are hiding.';wrap.appendChild(empty);return}
    profile.inventory.forEach(item=>wrap.appendChild(makeItemRow(item,{sell:true})));
  }
  function openDealer(npc) {
    if (!npc) return; $('#dealer-title').textContent=npc.name.toUpperCase();$('#dealer-job').textContent=npc.job;$('#dealer-avatar').textContent=npc.name.slice(0,1).toUpperCase();$('#dealer-avatar').style.background=npc.color;
    const quotes=[`"I've seen worse. Show me what you got."`,`"Could be junk. Could be a retirement plan."`,`"Don't tell anyone where you found that."`,`"Clean-ish stuff goes for a better price."`];$('#dealer-quote').textContent=quotes[Math.floor(Math.random()*quotes.length)];
    renderDealerItems();$('#npc-modal').classList.remove('hidden');
  }
  function closeModal(name) { const id={bag:'bag-modal',npc:'npc-modal',trade:'trade-modal',badges:'badges-modal'}[name];if(id)$('#'+id).classList.add('hidden'); }
  function closeAllModals() { ['bag-modal','npc-modal','trade-modal','incoming-trade-modal','badges-modal'].forEach(id=>$('#'+id).classList.add('hidden'));tradeContext=null; }
  function modalIsOpen(){return ['bag-modal','npc-modal','trade-modal','incoming-trade-modal','badges-modal'].some(id=>!$('#'+id).classList.contains('hidden'));}

  function requestTrade(username) { if(!socket||!socket.connected)return toast('Join the street before trading.','info');socket.emit('trade:request',{username}); }
  function renderTrade() {
    if(!tradeContext||!tradeContext.update||!profile)return;
    const upd=tradeContext.update;const me=profile.username.toLowerCase();const other=tradeContext.other.toLowerCase();
    const offeredMine=(upd.offers[me]||[]).map(i=>i.id);const offeredOther=upd.offers[other]||[];
    $('#trade-other-heading').textContent=`${tradeContext.other.toUpperCase()}'S OFFER`;
    $('#trade-my-ready').textContent=upd.ready[me]?'READY ✓':'NOT READY';$('#trade-my-ready').classList.toggle('ready',Boolean(upd.ready[me]));
    $('#trade-other-ready').textContent=upd.ready[other]?'READY ✓':'NOT READY';$('#trade-other-ready').classList.toggle('ready',Boolean(upd.ready[other]));
    const myWrap=$('#trade-my-items');myWrap.replaceChildren();
    if(!profile.inventory.length){const empty=document.createElement('div');empty.className='empty-state';empty.textContent='Nothing to trade. Go scavenge!';myWrap.appendChild(empty)}
    profile.inventory.forEach(item=>myWrap.appendChild(makeItemRow(item,{trade:true,offered:offeredMine.includes(item.id)})));
    const theirWrap=$('#trade-other-items');theirWrap.replaceChildren();
    if(!offeredOther.length){const empty=document.createElement('div');empty.className='empty-state';empty.textContent='They have not offered anything yet.';theirWrap.appendChild(empty)}
    offeredOther.forEach(item=>theirWrap.appendChild(makeItemRow(item,{offered:true})));
    const readyNow=Boolean(upd.ready[me]);$('#ready-trade').textContent=readyNow?'CANCEL READY':'READY TO SWAP ✓';$('#ready-trade').classList.toggle('button-primary',!readyNow);$('#ready-trade').classList.toggle('button-outline',readyNow);
    $('#trade-status').textContent=upd.ready[me]?'Waiting for the other diver…':'Make sure the offer looks fair before you ready up.';
  }

  // ── Multiplayer session ───────────────────────────────────────────────
  async function startGame() {
    if (!profile || !token) return showAuth();
    stopGame(false);
    $('#menu-screen').classList.add('hidden');$('#avatar-screen').classList.add('hidden');$('#friends-screen').classList.add('hidden');$('#game-screen').classList.remove('hidden');
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) $('#game-screen').classList.add('touch-device');
    $('#chat-messages').replaceChildren();$('#top-server-count').textContent='STARTING LOCAL GAME';$('#game-player-count').textContent='SOLO MODE';
    if (!window.THREE) { gameToast('The bundled 3D engine did not load. Close and reopen the game, or reinstall it.', 'error', 6000); return; }
    socket = io({auth:{token}, transports:['websocket','polling']});
    socket.on('connect',()=>{ $('#top-server-count').textContent='LOCAL GAME READY';gameToast('Welcome back! Look for green markers over dumpsters.'); });
    socket.on('connect_error',err=>{gameToast('The local game service could not connect. Close any other copy of Dumpster Divers and reopen this one.','error',6000);$('#top-server-count').textContent='LOCAL GAME UNAVAILABLE';});
    socket.on('disconnect',reason=>{if(reason!=='io client disconnect')gameToast('Local game service stopped. Trying to reconnect…','error',5000);$('#top-server-count').textContent='RECONNECTING LOCALLY';});
    socket.on('world:state',data=>{
      worldData=data.world;localPlayer={...localPlayer,x:data.me.x,z:data.me.z,username:profile.username,avatar:data.me.avatar};
      others.clear();data.players.forEach(p=>others.set(p.username.toLowerCase(),p));
      if(!scene) buildScene(); else {
        if(localMesh) scene.remove(localMesh);
        localMesh=createCharacter(profile.avatar,profile.username,false);
        localMesh.position.set(localPlayer.x,0,localPlayer.z);
        scene.add(localMesh);
        rebuildRemotePlayers();
      }
      $('#top-server-count').textContent='SOLO ADVENTURE';updateServerCount(data.count,data.maxPlayers);renderNearbyPlayers();gameToast('Welcome to Dumpster Street. Press E near a dumpster!');
    });
    socket.on('player:joined',p=>{if(p.username.toLowerCase()!==profile.username.toLowerCase())others.set(p.username.toLowerCase(),p);if(scene)ensureRemoteModel(p);renderNearbyPlayers();renderOnlineFriends()});
    socket.on('player:moved',p=>{if(p.username.toLowerCase()===profile.username.toLowerCase())return;others.set(p.username.toLowerCase(),{...(others.get(p.username.toLowerCase())||{}),...p});ensureRemoteModel(p);renderNearbyPlayers()});
    socket.on('player:left',data=>{others.delete(String(data.username).toLowerCase());removeRemoteModel(data.username);renderNearbyPlayers();renderOnlineFriends()});
    socket.on('server:count',data=>updateServerCount(data.count,data.maxPlayers));
    socket.on('toast',data=>gameToast(data.text,data.type||'good'));
    socket.on('profile:update',user=>{profile=user;updateProfileUI();renderNearbyPlayers()});
    socket.on('dumpster:found',data=>{profile=data.user;updateProfileUI();gameToast(`FOUND: ${data.item.name}  •  VALUE ¢${data.item.price}`,data.item.rarity==='legendary'?'good':'info',4500);toast(`${data.item.name} added to your bag!`);renderBag()});
    socket.on('npc:sold',data=>{profile=data.user;updateProfileUI();gameToast(`SOLD ${data.count} ITEM${data.count===1?'':'S'} FOR ¢${data.total}!`);toast(`+¢${data.total} from ${data.npc}!`);renderDealerItems()});
    socket.on('chat:message',appendChatMessage);
    socket.on('trade:incoming',data=>{incomingTradeFrom=data.username;$('#trade-request-title').textContent=`${data.username.toUpperCase()} WANTS TO TRADE`;$('#trade-request-copy').textContent='Swap some of your questionable treasures? This request expires after a short time.';$('#incoming-trade-modal').classList.remove('hidden')});
    socket.on('trade:open',data=>{profile=data.user;tradeContext={id:data.id,other:data.other,ready:false,update:null};$('#trade-modal').classList.remove('hidden');updateProfileUI();});
    socket.on('trade:update',data=>{if(!tradeContext||tradeContext.id!==data.id)return;tradeContext.update=data;tradeContext.ready=Boolean(data.ready[profile.username.toLowerCase()]);renderTrade()});
    socket.on('trade:complete',data=>{profile=data.user;updateProfileUI();closeModal('trade');tradeContext=null;gameToast(data.text||'Trade completed!');toast('Items swapped successfully!')});
    socket.on('trade:closed',data=>{closeModal('trade');tradeContext=null;gameToast(data.text||'Trade closed.','info')});
    window.setTimeout(()=>{if(socket&&!socket.connected&&!scene)gameToast('The local game is still starting. If it does not connect, close and reopen Dumpster Divers.','info',6000)},7000);
  }
  function stopGame(disconnect = true) {
    if(disconnect && socket){socket.disconnect();socket=null;}
    keys.clear();mobileKeys.clear();target=null;$('#interaction-hint').classList.add('hidden');closeAllModals();
    if(disconnect)$('#game-screen').classList.add('hidden');
  }
  function destroyScene() {
    if (animationId) cancelAnimationFrame(animationId);
    animationId=null;
    window.removeEventListener('resize',resizeRenderer);
    if (renderer) renderer.dispose();
    $('#game-world').replaceChildren();
    scene=null;camera=null;renderer=null;localMesh=null;worldData=null;
    modelMeshes.clear();dumpsterMeshes.clear();npcMeshes.clear();others.clear();lastFrameAt=0;
  }
  function updateServerCount(){$('#game-player-count').textContent='SINGLE-PLAYER';$('#menu-online').textContent='SOLO';$('#top-server-count').textContent='LOCAL SAVE ACTIVE';}
  function appendChatMessage(data) {
    const wrap=$('#chat-messages');const line=document.createElement('div');line.className='chat-line';const date=new Date(data.time||Date.now());const t=document.createElement('span');t.className='chat-time';t.textContent=`${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;const name=document.createElement('b');name.textContent=`${data.username}:`;const msg=document.createElement('span');msg.textContent=` ${String(data.text).slice(0,140)}`;line.append(t,name,msg);wrap.appendChild(line);while(wrap.children.length>60)wrap.firstChild.remove();wrap.scrollTop=wrap.scrollHeight;
  }
  function sendChat() { const input=$('#chat-input');const text=input.value.trim();if(!text)return;if(!socket||!socket.connected)return toast('Not connected to the street.','error');socket.emit('chat:send',text);input.value='';input.blur(); }

  // ── Low-resolution 3D street ──────────────────────────────────────────
  function mat(color, roughness=1, extra={}) { return new THREE.MeshStandardMaterial({color,roughness,flatShading:true,...extra}); }
  function box(parent, x,y,z, sx,sy,sz, material, extra={}) { const mesh=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),material);mesh.position.set(x,y,z);mesh.castShadow=false;mesh.receiveShadow=false;Object.assign(mesh,extra);parent.add(mesh);return mesh; }
  function plane(parent,x,y,z,sx,sz,material){const mesh=new THREE.Mesh(new THREE.PlaneGeometry(sx,sz),material);mesh.rotation.x=-Math.PI/2;mesh.position.set(x,y,z);parent.add(mesh);return mesh;}
  function makeLabelSprite(text,color='#f3f0e8',bg='#141b28',fontSize=16) {
    const canvas=document.createElement('canvas');canvas.width=256;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle=bg;ctx.fillRect(1,1,254,62);ctx.strokeStyle=color;ctx.lineWidth=4;ctx.strokeRect(2,2,252,60);ctx.fillStyle=color;ctx.font=`bold ${fontSize}px monospace`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(text).toUpperCase().slice(0,25),128,33);
    const texture=new THREE.CanvasTexture(canvas);texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;const sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:false,depthTest:false}));sprite.scale.set(3.5,.88,1);return sprite;
  }
  function makeSignTexture(text,color) {
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=32;const ctx=canvas.getContext('2d');ctx.fillStyle='#121824';ctx.fillRect(0,0,128,32);ctx.strokeStyle=color;ctx.lineWidth=3;ctx.strokeRect(2,2,124,28);ctx.fillStyle=color;ctx.font='bold 12px monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(text.slice(0,13),64,17);const texture=new THREE.CanvasTexture(canvas);texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;return texture;
  }
  function buildScene() {
    const mount=$('#game-world');mount.replaceChildren();
    scene=new THREE.Scene();scene.background=new THREE.Color('#202c46');scene.fog=new THREE.Fog('#202c46',55,155);
    camera=new THREE.PerspectiveCamera(58,window.innerWidth/window.innerHeight,.1,260);
    renderer=new THREE.WebGLRenderer({antialias:false,alpha:false,powerPreference:'high-performance'});renderer.setPixelRatio(1);renderer.setSize(Math.max(480,Math.floor(window.innerWidth*.62)),Math.max(270,Math.floor(window.innerHeight*.62)),false);renderer.domElement.style.width='100%';renderer.domElement.style.height='100%';renderer.domElement.style.imageRendering='pixelated';mount.appendChild(renderer.domElement);
    renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
    scene.add(new THREE.HemisphereLight('#b7d1ff','#29313a',2.2));const moonLight=new THREE.DirectionalLight('#b8c9ff',1.35);moonLight.position.set(-22,45,28);scene.add(moonLight);
    const road=mat('#252d3b'), pavement=mat('#6b6e79'), curb=mat('#9c9fac'), line=mat('#d4d1ad'), darkLine=mat('#374353'), asphaltPatch=mat('#1b2330');
    box(scene,0,-.4,0,38,.8,236,road);box(scene,-20.5,-.32,0,5.5,.5,236,pavement);box(scene,20.5,-.32,0,5.5,.5,236,pavement);
    box(scene,-17.7,-.1,0,.25,.28,236,curb);box(scene,17.7,-.1,0,.25,.28,236,curb);
    for(let z=-112;z<=112;z+=8){box(scene,0,.025,z,0.23,.05,3.1,line);box(scene,-7.5,.018,z,0.10,.04,2,darkLine);box(scene,7.5,.018,z,0.10,.04,2,darkLine);}
    for(let i=0;i<100;i++){const x=(Math.random()-.5)*32;const z=(Math.random()-.5)*220;box(scene,x,.012,z,.4+Math.random()*.8,.025,.15+Math.random()*.35,asphaltPatch)}
    // Rows of little shops, apartment blocks, rooftop details and lit signs.
    const buildingColors=['#46516a','#625b74','#395969','#736052','#4a665b','#55465d','#3c506c','#6c5360'];
    const shopNames=['PAWN','QUICK MART','LAUNDRY','TACOS','REPAIR','ARCADE','DINER','ODD JOBS','SECOND-HAND','NOODLES','RECORDS','MOTEL'];
    const signColors=['#c4ff4d','#59d6ff','#ff8d59','#ff75c7','#f5d75e'];
    for(const side of [-1,1]){
      for(let i=0;i<15;i++){
        const z=-105+i*15;const color=buildingColors[(i+(side===1?2:0))%buildingColors.length];const h=8+((i*13+(side===1?4:1))%7);const x=side*28;
        box(scene,x,h/2-0.2,z,10,h,13,mat(color));
        box(scene,x,h+0.1,z,10.5,.35,13.5,mat('#202a3c'));
        // windows facing toward the road
        for(let row=0;row<2;row++)for(let col=0;col<3;col++){
          const wx=x-side*(3.2-col*2.6);const wy=1.9+row*2.7;const wz=z-3.7;
          box(scene,wx,wy,wz,1.45,1.2,.12,mat((i+row+col)%4===0?'#f7d48a':'#263a55',1,{emissive:(i+row+col)%4===0?'#e7ab54':'#15233b',emissiveIntensity:(i+row+col)%4===0?.8:.25}));
        }
        const signX=x-side*5.08;const sign= new THREE.Mesh(new THREE.PlaneGeometry(5.2,1.25),new THREE.MeshBasicMaterial({map:makeSignTexture(shopNames[(i*3+(side===1?4:0))%shopNames.length],signColors[(i+ (side===1?1:0))%signColors.length]),side:THREE.DoubleSide}));sign.position.set(signX,2.4,z-4.8);sign.rotation.y=side===-1?Math.PI/2:-Math.PI/2;scene.add(sign);
        box(scene,signX,1.25,z-4.9,4.6,.26,.3,mat('#1b2635'));
        if(i%2===0){box(scene,x+side*4.5,h+.9,z-4.5,1.3,.55,1.3,mat('#30394c'));box(scene,x+side*4.5,h+1.4,z-4.5,.45,.6,.45,mat(signColors[i%signColors.length]));}
      }
    }
    // Fire escapes, street lamps, benches, crates, papers and bins make the walk feel lived-in.
    const metal=mat('#2a3546'), lampGlow=mat('#f8d78a',.4,{emissive:'#f6be58',emissiveIntensity:1.4}), wood=mat('#775f4c'), crateMat=mat('#5f6b63');
    for(let z=-104;z<=104;z+=16){
      for(const side of [-1,1]){
        const x=side*17.0;box(scene,x,2.25,z,.18,4.5,.18,metal);box(scene,x-side*.75,4.45,z,1.55,.18,.18,metal);box(scene,x-side*1.4,4.25,z,.35,.24,.7,lampGlow);
        if((Math.round((z+104)/16)+(side===1?1:0))%3===0){const bench=new THREE.Group();box(bench,0,.65,0,2,.2,.65,wood);box(bench,0,.94,-.24,2,.55,.14,wood);box(bench,-.72,.3,0,.13,.6,.13,metal);box(bench,.72,.3,0,.13,.6,.13,metal);bench.position.set(side*19.5,-.15,z+4);scene.add(bench);}
        if((Math.round((z+104)/16)+(side===1?0:1))%4===0){const g=new THREE.Group();box(g,0,.65,0,1.2,1.3,1.2,crateMat);box(g,0,.65,0,1.28,.13,.15,wood);box(g,0,.65,0,.15,.13,1.28,wood);g.position.set(side*21.0,-.25,z+2);scene.add(g);}
      }
    }
    // Small neon reflections / sidewalk patches.
    for(let i=0;i<26;i++){
      const side=i%2?1:-1;const z=-102+i*8;const x=side*(18.4+Math.random()*2.3);const color=signColors[i%signColors.length];box(scene,x,.012,z,.45+Math.random(),.02,.1+Math.random()*.3,mat(color,.5,{emissive:color,emissiveIntensity:.35}));
    }
    // Dumpsters from server-owned interaction coordinates.
    worldData.dumpsters.forEach((d,index)=>{
      const g=new THREE.Group();const green=mat(index%3===0?'#477d6a':index%3===1?'#3b6e67':'#38645f');const edge=mat('#203b3f');
      box(g,0,1.1,0,3.25,2.15,2.35,green);box(g,0,2.2,.05,3.5,.28,2.5,edge);box(g,0,2.38,.05,3.35,.17,2.35,green);
      for(let rib=-1;rib<=1;rib++){box(g,rib*1.02,1.07,-1.19,.1,1.75,.07,edge)}
      box(g,-.9,.2,1.1,.4,.5,.4,edge);box(g,.9,.2,1.1,.4,.5,.4,edge);
      const mark=makeLabelSprite('?', '#c4ff4d','#183128',24);mark.position.set(0,3.65,0);mark.scale.set(.9,.9,1);g.add(mark);
      g.position.set(d.x,-.2,d.z);scene.add(g);dumpsterMeshes.set(d.id,g);
      // A few scraps around the bin.
      for(let j=0;j<4;j++)box(scene,d.x+(Math.random()-.5)*3,.035,d.z+(Math.random()-.5)*3,.3,.06,.24,mat(['#ad8b59','#87a7a5','#d6bd78'][j%3]));
    });
    // NPC dealers are solid, low-poly citizens with floating name plaques.
    worldData.npcs.forEach(n=>{const g=createCharacter({skin:'#f2c879',shirt:n.color,hat:'none'},n.name,true);g.position.set(n.x,0,n.z);scene.add(g);const tag=makeLabelSprite(n.name, n.color,'#111822',14);tag.position.set(0,3.75,0);tag.scale.set(2.9,.72,1);g.add(tag);npcMeshes.set(n.id,g);});
    localMesh=createCharacter(profile.avatar,profile.username,false);localMesh.position.set(localPlayer.x,0,localPlayer.z);scene.add(localMesh);
    rebuildRemotePlayers();
    window.addEventListener('resize',resizeRenderer);
    if(!animationId) animationId=requestAnimationFrame(renderFrame);
  }
  function createCharacter(avatar,username,isNpc=false) {
    const group=new THREE.Group();const skin=mat(avatar.skin||'#f2c879'),shirt=mat(avatar.shirt||'#59d6ff'),pants=mat('#d7dce7'),shoe=mat('#242a38'),black=mat('#151923'),hatMat=mat(avatar.hat==='cone'?'#ff784f':avatar.hat==='crown'?'#f5d75e':avatar.hat==='bucket'?'#ff8d59':'#c4ff4d');
    box(group,0,1.52,0,.92,.84,.78,skin);box(group,0,.98,-.03,1.06,1.05,.75,shirt);
    box(group,-.66,1.01,0,.31,.84,.34,shirt);box(group,.66,1.01,0,.31,.84,.34,shirt);
    box(group,-.28,.39,0,.35,.76,.4,pants);box(group,.28,.39,0,.35,.76,.4,pants);
    box(group,-.28,.1,-.03,.39,.2,.5,shoe);box(group,.28,.1,-.03,.39,.2,.5,shoe);
    // The little square eyes face forward along -Z.
    box(group,-.2,1.56,-.405,.095,.13,.05,black);box(group,.2,1.56,-.405,.095,.13,.05,black);
    if(avatar.hat==='cap'){box(group,0,2.01,0,1.0,.18,.9,hatMat);box(group,0,1.94,-.45,.74,.12,.36,hatMat)}
    if(avatar.hat==='bucket'){box(group,0,2.01,0,.9,.23,.85,hatMat);box(group,0,1.88,0,1.16,.1,1.12,hatMat)}
    if(avatar.hat==='crown'){box(group,0,2.04,0,.78,.14,.66,hatMat);[-.27,0,.27].forEach((x,i)=>box(group,x,2.16,0,.16,.22,.65,hatMat))}
    if(avatar.hat==='cone'){const cone=new THREE.Mesh(new THREE.ConeGeometry(.42,.7,4),hatMat);cone.position.set(0,2.18,0);cone.rotation.y=Math.PI/4;group.add(cone);box(group,0,1.84,0,.75,.1,.65,mat('#f5d75e'))}
    if(isNpc){box(group,0,.95,.4,.4,.3,.12,mat('#273144'));}
    if(!isNpc){const name=makeLabelSprite(username,'#eef3ff','#151c29',13);name.position.set(0,3.0,0);name.scale.set(2.6,.66,1);group.add(name)}return group;
  }
  function rebuildRemotePlayers(){
    for(const [key,p] of others){ensureRemoteModel(p)}
    for(const [key,model] of modelMeshes){if(!others.has(key)){scene.remove(model);modelMeshes.delete(key)}}
  }
  function ensureRemoteModel(p){if(!scene||p.username.toLowerCase()===profile?.username.toLowerCase())return;const key=p.username.toLowerCase();let mesh=modelMeshes.get(key);if(!mesh){mesh=createCharacter(p.avatar,p.username);mesh.position.set(p.x,0,p.z);scene.add(mesh);modelMeshes.set(key,mesh)}else if(mesh.userData.avatarKey!==JSON.stringify(p.avatar)){const pos=mesh.position.clone();scene.remove(mesh);mesh=createCharacter(p.avatar,p.username);mesh.position.copy(pos);scene.add(mesh);modelMeshes.set(key,mesh)}mesh.userData.avatarKey=JSON.stringify(p.avatar);mesh.userData.targetX=p.x;mesh.userData.targetZ=p.z;}
  function removeRemoteModel(username){const key=String(username).toLowerCase();const mesh=modelMeshes.get(key);if(mesh&&scene)scene.remove(mesh);modelMeshes.delete(key);}
  function resizeRenderer(){if(!renderer||!camera)return;camera.aspect=window.innerWidth/window.innerHeight;camera.updateProjectionMatrix();renderer.setSize(Math.max(480,Math.floor(window.innerWidth*.62)),Math.max(270,Math.floor(window.innerHeight*.62)),false);}
  function renderFrame(time){animationId=requestAnimationFrame(renderFrame);if(!renderer||!scene)return;const now=time||performance.now();const dt=lastFrameAt?Math.min((now-lastFrameAt)/1000,.05):.016;lastFrameAt=now;clock.value+=dt;
    if(!$('#game-screen').classList.contains('hidden')) updateGame(dt,now);
    renderer.render(scene,camera);
  }
  function updateGame(dt,now){
    if(!localMesh)return;
    const canMove=!modalIsOpen() && document.activeElement!==$('#chat-input');
    const down=(...list)=>list.some(k=>keys.has(k)||mobileKeys.has(k));
    const forward=canMove&&down('KeyW','ArrowUp','forward');const back=canMove&&down('KeyS','ArrowDown','back');const left=canMove&&down('KeyA','ArrowLeft','left');const right=canMove&&down('KeyD','ArrowRight','right');
    let dx=(right?1:0)-(left?1:0);let dz=(forward?-1:0)+(back?1:0);const magnitude=Math.hypot(dx,dz);const sprint=canMove&&down('ShiftLeft','ShiftRight');
    localPlayer.moving=magnitude>0;localPlayer.sprinting=sprint;
    if(magnitude){
      dx/=magnitude;dz/=magnitude;const speed=sprint?8.4:5.2;
      const nextX=Math.max(-21.8,Math.min(21.8,localPlayer.x+dx*speed*dt));
      const nextZ=Math.max(-111,Math.min(111,localPlayer.z+dz*speed*dt));
      const blocked=(x,z)=>{
        if(worldData){
          for(const d of worldData.dumpsters)if(Math.hypot(x-d.x,z-d.z)<2.05)return true;
          for(const n of worldData.npcs)if(Math.hypot(x-n.x,z-n.z)<1.15)return true;
        }
        return false;
      };
      if(!blocked(nextX,localPlayer.z))localPlayer.x=nextX;
      if(!blocked(localPlayer.x,nextZ))localPlayer.z=nextZ;
      localMesh.rotation.y=Math.atan2(dx,-dz);
    }
    localMesh.position.x+=(localPlayer.x-localMesh.position.x)*Math.min(1,dt*18);localMesh.position.z+=(localPlayer.z-localMesh.position.z)*Math.min(1,dt*18);
    // A tiny step bounce gives the voxel character some life without making the camera jitter.
    const bob=localPlayer.moving?Math.abs(Math.sin(clock.value*(sprint?18:13)))*.08:0;localMesh.position.y=bob;
    const camX=localMesh.position.x+5.5,camY=8.5,camZ=localMesh.position.z+11.5;
    camera.position.lerp(new THREE.Vector3(camX,camY,camZ),Math.min(1,dt*3.4));camera.lookAt(localMesh.position.x,1.05,localMesh.position.z-3.1);
    for(const [key,mesh] of modelMeshes){const p=others.get(key);if(!p)continue;mesh.position.x+=(p.x-mesh.position.x)*Math.min(1,dt*8);mesh.position.z+=(p.z-mesh.position.z)*Math.min(1,dt*8);if(p.moving)mesh.position.y=Math.abs(Math.sin(clock.value*11))*.04;else mesh.position.y=0;}
    if(socket&&socket.connected&&now-lastSocketMove>90){socket.emit('player:move',{x:localPlayer.x,z:localPlayer.z,moving:localPlayer.moving,sprinting:localPlayer.sprinting});lastSocketMove=now;}
    updateTarget();
    if(now-pennyPollAt>30000){pennyPollAt=now;refreshProfile()}
    updatePennyClock();
  }
  function updateTarget(){
    if(!worldData){$('#interaction-hint').classList.add('hidden');target=null;return}
    let closest=null,closestD=5.7;
    for(const d of worldData.dumpsters){const dist=Math.hypot(localPlayer.x-d.x,localPlayer.z-d.z);if(dist<closestD){closestD=dist;closest={...d,type:'dumpster',name:'DUMPSTER'}}}
    for(const n of worldData.npcs){const dist=Math.hypot(localPlayer.x-n.x,localPlayer.z-n.z);if(dist<closestD){closestD=dist;closest={...n,type:'npc'}}}
    target=closest;
    const hint=$('#interaction-hint');
    if(!target||modalIsOpen()){hint.classList.add('hidden');return}
    hint.classList.remove('hidden');
    $('#interaction-title').textContent=target.type==='dumpster'?'SEARCH DUMPSTER':`TALK TO ${target.name.toUpperCase()}`;
    $('#interaction-copy').textContent=target.type==='dumpster'?'Press E to rummage for loot.':'Press E to sell your finds.';
    if(!$('#bag-modal').classList.contains('hidden'))renderBag();
  }
  function interact(){
    if(!target||!socket||!socket.connected){gameToast('Move closer to a dumpster or dealer.', 'info');return}
    if(target.type==='dumpster'){socket.emit('dumpster:search',{id:target.id});gameToast('Rummaging through the bin…','info',1200)}
    else openDealer(target);
  }
  function renderNearbyPlayers(){
    const wrap=$('#nearby-players');wrap.replaceChildren();
    const near=[...others.values()].map(p=>({...p,dist:Math.hypot(p.x-localPlayer.x,p.z-localPlayer.z)})).filter(p=>p.dist<32).sort((a,b)=>a.dist-b.dist).slice(0,5);
    if(!near.length){const span=document.createElement('span');span.className='muted';span.textContent='Nobody nearby yet…';wrap.appendChild(span);}
    near.forEach(p=>{const row=document.createElement('div');row.className='nearby-person';const dot=document.createElement('i');dot.className='person-dot';dot.style.background=p.avatar.shirt;const name=document.createElement('span');name.textContent=p.username;const trade=document.createElement('button');trade.textContent='TRADE';trade.addEventListener('click',()=>requestTrade(p.username));row.append(dot,name,trade);wrap.appendChild(row)});
    renderOnlineFriends();
  }

  // ── Keys and touch controls ───────────────────────────────────────────
  window.addEventListener('keydown',e=>{
    if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)&&!$('#game-screen').classList.contains('hidden'))e.preventDefault();
    if(e.repeat && ['KeyE','KeyI','KeyT','Escape'].includes(e.code))return;
    if(e.code==='KeyT'&&!$('#game-screen').classList.contains('hidden')&&!modalIsOpen()){e.preventDefault();$('#chat-input').focus();return}
    if(e.code==='KeyE'&&!$('#game-screen').classList.contains('hidden')&&!modalIsOpen()){interact();return}
    if(e.code==='KeyI'&&!$('#game-screen').classList.contains('hidden')&&!modalIsOpen()){openBag();return}
    if(e.code==='Escape'){if(modalIsOpen())closeAllModals();else if(!$('#game-screen').classList.contains('hidden')){stopGame();showScreen('menu-screen')}return}
    keys.add(e.code);
  });
  window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>{keys.clear();mobileKeys.clear()});
  $$('[data-move]').forEach(button=>{
    const name=button.dataset.move;
    const start=e=>{e.preventDefault();mobileKeys.add(name);button.setPointerCapture?.(e.pointerId)};
    const end=e=>{e.preventDefault();mobileKeys.delete(name)};
    button.addEventListener('pointerdown',start);button.addEventListener('pointerup',end);button.addEventListener('pointercancel',end);button.addEventListener('lostpointercapture',end);
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden){keys.clear();mobileKeys.clear()}});
  window.addEventListener('beforeunload',()=>{if(socket)socket.disconnect()});

  // Avoid the chat being treated like a movement surface on mobile.
  document.addEventListener('pointerdown',e=>{if(e.target.closest('.modal-card'))e.stopPropagation()});
  function boot() {
    setTimeout(hideBoot,450);
    if(token){
      api('/api/me').then(data=>{profile=data.user;showApp()}).catch(()=>{showAuth();showAuthMode('login')});
    } else {showAuth();showAuthMode('login')}
    setInterval(updatePennyClock,1000);
  }
  boot();
})();
