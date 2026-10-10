const $ = (selector) => document.querySelector(selector);
const DEFAULTS = { skin:'#f2c879', shirt:'#59d6ff', hat:'cap' };
const SKINS = ['#f2c879','#b1e3ff','#c4ff4d','#ff7777','#d5a5ff','#f0f0ee','#ff9d38'];
const SHIRTS = ['#ff784f','#59d6ff','#b5ee65','#c58aff','#f5d75e','#f0f0ee','#292e42'];
const HATS = ['none','cap','bucket','crown','cone'];
const HAT_ICONS = { none:'', cap:'🧢', bucket:'🪣', crown:'♛', cone:'🚧' };
const PENNY_MS = 15 * 60 * 1000;
const DEMO_KEY = 'dumpsterGamesDemoV1';
const DEMO_SESSION = 'dumpsterGamesDemoSession';
const BADGES = [
  {id:'fresh_diver',name:'Fresh Diver',icon:'🗑️',desc:'Create your DumpsterGames account.',reward:10,goal:'Unlocked when you join.'},
  {id:'style_icon',name:'Style Icon',icon:'🧢',desc:'Save a custom avatar look.',reward:15,goal:'Customize your diver.'},
  {id:'crew_starter',name:'Crew Starter',icon:'🤝',desc:'Accept your first friend.',reward:25,goal:'Build your first friendship.'},
  {id:'crew_builder',name:'Crew Builder',icon:'👥',desc:'Have at least 3 friends.',reward:50,goal:'Get three friends in your crew.'},
  {id:'penny_hoarder',name:'Penny Hoarder',icon:'🪙',desc:'Earn 100 Pennys in total.',reward:35,goal:'Keep earning time bonuses and badge rewards.'}
];
const config = window.DUMPSTER_CONFIG || {};
const cloudReady = Boolean(config.supabaseUrl && config.supabaseAnonKey && !config.supabaseUrl.includes('YOUR-PROJECT') && !config.supabaseAnonKey.includes('YOUR_'));
let supabase = null;
if (cloudReady) {
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
}
let authMode = 'login';
let session = null;
let profile = null;
let friends = [];
let requests = [];
let leaderboard = [];
let lastPennySync = 0;

