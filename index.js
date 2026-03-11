require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const TOKEN = process.env.DISCORD_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SECRET = process.env.WEBHOOK_SECRET;
const GUILD_ID = process.env.GUILD_ID;

const EVENT_SYNC_INTERVAL_MS = Number(process.env.EVENT_SYNC_INTERVAL_MS || 15 * 60 * 1000);
const MEMBER_SYNC_INTERVAL_MS = Number(process.env.MEMBER_SYNC_INTERVAL_MS || 6 * 60 * 60 * 1000);
const WEBHOOK_RETRIES = Number(process.env.WEBHOOK_RETRIES || 3);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function sendWebhook(data) {
  let attempt = 0;
  let lastError = null;

  while (attempt < WEBHOOK_RETRIES) {
    attempt += 1;

    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: SECRET,
          ...data
        })
      });

      const text = await res.text();

      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}: ${text}`);
        console.log(`[${nowIso()}] Webhook failed ${attempt}/${WEBHOOK_RETRIES}: ${lastError.message}`);
        await sleep(500 * attempt);
        continue;
      }

      console.log(`[${nowIso()}] Webhook ok (${data.type})`);
      return true;
    } catch (err) {
      lastError = err;
      console.log(`[${nowIso()}] Webhook error ${attempt}/${WEBHOOK_RETRIES}: ${err.message}`);
      await sleep(500 * attempt);
    }
  }

  console.log(`[${nowIso()}] Webhook permanently failed (${data.type}): ${lastError ? lastError.message : 'Unknown error'}`);
  return false;
}

function formatDuration(startMs, endMs) {
  if (!startMs || !endMs || endMs <= startMs) return '';

  const totalMinutes = Math.floor((endMs - startMs) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function mapDiscordStatus(eventStatus) {
  switch (Number(eventStatus || 0)) {
    case 1: return 'Not Started';
    case 2: return 'Started';
    case 3: return 'Done';
    case 4: return 'Cancelled';
    default: return 'Unknown';
  }
}

function buildEventPayload(event, interestedCount) {
  const startMs = event.scheduledStartTimestamp || '';
  const endMs = event.scheduledEndTimestamp || '';
  const uniqueInterested = Number(interestedCount || 0);

  return {
    id: event.id,
    name: event.name || '',
    startTime: startMs || '',
    endTime: endMs || '',
    duration: formatDuration(startMs, endMs),
    status: mapDiscordStatus(event.status),
    channelId: event.channelId || '',
    interestedCount: uniqueInterested,
    uniqueInterested: uniqueInterested,
    url: `https://discord.com/events/${event.guildId}/${event.id}`
  };
}

async function fetchAllSubscribers(event) {
  const subscribers = [];
  let lastId = null;

  while (true) {
    const batch = await event.fetchSubscribers({
      limit: 100,
      withMember: true,
      after: lastId || undefined
    });

    if (!batch || batch.size === 0) break;

    for (const [, subscriber] of batch) {
      subscribers.push(subscriber);
    }

    const ids = [...batch.keys()];
    lastId = ids[ids.length - 1];

    if (batch.size < 100) break;
  }

  return subscribers;
}

async function getInterestedCount(event) {
  if (typeof event.userCount === 'number') {
    return event.userCount;
  }

  try {
    const subscribers = await fetchAllSubscribers(event);
    return subscribers.length;
  } catch (err) {
    console.log(`[${nowIso()}] Could not fetch subscribers for ${event.name}: ${err.message}`);
    return 0;
  }
}

async function resolveDisplayName(guild, userId, fallbackUsername) {
  try {
    const member = await guild.members.fetch(userId);
    return member ? member.displayName : fallbackUsername;
  } catch {
    return fallbackUsername;
  }
}

function dedupeUsersByName(users) {
  const seen = new Set();
  const output = [];

  for (const u of users) {
    const username = String(u.username || '').trim();
    if (!username) continue;

    const key = username.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    output.push({ username });
  }

  return output;
}

async function syncSingleEvent(guild, event) {
  const subscribers = await fetchAllSubscribers(event);
  const interestedCount =
    typeof event.userCount === 'number'
      ? event.userCount
      : subscribers.length;

  await sendWebhook({
    type: 'sync_event',
    event: buildEventPayload(event, interestedCount)
  });

  const users = [];
  for (const subscriber of subscribers) {
    const fallback = subscriber.user?.username || '';
    const displayName = await resolveDisplayName(guild, subscriber.user.id, fallback);
    users.push({ username: displayName });
  }

  await sendWebhook({
    type: 'sync_interest_snapshot',
    eventId: event.id,
    eventName: event.name,
    users: dedupeUsersByName(users)
  });

  console.log(`[${nowIso()}] Synced event: ${event.name} (${interestedCount} interested)`);
}

