const U = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const T = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const BASE = process.env.TRACKER_BASE || 'https://api.tracker.gg/api/v2/valorant/standard';
const TYPE = process.env.TRACKER_MATCH_TYPE || '';
const MIN_OVERLAP = +process.env.TRACKER_MIN_PLAYERS || 8;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const RANKS = ['Radiant', 'Immortal', 'Ascendant', 'Diamond', 'Platinum', 'Gold', 'Silver', 'Bronze', 'Iron'];
const r = async c => (await (await fetch(U, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: JSON.stringify(c) })).json()).result;
const get = async k => { const v = await r(['GET', k]); return v ? JSON.parse(v) : null; };
const g = (o, ...p) => p.reduce((x, k) => (x == null ? x : x[k]), o);
const enc = id => { const [n, t] = String(id).split('#'); return encodeURIComponent(n) + '%23' + encodeURIComponent(t || ''); };
async function tget(path) {
  const headers = { 'User-Agent': UA, Accept: 'application/json', Origin: 'https://tracker.gg', Referer: 'https://tracker.gg/' };
  if (process.env.TRACKER_API_KEY) headers['TRN-Api-Key'] = process.env.TRACKER_API_KEY;
  try { const res = await fetch(BASE + path, { headers }), text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) {} return { status: res.status, json, text }; }
  catch (e) { return { status: 0, json: null, text: String(e.message) }; }
}
const why = x => x.status === 0 ? 'Could not reach tracker.gg.' : x.status === 403 || x.status === 429 ? 'tracker.gg blocked or rate limited the request (' + x.status + ').' : x.status === 404 ? 'Profile not found, or it is private.' : x.status >= 400 ? 'tracker.gg returned an error (' + x.status + ').' : x.json ? '' : 'tracker.gg did not return data.';
const rankOf = j => { for (const s of g(j, 'data', 'segments') || []) { const n = g(s, 'stats', 'rank', 'metadata', 'tierName'); if (n) return n; } return ''; };
const baseRank = n => /unrank|unrated/i.test(n) ? 'Unranked' : (RANKS.find(x => new RegExp('^' + x, 'i').test(String(n).trim())) || '');
const detail = j => {
  const d = (j && j.data) || {}, players = [], teams = {};
  for (const s of d.segments || []) {
    const m = s.metadata || {}, st = s.stats || {};
    if (s.type === 'player-summary') { const id = g(m, 'platformInfo', 'platformUserIdentifier') || m.name; if (id) players.push({ id: String(id).toLowerCase(), team: m.teamId, k: g(st, 'kills', 'value'), d: g(st, 'deaths', 'value'), a: g(st, 'assists', 'value'), ag: m.agentName || '' }); }
    else if (s.type === 'team-summary') teams[m.name || m.teamId] = { rounds: g(st, 'roundsWon', 'value') };
  }
  return { players, teams };
};
const evalMatch = (d, m, L) => {
  const ours = new Map(); [...m.A, ...m.B].forEach(k => ours.set(L.players[k].name.toLowerCase(), k));
  const found = d.players.filter(p => ours.has(p.id)); if (found.length < MIN_OVERLAP) return null;
  const votes = {}; found.forEach(p => { const v = votes[p.team] = votes[p.team] || { A: 0, B: 0 }; v[m.A.includes(ours.get(p.id)) ? 'A' : 'B']++; });
  const tt = Object.keys(votes); if (tt.length !== 2) return null;
  const aT = votes[tt[0]].A - votes[tt[0]].B >= votes[tt[1]].A - votes[tt[1]].B ? tt[0] : tt[1], bT = aT === tt[0] ? tt[1] : tt[0];
  const ra = g(d.teams, aT, 'rounds'), rb = g(d.teams, bT, 'rounds');
  if (!Number.isFinite(ra) || !Number.isFinite(rb) || ra === rb || Math.max(ra, rb) < 13) return null;
  const tdata = {}; found.forEach(p => { tdata[ours.get(p.id)] = { k: p.k, d: p.d, a: p.a, ag: p.ag }; });
  return { winner: ra > rb ? 'A' : 'B', scoreW: Math.max(ra, rb), scoreL: Math.min(ra, rb), tdata };
};
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  let L = (await get('ladder')) || { players: {}, matches: [] }; const me = b.me, p = L.players[me];
  if (!p || !p.token || p.token !== b.token) return res.json({ ok: false, err: 'Please sign in again.' });
  const mod = p.role === 'mod';
  if (['probe', 'rank'].includes(b.type)) {
    if (!mod) return res.json({ ok: false, err: 'Moderators only.' });
    if (!/^.{3,24}#.{2,8}$/.test(b.riotId || '')) return res.json({ ok: false, err: 'Use the format Name#TAG.' });
    if (b.type === 'probe') {
      const x = await tget((b.kind === 'matches' ? '/matches/riot/' : '/profile/riot/') + enc(b.riotId) + (b.kind === 'matches' && TYPE ? '?type=' + TYPE : ''));
      return res.json({ ok: true, status: x.status, raw: (x.json ? JSON.stringify(x.json, null, 1) : x.text).slice(0, 15000) });
    }
    const x = await tget('/profile/riot/' + enc(b.riotId)), e = why(x); if (e) return res.json({ ok: false, err: e });
    const tier = rankOf(x.json); return res.json({ ok: true, tier, rank: baseRank(tier) });
  }
  if (b.type !== 'detect') return res.json({ ok: false, err: 'Unknown action.' });
  const find = () => L.matches.find(x => x.id === b.matchId && x.status === 'live' && x.phase === 'play' && [...x.A, ...x.B].includes(me));
  let m = find(); if (!m) return res.json({ ok: true, found: false, msg: 'Nothing to check right now.' });
  if (Date.now() < (m.playUntil || 0)) return res.json({ ok: true, found: false, msg: 'The match timer is still running.' });
  if ((m.tTry || 0) >= 15) return res.json({ ok: true, found: false, msg: 'Automatic checking stopped. The winning leader can upload the scoreboard screenshot instead.' });
  if (Date.now() - (m.tLast || 0) < 80000) return res.json({ ok: true, found: false, msg: 'Checked a moment ago. Try again shortly.' });
  m.tLast = Date.now(); m.tTry = (m.tTry || 0) + 1; await r(['SET', 'ladder', JSON.stringify(L)]);
  const lead = L.players[m.A[0]].name, list = await tget('/matches/riot/' + enc(lead) + (TYPE ? '?type=' + TYPE : '')), e1 = why(list);
  if (e1) return res.json({ ok: true, found: false, msg: e1 });
  const cands = (g(list.json, 'data', 'matches') || []).map(x => ({ id: g(x, 'attributes', 'id') || x.id, ts: Date.parse(g(x, 'metadata', 'timestamp') || ''), map: String(g(x, 'metadata', 'mapName') || '') }))
    .filter(c => c.id && (isNaN(c.ts) || c.ts >= m.startedAt - 120000) && (!m.map || !c.map || c.map.toLowerCase() === m.map.toLowerCase())).slice(0, 3);
  for (const c of cands) {
    const dj = await tget('/matches/' + encodeURIComponent(c.id)); if (!dj.json) continue;
    const out = evalMatch(detail(dj.json), m, L); if (!out) continue;
    L = (await get('ladder')) || L; m = find();
    if (!m || L.matches.some(x => x.tmatch === c.id)) return res.json({ ok: true, found: false, msg: 'Already handled.' });
    Object.assign(m, { winner: out.winner, scoreW: out.scoreW, scoreL: out.scoreL, tdata: out.tdata, src: 'tracker', tmatch: c.id, status: 'submitted', autoAt: Date.now() + 180000 });
    m.chat.push({ i: Math.random().toString(16).slice(2, 10), sys: true, t: 'Result found on tracker.gg: Team ' + out.winner + ' won ' + out.scoreW + '-' + out.scoreL + '. It confirms automatically in 3 minutes unless the losing leader disputes it.' });
    await r(['SET', 'ladder', JSON.stringify(L)]);
    return res.json({ ok: true, found: true });
  }
  res.json({ ok: true, found: false, msg: 'No matching custom game found on tracker.gg yet.' });
};