function toast(message, good=false) {
  const el=$('#toast'); el.textContent=message; el.classList.remove('hidden'); el.style.borderColor=good?'var(--lime)':'var(--pink)';
  clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.classList.add('hidden'),3400);
}
function showMessage(message, good=false) { const el=$('#auth-message'); el.textContent=message; el.classList.toggle('good',good); }
function setAuthMode(mode) {
  authMode=mode;
  $('#login-tab').classList.toggle('active',mode==='login');
  $('#register-tab').classList.toggle('active',mode==='register');
  $('#username-field').classList.toggle('hidden',mode!=='register');
  $('#auth-title').textContent=mode==='login'?'Welcome back, diver.':'Join the crew.';
  $('#auth-subtitle').textContent=mode==='login'?'Sign in to see your crew.':'Make a name for yourself on Dumpster Street.';
  $('#auth-submit').textContent=mode==='login'?'LOG IN ↗':'CREATE ACCOUNT ↗';
  $('#password').autocomplete=mode==='login'?'current-password':'new-password';
  showMessage('');
}
function avatarElement(p, extra='') {
  const el=document.createElement('div'); el.className=`avatar ${extra}`.trim();
  el.style.setProperty('--skin',p.avatar_skin||p.skin||DEFAULTS.skin);
  el.style.setProperty('--shirt',p.avatar_shirt||p.shirt||DEFAULTS.shirt);
  const hat=document.createElement('div');hat.className='hat';hat.textContent=HAT_ICONS[p.avatar_hat||p.hat||DEFAULTS.hat]||'';
  const head=document.createElement('div');head.className='head';const body=document.createElement('div');body.className='body';
  el.append(hat,head,body); return el;
}
function profileFields(p) {
  return {id:p.id,username:p.username,pennies:Number(p.pennies)||0,avatar_skin:p.avatar_skin||p.skin||DEFAULTS.skin,avatar_shirt:p.avatar_shirt||p.shirt||DEFAULTS.shirt,avatar_hat:p.avatar_hat||p.hat||DEFAULTS.hat,earned_badges:p.earned_badges||p.badges||[],total_pennies_earned:Number(p.total_pennies_earned??p.totalPenniesEarned)||0,last_penny_at:p.last_penny_at??p.lastPennyAt??Date.now()};
}
function applyAvatarToEditor(p) { $('#skin').value=p.avatar_skin||DEFAULTS.skin;$('#shirt').value=p.avatar_shirt||DEFAULTS.shirt;$('#hat').value=p.avatar_hat||DEFAULTS.hat; }
function renderMyAvatar() {
  const old=$('#my-avatar');
  const next=avatarElement(profile,'big');
  next.id='my-avatar';
  if(old) old.replaceWith(next);
  $('#profile-name').textContent=profile.username;
  $('#profile-pennies').textContent=profile.pennies;
  $('#profile-badge-count').textContent=(profile.earned_badges||[]).length;
}
function badgeCard(b, earned) {
  const card=document.createElement('article'); card.className=`badge ${earned?'earned':''}`;
  const icon=document.createElement('div');icon.className='badge-icon';icon.textContent=b.icon;
  const title=document.createElement('strong');title.textContent=b.name;
  const desc=document.createElement('p');desc.textContent=b.desc;
  const reward=document.createElement('div');reward.className='reward';reward.textContent=`+${b.reward} PENNYS ${earned?'· EARNED':'· LOCKED'}`;
  card.append(icon,title,desc,reward);return card;
}
function renderBadges() {
  const earned=new Set(profile.earned_badges||[]);
  const latest=$('#profile-badges');latest.replaceChildren();
  const latestBadges=BADGES.filter(b=>earned.has(b.id)).slice(-3).reverse();
  if(!latestBadges.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No badges yet. Your first one is waiting.';latest.appendChild(empty)}
  else latestBadges.forEach(b=>latest.appendChild(badgeCard(b,true)));
  const all=$('#all-badges');all.replaceChildren();BADGES.forEach(b=>all.appendChild(badgeCard(b,earned.has(b.id))));
  $('#badge-total').textContent=earned.size;
  $('#profile-badge-count').textContent=earned.size;
}
function renderTopStats() {
  $('#hello-name').textContent=profile.username;
  $('#coin-total').textContent=profile.pennies;
  $('#profile-pennies').textContent=profile.pennies;
  $('#friend-total').textContent=friends.length;
  $('#badge-total').textContent=(profile.earned_badges||[]).length;
  $('#profile-badge-count').textContent=(profile.earned_badges||[]).length;
  $('#crew-title').textContent=`${friends.length} FRIEND${friends.length===1?'':'S'}`;
  $('#request-total').textContent=requests.length;
  $('#header-user').textContent=`SIGNED IN: ${profile.username}`;
  $('#header-user').classList.remove('hidden');
  renderMyAvatar();renderBadges();
}
function addFriendCard(container,p,buttons=[]) {
  const card=document.createElement('article');card.className='rowcard';card.appendChild(avatarElement(p));
  const main=document.createElement('div');main.className='rowmain';const name=document.createElement('strong');name.textContent=p.username;const small=document.createElement('small');small.textContent=`${(p.earned_badges||[]).length} badge${(p.earned_badges||[]).length===1?'':'s'} unlocked`;main.append(name,small);
  const coin=document.createElement('div');coin.className='rowcoin';coin.textContent=`¢ ${Number(p.pennies)||0}`;card.append(main,coin);
  for(const b of buttons)card.appendChild(b);container.appendChild(card);return card;
}
function actionButton(label,handler,kind='small') { const b=document.createElement('button');b.type='button';b.className=`btn ${kind==='danger'?'danger':'secondary'} small`;b.textContent=label;b.addEventListener('click',handler);return b; }
function renderFriendsUI() {
  const list=$('#friends-list'),home=$('#home-friends');list.replaceChildren();home.replaceChildren();
  if(!friends.length){const a=document.createElement('div');a.className='empty';a.textContent='No friends yet. Search for a diver and send a request.';list.appendChild(a);const b=a.cloneNode(true);home.appendChild(b)}
  friends.forEach(p=>{addFriendCard(list,p,[actionButton('REMOVE',()=>removeFriend(p.id),'danger')]);addFriendCard(home,p)});
  const reqWrap=$('#requests-list');reqWrap.replaceChildren();
  if(!requests.length){const e=document.createElement('div');e.className='empty';e.textContent='No incoming friend requests right now.';reqWrap.appendChild(e)}
  requests.forEach(r=>{const card=document.createElement('article');card.className='rowcard';card.appendChild(avatarElement(r));const main=document.createElement('div');main.className='rowmain';const name=document.createElement('strong');name.textContent=r.username;const sm=document.createElement('small');sm.textContent='WANTS TO JOIN YOUR CREW';main.append(name,sm);card.append(main,actionButton('ACCEPT',()=>acceptRequest(r.request_id),'small'),actionButton('NOPE',()=>rejectRequest(r.request_id),'danger'));reqWrap.appendChild(card)});
}
function renderLeaderboard() {
  const wrap=$('#leaderboard');wrap.replaceChildren();
  const entries=[...leaderboard].sort((a,b)=>(b.pennies||0)-(a.pennies||0)).slice(0,6);
  if(!entries.length){const e=document.createElement('div');e.className='empty';e.textContent='The leaderboard will fill up when more divers join.';wrap.appendChild(e);return}
  entries.forEach((p,i)=>{const badge= document.createElement('span');badge.className='rightmeta';badge.textContent=`#${i+1}`;const card=addFriendCard(wrap,p);card.prepend(badge)});
}
function showDashboard(view='profile') {
  $('#auth-page').classList.add('hidden');$('#dashboard-page').classList.remove('hidden');
  ['profile','friends','badges'].forEach(name=>$('#'+name+'-view').classList.toggle('sectionhide',name!==view));
  renderTopStats();renderFriendsUI();renderLeaderboard();
  if(profile)applyAvatarToEditor(profile);
}
function showAuth() {
  $('#auth-page').classList.remove('hidden');$('#dashboard-page').classList.add('hidden');$('#header-user').classList.add('hidden');
}

// ---------------- DEMO MODE (only this browser; never a real online account system) ----------------
function readDemo() { try{return JSON.parse(localStorage.getItem(DEMO_KEY)||'{"users":{},"requests":[]}')}catch{return {users:{},requests:[]}} }
function writeDemo(db) { localStorage.setItem(DEMO_KEY,JSON.stringify(db)); }
function demoCurrent(db=readDemo()) { const id=localStorage.getItem(DEMO_SESSION);return id?db.users[id]||null:null; }
function demoSaveUser(u,db=readDemo()) { db.users[u.id]=u;writeDemo(db); }
function demoFriends(db=readDemo()) { const u=demoCurrent(db);if(!u)return[];return (u.friends||[]).map(id=>db.users[id]).filter(Boolean).map(profileFields); }
function demoRequests(db=readDemo()) { const u=demoCurrent(db);if(!u)return[];return db.requests.filter(r=>r.receiverId===u.id&&r.status==='pending').map(r=>({...profileFields(db.users[r.senderId]||{}),request_id:r.id,sender_id:r.senderId})); }
function awardDemo(u,id,quiet=false,db=readDemo()) {
  u.earned_badges=u.earned_badges||[];if(u.earned_badges.includes(id))return false;
  const b=BADGES.find(x=>x.id===id);if(!b)return false;
  u.earned_badges.push(id);u.pennies=(u.pennies||0)+b.reward;u.total_pennies_earned=(u.total_pennies_earned||0)+b.reward;demoSaveUser(u,db);if(!quiet)toast(`BADGE UNLOCKED: ${b.name} · +${b.reward} Pennys`,true);return true;
}
function demoEvaluate(u,db=readDemo()) {
  const accepted=(db.requests||[]).filter(r=>r.status==='accepted'&&(r.senderId===u.id||r.receiverId===u.id)).length;
  if(u.avatar_skin!==DEFAULTS.skin||u.avatar_shirt!==DEFAULTS.shirt||u.avatar_hat!==DEFAULTS.hat)awardDemo(u,'style_icon',true,db);
  if(accepted>=1)awardDemo(u,'crew_starter',true,db);
  if(accepted>=3)awardDemo(u,'crew_builder',true,db);
  if((u.total_pennies_earned||0)>=100)awardDemo(u,'penny_hoarder',true,db);
}
function maybeEarnDemoPennies() {
  const db=readDemo(),u=demoCurrent(db);if(!u)return;
  const now=Date.now(),last=Number(u.last_penny_at)||now;const count=Math.floor((now-last)/PENNY_MS);
  if(count>0){u.pennies+=count;u.total_pennies_earned=(u.total_pennies_earned||0)+count;u.last_penny_at=last+count*PENNY_MS;demoEvaluate(u,db);demoSaveUser(u,db);toast(`+${count} free Penny${count===1?'':'s'} collected!`,true);loadDemoDashboard()}
}
async function hashDemoPassword(password,saltHex) {
  const enc=new TextEncoder();const salt=saltHex?Uint8Array.from(saltHex.match(/.{1,2}/g).map(x=>parseInt(x,16))):crypto.getRandomValues(new Uint8Array(16));
  const saltString=[...salt].map(x=>x.toString(16).padStart(2,'0')).join('');
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:120000,hash:'SHA-256'},key,256);
  return {salt:saltString,hash:[...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,'0')).join('')};
}
async function demoAuth(email,password,username) {
  const db=readDemo();const normalized=email.trim().toLowerCase();
  if(authMode==='register'){
    if(!/^[A-Za-z0-9_]{3,16}$/.test(username))throw new Error('Username must be 3–16 characters using letters, numbers, or underscores.');
    if([...Object.values(db.users)].some(u=>u.email===normalized))throw new Error('That email is already registered in this browser.');
    if([...Object.values(db.users)].some(u=>u.username.toLowerCase()===username.toLowerCase()))throw new Error('That username is already taken in this browser.');
    const hashed=await hashDemoPassword(password);const now=Date.now();
    const u={id:crypto.randomUUID(),email:normalized,username,pennies:10,total_pennies_earned:10,last_penny_at:now,avatar_skin:DEFAULTS.skin,avatar_shirt:DEFAULTS.shirt,avatar_hat:DEFAULTS.hat,earned_badges:[],friends:[],joined_at:now,password_salt:hashed.salt,password_hash:hashed.hash};
    db.users[u.id]=u;awardDemo(u,'fresh_diver',true,db);writeDemo(db);localStorage.setItem(DEMO_SESSION,u.id);return u;
  }
  const u=Object.values(db.users).find(x=>x.email===normalized);
  if(!u)throw new Error('No demo account with that email exists in this browser.');
  const hashed=await hashDemoPassword(password,u.password_salt);if(hashed.hash!==u.password_hash)throw new Error('Incorrect email or password.');
  localStorage.setItem(DEMO_SESSION,u.id);u.last_seen=Date.now();demoEvaluate(u,db);demoSaveUser(u,db);return u;
}
function loadDemoDashboard() {
  const db=readDemo(),u=demoCurrent(db);if(!u){session=null;profile=null;showAuth();return}
  profile=profileFields(u);friends=demoFriends(db);requests=demoRequests(db);leaderboard=Object.values(db.users).map(profileFields).filter(p=>p.id!==u.id);showDashboard('profile');
}
function syncDemoProfiles(db=readDemo()) { const u=demoCurrent(db);if(!u)return;demoSaveUser(u,db); }
function demoSendRequest(targetId) {
  const db=readDemo(),u=demoCurrent(db),target=db.users[targetId];if(!u||!target)throw new Error('Diver not found.');if(u.id===target.id)throw new Error('You cannot add yourself.');if((u.friends||[]).includes(target.id))throw new Error('You are already friends.');
  let request=db.requests.find(r=>(r.senderId===u.id&&r.receiverId===target.id)||(r.senderId===target.id&&r.receiverId===u.id));
  if(request?.status==='accepted')throw new Error('You are already friends.');if(request?.status==='pending')throw new Error('A request is already waiting.');
  db.requests.push({id:crypto.randomUUID(),senderId:u.id,receiverId:target.id,status:'pending',createdAt:Date.now()});writeDemo(db);
}
function demoAccept(requestId) {
  const db=readDemo(),u=demoCurrent(db),r=db.requests.find(x=>x.id===requestId&&x.receiverId===u?.id&&x.status==='pending');if(!r)throw new Error('That request is no longer available.');
  r.status='accepted';const other=db.users[r.senderId];u.friends=[...new Set([...(u.friends||[]),other.id])];other.friends=[...new Set([...(other.friends||[]),u.id])];awardDemo(u,'crew_starter',true,db);awardDemo(other,'crew_starter',true,db);demoEvaluate(u,db);demoEvaluate(other,db);demoSaveUser(u,db);demoSaveUser(other,db);writeDemo(db);
}
function demoRemoveFriend(friendId) {
  const db=readDemo(),u=demoCurrent(db),other=db.users[friendId];if(!u)return;u.friends=(u.friends||[]).filter(id=>id!==friendId);if(other)other.friends=(other.friends||[]).filter(id=>id!==u.id);db.requests=db.requests.filter(r=>!((r.senderId===u.id&&r.receiverId===friendId)||(r.senderId===friendId&&r.receiverId===u.id)));demoSaveUser(u,db);writeDemo(db);
}

