const crypto = require('crypto');
const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const MIN = +process.env.MIN_PLAYERS || 10;
const POOL = (process.env.MAP_POOL || 'Abyss,Ascent,Haven,Lotus,Split,Summit,Sunset').split(',').map(x => x.trim()).filter(Boolean);
const VETO_MS = (+process.env.VETO_SECONDS || 30) * 1000, SIDE_MS = (+process.env.SIDE_SECONDS || 30) * 1000;
const READY_MS = (+process.env.READY_SECONDS || 90) * 1000, PLAY_MS = (+process.env.PLAY_MINUTES || 25) * 60000;
const BOOT = (process.env.MOD_BOOTSTRAP || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
const RULES = 'keep the cheats off and no pauses only timeouts';
const r = async c => (await (await fetch(U, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: JSON.stringify(c) })).json()).result;
const load = async () => { const v = await r(['GET', 'ladder']); const s = v ? JSON.parse(v) : { players: {}, queue: [], matches: [] }; s.checks = s.checks || []; return s; };
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const rnd = () => crypto.randomBytes(16).toString('hex');
const open = m => !['done', 'void'].includes(m.status);
const busy = (s, id) => s.matches.some(m => open(m) && [...m.A, ...m.B].includes(id)) || s.checks.some(c => c.players.includes(id));
const makeCheck = s => {
  const ids = s.queue.splice(0, MIN);
  s.checks.push({ id: rnd().slice(0, 8), players: ids, ready: ids.filter(k => s.players[k].bot), deadline: Date.now() + READY_MS });
};
const startMatch = (s, c) => {
  const ids = c.players.slice().sort((a, d) => s.players[d].elo - s.players[a].elo), A = [], B = [], now = Date.now();
  ids.forEach((id, i) => (i % 4 == 0 || i % 4 == 3 ? A : B).push(id));
  s.matches.push({ id: now.toString(36), A, B, status: 'live', code: '', chat: [], startedAt: now, phase: 'veto', map: '',
    veto: { pool: (s.pool && s.pool.length > 1 ? s.pool : POOL).slice(), bans: [], turn: 'A', deadline: now + VETO_MS }, playUntil: 0 });
  s.checks = s.checks.filter(x => x !== c);
};
const openMaps = m => m.veto.pool.filter(x => !m.veto.bans.some(b => b.map === x));
const banMap = (m, team, map, at) => {
  m.veto.bans.push({ team, map });
  const left = openMaps(m);
  if (left.length === 1) { m.map = left[0]; m.phase = 'side'; m.veto.turn = 'B'; m.veto.deadline = at + SIDE_MS; }
  else { m.veto.turn = team === 'A' ? 'B' : 'A'; m.veto.deadline = at + VETO_MS; }
};
const setSide = (m, side, at) => { m.sideB = side; m.phase = 'play'; m.playUntil = at + PLAY_MS; };
const tick = s => {
  let ch = false;
  for (const m of s.matches) if (open(m) && ['veto', 'side'].includes(m.phase)) {
    while (m.phase === 'veto' && Date.now() > m.veto.deadline) { const l = openMaps(m); banMap(m, m.veto.turn, l[Math.random() * l.length | 0], m.veto.deadline); ch = true; }
    if (m.phase === 'side' && Date.now() > m.veto.deadline) { setSide(m, Math.random() < .5 ? 'attack' : 'defense', m.veto.deadline); ch = true; }
  }
  for (const c of s.checks.slice()) if (Date.now() > c.deadline) { s.queue = [...c.ready, ...s.queue]; s.checks = s.checks.filter(x => x !== c); ch = true; }
  while (s.queue.length >= MIN) { makeCheck(s); ch = true; }
  return ch;
};
const finish = (s, m) => {
  const win = m.winner === 'A' ? m.A : m.B, lose = m.winner === 'A' ? m.B : m.A;
  win.forEach(i => s.players[i].elo += 24);
  lose.forEach(i => s.players[i].elo = Math.max(0, s.players[i].elo - 24));
  m.status = 'done';
};

