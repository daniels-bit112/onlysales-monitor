/**
 * OnlySales 24/7 Monitoring Bot v2.0
 *
 * Features:
 *   - Socket.io connection to OnlySales CRM
 *   - Smart message classification (English + Spanish, edge cases)
 *   - 5-step lead qualification flow for interested leads
 *   - Slack interactive approvals (approve/edit/reject via buttons)
 *   - Auto warm-close for not-interested leads
 *   - HTTP server for Slack interaction payloads
 *
 * Usage:
 *   1. npm install
 *   2. Copy .env.example to .env and fill in your tokens
 *   3. node index.js
 */

const { io } = require('socket.io-client');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ============================================================
// CONFIGURATION
// ============================================================
require('dotenv').config();

const CONFIG = {
  // OnlySales API
  apiUrl: process.env.ONLYSALES_API_URL || 'https://api-temp.onlysales.io',
  accessToken: process.env.ONLYSALES_ACCESS_TOKEN || '',
  refreshToken: process.env.ONLYSALES_REFRESH_TOKEN || '',
  userId: process.env.ONLYSALES_USER_ID || '66f6f7e22cfd44889bf6b26e',
  appVersion: process.env.ONLYSALES_APP_VERSION || '2.38.2',

  // Slack
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',     // For interactive messages
  slackChannelId: process.env.SLACK_CHANNEL_ID || '',    // Channel to post to

  // Tag IDs
  notInterestedTagId: '66f7051ab1a7024acc4477b9',

  // Server
  port: process.env.PORT || 3000,

  // Intervals
  tokenRefreshIntervalMs: 60 * 60 * 1000,
  heartbeatIntervalMs: 90 * 1000,  // 90s ping interval (was 30s — too aggressive, caused disconnects)
  qualificationTimeoutMs: 24 * 60 * 60 * 1000, // 24h timeout for qualification
};

// ============================================================
// STATE
// ============================================================
let socket = null;
let currentAccessToken = CONFIG.accessToken;
let processedMessages = new Set();

// Lead qualification conversations: leadId -> { step, data, contact, lastActivity }
const qualificationFlows = new Map();

// Pending Slack approvals: actionId -> { leadId, draft, contact }
const pendingApprovals = new Map();

// Track active conversation to avoid duplicate conversationInit calls
let activeConversationLeadId = null;

// Dedup outgoing messages: "leadId:messageHash" -> timestamp
const recentSentMessages = new Map();

// Connection notification cooldown (prevents spam on flaky connections)
let lastConnectNotify = 0;
let lastDisconnectNotify = 0;
let disconnectTimer = null;
const CONNECTION_NOTIFY_COOLDOWN = 5 * 60 * 1000; // Only notify every 5 minutes max
const DISCONNECT_DELAY = 60 * 1000; // Wait 60s before sending disconnect notification

