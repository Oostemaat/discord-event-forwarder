require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require('discord.js');

const fetch = (...args) =>
  import('node-fetch').then(({ default: fetch }) => fetch(...args));

const TOKEN = process.env.DISCORD_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SECRET = process.env.WEBHOOK_SECRET;
const GUILD_ID = process.env.GUILD_ID;

const EVENT_SYNC_INTERVAL_MS = Number(
  process.env.EVENT_SYNC_INTERVAL_MS || 15 * 60 * 1000
);

const MEMBER_SYNC_INTERVAL_MS = Number(
  process.env.MEMBER_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000
);

const WEBHOOK_RETRIES = Number(
  process.env.WEBHOOK_RETRIES || 3
);

const EVENT_RETENTION_DAYS = Number(
  process.env.EVENT_RETENTION_DAYS || 30
);

const ROLE_SYNC_INTERVAL_MS = Number(
  process.env.ROLE_SYNC_INTERVAL_MS || 5 * 60 * 1000
);

const ROLE_SYNC_URL = process.env.ROLE_SYNC_URL;
const ROLE_SYNC_SECRET = process.env.ROLE_SYNC_SECRET;

const SYNC_NICKNAME_TO_RSN =
  String(process.env.SYNC_NICKNAME_TO_RSN || 'false').toLowerCase() ===
  'true';

const EVENT_STORE_FILE = path.join(
  __dirname,
  'event-store.json'
);

const ATTENDANCE_STORE_FILE = path.join(
  __dirname,
  'attendance-store.json'
);

/* =========================
   VAMPFIRE GE TRACKER
========================= */

const VAMPFIRE_USER_ID = '630533807111667742';
const VAMPFIRE_NAME = 'Vampfire';

const VAMP_STANDING_STORE_FILE = path.join(
  process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname,
  'vamp-standing.json'
);

const VAMP_STANDING_SAVE_INTERVAL_MS = 60 * 1000;

const LADDER_ROLE_MAP = {
  Owner: '1178145449165725706',
  Deputy_owner: '1178145449165725706',
  General: '1269265842433036298',
  Champion: '1269265842433036298',
  Templar: '1480269103410450596',
  Blood: '1480264334650249350',
  Carry: '1480268350721626264',
  Achiever: '1480268970090299607',
  Gamer: '1480263559224234196',
  Administrator: '1178145449165725706',
  Goblin: '1480264862880760049',
  Merchant: '1480267841335857264',
  Destroyer: '1480266664703430769',
  Unholy: '1480266140159836241',
  Maxed: '1480265333825867878',
  TzKal: '1480267421674897498',
  Quester: '1480268359772803184',
  Sergeant: '1480263303375753360',
  Corporal: '1480262992112390235',
  Recruit: '1480252412471148725',
  Bronze: '1480260972701552921',
  Guest: '1232810267608354917'
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildPresences
  ]
});

