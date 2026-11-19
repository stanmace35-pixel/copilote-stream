// Enregistre les lives Twitch et TikTok (spectateurs, chat, likes, cadeaux) pendant qu'ils ont lieu.
// Tourne sur GitHub Actions à l'heure habituelle du stream, s'arrête seul quand tout est fini.
import { supa, supaReady } from "./supa.mjs";

const TW_LOGIN = (process.env.TWITCH_LOGIN || "tansonrp").toLowerCase();
const TT_USER = (process.env.TIKTOK_USERNAME || "").replace(/^@/, "");
const MAX_MIN = Number(process.env.MAX_MINUTES || 345);
const WAIT_MIN = Number(process.env.WAIT_MINUTES || 90);   // abandon si rien ne démarre
const T0 = Date.now();
const mins = () => (Date.now() - T0) / 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sessions = { twitch: null, tiktok: null };
const newSession = (platform, started_at, extra = {}) => ({
  platform, started_at, ended_at: null, title: null, game: null, peak_viewers: 0, avg_viewers: 0,
  messages: 0, likes: 0, gifts: 0, diamonds: 0, new_followers: 0, samples: [], _last: 0, _off: 0, ...extra,
});
const row = (s) => {
  const v = s.samples.map((x) => x.v);
  return {
    platform: s.platform, started_at: s.started_at, ended_at: s.ended_at, title: s.title, game: s.game,
    peak_viewers: v.length ? Math.max(...v) : 0,
    avg_viewers: v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0,
    messages: s.messages, likes: s.likes, gifts: s.gifts, diamonds: s.diamonds, new_followers: s.new_followers,
    samples: s.samples,
  };
};
// Reprend un live déjà commencé (job précédent) au lieu de l'écraser.
async function seed(s) {
  if (!supaReady()) return;
  try {
    const [r] = await supa(`streams?platform=eq.${s.platform}&started_at=eq.${encodeURIComponent(s.started_at)}&select=*`);
    if (r) Object.assign(s, { messages: r.messages || 0, likes: r.likes || 0, gifts: r.gifts || 0, diamonds: r.diamonds || 0,
      new_followers: r.new_followers || 0, samples: r.samples || [], ended_at: null });
  } catch {}
}
async function save() {
  const rows = Object.values(sessions).filter(Boolean).map(row);
  if (!rows.length || !supaReady()) return;
  try { await supa("streams?on_conflict=platform,started_at", { method: "POST", body: rows, prefer: "resolution=merge-duplicates,return=minimal" }); }
  catch (e) { console.error(e.message); }
}

// ---------- Twitch (API officielle + chat anonyme) ----------
let twToken = null;
async function twitchToken() {
  const id = process.env.TWITCH_CLIENT_ID, secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) return null;
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${id}&client_secret=${secret}&grant_type=client_credentials`, { method: "POST" });
  return (await r.json()).access_token || null;
}
async function pollTwitch() {
  if (!twToken) twToken = await twitchToken();
  if (!twToken) return;
  const r = await fetch(`https://api.twitch.tv/helix/streams?user_login=${TW_LOGIN}`, {
    headers: { "Client-Id": process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${twToken}` },
  });
  if (r.status === 401) { twToken = null; return; }
  const live = (await r.json()).data?.[0];
  let s = sessions.twitch;
  if (live) {
    if (!s || s.ended_at) { s = sessions.twitch = newSession("twitch", live.started_at); await seed(s); startTwitchChat(); }
    s.title = live.title; s.game = live.game_name; s._off = 0;
    s.samples.push({ t: new Date().toISOString().slice(11, 16), v: live.viewer_count });
  } else if (s && !s.ended_at && ++s._off >= 3) {
    s.ended_at = new Date().toISOString();
  }
}
let chat = null;
function startTwitchChat() {
  if (chat || typeof WebSocket === "undefined") return;
  chat = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  chat.onopen = () => { chat.send("NICK justinfan" + Math.floor(Math.random() * 90000 + 10000)); chat.send(`JOIN #${TW_LOGIN}`); };
  chat.onmessage = (e) => {
    const t = String(e.data);
    if (t.startsWith("PING")) chat.send("PONG :tmi.twitch.tv");
    const n = (t.match(/ PRIVMSG /g) || []).length;
    if (n && sessions.twitch && !sessions.twitch.ended_at) sessions.twitch.messages += n;
  };
  chat.onclose = () => { chat = null; };
}