// ============================================================
// SLACK NOTIFICATIONS (webhook — for simple text messages)
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
          console.log('[Slack] Notification sent');
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
// SLACK BLOCK KIT (for interactive approval messages)
// ============================================================
function sendSlackBlocks(blocks, text) {
  return new Promise((resolve, reject) => {
    // If we have a bot token + channel, use chat.postMessage for interactivity
    if (CONFIG.slackBotToken && CONFIG.slackChannelId) {
      const payload = JSON.stringify({
        channel: CONFIG.slackChannelId,
        text: text || 'New lead notification',
        blocks,
      });

      const options = {
        hostname: 'slack.com',
        path: '/api/chat.postMessage',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.slackBotToken}`,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(payload),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.ok) {
              console.log('[Slack] Block message sent');
              resolve(parsed);
            } else {
              console.error('[Slack] Block error:', parsed.error);
              // Fallback to webhook
              sendSlackNotification(text).then(resolve).catch(reject);
            }
          } catch {
            reject(new Error('Failed to parse Slack response'));
          }
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    } else {
      // Fallback: use webhook with text only (no buttons)
      sendSlackNotification(text).then(resolve).catch(reject);
    }
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

      if (socket && socket.connected) {
        socket.auth = { token: currentAccessToken, version: CONFIG.appVersion };
      }
    } else {
      console.error('[Auth] Token refresh failed:', result.status, result.data);
      await sendSlackNotification('⚠️ *Token refresh failed* — Bot may disconnect soon. Please update tokens.');
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
// MESSAGE CLASSIFICATION v2 (English + Spanish + edge cases)
// ============================================================
function classifyMessage(content) {
  const lower = content.toLowerCase().trim();

  // Skip very short gibberish or single characters (except meaningful ones)
  if (lower.length === 1 && !['y', 'n', '?'].includes(lower)) {
    return 'unclear';
  }

  // === AGITATED / VULGAR ===
  const vulgarPatterns = [
    'fuck', 'shit', 'damn', 'hell no', 'ass', 'bitch', 'stfu', 'wtf', 'gtfo',
    'stop texting', 'stop calling', 'stop messaging', 'leave me alone',
    'do not contact', 'remove me', 'take me off', 'stop bothering',
    'how did you get my number', 'how you get my number',
    'reported', 'harassment', 'sue you', 'lawyer', 'attorney',
    'block you', 'blocking you', 'blocked',
    // Spanish agitated
    'no me llames', 'no me escribas', 'dejame en paz', 'déjame en paz',
    'no me molestes', 'deja de llamar', 'deja de escribir',
  ];
  for (const p of vulgarPatterns) {
    if (lower.includes(p)) return 'agitated';
  }

  // === COMPLAINT (firm but not vulgar) ===
  const complaintPatterns = [
    'too many calls', 'too many texts', 'too many messages',
    'stop sending', 'quit calling', 'quit texting',
    'spam', 'scam', 'unsubscribe', 'opt out', 'opt-out', 'optout',
    'wrong number', 'wrong person', 'who is this', 'who are you',
    'don\'t text me', 'dont text me', 'don\'t call me', 'dont call me',
    // Spanish complaints
    'numero equivocado', 'número equivocado', 'quien es', 'quién es',
    'no me interesa llamar', 'ya no llames',
  ];
  for (const p of complaintPatterns) {
    if (lower.includes(p)) return 'complaint';
  }
  if (lower === 'stop') return 'complaint';

  // === POLITE NOT INTERESTED ===
  const notInterestedPatterns = [
    'not interested', 'no thanks', 'no thank you', 'no thanx',
    'i\'m good', 'im good', 'i am good',
    'already have', 'already got', 'got a plan', 'have insurance',
    'have coverage', 'all set', 'i\'m set', 'im set',
    'don\'t need', 'dont need', 'do not need',
    'found insurance', 'found a plan', 'covered already',
    'already covered', 'have a plan', 'got insurance',
    'not looking', 'pass on', 'no need', 'i got',
    'good on insurance', 'taken care of', 'all taken care',
    'i\'ll pass', 'ill pass', 'not for me', 'not right now',
    'maybe later', 'not at this time',
    // Spanish not interested
    'no me interesa', 'ya tengo', 'ya tengo seguro', 'ya tengo plan',
    'no necesito', 'no gracias', 'estoy bien', 'ya estoy cubierto',
    'ya estoy cubierta', 'no busco', 'ya encontré',
  ];
  for (const p of notInterestedPatterns) {
    if (lower.includes(p)) return 'nice_no';
  }

  // Simple no variants
  const simpleNo = ['no', 'nah', 'nope', 'naw', 'na', 'nel', 'simon no', 'n'];
  if (simpleNo.includes(lower)) return 'nice_no';

  // === INTERESTED (explicit signals) ===
  const interestedPatterns = [
    'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay',
    'interested', 'tell me more', 'more info', 'information',
    'how much', 'price', 'cost', 'rate', 'rates',
    'what plans', 'what options', 'what do you have', 'what you got',
    'i need', 'i want', 'looking for', 'help me',
    'sign me up', 'enroll', 'apply', 'quote',
    'call me', 'give me a call', 'can you call',
    'when can', 'available', 'appointment',
    'family plan', 'individual plan', 'dental', 'vision', 'health',
    // Spanish interested
    'si', 'sí', 'claro', 'dime más', 'dime mas', 'me interesa',
    'cuánto cuesta', 'cuanto cuesta', 'qué planes', 'que planes',
    'necesito seguro', 'necesito ayuda', 'quiero', 'inscribir',
  ];
  for (const p of interestedPatterns) {
    if (lower.includes(p)) return 'interested';
  }

  // Single affirmative characters
  if (['y'].includes(lower)) return 'interested';

  // === QUESTION (ambiguous — might be interested) ===
  if (lower.includes('?') || lower.startsWith('what') || lower.startsWith('how') ||
      lower.startsWith('when') || lower.startsWith('where') || lower.startsWith('can') ||
      lower.startsWith('do you') || lower.startsWith('is there')) {
    return 'question';
  }

  // === UNCLEAR (can't tell — flag for review) ===
  return 'unclear';
}

// ============================================================
// 5-STEP LEAD QUALIFICATION FLOW
// ============================================================
const QUALIFICATION_STEPS = [
  {
    id: 'coverage_type',
    question: "Are you looking for health, dental, vision, or all of the above?",
    parse: (msg) => {
      const lower = msg.toLowerCase();
      const types = [];
      if (lower.includes('health') || lower.includes('salud')) types.push('Health');
      if (lower.includes('dental')) types.push('Dental');
      if (lower.includes('vision') || lower.includes('eye') || lower.includes('vista')) types.push('Vision');
      if (lower.includes('all') || lower.includes('everything') || lower.includes('todo') || lower.includes('todos')) {
        return { value: 'Health, Dental, Vision', valid: true };
      }
      if (types.length > 0) return { value: types.join(', '), valid: true };
      // Accept any response as valid since they might describe it differently
      return { value: msg.trim(), valid: true };
    },
  },
  {
    id: 'household',
    question: "Is this for just yourself or are you looking to cover family members too?",
    parse: (msg) => {
      const lower = msg.toLowerCase();
      if (lower.includes('just me') || lower.includes('myself') || lower.includes('solo') ||
          lower.includes('individual') || lower.includes('single') || lower === 'me') {
        return { value: 'Individual', valid: true };
      }
      if (lower.includes('family') || lower.includes('wife') || lower.includes('husband') ||
          lower.includes('kid') || lower.includes('child') || lower.includes('spouse') ||
          lower.includes('familia') || lower.includes('esposa') || lower.includes('hijo')) {
        return { value: 'Family', valid: true };
      }
      return { value: msg.trim(), valid: true };
    },
  },
  {
    id: 'age_range',
    question: "And how old are you? (If family, what are the ages of everyone who needs coverage?)",
    parse: (msg) => {
      // Accept anything with a number
      if (/\d/.test(msg)) return { value: msg.trim(), valid: true };
      return { value: msg.trim(), valid: true };
    },
  },
  {
    id: 'budget',
    question: "Do you have a monthly budget in mind, or would you like me to show you a range of options?",
    parse: (msg) => {
      return { value: msg.trim(), valid: true };
    },
  },
  {
    id: 'timeline',
    question: "When are you looking to get started? ASAP or a specific date?",
    parse: (msg) => {
      return { value: msg.trim(), valid: true };
    },
  },
];

function getQualificationFlow(leadId) {
  return qualificationFlows.get(leadId) || null;
}

function startQualificationFlow(leadId, contact) {
  const flow = {
    step: 0,
    data: {},
    contact,
    leadId,
    lastActivity: Date.now(),
  };
  qualificationFlows.set(leadId, flow);
  return flow;
}

async function handleQualificationStep(leadId, content, contact) {
  let flow = getQualificationFlow(leadId);

  if (!flow) {
    // Start new flow
    flow = startQualificationFlow(leadId, contact);

    // Send first question
    const firstStep = QUALIFICATION_STEPS[0];
    await sendMessage(leadId, firstStep.question, contact);
    console.log(`[Qualify] Started flow for ${leadId}, step 0: ${firstStep.id}`);

    await sendSlackNotification(
      `*Started qualification flow* for lead ${contact?.firstName || 'Unknown'}\n` +
      `Step 1/${QUALIFICATION_STEPS.length}: ${firstStep.id}`
    );
    return;
  }

  // Check for bail-out mid-flow
  const midFlowClassification = classifyMessage(content);
  if (['agitated', 'complaint', 'nice_no'].includes(midFlowClassification)) {
    // They want out — respect it
    qualificationFlows.delete(leadId);
    console.log(`[Qualify] Lead ${leadId} opted out during qualification (${midFlowClassification})`);

    if (midFlowClassification === 'nice_no') {
      const closer = getRandomCloser();
      await sendMessage(leadId, closer, contact);
      await addTagToContact(leadId, CONFIG.notInterestedTagId);
      await sendSlackNotification(
        `↩️ *${contact?.firstName || 'Unknown'}* opted out during qualification — warm closed & tagged`
      );
    } else {
      await addTagToContact(leadId, CONFIG.notInterestedTagId);
      await sendSlackNotification(
        `↩️ *${contact?.firstName || 'Unknown'}* opted out during qualification (${midFlowClassification}) — tagged, no reply`
      );
    }
    return;
  }

  // Parse current step answer
  const currentStep = QUALIFICATION_STEPS[flow.step];
  const parsed = currentStep.parse(content);
  flow.data[currentStep.id] = parsed.value;
  flow.lastActivity = Date.now();

  console.log(`[Qualify] Lead ${leadId} step ${flow.step} (${currentStep.id}): "${parsed.value}"`);

  // Move to next step
  flow.step++;

  if (flow.step < QUALIFICATION_STEPS.length) {
    // Send next question
    const nextStep = QUALIFICATION_STEPS[flow.step];
    await sendMessage(leadId, nextStep.question, contact);
    console.log(`[Qualify] Next step ${flow.step}: ${nextStep.id}`);
  } else {
    // Qualification complete — send summary to Slack for approval
    qualificationFlows.delete(leadId);

    const name = contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unknown' : 'Unknown';
    const phone = contact?.phoneNumber || 'unknown';
    const phoneProfileId = contact?.phoneProfiles?.[0] || contact?.defaultPhoneNumber || '';

    const summary =
      `*QUALIFIED LEAD: ${name}*\n` +
      `Phone: ${phone}\n` +
      `${contact?.city || ''}${contact?.state ? ', ' + contact.state : ''}\n\n` +
      `*Qualification Summary:*\n` +
      `- Coverage: ${flow.data.coverage_type || 'N/A'}\n` +
      `- Household: ${flow.data.household || 'N/A'}\n` +
      `- Age(s): ${flow.data.age_range || 'N/A'}\n` +
      `- Budget: ${flow.data.budget || 'N/A'}\n` +
      `- Timeline: ${flow.data.timeline || 'N/A'}\n\n` +
      `_Ready for you to call and close._`;

    // Send with approval buttons if possible, otherwise plain text
    const actionId = crypto.randomUUID();
    pendingApprovals.set(actionId, { leadId, contact, qualData: flow.data });

    if (CONFIG.slackBotToken && CONFIG.slackChannelId) {
      await sendSlackBlocks([
        {
          type: 'section',
          text: { type: 'mrkdwn', text: summary },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Mark as Called' },
              style: 'primary',
              action_id: `called_${actionId}`,
              value: JSON.stringify({ leadId, name, phone, phoneProfileId }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Remind Me Later' },
              action_id: `remind_${actionId}`,
              value: JSON.stringify({ leadId, name, phone, phoneProfileId }),
            },
          ],
        },
      ], summary);
    } else {
      await sendSlackNotification(summary);
    }

    // Send a holding message to the lead
    await sendMessage(leadId, "Thanks for all that info! Let me put together the best options for you. Someone will be in touch shortly!", contact);

    console.log(`[Qualify] Lead ${leadId} fully qualified. Summary sent to Slack.`);
  }
}

// Clean up stale qualification flows (24h timeout)
setInterval(() => {
  const now = Date.now();
  for (const [leadId, flow] of qualificationFlows) {
    if (now - flow.lastActivity > CONFIG.qualificationTimeoutMs) {
      qualificationFlows.delete(leadId);
      console.log(`[Qualify] Cleaned up stale flow for ${leadId}`);
    }
  }
}, 60 * 60 * 1000); // Check every hour

// ============================================================
// WARM CLOSER TEMPLATES
// ============================================================
const WARM_CLOSERS = [
  "No worries at all! If you ever need help with insurance down the road, feel free to reach out. Have a great day!",
  "No worries at all! Glad you got something in place. If you ever need to compare plans or want a second opinion, feel free to reach out. Have a great day!",
  "Totally understand! If anything changes or you want to explore other options in the future, don't hesitate to reach out. Have a wonderful day!",
  "No problem at all! If you ever want a second opinion on your coverage, I'm here to help. Have a great one!",
  "All good! Wishing you the best. If your situation ever changes, don't hesitate to reach out!",
  "Understood! Hope you're all set. Feel free to text back anytime if you need anything in the future!",
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

    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);

    // Keep set manageable
    if (processedMessages.size > 10000) {
      const arr = [...processedMessages];
      processedMessages = new Set(arr.slice(-5000));
    }

    // data.message can be an object with body/text/content, or a string
    const msg = data.message;
    const content = typeof msg === 'string' ? msg
      : (msg?.body || msg?.text || msg?.content || data.content || '');
    const leadId = data.leadId;
    const type = data.type || 'inbound'; // incoming-message events are always inbound

    // Log message details for debugging
    const msgType = (typeof msg === 'object' && msg?.type) || '';
    const rawDataType = (typeof msg === 'object' && msg?.rawDataType) || '';
    console.log(`[Handler] Data keys: ${Object.keys(data).join(',')}, msg.type=${msgType}, rawDataType=${rawDataType}`);
    console.log(`[Handler] message type: ${typeof msg}, content resolved: "${content}"`);
    if (typeof msg === 'object' && msg) {
      console.log(`[Handler] message keys: ${Object.keys(msg).join(',')}`);
    }

    // Skip if we recently sent this exact message to this lead (server echo dedup)
    const dedupKey = `${leadId}:${content}`;
    if (recentSentMessages.has(dedupKey)) {
      console.log(`[Handler] SKIPPING — matches recently sent outgoing message (echo from server)`);
      return;
    }

    if (type !== 'inbound') return;
    if (!String(content).trim()) return; // Skip empty messages

    console.log(`\n[Message] New inbound from lead ${leadId}: "${content}"`);

    const contact = await getContactInfo(leadId);
    // Try to get name from contact API, fall back to socket data
    let name = contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() : '';
    if (!name && data.lead) {
      name = `${data.lead.firstName || ''} ${data.lead.lastName || ''}`.trim();
    }
    if (!name) name = 'Unknown';
    const phone = contact?.phoneNumber || data.phoneNumber || data.phone || 'unknown';
    const phoneProfileId = contact?.phoneProfiles?.[0] || contact?.defaultPhoneNumber || data.phoneProfile || data.phone || '';
    const telnyxPhoneId = (typeof msg === 'object' && msg?.telnyxPhoneId) || '';
    console.log(`[Contact] leadId=${leadId}, name="${name}", phone="${phone}", phoneProfileId="${phoneProfileId}", telnyxPhoneId="${telnyxPhoneId}", contact API returned: ${contact ? 'yes' : 'null'}`);
    if (contact) {
      console.log(`[Contact] API keys: ${Object.keys(contact).join(',')}`);
      console.log(`[Contact] phoneProfiles: ${JSON.stringify(contact.phoneProfiles)}, defaultPhoneNumber: ${contact.defaultPhoneNumber}`);
      // Ensure contact has phone routing data
      if (!contact.phoneProfiles?.length && phoneProfileId) {
        contact.phoneProfiles = [phoneProfileId];
      }
      if (!contact.defaultPhoneNumber && phoneProfileId) {
        contact.defaultPhoneNumber = phoneProfileId;
      }
      // Store telnyxPhoneId for outbound messaging
      if (telnyxPhoneId) contact.telnyxPhoneId = telnyxPhoneId;
    }

    // Check if this lead is in a qualification flow
    if (qualificationFlows.has(leadId)) {
      await handleQualificationStep(leadId, content, contact);
      return;
    }

    // Classify the message
    const classification = classifyMessage(content);
    console.log(`[Classify] "${content}" → ${classification}`);

    switch (classification) {
      case 'complaint':
      case 'agitated':
      case 'nice_no': {
        await addTagToContact(leadId, CONFIG.notInterestedTagId);
        await sendSlackNotification(
          `*${name}* -- Tagged not interested\n"${content}"\n${phone}`
        );
        console.log(`[Action] Tagged ${name} not interested. No reply.`);
        break;
      }

      case 'interested': {
        // Start the qualification flow
        await sendMessage(leadId, "Hey! Thanks for reaching out. I'd love to help you find the right coverage. Let me ask a few quick questions so I can match you with the best options.", contact);
        await handleQualificationStep(leadId, null, contact);

        await sendSlackNotification(
          `*${name}* is interested -- Starting qualification flow.\n"${content}"\n${phone}`
        );
        console.log(`[Action] Started qualification for ${name}.`);
        break;
      }

      case 'question': {
        // Someone asking a question — likely interested, flag for approval
        const draft = generateDraft(content, contact);
        const actionId = crypto.randomUUID();
        pendingApprovals.set(actionId, { leadId, draft, contact });

        if (CONFIG.slackBotToken && CONFIG.slackChannelId) {
          await sendSlackBlocks([
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Question from ${name}*\n${phone}\n${contact?.city || ''}${contact?.state ? ', ' + contact.state : ''}\n\n"${content}"\n\nDraft: _"${draft}"_`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Send Draft' },
                  style: 'primary',
                  action_id: `approve_${actionId}`,
                  value: JSON.stringify({ leadId, name, phone, phoneProfileId, draft }),
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Start Qualification' },
                  action_id: `qualify_${actionId}`,
                  value: JSON.stringify({ leadId, name, phone, phoneProfileId }),
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Ignore' },
                  style: 'danger',
                  action_id: `ignore_${actionId}`,
                  value: JSON.stringify({ leadId, name, phoneProfileId }),
                },
              ],
            },
          ], `Question from ${name}: "${content}"`);
        } else {
          await sendSlackNotification(
            `*Question from ${name}*\n${phone}\n"${content}"\nDraft: "${draft}"\n_Needs your approval_`
          );
        }
        console.log(`[Action] Question from ${name} flagged for approval.`);
        break;
      }

      case 'unclear': {
        // Can't classify — flag for manual review
        const actionId = crypto.randomUUID();
        pendingApprovals.set(actionId, { leadId, contact, content });

        if (CONFIG.slackBotToken && CONFIG.slackChannelId) {
          await sendSlackBlocks([
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*Unclear message from ${name}*\n${phone}\n\n"${content}"\n\n_Couldn't classify -- needs your review_`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Start Qualification' },
                  style: 'primary',
                  action_id: `qualify_${actionId}`,
                  value: JSON.stringify({ leadId, name, phone, phoneProfileId }),
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Not Interested' },
                  action_id: `notinterested_${actionId}`,
                  value: JSON.stringify({ leadId, name, phoneProfileId }),
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'I\'ll Handle It' },
                  action_id: `ignore_${actionId}`,
                  value: JSON.stringify({ leadId, name, phoneProfileId }),
                },
              ],
            },
          ], `Unclear message from ${name}: "${content}"`);
        } else {
          await sendSlackNotification(
            `*Unclear message from ${name}*\n${phone}\n"${content}"\n_Needs manual review_`
          );
        }
        console.log(`[Action] Unclear message from ${name} — flagged for review.`);
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
async function sendMessage(leadId, message, contact) {
  const phoneId = contact?.phoneProfiles?.[0] || contact?.defaultPhoneNumber;

  if (!phoneId) {
    console.error(`[SendMsg] WARNING: No phoneId for lead ${leadId}. Contact keys: ${contact ? Object.keys(contact).join(',') : 'null'}`);
  }

  if (!socket || !socket.connected) {
    console.error('[SendMsg] Cannot send - socket not connected');
    return;
  }

  // Dedup: skip if same message was sent to same lead in last 10 seconds
  const dedupKey = `${leadId}:${message}`;
  const lastSent = recentSentMessages.get(dedupKey);
  if (lastSent && Date.now() - lastSent < 10000) {
    console.log(`[SendMsg] DEDUP: Skipping duplicate message to lead ${leadId}: "${message.substring(0, 40)}..."`);
    return;
  }
  recentSentMessages.set(dedupKey, Date.now());
  // Clean old entries
  if (recentSentMessages.size > 100) {
    const now = Date.now();
    for (const [k, t] of recentSentMessages) {
      if (now - t > 30000) recentSentMessages.delete(k);
    }
  }

  console.log(`[SendMsg] Sending to lead ${leadId}, phoneId=${phoneId}, msg="${message.substring(0, 50)}..."`);

  // Step 1: Initialize the conversation (wait for server ack before sending)
  if (activeConversationLeadId !== leadId) {
    try {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.log('[SendMsg] conversationInit: no callback after 3s, proceeding anyway');
          resolve();
        }, 3000);

        socket.emit('conversationInit', {
          leadId,
          phoneId,
          isTransferred: false,
        }, (response) => {
          clearTimeout(timeout);
          console.log(`[SendMsg] conversationInit ack received for lead ${leadId}`);
          resolve(response);
        });
      });
      activeConversationLeadId = leadId;
      console.log(`[SendMsg] Conversation initialized for lead ${leadId}`);
    } catch (err) {
      console.error(`[SendMsg] conversationInit error: ${err.message}`);
    }
  } else {
    console.log(`[SendMsg] Conversation already active for lead ${leadId}, skipping init`);
  }

  // Step 2: Send the message — plain emit, NO callback, NO volatile
  socket.emit('sendMessage', {
    message,
    scheduledAt: null,
    images: [],
  });

  console.log(`[SendMsg] sendMessage emitted for lead ${leadId}`);
}

