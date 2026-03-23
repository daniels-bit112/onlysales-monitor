/**
 * OnlySales 24/7 Monitoring Bot
 *
 * Connects to OnlySales CRM via Socket.io, listens for incoming messages,
 * auto-responds to "not interested" leads, and notifies Daniel via Slack webhook
 * for interested leads that need approval.
 *
 * Usage:
 *   1. npm install
 *   2. Copy .env.example to .env and fill in your tokens
 *   3. node index.js
 */

const { io } = require('socket.io-client');
const https = require('https');
const http = require('http');

// ============================================================
// CONFIGURATION (loaded from .env or environment variables)
// ============================================================
require('dotenv').config();

const CONFIG = {
  // OnlySales API
  apiUrl: process.env.ONLYSALES_API_URL || 'https://api-temp.onlysales.io',
  accessToken: process.env.ONLYSALES_ACCESS_TOKEN || '',
  refreshToken: process.env.ONLYSALES_REFRESH_TOKEN || '',
  userId: process.env.ONLYSALES_USER_ID || '66f6f7e22cfd44889bf6b26e',
  appVersion: process.env.ONLYSALES_APP_VERSION || '2.38.2',

  // Slack Webhook
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',

  // Tag IDs (from OnlySales)
  notInterestedTagId: '66f7051ab1a7024acc4477b9', // "not interested / found insurance"

  // Monitoring
  tokenRefreshIntervalMs: 60 * 60 * 1000, // Refresh token every hour
  heartbeatIntervalMs: 30 * 1000, // Ping every 30 seconds
};

// ============================================================
// STATE
// ============================================================
let socket = null;
let currentAccessToken = CONFIG.accessToken;
let processedMessages = new Set(); // Track processed message IDs

