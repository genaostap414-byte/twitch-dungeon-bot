require("dotenv").config();
const tmi    = require("tmi.js");
const axios  = require("axios");
const http   = require("http");
const Database = require("better-sqlite3");

// ─── Конфигурация ─────────────────────────────────────────────────────────────
const CHANNEL        = process.env.TWITCH_CHANNEL;
const BOT_USERNAME   = process.env.TWITCH_BOT_USERNAME;
const BOT_TOKEN      = process.env.TWITCH_BOT_TOKEN;
const CLIENT_ID      = process.env.TWITCH_CLIENT_ID;
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID;
const MODERATOR_ID   = process.env.TWITCH_MODERATOR_ID;
const API_TOKEN      = process.env.TWITCH_API_TOKEN;
const SE_JWT         = process.env.SE_JWT_TOKEN;       // JWT токен StreamElements
const SE_CHANNEL_ID  = process.env.SE_CHANNEL_ID;      // ID канала в StreamElements
const DUNGEON_COST   = 50;                              // стоимость входа в данж (очки SE)

// ─── База данных SQLite ───────────────────────────────────────────────────────
const db = new Database("./dungeon.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    username    TEXT PRIMARY KEY,
    user_id     TEXT,
    runs        INTEGER DEFAULT 0,
    wins        INTEGER DEFAULT 0,
    deaths      INTEGER DEFAULT 0,
    bans        INTEGER DEFAULT 0,
    total_loot  INTEGER DEFAULT 0,
    best_loot   TEXT DEFAULT '',
    last_run_stream TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS inventory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT,
    item        TEXT,
    rarity      TEXT,
    obtained_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stream_sessions (
    stream_id   TEXT PRIMARY KEY,
    started_at  TEXT DEFAULT (datetime('now'))
  );
`);

// ─── Текущая сессия стрима ────────────────────────────────────────────────────
// Простая схема: ID сессии = дата запуска бота (сбрасывается при перезапуске)
const CURRENT_STREAM_ID = new Date().toISOString().slice(0, 10) + "_" + Date.now();

// ─── Лут-таблица ─────────────────────────────────────────────────────────────
// rarity: common=обычный, rare=редкий, epic=эпический, legendary=легендарный
// points: очки SE за получение предмета
const LOOT_TABLE = [
  // common (55%)
  { item: "ржавая ложка",        rarity: "common",    weight: 20, points: 30,   emoji: "🥄" },
  { item: "дырявый щит",         rarity: "common",    weight: 15, points: 25,   emoji: "🛡️" },
  { item: "банка энергетика",    rarity: "common",    weight: 12, points: 20,   emoji: "🥤" },
  { item: "сломанный меч",       rarity: "common",    weight: 8,  points: 35,   emoji: "🗡️" },
  // rare (30%)
  { item: "меч +1 к понтам",     rarity: "rare",      weight: 12, points: 100,  emoji: "⚔️" },
  { item: "щит от кринжа",       rarity: "rare",      weight: 10, points: 120,  emoji: "🔰" },
  { item: "зелье удачи",         rarity: "rare",      weight: 8,  points: 90,   emoji: "🧪" },
  // epic (12%)
  { item: "питомец-гоблин",      rarity: "epic",      weight: 5,  points: 300,  emoji: "👺" },
  { item: "плащ невидимости",    rarity: "epic",      weight: 4,  points: 350,  emoji: "🧥" },
  { item: "легендарный тапок",   rarity: "epic",      weight: 3,  points: 400,  emoji: "👟" },
  // legendary (3%)
  { item: "корона данжа",        rarity: "legendary", weight: 2,  points: 1000, emoji: "👑" },
  { item: "меч судьбы",          rarity: "legendary", weight: 1,  points: 1500, emoji: "🔥" },
];

const LOOT_TOTAL_WEIGHT = LOOT_TABLE.reduce((s, l) => s + l.weight, 0);

// боссы у которых шанс смерти и бана
const DEATH_BOSSES = [
  { name: "Древний Дракон",    deathChance: 0.30, isBanBoss: true,  emoji: "🐲" },
  { name: "Тёмный Властелин",  deathChance: 0.25, isBanBoss: true,  emoji: "💀" },
  { name: "Скелет-Модератор",  deathChance: 0.20, isBanBoss: false, emoji: "💀" },
  { name: "Гоблин с кредитом", deathChance: 0.10, isBanBoss: false, emoji: "👺" },
  { name: "Лаг Сервера",       deathChance: 0.15, isBanBoss: false, emoji: "⚡" },
  { name: "Мимик-Сундук",      deathChance: 0.12, isBanBoss: false, emoji: "📦" },
  { name: "Слишком Умный Слизень", deathChance: 0.08, isBanBoss: false, emoji: "🐌" },
  { name: "Босс с 3 фазами",   deathChance: 0.35, isBanBoss: true,  emoji: "👹" },
];

const CLASSES   = ["Танк 🛡️", "Маг 🔮", "Лучник 🏹", "Ассасин 🗡️", "Хиллер 💚", "Берсерк 💀"];
const LOCATIONS = [
  "Проклятые катакомбы 🕳️",
  "Ледяная крепость ❄️",
  "Заброшенный храм 🏛️",
  "Пещера токсичных пауков 🕷️",
  "Башня безумного мага 🗼",
  "Подвал стримера 📺",
  "Могила забытых патчей ⚰️",
  "Логово читеров 💻",
];

const WIN_PHRASES = [
  "победа без шансов 🔥",
  "еле выжил, но забрал лут 😅",
  "спас всю пати, легенда чата 👑",
  "крит в последний момент ⚔️",
  "прошёл данж в соло без урона 😎",
];

const DEATH_PHRASES = [
  "получил крит и улетел в таверну 💀",
  "застрял в текстурах, классика 🤦",
  "продал пати за редкий дроп 😈",
  "умер от падения с первой ступеньки 🪦",
  "убит кат-сценой 📽️",
];

// ─── Вспомогательные функции ─────────────────────────────────────────────────
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function rollLoot() {
  let roll = Math.random() * LOOT_TOTAL_WEIGHT;
  for (const loot of LOOT_TABLE) {
    roll -= loot.weight;
    if (roll <= 0) return loot;
  }
  return LOOT_TABLE[0];
}

function rarityLabel(rarity) {
  return { common: "Обычный", rare: "Редкий", epic: "Эпический", legendary: "ЛЕГЕНДАРНЫЙ ✨" }[rarity] || rarity;
}

// ─── SQLite: работа с игроками ────────────────────────────────────────────────
function getPlayer(username) {
  return db.prepare("SELECT * FROM players WHERE username = ?").get(username);
}

function upsertPlayer(username, userId) {
  db.prepare(`
    INSERT INTO players (username, user_id) VALUES (?, ?)
    ON CONFLICT(username) DO UPDATE SET user_id = excluded.user_id
  `).run(username, userId || null);
}

function hasPlayedThisStream(username) {
  const p = getPlayer(username);
  return p && p.last_run_stream === CURRENT_STREAM_ID;
}

function markStreamRun(username) {
  db.prepare("UPDATE players SET last_run_stream = ? WHERE username = ?")
    .run(CURRENT_STREAM_ID, username);
}

function recordWin(username, lootItem) {
  db.prepare(`
    UPDATE players
    SET runs = runs + 1, wins = wins + 1, total_loot = total_loot + ?,
        best_loot = CASE WHEN best_loot = '' THEN ? ELSE best_loot END
    WHERE username = ?
  `).run(lootItem.points, lootItem.item, username);
}

function recordDeath(username) {
  db.prepare("UPDATE players SET runs = runs + 1, deaths = deaths + 1 WHERE username = ?")
    .run(username);
}

function recordBan(username) {
  db.prepare("UPDATE players SET bans = bans + 1 WHERE username = ?")
    .run(username);
}

function addToInventory(username, item, rarity) {
  db.prepare("INSERT INTO inventory (username, item, rarity) VALUES (?, ?, ?)")
    .run(username, item, rarity);
}

function getInventory(username) {
  return db.prepare("SELECT item, rarity, obtained_at FROM inventory WHERE username = ? ORDER BY obtained_at DESC LIMIT 10").all(username);
}

// ─── StreamElements API ───────────────────────────────────────────────────────
async function getSEPoints(username) {
  try {
    const res = await axios.get(
      `https://api.streamelements.com/kappa/v2/points/${SE_CHANNEL_ID}/${username}`,
      { headers: { Authorization: `Bearer ${SE_JWT}` } }
    );
    return res.data?.points ?? 0;
  } catch (err) {
    console.error(`[SE GET POINTS] ${err.response?.data?.message || err.message}`);
    return null;
  }
}