// ============================================================
// DRAFT GENERATION
// ============================================================
function generateDraft(incomingMessage, contact) {
  const lower = incomingMessage.toLowerCase();

  if (lower.includes('price') || lower.includes('cost') || lower.includes('how much') ||
      lower.includes('rate') || lower.includes('cuanto') || lower.includes('cuánto')) {
    return "Great question! To find the best rates for you I'd just need a little info. Is this for just yourself or a family plan?";
  }

  if (lower.includes('plan') || lower.includes('option') || lower.includes('what do you have') ||
      lower.includes('que planes') || lower.includes('qué planes')) {
    return "I'd love to help you find the right plan! First off, would this be for just yourself or are you looking to cover family members too?";
  }

  if (lower.includes('yes') || lower.includes('sure') || lower.includes('interested') ||
      lower.includes('tell me more') || lower.includes('info') || lower.includes('si') || lower.includes('sí')) {
    return "Awesome! I'd love to help you out. Are you looking for coverage for just yourself or for your family too?";
  }

  if (lower.includes('call') || lower.includes('llamar') || lower.includes('llam')) {
    return "I'd be happy to give you a call! When works best for you?";
  }

  if (lower.includes('when') || lower.includes('open enrollment') || lower.includes('deadline')) {
    return "Great timing on checking! I can walk you through the current enrollment options. Are you looking for health, dental, or vision coverage?";
  }

  return "Hey, thanks for getting back to me! I'd love to help you find the right coverage. Quick question — would this be for just yourself or a family plan?";
}