// ---------- TikTok (connecteur open source, non officiel) ----------
let tt = null, ttViewers = 0, ttBusy = false;
async function pollTikTok() {
  if (!TT_USER) return;
  const s = sessions.tiktok;
  if (tt && s && !s.ended_at) {
    // Si l'événement « spectateurs » n'arrive pas, on relit le compteur de la salle.
    if (!ttViewers) {
      try { const info = await tt.fetchRoomInfo(); ttViewers = Number(info?.user_count ?? info?.data?.user_count ?? info?.stats?.total_user ?? 0) || 0; } catch {}
    }
    s.samples.push({ t: new Date().toISOString().slice(11, 16), v: ttViewers }); return;
  }
  if (ttBusy) return;
  ttBusy = true;
  try {
    const { TikTokLiveConnection, WebcastEvent } = await import("tiktok-live-connector");
    const c = new TikTokLiveConnection(TT_USER, process.env.EULER_API_KEY ? { signApiKey: process.env.EULER_API_KEY } : {});
    await c.connect();
    tt = c;
    const started = c.roomInfo?.create_time ? new Date(c.roomInfo.create_time * 1000).toISOString() : new Date().toISOString();
    const cur = sessions.tiktok = newSession("tiktok", started, { title: c.roomInfo?.title || null });
    await seed(cur);
    c.on(WebcastEvent.ROOM_USER, (d) => { ttViewers = d.viewerCount || ttViewers; });
    c.on(WebcastEvent.CHAT, () => { cur.messages++; });
    c.on(WebcastEvent.LIKE, (d) => { if (d.totalLikeCount) cur.likes = d.totalLikeCount; });
    c.on(WebcastEvent.FOLLOW, () => { cur.new_followers++; });
    c.on(WebcastEvent.GIFT, (d) => {
      if (d.giftDetails?.giftType === 1 && !d.repeatEnd) return;
      cur.gifts += 1; cur.diamonds += (d.giftDetails?.diamondCount || 0) * (d.repeatCount || 1);
    });
    const end = () => { if (!cur.ended_at) cur.ended_at = new Date().toISOString(); tt = null; };
    c.on(WebcastEvent.STREAM_END, end);
    c.on(WebcastEvent.DISCONNECTED, end);
    console.log("TikTok : connecté au live.");
  } catch (e) {
    if (!/offline|not live|UserOffline/i.test(String(e?.name) + String(e?.message))) console.error("TikTok :", e?.message || e);
  } finally { ttBusy = false; }
}

// ---------- boucle ----------
async function main() {
  if (!supaReady()) console.log("Supabase non configuré : affichage console seulement.");
  let tick = 0, lastActivity = null;
  while (mins() < MAX_MIN) {
    await Promise.allSettled([pollTwitch(), tick % 2 === 0 ? pollTikTok() : Promise.resolve()]);
    const live = Object.values(sessions).some((s) => s && !s.ended_at);
    if (live) lastActivity = Date.now();
    if (++tick % 5 === 0) await save();
    if (!lastActivity && mins() > WAIT_MIN) { console.log("Pas de live ce soir."); break; }
    if (lastActivity && !live && Date.now() - lastActivity > 15 * 60000) { console.log("Lives terminés."); break; }
    await sleep(60000);
  }
  await save();
  try { tt?.disconnect(); chat?.close(); } catch {}
  for (const s of Object.values(sessions).filter(Boolean)) {
    const r = row(s); console.log(`${r.platform} : pic ${r.peak_viewers}, moyenne ${r.avg_viewers}, ${r.messages} messages, ${r.diamonds} diamants.`);
  }
  process.exit(0);
}
main();