async function updateSEPoints(username, amount) {
  // amount может быть отрицательным (списание) или положительным (начисление)
  try {
    await axios.put(
      `https://api.streamelements.com/kappa/v2/points/${SE_CHANNEL_ID}/${username}/${amount}`,
      {},
      { headers: { Authorization: `Bearer ${SE_JWT}` } }
    );
    return true;
  } catch (err) {
    console.error(`[SE UPDATE POINTS] ${err.response?.data?.message || err.message}`);
    return false;
  }
}

// ─── Twitch API: бан ──────────────────────────────────────────────────────────
async function getUserId(username) {
  try {
    const res = await axios.get("https://api.twitch.tv/helix/users", {
      params: { login: username.toLowerCase() },
      headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${API_TOKEN}` },
    });
    return res.data?.data?.[0]?.id ?? null;
  } catch (err) {
    console.error(`[USERID] ${err.message}`);
    return null;
  }
}

async function isModerator(userId) {
  try {
    const res = await axios.get("https://api.twitch.tv/helix/moderation/moderators", {
      params: { broadcaster_id: BROADCASTER_ID, user_id: userId },
      headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${API_TOKEN}` },
    });
    return (res.data?.data?.length ?? 0) > 0;
  } catch { return false; }
}

async function banUser(userId, reason) {
  try {
    await axios.post(
      "https://api.twitch.tv/helix/moderation/bans",
      { data: { user_id: userId, reason } },
      {
        params: { broadcaster_id: BROADCASTER_ID, moderator_id: MODERATOR_ID },
        headers: {
          "Client-Id": CLIENT_ID,
          Authorization: `Bearer ${API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    return true;
  } catch (err) {
    console.error(`[BAN] ${err.response?.data?.message || err.message}`);
    return false;
  }
}

async function tryBan(channel, username, userId, reason) {
  if (!userId) userId = await getUserId(username);
  if (!userId) return;

  if (userId === BROADCASTER_ID) {
    client.say(channel, `😅 @${username} — хозяин канала, его нельзя забанить даже боссу!`);
    return;
  }

  const mod = await isModerator(userId);
  if (mod) {
    try {
      await axios.delete("https://api.twitch.tv/helix/moderation/moderators", {
        params: { broadcaster_id: BROADCASTER_ID, user_id: userId },
        headers: { "Client-Id": CLIENT_ID, Authorization: `Bearer ${API_TOKEN}` },
      });
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      client.say(channel, `⚠️ Не удалось снять модку с @${username}.`);
      return;
    }
  }

  const banned = await banUser(userId, reason);
  if (banned) {
    recordBan(username);
    client.say(channel, `🔨 @${username} был ЗАБАНЕН боссом данжа! ${reason}`);
  } else {
    client.say(channel, `⚠️ Не удалось забанить @${username} (нет прав?).`);
  }
}

// ─── Команда !данж ────────────────────────────────────────────────────────────
async function handleDungeon(channel, tags, username) {
  const userId = tags["user-id"] || null;
  upsertPlayer(username, userId);

  // Проверка: уже играл в этот стрим?
  if (hasPlayedThisStream(username)) {
    client.say(channel, `⏳ @${username}, ты уже ходил в данж сегодня! Приходи на следующем стриме. 🏕️`);
    return;
  }

  // Проверка и списание очков SE
  if (SE_JWT && SE_CHANNEL_ID) {
    const points = await getSEPoints(username);
    if (points === null) {
      client.say(channel, `⚠️ @${username}, не удалось проверить твои очки. Попробуй позже.`);
      return;
    }
    if (points < DUNGEON_COST) {
      client.say(channel, `💸 @${username}, не хватает очков! Нужно ${DUNGEON_COST}, у тебя ${points}. Смотри стрим и копи! 👀`);
      return;
    }
    const spent = await updateSEPoints(username, -DUNGEON_COST);
    if (!spent) {
      client.say(channel, `⚠️ @${username}, ошибка при списании очков. Попробуй позже.`);
      return;
    }
  }

  markStreamRun(username);

  // Генерируем данж
  const heroClass = pick(CLASSES);
  const location  = pick(LOCATIONS);
  const boss      = pick(DEATH_BOSSES);
  const successChance = Math.floor(Math.random() * 100) + 1;
  const isDead    = Math.random() < boss.deathChance;

  // Сообщение 1: вход в данж
  client.say(channel,
    `⚔️ @${username} заходит в данж как ${heroClass} | 📍 Локация: ${location} | 👹 Босс: ${boss.emoji} ${boss.name} | Шанс выжить: ${successChance}%`
  );

  await new Promise(r => setTimeout(r, 2000));

  if (isDead) {
    // ── СМЕРТЬ ──
    recordDeath(username);
    const deathPhrase = pick(DEATH_PHRASES);
    client.say(channel,
      `💀 @${username} ${deathPhrase} | Босс ${boss.name} оказался слишком силён! Очки не возвращаются. 👻`
    );

    // Бан: случайный шанс (10%) при любой смерти ИЛИ гарантированный у бан-боссов (20%)
    const randomDeathBan = !boss.isBanBoss && Math.random() < 0.10;
    const bossBan        = boss.isBanBoss && Math.random() < 0.20;

    if (randomDeathBan || bossBan) {
      await new Promise(r => setTimeout(r, 1500));
      const banReason = boss.isBanBoss
        ? `Убит боссом ${boss.name} в данже — смерть означает бан!`
        : `Случайная смерть в данже от ${boss.name} — не повезло!`;
      await tryBan(channel, username, userId, banReason);
    }

  } else {
    // ── ПОБЕДА ──
    const loot      = rollLoot();
    const winPhrase = pick(WIN_PHRASES);

    recordWin(username, loot);
    addToInventory(username, loot.item, loot.rarity);

    // Начисляем очки SE за лут
    let pointsMsg = "";
    if (SE_JWT && SE_CHANNEL_ID) {
      const awarded = await updateSEPoints(username, loot.points);
      if (awarded) pointsMsg = ` | +${loot.points} очков SE 💰`;
    }

    client.say(channel,
      `🏆 @${username} ${winPhrase} | ${loot.emoji} Лут: ${loot.item} [${rarityLabel(loot.rarity)}]${pointsMsg}`
    );

    // Особое сообщение для легендарки
    if (loot.rarity === "legendary") {
      await new Promise(r => setTimeout(r, 1500));
      client.say(channel,
        `🌟✨ ЛЕГЕНДАРНЫЙ ЛУТ! @${username} выбил ${loot.emoji} ${loot.item}! Это редчайшая вещь! ✨🌟`
      );
    }
  }
}

// ─── Команда !стаьs / !stats ──────────────────────────────────────────────────
function handleStats(channel, username) {
  const p = getPlayer(username);
  if (!p || p.runs === 0) {
    client.say(channel, `@${username}, ты ещё не ходил в данж! Используй !данж (стоит ${DUNGEON_COST} очков). ⚔️`);
    return;
  }
  const winRate = p.runs > 0 ? Math.round((p.wins / p.runs) * 100) : 0;
  client.say(channel,
    `📊 @${username} | Заходов: ${p.runs} | Побед: ${p.wins} | Смертей: ${p.deaths} | Банов: ${p.bans} | Винрейт: ${winRate}% | Лучший лут: ${p.best_loot || "нет"}`
  );
}

// ─── Команда !инвентарь / !inv ────────────────────────────────────────────────
function handleInventory(channel, username) {
  const inv = getInventory(username);
  if (!inv.length) {
    client.say(channel, `@${username}, твой инвентарь пуст! Иди в данж за лутом. ⚔️`);
    return;
  }
  const items = inv.slice(0, 5).map(i => `${i.item} [${rarityLabel(i.rarity)}]`).join(" | ");
  client.say(channel, `🎒 @${username} — последние трофеи: ${items}`);
}

// ─── Команда !топданж ─────────────────────────────────────────────────────────
function handleTop(channel) {
  const top = db.prepare(`
    SELECT username, wins, runs, total_loot
    FROM players WHERE runs > 0
    ORDER BY wins DESC, total_loot DESC
    LIMIT 5
  `).all();

  if (!top.length) {
    client.say(channel, "🏆 Топ данжа пуст — никто ещё не ходил!");
    return;
  }
  const list = top.map((p, i) => `${i + 1}. ${p.username} (${p.wins}п/${p.runs}з)`).join(" | ");
  client.say(channel, `🏆 Топ данжа: ${list}`);
}

// ─── TMI клиент ───────────────────────────────────────────────────────────────
const client = new tmi.Client({
  options:  { debug: false },
  identity: { username: BOT_USERNAME, password: BOT_TOKEN },
  channels: [CHANNEL],
});

client.on("message", async (channel, tags, message, self) => {
  if (self) return;
  const cmd      = message.trim().toLowerCase();
  const username = tags["display-name"] || tags.username;

  if (cmd === "!данж" || cmd === "!dungeon") {
    await handleDungeon(channel, tags, username);
    return;
  }
  if (cmd === "!stats" || cmd === "!статы") {
    handleStats(channel, username);
    return;
  }
  if (cmd === "!inv" || cmd === "!инвентарь") {
    handleInventory(channel, username);
    return;
  }
  if (cmd === "!топданж" || cmd === "!topdungeon") {
    handleTop(channel);
    return;
  }
  if (cmd === "!данжhelp" || cmd === "!dungeonhelp") {
    client.say(channel,
      `⚔️ Команды данжа: !данж (вход, стоит ${DUNGEON_COST} очков SE) | !статы (твоя статистика) | !инвентарь (последние трофеи) | !топданж (топ-5 игроков)`
    );
    return;
  }
});

client.on("connected", (addr, port) => {
  console.log(`✅ Бот подключён к ${addr}:${port} — канал #${CHANNEL}`);
});

client.connect().catch(console.error);

// ─── Keep-alive HTTP (render.com) ─────────────────────────────────────────────
http
  .createServer((_, res) => res.end("Dungeon Bot is running ⚔️"))
  .listen(process.env.PORT || 3000, () =>
    console.log(`🌐 HTTP сервер на порту ${process.env.PORT || 3000}`)
  );