// ============================================================
// HTTP SERVER (for Slack interactive payloads)
// ============================================================
function startHttpServer() {
  const server = http.createServer((req, res) => {
    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        socketConnected: socket?.connected || false,
        activeFlows: qualificationFlows.size,
        pendingApprovals: pendingApprovals.size,
      }));
      return;
    }

    // Slack interaction endpoint
    if (req.method === 'POST' && req.url === '/slack/interactions') {
      let body = '';
      req.on('data', (chunk) => body += chunk);
      req.on('end', async () => {
        try {
          // Slack sends payload as form-encoded
          const params = new URLSearchParams(body);
          const payload = JSON.parse(params.get('payload') || '{}');

          console.log('[Slack] Interaction received:', payload.type);

          if (payload.type === 'block_actions') {
            const action = payload.actions?.[0];
            if (!action) return;

            const actionParts = action.action_id.split('_');
            const actionType = actionParts[0];
            const actionId = actionParts.slice(1).join('_');

            let pending = pendingApprovals.get(actionId);

            // If not in memory (lost after redeploy), reconstruct from button value
            if (!pending) {
              console.log('[Slack] Action not in memory, reconstructing from button value');
              try {
                const buttonValue = JSON.parse(action.value || '{}');
                if (buttonValue.leadId) {
                  const contact = await getContactInfo(buttonValue.leadId);
                  // Build a fallback contact with phoneProfiles so sendMessage works
                  const fallbackContact = {
                    firstName: buttonValue.name,
                    phoneNumber: buttonValue.phone,
                    phoneProfiles: buttonValue.phoneProfileId ? [buttonValue.phoneProfileId] : [],
                    defaultPhoneNumber: buttonValue.phoneProfileId || buttonValue.phone,
                  };
                  // If API returned a contact, make sure it has phone info
                  if (contact && !contact.phoneProfiles?.length && !contact.defaultPhoneNumber) {
                    contact.phoneProfiles = fallbackContact.phoneProfiles;
                    contact.defaultPhoneNumber = fallbackContact.defaultPhoneNumber;
                  }
                  pending = {
                    leadId: buttonValue.leadId,
                    draft: buttonValue.draft || null,
                    contact: contact || fallbackContact,
                    content: buttonValue.content || '',
                  };
                  console.log(`[Slack] Reconstructed pending for lead ${buttonValue.leadId}, phoneProfileId: ${buttonValue.phoneProfileId}`);
                }
              } catch (parseErr) {
                console.log('[Slack] Could not parse button value:', parseErr.message);
              }
            }

            if (!pending) {
              console.log('[Slack] Action expired and could not reconstruct:', actionId);
              await respondToSlackInteraction(payload.response_url,
                '*This action has expired.* A new notification will appear next time this lead texts.'
              );
              res.writeHead(200);
              res.end();
              return;
            }

            const { leadId, draft, contact } = pending;

            switch (actionType) {
              case 'approve': {
                // Send the draft message
                if (draft) {
                  await sendMessage(leadId, draft, contact);
                  console.log(`[Slack] Approved and sent draft to ${leadId}`);
                }
                pendingApprovals.delete(actionId);

                // Update Slack message
                await respondToSlackInteraction(payload.response_url,
                  `*Approved* -- Message sent to ${contact?.firstName || 'lead'}.`
                );
                break;
              }

              case 'qualify': {
                // Start qualification flow for this lead
                const firstStep = QUALIFICATION_STEPS[0];
                await sendMessage(leadId, "Hey! I'd love to help you find the right coverage. Let me ask a few quick questions.", contact);

                const flow = startQualificationFlow(leadId, contact);
                await sendMessage(leadId, firstStep.question, contact);

                pendingApprovals.delete(actionId);

                await respondToSlackInteraction(payload.response_url,
                  `*Qualification started* for ${contact?.firstName || 'lead'}.`
                );
                break;
              }

              case 'notinterested': {
                await addTagToContact(leadId, CONFIG.notInterestedTagId);
                pendingApprovals.delete(actionId);

                await respondToSlackInteraction(payload.response_url,
                  `*Tagged not interested* -- ${contact?.firstName || 'lead'}. No reply sent.`
                );
                break;
              }

              case 'ignore': {
                pendingApprovals.delete(actionId);
                await respondToSlackInteraction(payload.response_url,
                  `*Got it* -- you'll handle ${contact?.firstName || 'this lead'} manually.`
                );
                break;
              }

              case 'called': {
                pendingApprovals.delete(actionId);
                await respondToSlackInteraction(payload.response_url,
                  `*Marked as called.*`
                );
                break;
              }

              case 'remind': {
                // Keep in pending, send reminder in 1 hour
                setTimeout(async () => {
                  const name = contact?.firstName || 'a lead';
                  await sendSlackNotification(`*Reminder* -- Follow up with *${name}*. ${contact?.phoneNumber || ''}`);
                }, 60 * 60 * 1000);

                await respondToSlackInteraction(payload.response_url,
                  `*Reminder set* -- pinging you in 1 hour about ${contact?.firstName || 'this lead'}.`
                );
                break;
              }
            }
          }

          res.writeHead(200);
          res.end();
        } catch (err) {
          console.error('[HTTP] Error handling interaction:', err);
          res.writeHead(200);
          res.end();
        }
      });
      return;
    }

    // Debug endpoint: GET /debug-contact?id=LEAD_ID
    if (req.url?.startsWith('/debug-contact') && req.method === 'GET') {
      (async () => {
        try {
          const url = new URL(req.url, `http://localhost`);
          const leadId = url.searchParams.get('id');
          if (!leadId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing ?id= parameter' }));
            return;
          }
          const contact = await getContactInfo(leadId);
          const result = {
            leadId,
            contactFound: !!contact,
            contactKeys: contact ? Object.keys(contact) : [],
            firstName: contact?.firstName || null,
            lastName: contact?.lastName || null,
            phoneNumber: contact?.phoneNumber || null,
            phoneProfiles: contact?.phoneProfiles || null,
            defaultPhoneNumber: contact?.defaultPhoneNumber || null,
            phone: contact?.phone || null,
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result, null, 2));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    // Diagnostic endpoint: GET /test-slack
    if (req.url === '/test-slack' && req.method === 'GET') {
      (async () => {
        const results = {};

        // Test 1: Socket status
        results.socket = {
          connected: socket?.connected || false,
          id: socket?.id || 'none',
        };

        // Test 2: Webhook
        try {
          await sendSlackNotification('*Test* -- Webhook is working.');
          results.webhook = 'OK';
        } catch (err) {
          results.webhook = `FAILED: ${err.message}`;
        }

        // Test 3: Bot token (chat.postMessage)
        try {
          await sendSlackBlocks(
            [{
              type: 'section',
              text: { type: 'mrkdwn', text: '*Test* -- Bot token and interactive buttons working.' },
            },
            {
              type: 'actions',
              elements: [{
                type: 'button',
                text: { type: 'plain_text', text: 'Looks good' },
                action_id: 'test_ok',
                style: 'primary',
              }],
            }],
            'Test — Bot token working!'
          );
          results.botToken = 'OK';
        } catch (err) {
          results.botToken = `FAILED: ${err.message}`;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(results, null, 2));
      })();
      return;
    }

    // 404 for everything else
    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(CONFIG.port, () => {
    console.log(`[HTTP] Server listening on port ${CONFIG.port}`);
  });

  return server;
}

function respondToSlackInteraction(responseUrl, text) {
  return new Promise((resolve, reject) => {
    const url = new URL(responseUrl);
    const payload = JSON.stringify({
      response_type: 'in_channel',
      replace_original: true,
      text,
    });

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
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

  socket.on('connect', () => {
    console.log(`[Socket] Connected! Socket ID: ${socket.id}`);

    // CRITICAL: Clear socket.io's send buffer on reconnect to prevent
    // buffered sendMessage packets from being replayed (causes double-send)
    if (socket.sendBuffer && socket.sendBuffer.length > 0) {
      console.log(`[Socket] Clearing ${socket.sendBuffer.length} buffered packets to prevent duplicates`);
      socket.sendBuffer = [];
    }

    // Cancel any pending disconnect notification (reconnected quickly)
    if (disconnectTimer) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
      console.log('[Socket] Reconnected before disconnect notification was sent — suppressed');
    }

    // Only send connect notification if enough time has passed
    const now = Date.now();
    if (now - lastConnectNotify > CONNECTION_NOTIFY_COOLDOWN) {
      lastConnectNotify = now;
      sendSlackNotification('*OnlySales Monitor Connected* -- Listening 24/7');
    } else {
      console.log('[Socket] Connected (notification suppressed — cooldown active)');
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Disconnected: ${reason}`);
    activeConversationLeadId = null; // Reset active conversation on disconnect
    if (reason !== 'io client disconnect') {
      // Delay disconnect notification — if we reconnect quickly, suppress it
      if (!disconnectTimer) {
        disconnectTimer = setTimeout(() => {
          disconnectTimer = null;
          const now = Date.now();
          if (now - lastDisconnectNotify > CONNECTION_NOTIFY_COOLDOWN) {
            lastDisconnectNotify = now;
            sendSlackNotification(`*Monitor Disconnected* -- ${reason}. Attempting to reconnect...`);
          }
        }, DISCONNECT_DELAY);
      }
    }
  });

  socket.on('connect_error', (err) => {
    console.error(`[Socket] Connection error: ${err.message}`);
  });

  // Debug: log ALL events from the server
  socket.onAny((eventName, ...args) => {
    console.log(`[Socket] EVENT: "${eventName}" — data keys: ${args[0] ? Object.keys(args[0]).join(',') : 'none'}`);
  });

  socket.on('incoming-message', (data) => {
    console.log('[Socket] incoming-message event received');
    handleIncomingMessage(data);
  });

  socket.on('conversation-log', (data) => {
    // Only log, do NOT re-process — incoming-message already handles inbound messages
    console.log(`[Socket] conversation-log event, type=${data?.type || 'unknown'}`);
  });

  socket.on('message-response', (data) => {
    console.log(`[Socket] Message response:`, data?.status || 'unknown');
  });

  socket.on('force-refresh', () => {
    console.log('[Socket] Force refresh - reconnecting...');
    socket.disconnect();
    setTimeout(connectSocket, 5000);
  });

  socket.on('force-logout', () => {
    console.error('[Socket] Force logout!');
    sendSlackNotification('*Force Logout* -- Update access token immediately!');
  });

  // Heartbeat: only emit ping (version emit was causing server to drop connection)
  setInterval(() => {
    if (socket.connected) {
      socket.emit('ping');
    }
  }, CONFIG.heartbeatIntervalMs);
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('========================================');
  console.log('  OnlySales 24/7 Monitor v2.0');
  console.log('========================================');
  console.log(`API URL: ${CONFIG.apiUrl}`);
  console.log(`User ID: ${CONFIG.userId}`);
  console.log(`Slack Webhook: ${CONFIG.slackWebhookUrl ? 'Configured' : 'Missing'}`);
  console.log(`Slack Bot Token: ${CONFIG.slackBotToken ? 'Configured' : 'Not set (webhook-only mode)'}`);
  console.log(`HTTP Port: ${CONFIG.port}`);
  console.log('');

  if (!CONFIG.accessToken) {
    console.error('ERROR: ONLYSALES_ACCESS_TOKEN is required');
    process.exit(1);
  }

  if (!CONFIG.slackWebhookUrl) {
    console.error('ERROR: SLACK_WEBHOOK_URL is required');
    process.exit(1);
  }

  // Start HTTP server (for health checks + Slack interactions)
  startHttpServer();

  // Connect to Socket.io
  connectSocket();

  // Token refresh
  setInterval(refreshAccessToken, CONFIG.tokenRefreshIntervalMs);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Shutdown] Disconnecting...');
    sendSlackNotification('*OnlySales Monitor Shutting Down*').finally(() => {
      socket?.disconnect();
      process.exit(0);
    });
  });

  process.on('SIGTERM', () => {
    console.log('\n[Shutdown] SIGTERM received...');
    socket?.disconnect();
    process.exit(0);
  });

  console.log('[Main] Bot v2.0 is running. Press Ctrl+C to stop.\n');
}

main().catch(console.error);