// ============================================================
// SLACK NOTIFICATIONS
// ============================================================
function sendSlackNotification(message) {
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.slackWebhookUrl);
    const payload = JSON.stringify({ text: message });

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('[Slack] Notification sent successfully');
          resolve(data);
        } else {
          console.error(`[Slack] Error: ${res.statusCode} - ${data}`);
          reject(new Error(`Slack error: ${res.statusCode}`));
        }
      });
    });

    req.on('error', (err) => {
      console.error('[Slack] Request error:', err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

// ============================================================
// ONLYSALES REST API
// ============================================================
function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, CONFIG.apiUrl);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${currentAccessToken}`,
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function refreshAccessToken() {
  try {
    console.log('[Auth] Refreshing access token...');
    const result = await apiRequest('POST', '/jwt/refresh-token', {
      refreshToken: CONFIG.refreshToken,
    });

    if (result.status === 200 && result.data.accessToken) {
      currentAccessToken = result.data.accessToken;
      if (result.data.refreshToken) {
        CONFIG.refreshToken = result.data.refreshToken;
      }
      console.log('[Auth] Token refreshed successfully');

      // Reconnect socket with new token
      if (socket && socket.connected) {
        socket.auth = { token: currentAccessToken, version: CONFIG.appVersion };
      }
    } else {
      console.error('[Auth] Token refresh failed:', result.status, result.data);
    }
  } catch (err) {
    console.error('[Auth] Token refresh error:', err.message);
  }
}

async function getContactInfo(contactId) {
  try {
    const result = await apiRequest('GET', `/contact/${contactId}`);
    if (result.status === 200) {
      return result.data.data || result.data;
    }
  } catch (err) {
    console.error('[API] Error fetching contact:', err.message);
  }
  return null;
}

async function addTagToContact(contactId, tagId) {
  try {
    const result = await apiRequest('PUT', `/contact/${contactId}`, {
      tags: [tagId],
    });
    console.log(`[Tags] Tag added to contact ${contactId}:`, result.status);
    return result.status === 200;
  } catch (err) {
    console.error('[Tags] Error adding tag:', err.message);
    return false;
  }
}

// ============================================================
// MESSAGE CLASSIFICATION
// ============================================================
function classifyMessage(content) {
  const lower = content.toLowerCase().trim();

  // Vulgar / agitated patterns
  const vulgarPatterns = [
    'fuck', 'shit', 'damn', 'hell', 'ass', 'bitch', 'stfu',
    'stop texting', 'stop calling', 'stop messaging', 'leave me alone',
    'do not contact', 'remove me', 'take me off', 'stop bothering',
    'how did you get my number', 'reported', 'harassment',
  ];
  for (const pattern of vulgarPatterns) {
    if (lower.includes(pattern)) return 'agitated';
  }

  // Complaint about calls/texts
  const complaintPatterns = [
    'too many calls', 'too many texts', 'stop sending', 'quit calling',
    'spam', 'scam', 'unsubscribe', 'opt out', 'opt-out',
  ];
  for (const pattern of complaintPatterns) {
    if (lower.includes(pattern)) return 'complaint';
  }

  // Polite not interested
  const notInterestedPatterns = [
    'not interested', 'no thanks', 'no thank you', "i'm good",
    'already have', 'already got', 'got a plan', 'have insurance',
    'have coverage', 'all set', "i'm set", "don't need",
    'found insurance', 'found a plan', 'covered already',
    'already covered', 'have a plan', 'got insurance',
    'not looking', 'pass', 'no need', 'i got',
  ];
  for (const pattern of notInterestedPatterns) {
    if (lower.includes(pattern)) return 'nice_no';
  }

  // Simple no
  if (lower === 'no' || lower === 'nah' || lower === 'nope') return 'nice_no';

  // Stop / opt out
  if (lower === 'stop') return 'complaint';

  // Default: potentially interested
  return 'interested';
}

// ============================================================
// WARM CLOSER TEMPLATES (no names included)
// ============================================================
const WARM_CLOSERS = [
  "No worries at all! If you ever need help with insurance down the road, feel free to reach out. Have a great day!",
  "No worries at all! Glad you got something in place. If you ever need to compare plans or want a second opinion, feel free to reach out. Have a great day!",
  "Totally understand! If anything changes or you want to explore other options in the future, don't hesitate to reach out. Have a wonderful day!",
  "No problem at all! If you ever want a second opinion on your coverage, I'm here to help. Have a great one!",
];

function getRandomCloser() {
  return WARM_CLOSERS[Math.floor(Math.random() * WARM_CLOSERS.length)];
}

// ============================================================
// MESSAGE HANDLER
// ============================================================
async function handleIncomingMessage(data) {
  try {
    const messageId = data._id || data.id || `${data.leadId}-${Date.now()}`;

    // Skip if already processed
    if (processedMessages.has(messageId)) {
      return;
    }
    processedMessages.add(messageId);

    // Keep set from growing too large
    if (processedMessages.size > 10000) {
      const arr = [...processedMessages];
      processedMessages = new Set(arr.slice(-5000));
    }

    const content = data.content || data.message || '';
    const leadId = data.leadId;
    const type = data.type;

    // Only handle inbound messages
    if (type !== 'inbound') return;

    console.log(`\n[Message] New inbound from lead ${leadId}: "${content}"`);

    // Get contact info
    const contact = await getContactInfo(leadId);
    const name = contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() : 'Unknown';
    const phone = contact?.phoneNumber || 'unknown';

    // Classify the message
    const classification = classifyMessage(content);
    console.log(`[Classify] "${content}" → ${classification}`);

    switch (classification) {
      case 'complaint': {
        // Tag as not interested, no reply
        await addTagToContact(leadId, CONFIG.notInterestedTagId);
        await sendSlackNotification(
          `🏷️ *${name}* — Tagged as not interested (complained about calls/texts)\nTheir message: "${content}"`
        );
        console.log(`[Action] Tagged ${name} as not interested (complaint). No reply sent.`);
        break;
      }

      case 'agitated': {
        // Tag as not interested, no reply
        await addTagToContact(leadId, CONFIG.notInterestedTagId);
        await sendSlackNotification(
          `🏷️ *${name}* — Tagged not interested (agitated/vulgar, no reply sent)\nTheir message: "${content}"`
        );
        console.log(`[Action] Tagged ${name} as not interested (agitated). No reply sent.`);
        break;
      }

      case 'nice_no': {
        // Send warm closer + tag
        const closer = getRandomCloser();
        sendMessage(leadId, closer, contact);
        await addTagToContact(leadId, CONFIG.notInterestedTagId);
        await sendSlackNotification(
          `✅ *${name}* — Auto-sent warm closer & tagged "not interested"\nTheir message: "${content}"\nOur reply: "${closer}"`
        );
        console.log(`[Action] Sent warm closer to ${name} and tagged not interested.`);
        break;
      }

      case 'interested': {
        // Draft a response and send to Slack for approval
        const draft = generateDraft(content, contact);
        await sendSlackNotification(
          `📋 *NEW LEAD: ${name}*\n` +
          `📱 Phone: ${phone}\n` +
          `📍 ${contact?.city || ''}${contact?.state ? ', ' + contact.state : ''}\n` +
          `💬 Their message: "${content}"\n\n` +
          `✏️ Draft response: "${draft}"\n\n` +
          `⚠️ _This needs your approval — reply in the OnlySales app to send._`
        );
        console.log(`[Action] Flagged ${name} for approval. Draft: "${draft}"`);
        break;
      }
    }
  } catch (err) {
    console.error('[Handler] Error processing message:', err);
    try {
      await sendSlackNotification(`⚠️ *Error processing message*: ${err.message}`);
    } catch { }
  }
}

// ============================================================
// SEND MESSAGE VIA SOCKET
// ============================================================
function sendMessage(leadId, message, contact) {
  if (!socket || !socket.connected) {
    console.error('[Socket] Cannot send message - not connected');
    return;
  }

  // Get the phone profile ID for this contact
  const phoneId = contact?.phoneProfiles?.[0] || contact?.defaultPhoneNumber;

  socket.emit('sendMessage', {
    leadId,
    phoneId,
    message,
    scheduledAt: null,
    images: [],
  });

  console.log(`[Socket] Message sent to lead ${leadId}`);
}

// ============================================================
// DRAFT GENERATION (for interested leads)
// ============================================================
function generateDraft(incomingMessage, contact) {
  const lower = incomingMessage.toLowerCase();

  // Check if they're asking about pricing
  if (lower.includes('price') || lower.includes('cost') || lower.includes('how much') || lower.includes('rate')) {
    return "Great question! To find the best rates for you I'd just need a little info. Is this for just yourself or a family plan?";
  }

  // Check if they're asking about plans
  if (lower.includes('plan') || lower.includes('option') || lower.includes('what do you have')) {
    return "I'd love to help you find the right plan! First off, would this be for just yourself or are you looking to cover family members too?";
  }

  // Check if they express interest
  if (lower.includes('yes') || lower.includes('sure') || lower.includes('interested') || lower.includes('tell me more') || lower.includes('info')) {
    return "Awesome! I'd love to help you out. First question — are you looking for coverage for just yourself or for your family too?";
  }

  // Generic interested response
  return "Hey, thanks for getting back to me! I'd love to help you find the right coverage. Quick question — would this be for just yourself or a family plan?";
}

// ============================================================
// SOCKET CONNECTION
// ============================================================
function connectSocket() {
  console.log('[Socket] Connecting to OnlySales...');

  socket = io(CONFIG.apiUrl, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: {
      token: currentAccessToken,
      version: CONFIG.appVersion,
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 5000,
    reconnectionDelayMax: 30000,
  });

  // Connection events
  socket.on('connect', () => {
    console.log(`[Socket] Connected! Socket ID: ${socket.id}`);
    sendSlackNotification('🟢 *OnlySales Monitor Connected* — Listening for incoming messages 24/7');
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Disconnected: ${reason}`);
    if (reason !== 'io client disconnect') {
      sendSlackNotification(`🔴 *OnlySales Monitor Disconnected* — Reason: ${reason}. Reconnecting...`);
    }
  });

  socket.on('connect_error', (err) => {
    console.error(`[Socket] Connection error: ${err.message}`);
  });

  // Listen for incoming messages
  socket.on('$incoming-message', (data) => {
    console.log('[Socket] $incoming-message event received');
    handleIncomingMessage(data);
  });

  // Listen for conversation log updates (backup listener)
  socket.on('$conversation-log', (data) => {
    if (data?.type === 'inbound') {
      console.log('[Socket] $conversation-log inbound event');
      handleIncomingMessage(data);
    }
  });

  // Listen for message responses (confirmation of sent messages)
  socket.on('$message-response', (data) => {
    console.log(`[Socket] Message response:`, data?.status || 'unknown');
  });

  // Force refresh (app update)
  socket.on('$force-refresh', () => {
    console.log('[Socket] Force refresh requested - reconnecting...');
    socket.disconnect();
    setTimeout(connectSocket, 5000);
  });

  // Force logout
  socket.on('$force-logout', () => {
    console.error('[Socket] Force logout! Token may be invalid.');
    sendSlackNotification('🚨 *OnlySales Monitor Force Logout* — Please update the access token!');
  });

  // Heartbeat
  setInterval(() => {
    if (socket.connected) {
      socket.emit('ping');
      socket.emit('version');
    }
  }, CONFIG.heartbeatIntervalMs);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('========================================');
  console.log('  OnlySales 24/7 Monitoring Bot');
  console.log('========================================');
  console.log(`API URL: ${CONFIG.apiUrl}`);
  console.log(`User ID: ${CONFIG.userId}`);
  console.log(`Slack Webhook: ${CONFIG.slackWebhookUrl ? '✅ Configured' : '❌ Missing'}`);
  console.log('');

  if (!CONFIG.accessToken) {
    console.error('ERROR: ONLYSALES_ACCESS_TOKEN is required. Set it in .env');
    process.exit(1);
  }

  if (!CONFIG.slackWebhookUrl) {
    console.error('ERROR: SLACK_WEBHOOK_URL is required. Set it in .env');
    process.exit(1);
  }

  // Connect to Socket.io
  connectSocket();

  // Set up token refresh interval
  setInterval(refreshAccessToken, CONFIG.tokenRefreshIntervalMs);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Shutdown] Disconnecting...');
    sendSlackNotification('🔴 *OnlySales Monitor Shutting Down*').finally(() => {
      socket?.disconnect();
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    console.log('\n[Shutdown] SIGTERM received...');
    socket?.disconnect();
    process.exit(0);
  });

  console.log('[Main] Bot is running. Press Ctrl+C to stop.\n');
}

main().catch(console.error);