// ---------------- ONLINE MODE (Supabase) ----------------
async function loadCloudProfile() {
  const {data:{user}}=await supabase.auth.getUser();if(!user)throw new Error('Please sign in again.');
  await supabase.rpc('claim_pennies');
  const {data,error}=await supabase.from('profiles').select('*').eq('id',user.id).single();if(error)throw error;
  profile=profileFields(data);
  await loadCloudSocial();
  return profile;
}
async function loadCloudSocial() {
  const [fr,req,lb]=await Promise.all([supabase.rpc('get_my_friends'),supabase.rpc('get_friend_requests'),supabase.rpc('get_leaderboard')]);
  if(fr.error)throw fr.error;if(req.error)throw req.error;
  friends=(fr.data||[]).map(profileFields);requests=(req.data||[]).map(profileFields);leaderboard=(lb.data||[]).map(profileFields);
  requests.forEach((r,i)=>{r.request_id=(req.data||[])[i].request_id;r.sender_id=(req.data||[])[i].sender_id});
}
async function cloudRefresh() { await loadCloudProfile();showDashboard(currentView()); }
function currentView(){for(const n of ['profile','friends','badges'])if(!$('#'+n+'-view').classList.contains('sectionhide'))return n;return 'profile'}

async function handleAuth(e) {
  e.preventDefault();const button=$('#auth-submit');button.disabled=true;button.textContent='PLEASE WAIT...';showMessage('');
  const email=$('#email').value.trim().toLowerCase(),password=$('#password').value,username=$('#username').value.trim();
  try {
    if(password.length<8)throw new Error('Password must be at least 8 characters.');
    if(cloudReady) {
      if(authMode==='register') {
        if(!/^[A-Za-z0-9_]{3,16}$/.test(username))throw new Error('Username must be 3–16 characters using letters, numbers, or underscores.');
        const {data,error}=await supabase.auth.signUp({email,password,options:{data:{username}}});if(error)throw error;
        if(!data.session){showMessage('Check your email to confirm the account, then log in.',true);return;}
        session=data.session;await loadCloudProfile();showDashboard('profile');toast('Account made. Fresh Diver badge unlocked!',true);
      } else {
        const {data,error}=await supabase.auth.signInWithPassword({email,password});if(error)throw error;session=data.session;await loadCloudProfile();showDashboard('profile');toast(`Welcome back, ${profile.username}!`,true);
      }
    } else {
      await demoAuth(email,password,username);loadDemoDashboard();toast(authMode==='register'?'Demo account made! Fresh Diver badge unlocked.':'Welcome back to your local demo account.',true);
    }
    $('#password').value='';
  } catch(err){showMessage(err.message||'Could not sign in. Please try again.');}
  finally{button.disabled=false;button.textContent=authMode==='login'?'LOG IN ↗':'CREATE ACCOUNT ↗';}
}
async function signOut() {
  try { if(cloudReady)await supabase.auth.signOut(); else localStorage.removeItem(DEMO_SESSION); }catch{}
  session=null;profile=null;friends=[];requests=[];leaderboard=[];showAuth();toast('Logged out.');
}
async function searchFriends(term) {
  const wrap=$('#search-results');wrap.replaceChildren();
  if(!term.trim()){wrap.textContent='Type a username to search.';return}
  if(cloudReady) {
    const {data,error}=await supabase.rpc('search_profiles',{p_term:term.trim()});if(error)throw error;
    const results=(data||[]).filter(p=>p.id!==profile.id&&!friends.some(f=>f.id===p.id));
    renderSearchResults(results,wrap);
  } else {
    const db=readDemo();const results=Object.values(db.users).map(profileFields).filter(p=>p.id!==profile.id&&!friends.some(f=>f.id===p.id)&&p.username.toLowerCase().includes(term.toLowerCase())).slice(0,20);
    renderSearchResults(results,wrap);
  }
}
function renderSearchResults(results,wrap) {
  if(!results.length){const e=document.createElement('div');e.className='empty';e.textContent='No matching divers found. Check the spelling or invite a friend to make an account.';wrap.appendChild(e);return}
  results.forEach(p=>addFriendCard(wrap,p,[actionButton('ADD FRIEND',async()=>{try{if(cloudReady) {const {error}=await supabase.rpc('send_friend_request',{p_target:p.id});if(error)throw error;}else demoSendRequest(p.id);toast(`Friend request sent to ${p.username}.`,true);await refreshSocialAndRender();}catch(e){toast(e.message||'Could not send request.')}})]));
}
async function refreshSocialAndRender() {
  if(cloudReady){await loadCloudProfile();}else{const db=readDemo();const u=demoCurrent(db);if(!u)return;demoEvaluate(u,db);demoSaveUser(u,db);profile=profileFields(u);friends=demoFriends(db);requests=demoRequests(db);leaderboard=Object.values(db.users).map(profileFields).filter(p=>p.id!==u.id)}
  showDashboard(currentView());
}
async function acceptRequest(id) {
  try {if(cloudReady){const {error}=await supabase.rpc('accept_friend_request',{p_request_id:id});if(error)throw error;}else demoAccept(id);await refreshSocialAndRender();toast('Friend added! Check your Pennys for badge rewards.',true);}catch(e){toast(e.message||'Could not accept friend request.')}
}
async function rejectRequest(id) {
  try {if(cloudReady){const {error}=await supabase.rpc('reject_friend_request',{p_request_id:id});if(error)throw error;}else{const db=readDemo();db.requests=db.requests.filter(r=>r.id!==id);writeDemo(db);}await refreshSocialAndRender();}catch(e){toast(e.message||'Could not dismiss request.')}
}
async function removeFriend(id) {
  if(!confirm('Remove this diver from your friends?'))return;
  try {if(cloudReady){const {error}=await supabase.rpc('remove_friend',{p_friend_id:id});if(error)throw error;}else demoRemoveFriend(id);await refreshSocialAndRender();toast('Friend removed.');}catch(e){toast(e.message||'Could not remove friend.')}
}
async function saveAvatar() {
  const next={skin:$('#skin').value,shirt:$('#shirt').value,hat:$('#hat').value};const note=$('#avatar-message');note.textContent='SAVING LOOK...';
  try {
    if(cloudReady){const {error}=await supabase.rpc('save_avatar',{p_skin:next.skin,p_shirt:next.shirt,p_hat:next.hat});if(error)throw error;await loadCloudProfile();}
    else {const db=readDemo(),u=demoCurrent(db);if(!u)throw new Error('Please log in again.');u.avatar_skin=next.skin;u.avatar_shirt=next.shirt;u.avatar_hat=next.hat;demoEvaluate(u,db);demoSaveUser(u,db);profile=profileFields(u);friends=demoFriends(db);requests=demoRequests(db);leaderboard=Object.values(db.users).map(profileFields).filter(p=>p.id!==u.id);}
    showDashboard('profile');note.textContent='LOOK SAVED. Your crew can see your avatar now.';note.classList.add('good');toast('Avatar saved!',true);
  } catch(e){note.textContent=e.message||'Could not save avatar.';note.classList.remove('good')}
}
function updatePennyClock() {
  if(!profile)return;const last=typeof profile.last_penny_at==='number'?profile.last_penny_at:new Date(profile.last_penny_at||Date.now()).getTime();const remaining=Math.max(0,PENNY_MS-(Date.now()-last)%PENNY_MS);const m=Math.floor(remaining/60000).toString().padStart(2,'0');const s=Math.floor(remaining%60000/1000).toString().padStart(2,'0');$('#penny-clock').textContent=`${m}:${s}`;
}
async function tickPennySync() {
  updatePennyClock();if(!profile||Date.now()-lastPennySync<30000)return;lastPennySync=Date.now();
  try {
    if(cloudReady){const old=profile.pennies;await supabase.rpc('claim_pennies');const {data}=await supabase.from('profiles').select('*').eq('id',profile.id).single();if(data){profile=profileFields(data);if(profile.pennies>old)toast(`+${profile.pennies-old} free Penny${profile.pennies-old===1?'':'s'} collected!`,true);renderTopStats();}}
    else maybeEarnDemoPennies();
  }catch{}
}
function navigate(view){showDashboard(view);}