const slashCommands = [
  new SlashCommandBuilder()
    .setName('setrsn')
    .setDescription('Set your own RuneScape name')
    .addStringOption(option =>
      option
        .setName('rsn')
        .setDescription('Your full RuneScape name')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('removersn')
    .setDescription('Remove a Discord user RSN mapping')
    .setDefaultMemberPermissions(
      PermissionFlagsBits.ManageGuild
    )
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription(
          'Discord user to remove mapping for'
        )
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('vampstanding')
    .setDescription(
      'Show how long Vampfire has been standing at the Grand Exchange'
    )
].map(command => command.toJSON());

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function safeDateMs(value) {
  const numberValue = Number(value || 0);

  return Number.isFinite(numberValue)
    ? numberValue
    : 0;
}

function cleanRsn(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function registerSlashCommands() {
  try {
    if (!client.application) {
      await client.application?.fetch();
    }

    const applicationId = client.application?.id;

    if (!applicationId) {
      console.log(
        `[${nowIso()}] Could not determine application ID, skipping slash command registration.`
      );

      return;
    }

    const rest = new REST({
      version: '10'
    }).setToken(TOKEN);

    await rest.put(
      Routes.applicationGuildCommands(
        applicationId,
        GUILD_ID
      ),
      {
        body: slashCommands
      }
    );

    console.log(
      `[${nowIso()}] Slash commands registered for guild ${GUILD_ID}`
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed to register slash commands: ${err.message}`
    );
  }
}

async function sendWebhook(data) {
  let attempt = 0;
  let lastError = null;

  while (attempt < WEBHOOK_RETRIES) {
    attempt += 1;

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          secret: SECRET,
          ...data
        })
      });

      const text = await response.text();

      if (!response.ok) {
        lastError = new Error(
          `HTTP ${response.status}: ${text}`
        );

        console.log(
          `[${nowIso()}] Webhook failed ${attempt}/${WEBHOOK_RETRIES}: ${lastError.message}`
        );

        await sleep(500 * attempt);
        continue;
      }

      console.log(
        `[${nowIso()}] Webhook ok (${data.type || data.action || 'unknown'})`
      );

      return true;
    } catch (err) {
      lastError = err;

      console.log(
        `[${nowIso()}] Webhook error ${attempt}/${WEBHOOK_RETRIES}: ${err.message}`
      );

      await sleep(500 * attempt);
    }
  }

  console.log(
    `[${nowIso()}] Webhook permanently failed (${data.type || data.action || 'unknown'}): ${
      lastError
        ? lastError.message
        : 'Unknown error'
    }`
  );

  return false;
}

async function sendWebhookJson(data) {
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json'
      },

      body: JSON.stringify({
        secret: SECRET,
        ...data
      })
    });

    const text = await response.text();

    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {
        ok: false,

        error:
          text ||
          `Non-JSON response (HTTP ${response.status})`
      };
    }

    if (!response.ok && parsed.ok !== true) {
      return {
        ok: false,

        error:
          parsed.error ||
          `HTTP ${response.status}`
      };
    }

    return parsed;
  } catch (err) {
    return {
      ok: false,
      error: err.message
    };
  }
}

function formatDuration(startMs, endMs) {
  const start = safeDateMs(startMs);
  const end = safeDateMs(endMs);

  if (!start || !end || end <= start) {
    return '';
  }

  const totalMinutes = Math.floor(
    (end - start) / 60000
  );

  const hours = Math.floor(
    totalMinutes / 60
  );

  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h`;
  }

  return `${minutes}m`;
}

function mapDiscordStatus(eventStatus) {
  switch (Number(eventStatus || 0)) {
    case 1:
      return 'Not Started';

    case 2:
      return 'Started';

    case 3:
      return 'Done';

    case 4:
      return 'Cancelled';

    default:
      return 'Unknown';
  }
}

function buildEventPayload(event, interestedCount) {
  const startMs = safeDateMs(
    event.scheduledStartTimestamp
  );

  const endMs = safeDateMs(
    event.scheduledEndTimestamp
  );

  const uniqueInterested = Number(
    interestedCount || 0
  );

  const rawStatusCode = Number(
    event.status || 0
  );

  return {
    id: String(event.id || ''),
    name: event.name || '',
    startTime: startMs || '',
    endTime: endMs || '',
    duration: formatDuration(startMs, endMs),
    status: mapDiscordStatus(rawStatusCode),
    rawStatusCode,
    statusSource: 'discord',
    channelId: event.channelId || '',
    interestedCount: uniqueInterested,
    uniqueInterested,

    url:
      `https://discord.com/events/` +
      `${event.guildId}/${event.id}`
  };
}

/* =========================
   EVENT STORE
========================= */

function readEventStore() {
  try {
    if (!fs.existsSync(EVENT_STORE_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(
      EVENT_STORE_FILE,
      'utf8'
    );

    return raw
      ? JSON.parse(raw)
      : {};
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed reading event store: ${err.message}`
    );

    return {};
  }
}

function writeEventStore(store) {
  try {
    fs.writeFileSync(
      EVENT_STORE_FILE,
      JSON.stringify(store, null, 2),
      'utf8'
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed writing event store: ${err.message}`
    );
  }
}

function upsertStoredEvent(eventPayload) {
  if (!eventPayload || !eventPayload.id) {
    return;
  }

  const store = readEventStore();

  const existing =
    store[eventPayload.id] || {};

  store[eventPayload.id] = {
    id: eventPayload.id,

    name:
      eventPayload.name ||
      existing.name ||
      '',

    startTime:
      eventPayload.startTime ||
      existing.startTime ||
      '',

    endTime:
      eventPayload.endTime ||
      existing.endTime ||
      '',

    duration:
      eventPayload.duration ||
      existing.duration ||
      '',

    status:
      eventPayload.status ||
      existing.status ||
      'Unknown',

    rawStatusCode: Number(
      eventPayload.rawStatusCode ||
      existing.rawStatusCode ||
      0
    ),

    statusSource:
      eventPayload.statusSource ||
      existing.statusSource ||
      '',

    channelId:
      eventPayload.channelId ||
      existing.channelId ||
      '',

    interestedCount: Number(
      eventPayload.interestedCount || 0
    ),

    uniqueInterested: Number(
      eventPayload.uniqueInterested || 0
    ),

    url:
      eventPayload.url ||
      existing.url ||
      '',

    guildId: GUILD_ID,
    lastSeenAt: nowIso(),

    finalised:
      existing.finalised === true
  };

  writeEventStore(store);
}

function markStoredEventStatus(
  eventId,
  status,
  rawStatusCode,
  statusSource
) {
  const store = readEventStore();

  if (!store[eventId]) {
    return;
  }

  store[eventId].status = status;

  store[eventId].rawStatusCode =
    Number(rawStatusCode || 0);

  store[eventId].statusSource =
    statusSource ||
    store[eventId].statusSource ||
    '';

  store[eventId].lastSeenAt = nowIso();

  if (
    status === 'Done' ||
    status === 'Cancelled'
  ) {
    store[eventId].finalised = true;
  }

  writeEventStore(store);
}

function pruneOldStoredEvents() {
  const store = readEventStore();

  const cutoff =
    Date.now() -
    EVENT_RETENTION_DAYS *
      24 *
      60 *
      60 *
      1000;

  for (const eventId of Object.keys(store)) {
    const item = store[eventId];

    const endMs =
      item && item.endTime
        ? new Date(item.endTime).getTime()
        : 0;

    const lastSeenMs =
      item && item.lastSeenAt
        ? new Date(item.lastSeenAt).getTime()
        : 0;

    const referenceMs = Math.max(
      endMs || 0,
      lastSeenMs || 0
    );

    if (
      referenceMs &&
      referenceMs < cutoff
    ) {
      delete store[eventId];
    }
  }

  writeEventStore(store);
}

/* =========================
   ATTENDANCE STORE
========================= */

function readAttendanceStore() {
  try {
    if (!fs.existsSync(ATTENDANCE_STORE_FILE)) {
      return {};
    }

    const raw = fs.readFileSync(
      ATTENDANCE_STORE_FILE,
      'utf8'
    );

    return raw
      ? JSON.parse(raw)
      : {};
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed reading attendance store: ${err.message}`
    );

    return {};
  }
}

function writeAttendanceStore(store) {
  try {
    fs.writeFileSync(
      ATTENDANCE_STORE_FILE,
      JSON.stringify(store, null, 2),
      'utf8'
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed writing attendance store: ${err.message}`
    );
  }
}

function ensureAttendanceEvent(eventPayload) {
  if (!eventPayload || !eventPayload.id) {
    return;
  }

  const store = readAttendanceStore();

  const existing =
    store[eventPayload.id] || {};

  store[eventPayload.id] = {
    eventId: eventPayload.id,

    eventName:
      eventPayload.name ||
      existing.eventName ||
      '',

    channelId:
      eventPayload.channelId ||
      existing.channelId ||
      '',

    startTime:
      eventPayload.startTime ||
      existing.startTime ||
      '',

    endTime:
      eventPayload.endTime ||
      existing.endTime ||
      '',

    status:
      eventPayload.status ||
      existing.status ||
      '',

    joinedUsers:
      existing.joinedUsers || {},

    currentUsers:
      existing.currentUsers || {},

    finalised:
      existing.finalised === true
  };

  writeAttendanceStore(store);
}

function updateAttendanceEventStatus(eventPayload) {
  if (!eventPayload || !eventPayload.id) {
    return;
  }

  const store = readAttendanceStore();

  const existing =
    store[eventPayload.id];

  if (!existing) {
    ensureAttendanceEvent(eventPayload);
    return;
  }

  existing.eventName =
    eventPayload.name ||
    existing.eventName ||
    '';

  existing.channelId =
    eventPayload.channelId ||
    existing.channelId ||
    '';

  existing.startTime =
    eventPayload.startTime ||
    existing.startTime ||
    '';

  existing.endTime =
    eventPayload.endTime ||
    existing.endTime ||
    '';

  existing.status =
    eventPayload.status ||
    existing.status ||
    '';

  store[eventPayload.id] = existing;

  writeAttendanceStore(store);
}

function addAttendanceUser(
  eventId,
  userId,
  username
) {
  const store = readAttendanceStore();

  const attendance =
    store[eventId];

  if (!attendance) {
    return;
  }

  attendance.joinedUsers =
    attendance.joinedUsers || {};

  attendance.currentUsers =
    attendance.currentUsers || {};

  attendance.joinedUsers[userId] = {
    username:
      username ||
      attendance.joinedUsers[userId]?.username ||
      '',

    firstSeenAt:
      attendance.joinedUsers[userId]?.firstSeenAt ||
      nowIso(),

    lastSeenAt: nowIso()
  };

  attendance.currentUsers[userId] = true;

  store[eventId] = attendance;

  writeAttendanceStore(store);
}

function removeAttendanceUser(
  eventId,
  userId
) {
  const store = readAttendanceStore();

  const attendance =
    store[eventId];

  if (!attendance) {
    return;
  }

  attendance.currentUsers =
    attendance.currentUsers || {};

  delete attendance.currentUsers[userId];

  if (
    attendance.joinedUsers &&
    attendance.joinedUsers[userId]
  ) {
    attendance.joinedUsers[userId].lastSeenAt =
      nowIso();
  }

  store[eventId] = attendance;

  writeAttendanceStore(store);
}

function isAttendanceEventLive(attendance) {
  const now = Date.now();

  const startMs = attendance.startTime
    ? new Date(attendance.startTime).getTime()
    : 0;

  const endMs = attendance.endTime
    ? new Date(attendance.endTime).getTime()
    : 0;

  const status = String(
    attendance.status || ''
  ).trim();

  if (attendance.finalised === true) {
    return false;
  }

  if (
    status === 'Cancelled' ||
    status === 'Done'
  ) {
    return false;
  }

  if (endMs && now >= endMs) {
    return false;
  }

  return (
    (startMs && now >= startMs) ||
    status === 'Started'
  );
}

function getTrackedEventByChannel(channelId) {
  const store = readAttendanceStore();

  const liveEvents = Object.values(store).filter(
    attendance =>
      String(attendance.channelId || '') ===
        String(channelId || '') &&
      isAttendanceEventLive(attendance)
  );

  if (!liveEvents.length) {
    return null;
  }

  liveEvents.sort((a, b) => {
    const aStart = a.startTime
      ? new Date(a.startTime).getTime()
      : 0;

    const bStart = b.startTime
      ? new Date(b.startTime).getTime()
      : 0;

    return bStart - aStart;
  });

  return liveEvents[0];
}

async function sendLiveAttendanceSnapshot(eventId) {
  const store = readAttendanceStore();

  const attendance =
    store[eventId];

  if (!attendance) {
    return;
  }

  const users = Object.values(
    attendance.joinedUsers || {}
  )
    .map(user => ({
      username: user.username || ''
    }))
    .filter(user => user.username);

  await sendWebhook({
    type: 'attendance_snapshot',
    eventId: attendance.eventId,
    eventName: attendance.eventName,
    users
  });

  console.log(
    `[${nowIso()}] Sent live attendance snapshot for ${attendance.eventName}: ${users.length} attendee(s)`
  );
}

async function sendAttendanceSnapshot(eventId) {
  const store = readAttendanceStore();

  const attendance =
    store[eventId];

  if (
    !attendance ||
    attendance.finalised === true
  ) {
    return;
  }

  const users = Object.values(
    attendance.joinedUsers || {}
  )
    .map(user => ({
      username: user.username || ''
    }))
    .filter(user => user.username);

  await sendWebhook({
    type: 'attendance_snapshot',
    eventId: attendance.eventId,
    eventName: attendance.eventName,
    users
  });

  attendance.finalised = true;
  store[eventId] = attendance;

  writeAttendanceStore(store);

  console.log(
    `[${nowIso()}] Sent final attendance snapshot for ${attendance.eventName}: ${users.length} unique attendees`
  );
}

async function captureCurrentVoiceMembersForEvent(
  guild,
  eventPayload
) {
  if (
    !eventPayload ||
    !eventPayload.id ||
    !eventPayload.channelId
  ) {
    return;
  }

  const now = Date.now();

  const startMs = safeDateMs(
    eventPayload.startTime
  );

  const endMs = safeDateMs(
    eventPayload.endTime
  );

  const status = String(
    eventPayload.status || ''
  ).trim();

  const isLive =
    status === 'Started' ||
    (
      startMs &&
      now >= startMs &&
      (!endMs || now < endMs)
    );

  if (!isLive) {
    return;
  }

  const activeEventForChannel =
    getTrackedEventByChannel(
      eventPayload.channelId
    );

  if (
    activeEventForChannel &&
    activeEventForChannel.eventId !==
      eventPayload.id
  ) {
    return;
  }

  try {
    const channel = await guild.channels
      .fetch(eventPayload.channelId)
      .catch(() => null);

    if (!channel) {
      return;
    }

    const isVoiceLike =
      channel.type === ChannelType.GuildVoice ||
      channel.type === ChannelType.GuildStageVoice;

    if (!isVoiceLike || !channel.members) {
      return;
    }

    const store = readAttendanceStore();

    const attendance =
      store[eventPayload.id];

    if (!attendance) {
      return;
    }

    const currentIds = new Set(
      channel.members.map(member => member.id)
    );

    Object.keys(
      attendance.currentUsers || {}
    ).forEach(userId => {
      if (!currentIds.has(userId)) {
        removeAttendanceUser(
          eventPayload.id,
          userId
        );
      }
    });

    channel.members.forEach(member => {
      addAttendanceUser(
        eventPayload.id,
        member.id,
        member.displayName ||
          member.user?.username ||
          ''
      );
    });

    await sendLiveAttendanceSnapshot(
      eventPayload.id
    );

    console.log(
      `[${nowIso()}] Captured current voice members for LIVE event ${eventPayload.name}: ${channel.members.size}`
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed capturing voice members for ${eventPayload.name}: ${err.message}`
    );
  }
}

/* =========================
   DISCORD EVENT HELPERS
========================= */

async function fetchAllSubscribers(event) {
  const subscribers = [];
  let lastId = null;

  while (true) {
    const batch =
      await event.fetchSubscribers({
        limit: 100,
        withMember: true,
        after: lastId || undefined
      });

    if (!batch || batch.size === 0) {
      break;
    }

    for (const [, subscriber] of batch) {
      subscribers.push(subscriber);
    }

    const ids = [...batch.keys()];

    lastId = ids[ids.length - 1];

    if (batch.size < 100) {
      break;
    }
  }

  return subscribers;
}

async function getInterestedCount(event) {
  if (typeof event.userCount === 'number') {
    return event.userCount;
  }

  try {
    const subscribers =
      await fetchAllSubscribers(event);

    return subscribers.length;
  } catch (err) {
    console.log(
      `[${nowIso()}] Could not fetch subscribers for ${event.name}: ${err.message}`
    );

    return 0;
  }
}

async function resolveDisplayName(
  guild,
  userId,
  fallbackUsername
) {
  try {
    const member =
      await guild.members.fetch(userId);

    return member
      ? member.displayName
      : fallbackUsername;
  } catch {
    return fallbackUsername;
  }
}

function dedupeUsersByName(users) {
  const seen = new Set();
  const output = [];

  for (const user of users) {
    const username = String(
      user.username || ''
    ).trim();

    if (!username) {
      continue;
    }

    const key = username.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    output.push({
      username
    });
  }

  return output;
}

/* =========================
   ROLE / RANK SYNC
========================= */

async function fetchRoleSyncRows() {
  if (!ROLE_SYNC_URL) {
    console.log(
      `[${nowIso()}] ROLE_SYNC_URL missing, skipping role sync.`
    );

    return [];
  }

  try {
    const response = await fetch(
      ROLE_SYNC_URL,
      {
        method: 'POST',

        headers: {
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          secret: ROLE_SYNC_SECRET || '',
          type: 'role_sync_request'
        })
      }
    );

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}: ${text}`
      );
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Invalid JSON response: ${text}`
      );
    }

    if (!Array.isArray(data)) {
      console.log(
        `[${nowIso()}] Role sync response was not an array.`
      );

      return [];
    }

    return data;
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed fetching role sync rows: ${err.message}`
    );

    return [];
  }
}

function getDesiredLadderRoleId(row) {
  const rawRank = String(
    row.rank ||
    row.roleKey ||
    ''
  ).trim();

  if (!rawRank) {
    return '';
  }

  const rankAliases = {
    Owner: 'Owner',
    owner: 'Owner',

    Deputy_owner: 'Deputy_owner',
    'Deputy Owner': 'Deputy_owner',
    'deputy owner': 'Deputy_owner',
    deputy_owner: 'Deputy_owner',

    Administrator: 'Administrator',
    administrator: 'Administrator',

    General: 'General',
    general: 'General',

    Champion: 'Champion',
    champion: 'Champion',

    Templar: 'Templar',
    templar: 'Templar',

    Blood: 'Blood',
    blood: 'Blood',

    Carry: 'Carry',
    carry: 'Carry',

    Achiever: 'Achiever',
    achiever: 'Achiever',

    Gamer: 'Gamer',
    gamer: 'Gamer',

    Goblin: 'Goblin',
    goblin: 'Goblin',

    Merchant: 'Merchant',
    merchant: 'Merchant',

    Destroyer: 'Destroyer',
    destroyer: 'Destroyer',

    Unholy: 'Unholy',
    unholy: 'Unholy',

    Maxed: 'Maxed',
    maxed: 'Maxed',

    TzKal: 'TzKal',
    tzkal: 'TzKal',

    Quester: 'Quester',
    quester: 'Quester',

    Sergeant: 'Sergeant',
    sergeant: 'Sergeant',

    Corporal: 'Corporal',
    corporal: 'Corporal',

    Recruit: 'Recruit',
    recruit: 'Recruit',

    Bronze: 'Bronze',
    bronze: 'Bronze',
    'Bronze bar': 'Bronze',
    'bronze bar': 'Bronze',

    Guest: 'Guest',
    guest: 'Guest'
  };

  const excludedRanks = new Set([
    'Owner',
    'Deputy_owner',
    'General',
    'Champion'
  ]);

  const canonicalRank =
    rankAliases[rawRank] || rawRank;

  if (excludedRanks.has(canonicalRank)) {
    return '';
  }

  return LADDER_ROLE_MAP[canonicalRank] || '';
}

function getAllManagedLadderRoleIds() {
  const excludedRoleIds = new Set([
    '1178145449165725706',
    '1269265842433036298'
  ]);

  return [
    ...new Set(
      Object.values(LADDER_ROLE_MAP)
        .filter(Boolean)
        .filter(
          roleId =>
            !excludedRoleIds.has(roleId)
        )
    )
  ];
}

async function syncMemberRolesFromRow(
  guild,
  row
) {
  const discordId = String(
    row.discordId || ''
  ).trim();

  const rsn = String(
    row.rsn || ''
  ).trim();

  const active =
    String(
      row.active ?? 'true'
    ).toLowerCase() !== 'false';

  if (!discordId) {
    return {
      ok: false,
      reason: 'missing_discord_id'
    };
  }

  const member = await guild.members
    .fetch(discordId)
    .catch(() => null);

  if (!member) {
    return {
      ok: false,
      reason: 'member_not_found',
      discordId
    };
  }

  const desiredRoleId = active
    ? getDesiredLadderRoleId(row)
    : '';

  const managedRoleIds =
    getAllManagedLadderRoleIds();

  const currentManagedRoleIds =
    member.roles.cache
      .filter(role =>
        managedRoleIds.includes(role.id)
      )
      .map(role => role.id);

  if (!desiredRoleId) {
    console.log(
      `[${nowIso()}] No valid ladder role resolved for ${member.user.tag} | rsn="${rsn}" | rank="${String(
        row.rank ||
        row.roleKey ||
        ''
      ).trim()}"`
    );

    return {
      ok: false,
      reason: 'no_valid_desired_role',
      discordId,
      rsn,

      rank: String(
        row.rank ||
        row.roleKey ||
        ''
      ).trim()
    };
  }

  const toRemove =
    currentManagedRoleIds.filter(
      roleId =>
        roleId !== desiredRoleId
    );

  const toAdd =
    currentManagedRoleIds.includes(
      desiredRoleId
    )
      ? []
      : [desiredRoleId];

  for (const roleId of toRemove) {
    try {
      await member.roles.remove(
        roleId,
        'Shadowvale ladder role sync from sheet'
      );
    } catch (err) {
      console.log(
        `[${nowIso()}] Failed removing ladder role ${roleId} from ${member.user.tag}: ${err.message}`
      );
    }
  }

  for (const roleId of toAdd) {
    try {
      await member.roles.add(
        roleId,
        'Shadowvale ladder role sync from sheet'
      );
    } catch (err) {
      console.log(
        `[${nowIso()}] Failed adding ladder role ${roleId} to ${member.user.tag}: ${err.message}`
      );
    }
  }

  if (SYNC_NICKNAME_TO_RSN && rsn) {
    const currentNickname =
      member.nickname ||
      member.displayName ||
      '';

    if (currentNickname !== rsn) {
      try {
        await member.setNickname(
          rsn,
          'Shadowvale nickname sync from sheet'
        );
      } catch (err) {
        console.log(
          `[${nowIso()}] Failed nickname sync for ${member.user.tag}: ${err.message}`
        );
      }
    }
  }

  return {
    ok: true,
    discordId,
    rsn,
    desiredRoleId,
    added: toAdd.length,
    removed: toRemove.length
  };
}

async function syncRolesFromSheet(
  reason = 'manual'
) {
  console.log(
    `[${nowIso()}] Role sync started (${reason})`
  );

  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    const rows =
      await fetchRoleSyncRows();

    if (!rows.length) {
      console.log(
        `[${nowIso()}] No role sync rows returned.`
      );

      return;
    }

    let ok = 0;
    let failed = 0;

    for (const row of rows) {
      const result =
        await syncMemberRolesFromRow(
          guild,
          row
        );

      if (result.ok) {
        ok += 1;
      } else {
        failed += 1;
      }
    }

    console.log(
      `[${nowIso()}] Role sync finished (${reason}) ok=${ok} failed=${failed}`
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Role sync failed (${reason}): ${err.message}`
    );
  }
}

/* =========================
   VAMPFIRE GE TRACKING
========================= */

function createDefaultVampStandingStore() {
  return {
    userId: VAMPFIRE_USER_ID,
    rsn: VAMPFIRE_NAME,
    trackingStartedAt: nowIso(),
    accumulatedMs: 0,
    currentSessionStartedAt: null,
    currentlyAtGe: false,
    lastPresenceUpdateAt: null,
    lastSavedAt: nowIso()
  };
}

function writeVampStandingStore(store) {
  try {
    const safeStore = {
      userId: VAMPFIRE_USER_ID,
      rsn: VAMPFIRE_NAME,

      trackingStartedAt:
        store.trackingStartedAt ||
        nowIso(),

      accumulatedMs: Math.max(
        0,
        Number(store.accumulatedMs || 0)
      ),

      currentSessionStartedAt:
        store.currentSessionStartedAt ||
        null,

      currentlyAtGe:
        store.currentlyAtGe === true,

      lastPresenceUpdateAt:
        store.lastPresenceUpdateAt ||
        null,

      lastSavedAt: nowIso()
    };

    const temporaryFile =
      `${VAMP_STANDING_STORE_FILE}.tmp`;

    fs.writeFileSync(
      temporaryFile,
      JSON.stringify(safeStore, null, 2),
      'utf8'
    );

    fs.renameSync(
      temporaryFile,
      VAMP_STANDING_STORE_FILE
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed writing Vampfire standing store: ${err.message}`
    );
  }
}

function readVampStandingStore() {
  try {
    if (!fs.existsSync(VAMP_STANDING_STORE_FILE)) {
      const initialStore =
        createDefaultVampStandingStore();

      writeVampStandingStore(initialStore);

      return initialStore;
    }

    const raw = fs.readFileSync(
      VAMP_STANDING_STORE_FILE,
      'utf8'
    );

    if (!raw.trim()) {
      const initialStore =
        createDefaultVampStandingStore();

      writeVampStandingStore(initialStore);

      return initialStore;
    }

    const parsed = JSON.parse(raw);

    return {
      userId: VAMPFIRE_USER_ID,
      rsn: VAMPFIRE_NAME,

      trackingStartedAt:
        parsed.trackingStartedAt ||
        nowIso(),

      accumulatedMs:
        Number.isFinite(
          Number(parsed.accumulatedMs)
        )
          ? Math.max(
              0,
              Number(parsed.accumulatedMs)
            )
          : 0,

      currentSessionStartedAt:
        parsed.currentSessionStartedAt ||
        null,

      currentlyAtGe:
        parsed.currentlyAtGe === true,

      lastPresenceUpdateAt:
        parsed.lastPresenceUpdateAt ||
        null,

      lastSavedAt:
        parsed.lastSavedAt ||
        null
    };
  } catch (err) {
    console.log(
      `[${nowIso()}] Failed reading Vampfire standing store: ${err.message}`
    );

    const initialStore =
      createDefaultVampStandingStore();

    writeVampStandingStore(initialStore);

    return initialStore;
  }
}

function isRuneLiteGrandExchangePresence(
  presence
) {
  if (
    !presence ||
    !Array.isArray(presence.activities)
  ) {
    return false;
  }

  return presence.activities.some(
    activity => {
      const applicationName = String(
        activity?.name || ''
      ).trim();

      const details = String(
        activity?.details || ''
      ).trim();

      const state = String(
        activity?.state || ''
      ).trim();

      return (
        applicationName === 'RuneLite' &&
        (
          details === 'Grand Exchange' ||
          state === 'Grand Exchange'
        )
      );
    }
  );
}

function startVampGeSession(
  reason = 'presence_update'
) {
  const store = readVampStandingStore();

  if (
    store.currentlyAtGe &&
    store.currentSessionStartedAt
  ) {
    return false;
  }

  const startedAt = nowIso();

  store.currentlyAtGe = true;
  store.currentSessionStartedAt = startedAt;
  store.lastPresenceUpdateAt = startedAt;

  writeVampStandingStore(store);

  console.log(
    `[${nowIso()}] Vampfire GE session started (${reason})`
  );

  return true;
}

function stopVampGeSession(
  reason = 'presence_update'
) {
  const store = readVampStandingStore();

  if (
    !store.currentlyAtGe ||
    !store.currentSessionStartedAt
  ) {
    if (
      store.currentlyAtGe ||
      store.currentSessionStartedAt
    ) {
      store.currentlyAtGe = false;
      store.currentSessionStartedAt = null;
      store.lastPresenceUpdateAt = nowIso();

      writeVampStandingStore(store);
    }

    return false;
  }

  const sessionStartMs = new Date(
    store.currentSessionStartedAt
  ).getTime();

  const endedAtMs = Date.now();

  if (
    Number.isFinite(sessionStartMs) &&
    sessionStartMs > 0 &&
    endedAtMs > sessionStartMs
  ) {
    store.accumulatedMs +=
      endedAtMs - sessionStartMs;
  }

  store.currentlyAtGe = false;
  store.currentSessionStartedAt = null;
  store.lastPresenceUpdateAt = nowIso();

  writeVampStandingStore(store);

  console.log(
    `[${nowIso()}] Vampfire GE session stopped (${reason})`
  );

  return true;
}

function updateVampPresenceTracking(
  presence,
  reason = 'presence_update'
) {
  const atGrandExchange =
    isRuneLiteGrandExchangePresence(
      presence
    );

  if (atGrandExchange) {
    startVampGeSession(reason);
  } else {
    stopVampGeSession(reason);
  }

  return atGrandExchange;
}

function getVampStandingTotalMs(
  store = readVampStandingStore()
) {
  let totalMs = Math.max(
    0,
    Number(store.accumulatedMs || 0)
  );

  if (
    store.currentlyAtGe &&
    store.currentSessionStartedAt
  ) {
    const sessionStartMs = new Date(
      store.currentSessionStartedAt
    ).getTime();

    if (
      Number.isFinite(sessionStartMs) &&
      sessionStartMs > 0 &&
      Date.now() > sessionStartMs
    ) {
      totalMs +=
        Date.now() - sessionStartMs;
    }
  }

  return totalMs;
}

function formatStandingDuration(totalMs) {
  const totalSeconds = Math.max(
    0,
    Math.floor(
      Number(totalMs || 0) / 1000
    )
  );

  const days = Math.floor(
    totalSeconds / 86400
  );

  const hours = Math.floor(
    (totalSeconds % 86400) / 3600
  );

  const minutes = Math.floor(
    (totalSeconds % 3600) / 60
  );

  const seconds =
    totalSeconds % 60;

  const pad = value =>
    String(value).padStart(2, '0');

  return (
    `${pad(days)}:` +
    `${pad(hours)}:` +
    `${pad(minutes)}:` +
    `${pad(seconds)}`
  );
}

function getDiscordTimestamp(
  isoValue,
  style = 'F'
) {
  const timestampMs =
    new Date(isoValue).getTime();

  if (
    !Number.isFinite(timestampMs) ||
    timestampMs <= 0
  ) {
    return 'Unknown';
  }

  return (
    `<t:${Math.floor(
      timestampMs / 1000
    )}:${style}>`
  );
}

async function initialiseVampStandingTracking() {
  const store =
    readVampStandingStore();

  /*
   * Prevent offline/deployment time from being counted.
   * Only time observed while the bot is online is included.
   */
  if (
    store.currentlyAtGe &&
    store.currentSessionStartedAt
  ) {
    const previousStartMs = new Date(
      store.currentSessionStartedAt
    ).getTime();

    const previousSavedMs =
      store.lastSavedAt
        ? new Date(
            store.lastSavedAt
          ).getTime()
        : Date.now();

    if (
      Number.isFinite(previousStartMs) &&
      Number.isFinite(previousSavedMs) &&
      previousSavedMs > previousStartMs
    ) {
      store.accumulatedMs +=
        previousSavedMs -
        previousStartMs;
    }

    store.currentlyAtGe = false;
    store.currentSessionStartedAt = null;
    store.lastPresenceUpdateAt = nowIso();

    writeVampStandingStore(store);
  }

  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    await guild.members.fetch({
      withPresences: true
    }).catch(err => {
      console.log(
        `[${nowIso()}] Could not preload presences: ${err.message}`
      );
    });

    const presence =
      guild.presences.cache.get(
        VAMPFIRE_USER_ID
      ) ||
      guild.members.cache.get(
        VAMPFIRE_USER_ID
      )?.presence ||
      null;

    const atGrandExchange =
      updateVampPresenceTracking(
        presence,
        'startup_presence_check'
      );

    console.log(
      `[${nowIso()}] Vampfire startup presence checked: ${
        atGrandExchange
          ? 'Grand Exchange'
          : 'not at Grand Exchange'
      }`
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Vampfire startup tracking check failed: ${err.message}`
    );
  }
}

function saveActiveVampStandingProgress() {
  const store =
    readVampStandingStore();

  if (
    !store.currentlyAtGe ||
    !store.currentSessionStartedAt
  ) {
    return;
  }

  const sessionStartMs = new Date(
    store.currentSessionStartedAt
  ).getTime();

  const nowMs = Date.now();

  if (
    Number.isFinite(sessionStartMs) &&
    sessionStartMs > 0 &&
    nowMs > sessionStartMs
  ) {
    store.accumulatedMs +=
      nowMs - sessionStartMs;

    store.currentSessionStartedAt =
      new Date(nowMs).toISOString();

    writeVampStandingStore(store);
  }
}

function closeVampStandingTracker(
  reason = 'shutdown'
) {
  const store =
    readVampStandingStore();

  if (
    store.currentlyAtGe &&
    store.currentSessionStartedAt
  ) {
    const sessionStartMs = new Date(
      store.currentSessionStartedAt
    ).getTime();

    const nowMs = Date.now();

    if (
      Number.isFinite(sessionStartMs) &&
      sessionStartMs > 0 &&
      nowMs > sessionStartMs
    ) {
      store.accumulatedMs +=
        nowMs - sessionStartMs;
    }
  }

  store.currentlyAtGe = false;
  store.currentSessionStartedAt = null;
  store.lastPresenceUpdateAt = nowIso();

  writeVampStandingStore(store);

  console.log(
    `[${nowIso()}] Vampfire tracker saved and closed (${reason})`
  );
}

async function handleVampStandingCommand(
  interaction
) {
  try {
    const store =
      readVampStandingStore();

    const totalMs =
      getVampStandingTotalMs(store);

    const formattedDuration =
      formatStandingDuration(totalMs);

    const statusText =
      store.currentlyAtGe
        ? '🟢 Currently at the Grand Exchange'
        : '⚫ Not currently at the Grand Exchange';

    let response = '';

    response +=
      `## Vampfire Grand Exchange Standing\n`;

    response +=
      `**${VAMPFIRE_NAME} has been at the Grand Exchange for ${formattedDuration}.**\n\n`;

    response +=
      `**Format:** DD:HH:MM:SS\n`;

    response +=
      `**Tracking started:** ${getDiscordTimestamp(
        store.trackingStartedAt,
        'F'
      )}\n`;

    response +=
      `**Status:** ${statusText}`;

    if (
      store.currentlyAtGe &&
      store.currentSessionStartedAt
    ) {
      response +=
        `\n**Current visit started:** ${getDiscordTimestamp(
          store.currentSessionStartedAt,
          'R'
        )}`;
    }

    await interaction.reply({
      content: response
    });
  } catch (err) {
    console.log(
      `[${nowIso()}] vampstanding command error: ${err.message}`
    );

    const errorMessage =
      `❌ Error reading Vampfire's Grand Exchange time: ${err.message}`;

    if (
      interaction.replied ||
      interaction.deferred
    ) {
      await interaction.editReply(
        errorMessage
      );
    } else {
      await interaction.reply({
        content: errorMessage,
        ephemeral: true
      });
    }
  }
}

/* =========================
   COMMANDS
========================= */

async function handleSetRsnCommand(
  interaction
) {
  await interaction.deferReply({
    ephemeral: true
  });

  try {
    const targetUser =
      interaction.user;

    const guild =
      interaction.guild;

    const rsn = cleanRsn(
      interaction.options.getString(
        'rsn',
        true
      )
    );

    if (!rsn) {
      await interaction.editReply(
        '❌ RSN cannot be empty.'
      );

      return;
    }

    const member = await guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    const payload = {
      action: 'setup_rsn',
      guildId: guild.id,
      guildName: guild.name,
      discordUserId: targetUser.id,
      discordTag: targetUser.tag,
      discordUsername: targetUser.username,

      displayName:
        member?.displayName ||
        targetUser.globalName ||
        targetUser.username,

      rsn,
      approvedById: targetUser.id,
      approvedByTag: targetUser.tag,
      approvedAt: new Date().toISOString()
    };

    const data =
      await sendWebhookJson(payload);

    if (!data.ok) {
      await interaction.editReply(
        `❌ Failed to save RSN: ${
          data.error ||
          'Unknown error'
        }`
      );

      return;
    }

    await syncRolesFromSheet('setrsn');

    data.syncTriggered = true;

    let message = '';

    message +=
      `✅ Your RSN has been saved.\n`;

    message +=
      `RSN: **${data.rsn || rsn}**\n`;

    message +=
      `Map row: ${
        data.updated
          ? 'updated'
          : 'created'
      }\n`;

    message +=
      `Unmapped row: ${
        data.removedFromUnmapped
          ? 'removed'
          : 'no match found'
      }\n`;

    message +=
      `Role sync: ${
        data.syncTriggered
          ? 'triggered'
          : 'not triggered'
      }`;

    await interaction.editReply(message);
  } catch (err) {
    console.log(
      `[${nowIso()}] setrsn error: ${err.message}`
    );

    await interaction.editReply(
      `❌ Error running setrsn: ${err.message}`
    );
  }
}

async function handleRemoveRsnCommand(
  interaction
) {
  await interaction.deferReply({
    ephemeral: true
  });

  try {
    if (
      !interaction.memberPermissions?.has(
        PermissionFlagsBits.ManageGuild
      )
    ) {
      await interaction.editReply(
        '❌ You do not have permission to use this command.'
      );

      return;
    }

    const targetUser =
      interaction.options.getUser(
        'user',
        true
      );

    const guild =
      interaction.guild;

    const member = await guild.members
      .fetch(targetUser.id)
      .catch(() => null);

    const payload = {
      action: 'remove_rsn',
      guildId: guild.id,
      guildName: guild.name,
      discordUserId: targetUser.id,
      discordTag: targetUser.tag,
      discordUsername: targetUser.username,

      displayName:
        member?.displayName ||
        targetUser.globalName ||
        targetUser.username,

      removedById:
        interaction.user.id,

      removedByTag:
        interaction.user.tag,

      removedAt:
        new Date().toISOString()
    };

    const data =
      await sendWebhookJson(payload);

    if (!data.ok) {
      await interaction.editReply(
        `❌ Failed to remove RSN: ${
          data.error ||
          'Unknown error'
        }`
      );

      return;
    }

    await syncRolesFromSheet(
      'removersn'
    );

    data.syncTriggered = true;

    let message = '';

    message +=
      `✅ RSN mapping removed.\n`;

    message +=
      `User: <@${targetUser.id}>\n`;

    message +=
      `Map row: ${
        data.found
          ? 'removed'
          : 'no existing mapping found'
      }\n`;

    message +=
      `Role sync: ${
        data.syncTriggered
          ? 'triggered'
          : 'not triggered'
      }`;

    await interaction.editReply(message);
  } catch (err) {
    console.log(
      `[${nowIso()}] removersn error: ${err.message}`
    );

    await interaction.editReply(
      `❌ Error running removersn: ${err.message}`
    );
  }
}

/* =========================
   SYNC
========================= */

async function syncSingleEvent(
  guild,
  event
) {
  const subscribers =
    await fetchAllSubscribers(event);

  const interestedCount =
    typeof event.userCount === 'number'
      ? event.userCount
      : subscribers.length;

  const payload =
    buildEventPayload(
      event,
      interestedCount
    );

  const now = Date.now();

  const startMs = safeDateMs(
    event.scheduledStartTimestamp
  );

  const endMs = safeDateMs(
    event.scheduledEndTimestamp
  );

  if (endMs && now >= endMs) {
    payload.status = 'Done';
    payload.rawStatusCode = 3;

    payload.statusSource =
      'bot_time_finished';
  } else if (
    startMs &&
    now >= startMs
  ) {
    payload.status = 'Started';
    payload.rawStatusCode = 2;

    payload.statusSource =
      'bot_time_started';
  }

  await sendWebhook({
    type: 'sync_event',
    event: payload
  });

  upsertStoredEvent(payload);
  ensureAttendanceEvent(payload);
  updateAttendanceEventStatus(payload);

  await captureCurrentVoiceMembersForEvent(
    guild,
    payload
  );

  const users = [];

  for (const subscriber of subscribers) {
    const fallback =
      subscriber.user?.username || '';

    const displayName =
      await resolveDisplayName(
        guild,
        subscriber.user.id,
        fallback
      );

    users.push({
      username: displayName
    });
  }

  await sendWebhook({
    type: 'sync_interest_snapshot',
    eventId: event.id,
    eventName: event.name,
    users: dedupeUsersByName(users)
  });

  console.log(
    `[${nowIso()}] Synced event: ${event.name} (${interestedCount} interested)`
  );
}

async function finaliseMissingEvents(
  liveEventIds
) {
  const store = readEventStore();
  const now = Date.now();

  for (const eventId of Object.keys(store)) {
    const stored = store[eventId];

    if (
      !stored ||
      liveEventIds.has(eventId) ||
      stored.finalised === true
    ) {
      continue;
    }

    const startMs =
      stored.startTime
        ? new Date(
            stored.startTime
          ).getTime()
        : 0;

    const endMs =
      stored.endTime
        ? new Date(
            stored.endTime
          ).getTime()
        : 0;

    const previousStatus = String(
      stored.status || ''
    ).trim();

    let finalStatus = '';
    let rawStatusCode = 0;
    let statusSource = '';

    if (previousStatus === 'Started') {
      finalStatus = 'Done';
      rawStatusCode = 3;

      statusSource =
        'bot_missing_started_then_gone';
    } else if (
      endMs &&
      now >= endMs
    ) {
      finalStatus = 'Done';
      rawStatusCode = 3;

      statusSource =
        'bot_missing_finished';
    } else {
      finalStatus = 'Cancelled';
      rawStatusCode = 4;

      statusSource =
        'bot_missing_cancelled';
    }

    const payload = {
      id: stored.id,
      name: stored.name || '',
      startTime: stored.startTime || '',
      endTime: stored.endTime || '',

      duration:
        stored.duration ||
        formatDuration(startMs, endMs),

      status: finalStatus,
      rawStatusCode,
      statusSource,
      channelId: stored.channelId || '',

      interestedCount: Number(
        stored.interestedCount || 0
      ),

      uniqueInterested: Number(
        stored.uniqueInterested || 0
      ),

      url:
        stored.url ||
        `https://discord.com/events/${GUILD_ID}/${stored.id}`
    };

    await sendWebhook({
      type: 'event_update',
      event: payload
    });

    markStoredEventStatus(
      eventId,
      finalStatus,
      rawStatusCode,
      statusSource
    );

    updateAttendanceEventStatus(
      payload
    );

    await sendAttendanceSnapshot(
      eventId
    );

    console.log(
      `[${nowIso()}] Finalised missing event as ${finalStatus}: ${stored.name} (${stored.id}) previousStatus=${previousStatus}`
    );
  }
}

async function syncExistingEventsAndUsers(
  reason = 'manual'
) {
  console.log(
    `[${nowIso()}] Event sync started (${reason})`
  );

  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    const events =
      await guild.scheduledEvents.fetch({
        withUserCount: true
      });

    console.log(
      `[${nowIso()}] Found ${events.size} scheduled event(s)`
    );

    const liveEventIds = new Set();

    for (const [, event] of events) {
      liveEventIds.add(event.id);

      await syncSingleEvent(
        guild,
        event
      );
    }

    await finaliseMissingEvents(
      liveEventIds
    );

    pruneOldStoredEvents();

    console.log(
      `[${nowIso()}] Event sync finished (${reason})`
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Event sync failed (${reason}): ${err.message}`
    );
  }
}

async function syncGuildMembers(
  reason = 'manual'
) {
  console.log(
    `[${nowIso()}] Member sync started (${reason})`
  );

  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    const members =
      await guild.members.fetch();

    const payload = [];

    members.forEach(member => {
      payload.push({
        discordId: member.id,
        displayName: member.displayName,

        username:
          member.user?.username || '',

        isBot:
          member.user?.bot === true
      });
    });

    await sendWebhook({
      type: 'member_snapshot',
      members: payload
    });

    console.log(
      `[${nowIso()}] Synced ${payload.length} guild members`
    );
  } catch (err) {
    console.log(
      `[${nowIso()}] Member sync failed (${reason}): ${err.message}`
    );
  }
}

/* =========================
   CLIENT EVENTS
========================= */

client.once(
  Events.ClientReady,
  async () => {
    console.log(
      `[${nowIso()}] Bot ready: ${client.user.tag}`
    );

    await registerSlashCommands();

    await initialiseVampStandingTracking();

    await syncExistingEventsAndUsers(
      'startup'
    );

    await syncGuildMembers(
      'startup'
    );

    await syncRolesFromSheet(
      'startup'
    );

    setInterval(async () => {
      await syncExistingEventsAndUsers(
        'interval'
      );
    }, EVENT_SYNC_INTERVAL_MS);

    setInterval(async () => {
      await syncGuildMembers(
        'interval'
      );
    }, MEMBER_SYNC_INTERVAL_MS);

    setInterval(async () => {
      await syncRolesFromSheet(
        'interval'
      );
    }, ROLE_SYNC_INTERVAL_MS);

    setInterval(() => {
      saveActiveVampStandingProgress();
    }, VAMP_STANDING_SAVE_INTERVAL_MS);
  }
);

client.on(
  Events.InteractionCreate,
  async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.guildId !== GUILD_ID) {
      return;
    }

    if (
      interaction.commandName ===
      'setrsn'
    ) {
      await handleSetRsnCommand(
        interaction
      );

      return;
    }

    if (
      interaction.commandName ===
      'removersn'
    ) {
      await handleRemoveRsnCommand(
        interaction
      );

      return;
    }

    if (
      interaction.commandName ===
      'vampstanding'
    ) {
      await handleVampStandingCommand(
        interaction
      );

      return;
    }
  }
);

client.on(
  'guildScheduledEventCreate',
  async event => {
    if (event.guildId !== GUILD_ID) {
      return;
    }

    const interestedCount =
      await getInterestedCount(event);

    const payload =
      buildEventPayload(
        event,
        interestedCount
      );

    await sendWebhook({
      type: 'event_create',
      event: payload
    });

    upsertStoredEvent(payload);
    ensureAttendanceEvent(payload);
    updateAttendanceEventStatus(payload);

    const guild =
      await client.guilds.fetch(GUILD_ID);

    await captureCurrentVoiceMembersForEvent(
      guild,
      payload
    );
  }
);

client.on(
  'guildScheduledEventUpdate',
  async (_oldEvent, event) => {
    if (event.guildId !== GUILD_ID) {
      return;
    }

    const interestedCount =
      await getInterestedCount(event);

    const payload =
      buildEventPayload(
        event,
        interestedCount
      );

    await sendWebhook({
      type: 'event_update',
      event: payload
    });

    upsertStoredEvent(payload);
    ensureAttendanceEvent(payload);
    updateAttendanceEventStatus(payload);

    const guild =
      await client.guilds.fetch(GUILD_ID);

    await captureCurrentVoiceMembersForEvent(
      guild,
      payload
    );

    const subscribers =
      await fetchAllSubscribers(event);

    const users = await Promise.all(
      subscribers.map(
        async subscriber => {
          const member =
            await guild.members
              .fetch(subscriber.user.id)
              .catch(() => null);

          return {
            username:
              member
                ? member.displayName
                : (
                    subscriber.user
                      ?.username ||
                    ''
                  )
          };
        }
      )
    );

    await sendWebhook({
      type: 'sync_interest_snapshot',
      eventId: event.id,
      eventName: event.name,
      users: dedupeUsersByName(users)
    });
  }
);

client.on(
  'guildScheduledEventDelete',
  async event => {
    if (event.guildId !== GUILD_ID) {
      return;
    }

    const payload =
      buildEventPayload(event, 0);

    const now = Date.now();

    const startMs = safeDateMs(
      event.scheduledStartTimestamp
    );

    const endMs = safeDateMs(
      event.scheduledEndTimestamp
    );

    if (
      (
        startMs &&
        now >= startMs
      ) ||
      (
        endMs &&
        now >= endMs
      )
    ) {
      payload.status = 'Done';
      payload.rawStatusCode = 3;

      payload.statusSource =
        'bot_delete_finished';
    } else {
      payload.status = 'Cancelled';
      payload.rawStatusCode = 4;

      payload.statusSource =
        'bot_delete_cancelled';
    }

    await sendWebhook({
      type: 'event_update',
      event: payload
    });

    upsertStoredEvent(payload);

    markStoredEventStatus(
      event.id,
      payload.status,
      payload.rawStatusCode,
      payload.statusSource
    );

    ensureAttendanceEvent(payload);

    updateAttendanceEventStatus(
      payload
    );

    await sendWebhook({
      type: 'sync_interest_snapshot',
      eventId: event.id,
      eventName: event.name,
      users: []
    });

    await sendAttendanceSnapshot(
      event.id
    );

    console.log(
      `[${nowIso()}] Event removed: ${event.name} -> ${payload.status}`
    );
  }
);

client.on(
  'guildScheduledEventUserAdd',
  async (event, user) => {
    if (event.guildId !== GUILD_ID) {
      return;
    }

    const guild =
      await client.guilds.fetch(GUILD_ID);

    const displayName =
      await resolveDisplayName(
        guild,
        user.id,
        user.username
      );

    await sendWebhook({
      type: 'interest_add',
      eventId: event.id,
      eventName: event.name,
      username: displayName
    });

    const interestedCount =
      await getInterestedCount(event);

    const payload =
      buildEventPayload(
        event,
        interestedCount
      );

    await sendWebhook({
      type: 'event_update',
      event: payload
    });

    upsertStoredEvent(payload);
    ensureAttendanceEvent(payload);
    updateAttendanceEventStatus(payload);
  }
);

client.on(
  'guildScheduledEventUserRemove',
  async (event, user) => {
    if (event.guildId !== GUILD_ID) {
      return;
    }

    const guild =
      await client.guilds.fetch(GUILD_ID);

    const displayName =
      await resolveDisplayName(
        guild,
        user.id,
        user.username
      );

    await sendWebhook({
      type: 'interest_remove',
      eventId: event.id,
      eventName: event.name,
      username: displayName
    });

    const interestedCount =
      await getInterestedCount(event);

    const payload =
      buildEventPayload(
        event,
        interestedCount
      );

    await sendWebhook({
      type: 'event_update',
      event: payload
    });

    upsertStoredEvent(payload);
    ensureAttendanceEvent(payload);
    updateAttendanceEventStatus(payload);
  }
);

client.on(
  Events.PresenceUpdate,
  async (_oldPresence, newPresence) => {
    try {
      if (!newPresence) {
        return;
      }

      if (
        newPresence.guild?.id !==
        GUILD_ID
      ) {
        return;
      }

      if (
        newPresence.userId !==
        VAMPFIRE_USER_ID
      ) {
        return;
      }

      const atGrandExchange =
        updateVampPresenceTracking(
          newPresence,
          'discord_presence_update'
        );

      const activities =
        Array.isArray(
          newPresence.activities
        )
          ? newPresence.activities.map(
              activity => ({
                name:
                  activity.name || '',

                details:
                  activity.details || '',

                state:
                  activity.state || ''
              })
            )
          : [];

      console.log(
        `[${nowIso()}] Vampfire presence update: ${
          atGrandExchange
            ? 'Grand Exchange'
            : 'not Grand Exchange'
        } ${JSON.stringify(activities)}`
      );
    } catch (err) {
      console.log(
        `[${nowIso()}] Vampfire PresenceUpdate error: ${err.message}`
      );
    }
  }
);

client.on(
  Events.VoiceStateUpdate,
  async (oldState, newState) => {
    try {
      const member =
        newState.member ||
        oldState.member;

      const userId =
        member?.id;

      const username =
        member?.displayName ||
        member?.user?.username ||
        '';

      const oldChannelId =
        oldState.channelId;

      const newChannelId =
        newState.channelId;

      if (!userId) {
        return;
      }

      if (
        oldChannelId &&
        oldChannelId !== newChannelId
      ) {
        const oldEvent =
          getTrackedEventByChannel(
            oldChannelId
          );

        if (oldEvent) {
          removeAttendanceUser(
            oldEvent.eventId,
            userId
          );

          await sendLiveAttendanceSnapshot(
            oldEvent.eventId
          );
        }
      }

      if (newChannelId) {
        const newEvent =
          getTrackedEventByChannel(
            newChannelId
          );

        if (newEvent) {
          addAttendanceUser(
            newEvent.eventId,
            userId,
            username
          );

          await sendLiveAttendanceSnapshot(
            newEvent.eventId
          );
        }
      }
    } catch (err) {
      console.log(
        `[${nowIso()}] VoiceStateUpdate attendance error: ${err.message}`
      );
    }
  }
);

process.on('SIGTERM', () => {
  console.log(
    `[${nowIso()}] SIGTERM received, shutting down.`
  );

  closeVampStandingTracker(
    'SIGTERM'
  );

  client.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(
    `[${nowIso()}] SIGINT received, shutting down.`
  );

  closeVampStandingTracker(
    'SIGINT'
  );

  client.destroy();
  process.exit(0);
});

client.login(TOKEN);