async function syncExistingEventsAndUsers(reason = 'manual') {
  console.log(`[${nowIso()}] Event sync started (${reason})`);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const events = await guild.scheduledEvents.fetch({ withUserCount: true });

    console.log(`[${nowIso()}] Found ${events.size} scheduled event(s)`);

    for (const [, event] of events) {
      await syncSingleEvent(guild, event);
    }

    console.log(`[${nowIso()}] Event sync finished (${reason})`);
  } catch (err) {
    console.log(`[${nowIso()}] Event sync failed (${reason}): ${err.message}`);
  }
}

async function syncGuildMembers(reason = 'manual') {
  console.log(`[${nowIso()}] Member sync started (${reason})`);

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const members = await guild.members.fetch();

    const payload = [];
    members.forEach(member => {
      payload.push({
        discordId: member.id,
        displayName: member.displayName,
        username: member.user?.username || ''
      });
    });

    await sendWebhook({
      type: 'member_snapshot',
      members: payload
    });

    console.log(`[${nowIso()}] Synced ${payload.length} guild members`);
  } catch (err) {
    console.log(`[${nowIso()}] Member sync failed (${reason}): ${err.message}`);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`[${nowIso()}] Bot ready: ${client.user.tag}`);

  await syncExistingEventsAndUsers('startup');
  await syncGuildMembers('startup');

  setInterval(async () => {
    await syncExistingEventsAndUsers('interval');
  }, EVENT_SYNC_INTERVAL_MS);

  setInterval(async () => {
    await syncGuildMembers('interval');
  }, MEMBER_SYNC_INTERVAL_MS);
});

client.on('guildScheduledEventCreate', async (event) => {
  if (event.guildId !== GUILD_ID) return;

  const interestedCount = await getInterestedCount(event);

  await sendWebhook({
    type: 'event_create',
    event: buildEventPayload(event, interestedCount)
  });
});

client.on('guildScheduledEventUpdate', async (_oldEvent, event) => {
  if (event.guildId !== GUILD_ID) return;

  const interestedCount = await getInterestedCount(event);

  await sendWebhook({
    type: 'event_update',
    event: buildEventPayload(event, interestedCount)
  });

  const subscribers = await fetchAllSubscribers(event);
  const guild = await client.guilds.fetch(GUILD_ID);

  await sendWebhook({
    type: 'sync_interest_snapshot',
    eventId: event.id,
    eventName: event.name,
    users: await Promise.all(
      subscribers.map(async (subscriber) => {
        const member = await guild.members.fetch(subscriber.user.id).catch(() => null);
        return {
          username: member ? member.displayName : (subscriber.user?.username || '')
        };
      })
    )
  });
});

client.on('guildScheduledEventDelete', async (event) => {
  if (event.guildId !== GUILD_ID) return;

  const payload = buildEventPayload(event, 0);
  payload.status = 'Cancelled';

  await sendWebhook({
    type: 'event_update',
    event: payload
  });

  await sendWebhook({
    type: 'sync_interest_snapshot',
    eventId: event.id,
    eventName: event.name,
    users: []
  });

  console.log(`[${nowIso()}] Event cancelled/deleted: ${event.name}`);
});

client.on('guildScheduledEventUserAdd', async (event, user) => {
  if (event.guildId !== GUILD_ID) return;

  const guild = await client.guilds.fetch(GUILD_ID);
  const displayName = await resolveDisplayName(guild, user.id, user.username);

  await sendWebhook({
    type: 'interest_add',
    eventId: event.id,
    eventName: event.name,
    username: displayName
  });

  const interestedCount = await getInterestedCount(event);

  await sendWebhook({
    type: 'event_update',
    event: buildEventPayload(event, interestedCount)
  });
});

client.on('guildScheduledEventUserRemove', async (event, user) => {
  if (event.guildId !== GUILD_ID) return;

  const guild = await client.guilds.fetch(GUILD_ID);
  const displayName = await resolveDisplayName(guild, user.id, user.username);

  await sendWebhook({
    type: 'interest_remove',
    eventId: event.id,
    eventName: event.name,
    username: displayName
  });

  const interestedCount = await getInterestedCount(event);

  await sendWebhook({
    type: 'event_update',
    event: buildEventPayload(event, interestedCount)
  });
});

process.on('SIGTERM', () => {
  console.log(`[${nowIso()}] SIGTERM received, shutting down.`);
  client.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log(`[${nowIso()}] SIGINT received, shutting down.`);
  client.destroy();
  process.exit(0);
});

client.login(TOKEN);