$('#login-tab').addEventListener('click',()=>setAuthMode('login'));
$('#register-tab').addEventListener('click',()=>setAuthMode('register'));
$('#auth-form').addEventListener('submit',handleAuth);
$('#logout').addEventListener('click',signOut);
$('#save-avatar').addEventListener('click',saveAvatar);
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.view)));
$('#search-form').addEventListener('submit',async e=>{e.preventDefault();try{await searchFriends($('#friend-search').value)}catch(err){toast(err.message||'Search failed.')}});

const gameDownloadUrl = String(config.gameDownloadUrl || '');
if (gameDownloadUrl.startsWith('https://github.com/') && !gameDownloadUrl.includes('YOUR-USERNAME') && !gameDownloadUrl.includes('YOUR-REPOSITORY')) {
  $('#get-game').href = gameDownloadUrl;
  $('#get-game').classList.remove('hidden');
}

if(!cloudReady){
  $('#mode-banner').innerHTML='<b>LOCAL PREVIEW MODE.</b> The account screens work in this browser, so you can test profiles, friends, avatars, badges and Penny rewards. Accounts are <b>not shared</b> with other people yet. To make everyone share real online accounts, follow the included Supabase setup guide and fill in <code>config.js</code>.';
  $('#mode-banner').classList.remove('hidden');
} else {
  $('#mode-banner').innerHTML='<b>ONLINE PROFILE MODE.</b> Profiles, Pennys, badges, and friend lists are saved to your connected cloud database.';
  $('#mode-banner').classList.remove('hidden');
}

(async function init(){
  setAuthMode('login');
  for(const select of [$('#skin'),$('#shirt'),$('#hat')])select.addEventListener('change',()=>{const av=$('#my-avatar');if(!av)return;av.style.setProperty('--skin',$('#skin').value);av.style.setProperty('--shirt',$('#shirt').value);const hat=av.querySelector('.hat');if(hat)hat.textContent=HAT_ICONS[$('#hat').value]||'';});
  if(cloudReady){
    const {data:{session:existing}}=await supabase.auth.getSession();
    if(existing){session=existing;try{await loadCloudProfile();showDashboard('profile')}catch(e){toast(e.message||'Could not load account.')}}
    supabase.auth.onAuthStateChange((_event,next)=>{session=next;});
  } else {
    if(demoCurrent()){loadDemoDashboard();maybeEarnDemoPennies()}
  }
  setInterval(tickPennySync,1000);
})();
