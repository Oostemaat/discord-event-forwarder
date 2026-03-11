require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const TOKEN = process.env.DISCORD_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const SECRET = process.env.WEBHOOK_SECRET;
const GUILD_ID = process.env.GUILD_ID;

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

async function sendWebhook(data) {
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
    console.log('Webhook status:', res.status);
    console.log('Webhook response:', text);
  } catch (err) {
    console.log('Webhook error:', err);
  }
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

function getDisplayStatus(event) {
  const discordStatus = Number(event.status || 0);
  const now = Date.now();
  const startMs = event.scheduledStartTimestamp || null;
  const endMs = event.scheduledEndTimestamp || null;

  // Discord-cancelled should always stay cancelled
  if (discordStatus === 4) return 'Cancelled';

  // If Discord explicitly says completed, trust it
  if (discordStatus === 3) return 'Done';

  // Time-based fallback for better sheet display
  if (startMs && now < startMs) return 'Not Started';
  if (endMs && now >= endMs) return 'Done';
  if (startMs && now >= startMs) return 'Started';

  // Last fallback to Discord status if no useful times exist
  switch (discordStatus) {
    case 1: return 'Not Started';
    case 2: return 'Started';
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
    status: getDisplayStatus(event),
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
    console.log(`Could not fetch subscribers for ${event.name}:`, err.message);
    return 0;
  }
}

async function syncExistingEventsAndUsers() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const events = await guild.scheduledEvents.fetch({ withUserCount: true });

    console.log(`Startup sync: found ${events.size} scheduled event(s)`);

    for (const [, event] of events) {
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
        const member = await guild.members
          .fetch(subscriber.user.id)
          .catch(() => null);

        const displayName = member
          ? member.displayName
          : subscriber.user?.username || '';

        users.push({
          username: displayName
        });
      }

      await sendWebhook({
        type: 'sync_interest_snapshot',
        eventId: event.id,
        eventName: event.name,
        users
      });

      console.log(`Synced event: ${event.name} (${interestedCount} interested)`);
    }
  } catch (err) {
    console.log('Startup sync failed:', err);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Bot ready: ${client.user.tag}`);

  await syncExistingEventsAndUsers();

  setInterval(async () => {
    console.log('Running scheduled sync...');
    await syncExistingEventsAndUsers();
  }, 15 * 60 * 1000);
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
        const member = await guild.members
          .fetch(subscriber.user.id)
          .catch(() => null);

        return {
          username: member ? member.displayName : (subscriber.user?.username || '')
        };
      })
    )
  });
});

client.on('guildScheduledEventUserAdd', async (event, user) => {
  if (event.guildId !== GUILD_ID) return;

  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(user.id).catch(() => null);
  const displayName = member ? member.displayName : user.username;

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
  const member = await guild.members.fetch(user.id).catch(() => null);
  const displayName = member ? member.displayName : user.username;

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

client.login(TOKEN);