module.exports = async (req, res) => {
  const s = await load(), changed = tick(s);
  if (req.method === 'GET') {
    if (changed) await r(['SET', 'ladder', JSON.stringify(s)]);
    const q = req.query;
    if (q.shot || q.proof) {
      const u = s.players[q.me];
      if (!u || u.role !== 'mod' || u.token !== q.token) return res.status(403).json({});
      if (q.proof) return res.json({ shot: (s.players[q.proof] || {}).proof });
      const m = s.matches.find(x => x.id === q.shot); return res.json({ shot: m && m.shot });
    }
    const usr = s.players[q.me], who = usr && usr.token === q.token ? q.me : null, isM = who && usr.role === 'mod';
    const view = m => {
      const { shot, tchat, veto, chat, ...x } = m, votes = (veto && veto.votes) || {}, o = { ...x, hasShot: !!shot };
      const team = who && m.A.includes(who) ? 'A' : who && m.B.includes(who) ? 'B' : null;
      if (veto) o.veto = { ...veto, votes: undefined };
      if (team || isM) o.chat = chat || [];
      if (team) {
        const mem = team === 'A' ? m.A : m.B, tally = {};
        Object.entries(votes).forEach(([k, v]) => { if (mem.includes(k)) tally[v] = (tally[v] || 0) + 1; });
        o.tally = tally; o.myVote = votes[who]; o.tchat = (tchat || {})[team] || [];
      }
      return o;
    };
    const pl = {}; for (const k in s.players) { const p = s.players[k]; pl[k] = { name: p.name, elo: p.elo, status: p.status, role: p.role || 'player', bot: !!p.bot }; }
    return res.json({ players: pl, queue: s.queue, min: MIN, checks: s.checks, now: Date.now(), readyMs: READY_MS, playMs: PLAY_MS, vetoMs: VETO_MS, sideMs: SIDE_MS, pool: s.pool && s.pool.length > 1 ? s.pool : POOL, matches: s.matches.filter(open).map(view) });
  }
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const me = b.me, p = s.players[me], authed = p && p.token && p.token === b.token;
  const m = s.matches.find(x => x.id === b.matchId);
  const loserLead = m && (m.winner === 'A' ? m.B[0] : m.A[0]);
  const isMod = authed && p.role === 'mod';
  const MODS = ['review', 'resolve', 'setrole', 'ban', 'voidmatch', 'delmsg', 'fillqueue', 'clearbots', 'skiptimer', 'setpool'];
  let err, extra = {};
  if (['join', 'leave', 'submit', 'confirm', 'dispute', 'say', 'announce', 'ready', 'mapban', 'pickside', 'vote', 'tsay', ...MODS].includes(b.type) && !authed) err = 'Please sign in again.';
  else if (MODS.includes(b.type) && !isMod) err = 'Moderators only.';
  else switch (b.type) {
    case 'register': {
      const id = (b.name || '').toLowerCase();
      if (!/^.{3,24}#.{2,8}$/.test(b.name || '')) err = 'Use the format Name#TAG.';
      else if ((b.password || '').length < 6) err = 'Password needs at least 6 characters.';
      else if (!b.proof && !BOOT.includes(id)) err = 'Upload a screenshot of your Valorant profile for verification.';
      else if (s.players[id]) err = 'That Riot ID is already registered.';
      else { const salt = rnd(); s.players[id] = { name: b.name, elo: 1000, salt, hash: hash(b.password, salt), token: rnd(), status: BOOT.includes(id) ? 'approved' : 'pending', role: BOOT.includes(id) ? 'mod' : 'player', proof: b.proof || '' }; extra.token = s.players[id].token; }
      break;
    }
    case 'login': {
      const q = s.players[(b.name || '').toLowerCase()];
      if (!q || hash(b.password || '', q.salt) !== q.hash) err = 'Wrong Riot ID or password.';
      else { if (BOOT.includes((b.name || '').toLowerCase())) { q.role = 'mod'; q.status = 'approved'; } extra.token = q.token; }
      break;
    }
    case 'review': {
      const q = s.players[b.target];
      if (q && q.status === 'pending') { q.status = b.approve ? 'approved' : 'rejected'; q.proof = ''; }
      break;
    }
    case 'join':
      if (p.status !== 'approved') { err = 'Your account is not verified yet.'; break; }
      if (!s.queue.includes(me) && !busy(s, me)) {
        s.queue.push(me);
        while (s.queue.length >= MIN) makeCheck(s);
      }
      break;
    case 'ready': {
      const c = s.checks.find(x => x.id === b.checkId);
      if (!c || !c.players.includes(me)) err = 'This ready check is over.';
      else { if (!c.ready.includes(me)) c.ready.push(me); if (c.ready.length === c.players.length) startMatch(s, c); }
      break;
    }
    case 'mapban': {
      const t = m && m.phase === 'veto' && m.veto.turn;
      if (!t || me !== m[t][0]) err = 'It is not your turn to ban.';
      else if (!openMaps(m).includes(b.map)) err = 'That map is not available.';
      else banMap(m, t, b.map, Date.now());
      break;
    }
    case 'pickside':
      if (!m || m.phase !== 'side' || me !== m.B[0]) err = 'Only the Team B leader can choose the side.';
      else if (!['attack', 'defense'].includes(b.side)) err = 'Choose attack or defense.';
      else setSide(m, b.side, Date.now());
      break;
    case 'setpool': {
      const mp = [...new Set((b.maps || []).map(x => String(x).trim().slice(0, 24)).filter(Boolean))];
      if (mp.length < 2 || mp.length > 15) err = 'Enter between 2 and 15 maps.'; else s.pool = mp;
      break;
    }
    case 'vote':
      if (m && m.phase === 'veto' && [...m.A, ...m.B].includes(me) && openMaps(m).includes(b.map)) { m.veto.votes = m.veto.votes || {}; m.veto.votes[me] = b.map; }
      else err = 'Voting is closed.';
      break;
    case 'tsay': {
      const tm = m && open(m) && (m.A.includes(me) ? 'A' : m.B.includes(me) ? 'B' : '');
      if (!tm) { err = 'You are not in this match.'; break; }
      m.tchat = m.tchat || { A: [], B: [] };
      m.tchat[tm].push({ i: rnd().slice(0, 8), from: p.name, t: String(b.text || '').slice(0, 200) }); m.tchat[tm] = m.tchat[tm].slice(-100);
      break;
    }
    case 'skiptimer': if (m && open(m) && (!m.phase || m.phase === 'play')) m.playUntil = Date.now(); else err = 'Match is not open, or the map is still being chosen.'; break;
    case 'leave': s.queue = s.queue.filter(x => x !== me); break;
    case 'say':
      if (!m || !open(m) || ![...m.A, ...m.B].includes(me)) { err = 'You are not in this match.'; break; }
      m.chat.push({ i: rnd().slice(0, 8), from: p.name, t: String(b.text || '').slice(0, 200) }); m.chat = m.chat.slice(-100);
      break;
    case 'announce':
      if (!m || m.status !== 'live' || me !== m.A[0]) { err = 'Only the Team A leader can announce the party code.'; break; }
      if (m.phase && m.phase !== 'play') { err = 'Announce the party code after the map and side are chosen.'; break; }
      if (!/^[A-Za-z0-9-]{3,12}$/.test(b.code || '')) { err = 'Enter the party code exactly as shown in Valorant.'; break; }
      m.code = b.code; m.chat.push({ i: rnd().slice(0, 8), sys: true, t: 'Party code: ' + b.code + ' - ' + RULES });
      break;
    case 'submit':
      if (!m || m.status !== 'live' || (me !== m.A[0] && me !== m.B[0])) { err = 'Only a team leader can report.'; break; }
      if ((m.phase && m.phase !== 'play') || Date.now() < (m.playUntil || 0)) { err = 'The match is not over yet. Results open when the timer ends.'; break; }
      if (!(b.scoreW >= 13 && b.scoreW > b.scoreL && b.scoreL >= 0)) { err = 'Winner needs 13+ rounds and more than the other team.'; break; }
      if (!b.shot) { err = 'Upload the scoreboard screenshot.'; break; }
      Object.assign(m, { winner: me === m.A[0] ? 'A' : 'B', scoreW: b.scoreW, scoreL: b.scoreL, shot: b.shot, status: 'submitted' });
      break;
    case 'confirm':
      if (m && m.status === 'submitted' && me === loserLead) finish(s, m); else err = 'Only the losing leader can confirm.';
      break;
    case 'dispute':
      if (m && m.status === 'submitted' && me === loserLead) m.status = 'disputed'; else err = 'Only the losing leader can dispute.';
      break;
    case 'resolve':
      if (m && ['submitted', 'disputed'].includes(m.status)) { if (b.uphold) finish(s, m); else m.status = 'void'; }
      break;
    case 'setrole': {
      const q = s.players[b.target];
      if (!q || b.target === me || !['mod', 'player'].includes(b.role)) err = 'Cannot change that account.';
      else { q.role = b.role; if (b.role === 'mod') q.status = 'approved'; }
      break;
    }
    case 'ban': {
      const q = s.players[b.target];
      if (!q || q.role === 'mod') err = 'Remove moderator status before banning.';
      else if (b.ban) { q.was = q.status; q.status = 'banned'; s.queue = s.queue.filter(x => x !== b.target); }
      else q.status = q.was && q.was !== 'banned' ? q.was : 'approved';
      break;
    }
    case 'voidmatch': if (m && open(m)) m.status = 'void'; else err = 'Match is not open.'; break;
    case 'delmsg': if (m) m.chat = m.chat.filter(x => x.i !== b.msgId); break;
    case 'fillqueue': {
      if (!s.queue.includes(me)) { err = 'Join the queue yourself first, then fill it.'; break; }
      let i = 1;
      while (s.queue.length < MIN) {
        const k = 'bot' + i + '#test', n = 'Bot' + i + '#TEST'; i++;
        if (s.queue.includes(k) || busy(s, k)) continue;
        s.players[k] = s.players[k] || { name: n, elo: 1000, salt: rnd(), hash: rnd(), token: rnd(), status: 'approved', role: 'player', bot: true };
        s.queue.push(k);
      }
      while (s.queue.length >= MIN) makeCheck(s);
      break;
    }
    case 'clearbots':
      Object.keys(s.players).filter(k => s.players[k].bot && !busy(s, k)).forEach(k => delete s.players[k]);
      s.queue = s.queue.filter(k => s.players[k]);
      break;
    default: err = 'Unknown action.';
  }
  if (!err || changed) await r(['SET', 'ladder', JSON.stringify(s)]);
  res.json({ ok: !err, err, ...extra });
};
