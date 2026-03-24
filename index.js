/**
 * OnlySales 24/7 Monitoring Bot v2.1
 *
 * Flow:
 *   1. Lead texts in → classify message
 *   2. Not interested (agitated/complaint/polite no) → auto-tag "not interested", no reply
 *   3. Positive (interested/question/unclear) → tag "positive", draft context-aware reply,
 *      send to Slack for approval with Send / Not Interested / I'll Handle It buttons
 *   4. You approve → draft sent to lead, qualification flow starts automatically
 *   5. Qualification: coverage_for → (family DOB if needed) → preexisting → providers → tax status → income
 *      - Pre-scans lead's messages to skip questions they already answered
 *      - Forward-scans each reply to catch multi-answer responses
 *      - Natural acknowledgments between questions
 *   6. Qualified → summary sent to Slack with Mark as Called / Remind Me Later
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
  slackUserId: process.env.SLACK_USER_ID || 'U0AN7ALKR0W', // Your Slack user ID for @mentions

  // Tag IDs
  notInterestedTagId: '66f7051ab1a7024acc4477b9',
  interestedTagId: process.env.ONLYSALES_INTERESTED_TAG_ID || '',  // Set this to your "Interested" / "Positive" tag ID

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

// Track leads with conversations already in progress: leadId -> timestamp
// Prevents re-triggering the bot when a lead sends multiple messages rapidly
const activeLeadConversations = new Map();

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

async function fetchAndSetInterestedTag() {
  try {
    const result = await apiRequest('GET', '/tag');
    if (result.status === 200) {
      const tags = Array.isArray(result.data) ? result.data : (result.data?.data || []);
      console.log(`[Tags] Found ${tags.length} tags`);
      for (const t of tags) {
        const name = (t.name || t.title || '').toLowerCase();
        const id = t._id || t.id;
        console.log(`  ${t.name || t.title}  →  ${id}`);
        if (name === 'positive') {
          CONFIG.interestedTagId = id;
          console.log(`[Tags] Found "positive" tag → ${id}`);
        }
      }
      if (!CONFIG.interestedTagId) {
        console.log('[Tags] WARNING: No tag named "positive" found. Positive leads will not be tagged.');
      }
    }
  } catch (err) {
    console.error('[Tags] Error fetching tags:', err.message);
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
// QUALIFICATION FLOW (dynamic steps, context-aware)
// ============================================================
// Helper: detect coverage_for from free-form text
function detectCoverageFor(msg) {
  const lower = msg.toLowerCase();
  const familyKeywords = ['family', 'spouse', 'wife', 'husband', 'kid', 'kids', 'child', 'children',
    'son', 'daughter', 'dependent', 'dependents', 'partner', 'both of us', 'me and my',
    'two', 'three', 'four', '2 people', '3 people', '4 people', 'couple', 'plus my'];
  const justMeKeywords = ['just me', 'only me', 'myself', 'just myself', 'solo', 'individual',
    'for me', 'for myself', 'only myself', 'just for me', 'coverage for me'];
  const isFamily = familyKeywords.some(kw => lower.includes(kw));
  const isJustMe = justMeKeywords.some(kw => lower.includes(kw));
  if (isFamily && !isJustMe) return { value: msg.trim(), needsFamilyDob: true };
  if (isJustMe && !isFamily) return { value: 'Just me', needsFamilyDob: false };
  if (isFamily) return { value: msg.trim(), needsFamilyDob: true };
  return null; // couldn't detect — need to ask
}

// Helper: detect pre-existing conditions from free-form text
function detectPreexisting(msg) {
  const lower = msg.toLowerCase();
  const keywords = ['diabetes', 'diabetic', 'asthma', 'blood pressure', 'hypertension',
    'heart', 'cancer', 'arthritis', 'cholesterol', 'thyroid', 'copd', 'seizure', 'epilepsy',
    'depression', 'anxiety', 'bipolar', 'insulin', 'metformin', 'medication', 'medications',
    'taking pills', 'prescription', 'pre-existing', 'preexisting', 'condition',
    'no conditions', 'no medications', 'nothing', 'none', 'healthy', 'no pre-existing',
    'no preexisting', 'no meds'];
  if (keywords.some(kw => lower.includes(kw))) return { value: msg.trim() };
  return null;
}

// Helper: detect tax status from free-form text
function detectTaxStatus(msg) {
  const lower = msg.toLowerCase();
  // Only detect if it's clearly stated (not ambiguous)
  if (lower.includes('file single') || lower.includes('filing single') || (lower.includes('single') && lower.includes('tax'))) return { value: 'Single' };
  if (lower.includes('head of household') || lower.includes('hoh')) return { value: 'Head of Household' };
  if (lower.includes('filing jointly') || lower.includes('married filing')) return { value: 'Married Filing Jointly' };
  return null;
}

// Helper: detect income from free-form text
function detectIncome(msg) {
  // Look for dollar amounts like $50k, $50,000, 50000, etc.
  const incomeMatch = msg.match(/\$?\s*\d{2,3}[,.]?\d{0,3}\s*(?:k|K|thousand|a year|per year|annually)?/);
  if (incomeMatch) return { value: incomeMatch[0].trim() };
  return null;
}

// Pre-scan a message and extract any qualification info the lead already gave
function prescanMessage(msg) {
  const extracted = {};
  const coverageFor = detectCoverageFor(msg);
  if (coverageFor) extracted.coverage_for = coverageFor;
  const preexisting = detectPreexisting(msg);
  if (preexisting) extracted.preexisting = preexisting;
  const taxStatus = detectTaxStatus(msg);
  if (taxStatus) extracted.tax_status = taxStatus;
  const income = detectIncome(msg);
  if (income) extracted.income = income;
  return extracted;
}

// Acknowledgment phrases to make the bot feel conversational
const ACKS = ['Got it.', 'Perfect.', 'Okay great.', 'Thanks for that.', 'Appreciate it.'];
function randomAck() { return ACKS[Math.floor(Math.random() * ACKS.length)]; }

// Base qualification steps (family_dob step gets inserted dynamically if needed)
const QUALIFICATION_STEPS = [
  {
    id: 'coverage_for',
    question: "Is this just for you, or are you looking to cover anyone else too?",
    parse: (msg) => {
      const result = detectCoverageFor(msg);
      if (result) return { value: result.value, valid: true, needsFamilyDob: result.needsFamilyDob };
      return { value: msg.trim() || 'Just me', valid: true, needsFamilyDob: false };
    },
  },
  {
    id: 'preexisting',
    question: "Do you have any pre-existing conditions or take any medications? Just want to make sure everything gets covered.",
    parse: (msg) => {
      const lower = msg.toLowerCase().trim();
      // Clear "no" answers — no follow-up needed
      const noKeywords = ['no', 'nope', 'nah', 'none', 'nothing', 'n/a', 'na', 'healthy',
        'no conditions', 'no meds', 'no medications', 'don\'t take', 'dont take', 'not taking'];
      if (noKeywords.some(kw => lower === kw || lower.includes(kw))) {
        return { value: 'None', valid: true, needsFollowUp: false };
      }
      // Vague "yes" without specifics — need to follow up
      const vagueYes = ['yes', 'yeah', 'yep', 'yup', 'i do', 'i am', 'y', 'si', 'sí',
        'some', 'a few', 'couple', 'yes i do', 'yeah i do'];
      const hasSpecifics = /diabetes|diabetic|asthma|blood pressure|hypertension|heart|cancer|arthritis|cholesterol|thyroid|copd|seizure|epilepsy|depression|anxiety|bipolar|insulin|metformin|lisinopril|amlodipine|atorvastatin|omeprazole|losartan|gabapentin|sertraline|xanax|adderall|lexapro|zoloft|prozac|wellbutrin|prescription|mg\b/i.test(msg);
      if (!hasSpecifics && vagueYes.some(kw => lower === kw || lower.startsWith(kw + ' '))) {
        return { value: msg.trim(), valid: true, needsFollowUp: 'preexisting_details' };
      }
      // They gave specifics — good to go
      return { value: msg.trim(), valid: true, needsFollowUp: false };
    },
  },
  {
    id: 'providers',
    question: "Any doctors, specialists, or hospitals you'd want to keep seeing? I'll make sure they're in-network.",
    parse: (msg) => {
      const lower = msg.toLowerCase().trim();
      // Clear "no" answers
      const noKeywords = ['no', 'nope', 'nah', 'none', 'nothing', 'n/a', 'na', 'not really',
        'don\'t have', 'dont have', 'no doctor', 'no one', 'nobody'];
      if (noKeywords.some(kw => lower === kw || lower.includes(kw))) {
        return { value: 'None', valid: true, needsFollowUp: false };
      }
      // Vague "yes" without names — need to follow up
      const vagueYes = ['yes', 'yeah', 'yep', 'yup', 'i do', 'y', 'si', 'sí',
        'some', 'a few', 'couple', 'yes i do', 'yeah i do'];
      const hasNames = /dr\.?\s|doctor\s\w|hospital|clinic|medical center|kaiser|mayo|cedars|mount sinai|cleveland|memorial|regional|methodist|baptist|presbyterian|st\.?\s/i.test(msg);
      if (!hasNames && vagueYes.some(kw => lower === kw || lower.startsWith(kw + ' '))) {
        return { value: msg.trim(), valid: true, needsFollowUp: 'providers_details' };
      }
      return { value: msg.trim(), valid: true, needsFollowUp: false };
    },
  },
  {
    id: 'tax_status',
    question: "How do you file your taxes? Single, Head of Household, Married Filing Jointly, or claiming dependents?",
    parse: (msg) => {
      const lower = msg.toLowerCase();
      if (lower.includes('single')) return { value: 'Single', valid: true };
      if (lower.includes('head') || lower.includes('hoh')) return { value: 'Head of Household', valid: true };
      if (lower.includes('joint') || lower.includes('married')) return { value: 'Married Filing Jointly', valid: true };
      if (lower.includes('dependent')) return { value: msg.trim() + ' (claiming dependents)', valid: true };
      return { value: msg.trim(), valid: true };
    },
  },
  {
    id: 'income',
    question: "Last one — roughly what's your household income for this year? Ballpark is fine, it helps me see what you qualify for.",
    parse: (msg) => {
      return { value: msg.trim(), valid: true };
    },
  },
];

// Dynamic follow-up steps that get inserted when the lead gives a vague answer
const FAMILY_DOB_STEP = {
  id: 'family_dob',
  question: "No problem! I'll need the date of birth for each person you want covered. Can you list them out for me?",
  parse: (msg) => { return { value: msg.trim(), valid: true }; },
};

const PREEXISTING_DETAILS_STEP = {
  id: 'preexisting_details',
  question: "Which conditions or medications specifically? I need the names so I can make sure they're covered under the plan.",
  parse: (msg) => { return { value: msg.trim(), valid: true }; },
};

const PROVIDERS_DETAILS_STEP = {
  id: 'providers_details',
  question: "What are the names of the doctors, clinics, or hospitals? That way I can check which plans they accept.",
  parse: (msg) => { return { value: msg.trim(), valid: true }; },
};

function getQualificationFlow(leadId) {
  return qualificationFlows.get(leadId) || null;
}

function startQualificationFlow(leadId, contact, originalMessage) {
  const flow = {
    step: 0,
    data: {},
    steps: [...QUALIFICATION_STEPS], // Copy so we can insert family_dob dynamically per lead
    contact,
    leadId,
    lastActivity: Date.now(),
  };

  // Pre-scan the lead's original message to extract info they already gave
  if (originalMessage) {
    const extracted = prescanMessage(originalMessage);
    for (const [stepId, result] of Object.entries(extracted)) {
      flow.data[stepId] = result.value;
      console.log(`[Qualify] Pre-filled "${stepId}" from original message: "${result.value}"`);

      // Handle family DOB insertion if coverage_for detected family
      if (stepId === 'coverage_for' && result.needsFamilyDob) {
        // Find coverage_for index and insert family_dob after it
        const covIdx = flow.steps.findIndex(s => s.id === 'coverage_for');
        if (covIdx !== -1) {
          flow.steps.splice(covIdx + 1, 0, FAMILY_DOB_STEP);
          console.log(`[Qualify] Family plan detected from prescan — inserted family_dob step`);
        }
      }
    }

    // Skip past any steps that were pre-filled
    while (flow.step < flow.steps.length && flow.data[flow.steps[flow.step].id] !== undefined) {
      console.log(`[Qualify] Skipping step ${flow.step} (${flow.steps[flow.step].id}) — already answered`);
      flow.step++;
    }
  }

  qualificationFlows.set(leadId, flow);
  return flow;
}

async function handleQualificationStep(leadId, content, contact) {
  let flow = getQualificationFlow(leadId);

  if (!flow) {
    // Start new flow
    flow = startQualificationFlow(leadId, contact);

    // Send first question
    const firstStep = flow.steps[0];
    await sendMessage(leadId, firstStep.question, contact);
    console.log(`[Qualify] Started flow for ${leadId}, step 0: ${firstStep.id}`);

    await sendSlackNotification(
      `*Started qualification flow* for lead ${contact?.firstName || 'Unknown'}\n` +
      `Step 1/${flow.steps.length}: ${firstStep.id}`
    );
    return;
  }

  // Check for bail-out mid-flow — BUT only on EXPLICIT opt-outs.
  // Simple "no", "nope", "nah" etc. are valid answers to yes/no qualification questions
  // (e.g., "Do you have pre-existing conditions?" → "Nope" means no conditions, NOT "I'm not interested")
  const lower = content.toLowerCase().trim();
  const explicitOptOut = [
    'not interested', 'no thanks', 'no thank you', 'stop', 'unsubscribe', 'opt out',
    'leave me alone', 'stop texting', 'stop calling', 'remove me', 'take me off',
    'don\'t need', 'dont need', 'do not need', 'not looking', 'already have',
    'already covered', 'have insurance', 'have coverage', 'i\'m good on insurance',
    'no me interesa', 'no necesito', 'dejame en paz',
  ];
  const isAgitated = classifyMessage(content) === 'agitated'; // vulgar/hostile always bail
  const isExplicitNo = explicitOptOut.some(p => lower.includes(p));

  if (isAgitated || isExplicitNo) {
    qualificationFlows.delete(leadId);
    console.log(`[Qualify] Lead ${leadId} explicitly opted out during qualification`);

    await addTagToContact(leadId, CONFIG.notInterestedTagId);
    await sendSlackNotification(
      `↩️ *${contact?.firstName || 'Unknown'}* opted out during qualification — tagged, no reply`
    );
    return;
  }

  // Parse current step answer
  const currentStep = flow.steps[flow.step];
  const parsed = currentStep.parse(content);
  flow.data[currentStep.id] = parsed.value;
  flow.lastActivity = Date.now();

  console.log(`[Qualify] Lead ${leadId} step ${flow.step} (${currentStep.id}): "${parsed.value}"`);

  // Dynamic follow-up insertions based on vague answers
  if (currentStep.id === 'coverage_for' && parsed.needsFamilyDob) {
    flow.steps.splice(flow.step + 1, 0, FAMILY_DOB_STEP);
    console.log(`[Qualify] Family plan detected — inserted family_dob step`);
  }
  if (parsed.needsFollowUp === 'preexisting_details') {
    flow.steps.splice(flow.step + 1, 0, PREEXISTING_DETAILS_STEP);
    console.log(`[Qualify] Vague preexisting answer — inserted follow-up for specifics`);
  }
  if (parsed.needsFollowUp === 'providers_details') {
    flow.steps.splice(flow.step + 1, 0, PROVIDERS_DETAILS_STEP);
    console.log(`[Qualify] Vague providers answer — inserted follow-up for names`);
  }

  // Forward-scan: check if their reply also answers upcoming steps
  // (e.g. "No conditions, I file single" answers preexisting + tax_status in one message)
  const extracted = prescanMessage(content);
  for (let i = flow.step + 1; i < flow.steps.length; i++) {
    const futureStep = flow.steps[i];
    if (extracted[futureStep.id] && !flow.data[futureStep.id]) {
      flow.data[futureStep.id] = extracted[futureStep.id].value;
      console.log(`[Qualify] Forward-filled "${futureStep.id}" from same reply: "${extracted[futureStep.id].value}"`);
    }
  }

  // Move to next step
  flow.step++;

  // Skip any steps that got forward-filled
  while (flow.step < flow.steps.length && flow.data[flow.steps[flow.step].id] !== undefined) {
    console.log(`[Qualify] Skipping step ${flow.step} (${flow.steps[flow.step].id}) — already answered`);
    flow.step++;
  }

  if (flow.step < flow.steps.length) {
    // Send next question with a natural acknowledgment
    const nextStep = flow.steps[flow.step];
    const ack = randomAck();
    await sendMessage(leadId, `${ack} ${nextStep.question}`, contact);
    console.log(`[Qualify] Next step ${flow.step}: ${nextStep.id}`);
  } else {
    // Qualification complete — send summary to Slack for approval
    qualificationFlows.delete(leadId);

    const name = contact ? `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || 'Unknown' : 'Unknown';
    const phone = contact?.phoneNumber || 'unknown';
    const phoneProfileId = contact?.phoneProfiles?.[0] || contact?.defaultPhoneNumber || '';

    // Build family DOB line only if they have a family plan
    const familyDobLine = flow.data.family_dob
      ? `- Other Person(s) DOB: ${flow.data.family_dob}\n`
      : '';

    const summary =
      `<@${CONFIG.slackUserId}> *QUALIFIED LEAD: ${name}*\n` +
      `Phone: ${phone}\n` +
      `${contact?.city || ''}${contact?.state ? ', ' + contact.state : ''}\n\n` +
      `*Qualification Summary:*\n` +
      `- Coverage For: ${flow.data.coverage_for || 'N/A'}\n` +
      familyDobLine +
      `- Pre-existing / Medications: ${flow.data.preexisting_details || flow.data.preexisting || 'N/A'}\n` +
      `- Providers (doctors/clinics/hospitals): ${flow.data.providers_details || flow.data.providers || 'N/A'}\n` +
      `- Tax Filing Status: ${flow.data.tax_status || 'N/A'}\n` +
      `- Estimated Household Income: ${flow.data.income || 'N/A'}\n\n` +
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
    await sendMessage(leadId, "That's everything I need! I'm going to put together the best options for you and we'll be in touch real soon.", contact);

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

    // Skip if we recently sent this exact message to this lead (server echo dedup)
    const dedupKey = `${leadId}:${content}`;
    if (recentSentMessages.has(dedupKey)) {
      console.log(`[Handler] SKIPPING — matches recently sent outgoing message (echo from server)`);
      return;
    }

    if (type !== 'inbound') return;
    if (!String(content).trim()) return; // Skip empty messages

    // ===== SYNCHRONOUS LOCK: Prevent concurrent processing for the same lead =====
    // This MUST happen before any async work (API calls, socket emits, etc.)
    // When a lead sends "Help" then "Hello" quickly, both events fire simultaneously.
    // Without this lock, both would pass the guard and trigger duplicate sequences.
    // BUT: always let messages through if lead is in a qualification flow (they're answering questions)
    const inQualFlow = qualificationFlows.has(leadId);

    if (!inQualFlow) {
      if (activeLeadConversations.has(leadId)) {
        const elapsed = Date.now() - activeLeadConversations.get(leadId);
        if (elapsed < 5 * 60 * 1000) { // 5-minute cooldown
          console.log(`[Guard] Lead ${leadId} already being handled (${Math.round(elapsed / 1000)}s ago) — skipping "${content}"`);
          return;
        }
      }

      // Also check if this lead already has a pending Slack approval
      const hasPending = [...pendingApprovals.values()].some(p => p.leadId === leadId);
      if (hasPending) {
        console.log(`[Guard] Lead ${leadId} has pending Slack approval — skipping "${content}"`);
        return;
      }
    }

    // Set the lock IMMEDIATELY (synchronous) before any async work
    activeLeadConversations.set(leadId, Date.now());

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
    console.log(`[Contact] ${name} (${phone}) — leadId=${leadId}`);
    if (contact) {
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

    // PRE-INITIALIZE the conversation now, so it's ready before any sendMessage call.
    // This prevents the double-send bug caused by conversationInit + sendMessage in rapid succession.
    const preInitPhoneId = contact?.phoneProfiles?.[0] || contact?.defaultPhoneNumber || phoneProfileId;
    if (preInitPhoneId && activeConversationLeadId !== leadId) {
      try {
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            console.log('[PreInit] conversationInit: no ack after 3s');
            resolve();
          }, 3000);
          socket.emit('conversationInit', {
            leadId,
            phoneId: preInitPhoneId,
            isTransferred: false,
          }, (response) => {
            clearTimeout(timeout);
            console.log(`[PreInit] conversationInit ack for lead ${leadId}`);
            resolve(response);
          });
        });
        activeConversationLeadId = leadId;
      } catch (err) {
        console.error(`[PreInit] Error: ${err.message}`);
      }
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
        // Autonomous: tag not interested, no reply, move on
        await addTagToContact(leadId, CONFIG.notInterestedTagId);
        await sendSlackNotification(
          `*${name}* -- Not interested (${classification}). Tagged & moved on.\n"${content}"\n${phone}`
        );
        console.log(`[Action] Tagged ${name} not interested (${classification}). No reply.`);
        break;
      }

      case 'interested':
      case 'question':
      case 'unclear': {
        // Positive lead — tag positive, draft a response, send to Slack for approval
        if (CONFIG.interestedTagId) {
          await addTagToContact(leadId, CONFIG.interestedTagId);
        }

        const draft = generateDraft(content, contact);
        const posActionId = crypto.randomUUID();
        pendingApprovals.set(posActionId, { leadId, draft, contact, content });

        if (CONFIG.slackBotToken && CONFIG.slackChannelId) {
          await sendSlackBlocks([
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `<@${CONFIG.slackUserId}> *Positive lead: ${name}*\n${phone}\n${contact?.city || ''}${contact?.state ? ', ' + contact.state : ''}\n\nThey said: "${content}"\n\nDraft reply: _"${draft}"_`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Send Draft' },
                  style: 'primary',
                  action_id: `approve_${posActionId}`,
                  value: JSON.stringify({ leadId, name, phone, phoneProfileId, draft }),
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Not Interested' },
                  action_id: `notinterested_${posActionId}`,
                  value: JSON.stringify({ leadId, name, phoneProfileId }),
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: "I'll Handle It" },
                  action_id: `ignore_${posActionId}`,
                  value: JSON.stringify({ leadId, name, phoneProfileId }),
                },
              ],
            },
          ], `Positive lead: ${name} — "${content}"`);
        } else {
          await sendSlackNotification(
            `*Positive lead: ${name}*\n${phone}\n"${content}"\nDraft: "${draft}"\n_Awaiting your approval_`
          );
        }
        console.log(`[Action] Positive lead ${name} — tagged, draft sent to Slack for approval.`);
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

  console.log(`[SendMsg] → ${leadId}: "${message.substring(0, 60)}..."`);

  // Ensure conversation is initialized before sending
  if (activeConversationLeadId !== leadId) {
    try {
      await new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        socket.emit('conversationInit', {
          leadId, phoneId, isTransferred: false,
        }, (response) => {
          clearTimeout(timeout);
          resolve(response);
        });
      });
      activeConversationLeadId = leadId;
    } catch (err) {
      console.error(`[SendMsg] Init error: ${err.message}`);
    }
  }

  // Send the message
  socket.volatile.emit('sendMessage', { message, scheduledAt: null, images: [] });

  // MANDATORY delay after every send — ensures consecutive messages are in separate
  // websocket frames and the server fully processes each one before the next arrives.
  // Without this, rapid back-to-back emits get batched and the server double-processes.
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// ============================================================
// DRAFT GENERATION (context-aware)
// ============================================================
function generateDraft(incomingMessage, contact) {
  const lower = incomingMessage.toLowerCase();
  const firstName = contact?.firstName || '';

  // Pre-scan to see what they already told us
  const already = prescanMessage(incomingMessage);
  const alreadyKnowsCoverage = !!already.coverage_for;

  // Figure out the right NEXT question to tee up (skip what's already answered)
  // This makes the draft flow naturally into qualification
  let nextAsk = '';
  if (!alreadyKnowsCoverage) {
    nextAsk = 'Is this just for you or are you looking to cover anyone else too?';
  } else {
    nextAsk = 'Do you have any pre-existing conditions or medications I should know about so we can make sure everything is covered?';
  }

  // --- Match what the lead actually said ---

  // They asked about pricing
  if (lower.includes('price') || lower.includes('cost') || lower.includes('how much') ||
      lower.includes('rate') || lower.includes('cuanto') || lower.includes('cuánto') ||
      lower.includes('affordable') || lower.includes('cheap')) {
    return `Rates depend on a few things so I can get you an accurate number. ${nextAsk}`;
  }

  // They asked about plans/options
  if (lower.includes('plan') || lower.includes('option') || lower.includes('what do you have') ||
      lower.includes('que planes') || lower.includes('qué planes') || lower.includes('what kind')) {
    return `There are a few different options depending on your situation. ${nextAsk}`;
  }

  // They want a call
  if (lower.includes('call me') || lower.includes('give me a call') || lower.includes('can you call') ||
      lower.includes('llamar') || lower.includes('llam')) {
    return "For sure! Before I call, let me grab a couple details so I can have the right info ready for you. What's the best time to reach you?";
  }

  // They mentioned specific coverage (individual/family/dental/vision)
  if (lower.includes('individual') || lower.includes('just me') || lower.includes('myself') || lower.includes('for me')) {
    return "Got it, just for you. Do you have any pre-existing conditions or medications I should know about so we can make sure everything is covered?";
  }
  if (lower.includes('family') || lower.includes('wife') || lower.includes('husband') || lower.includes('kids') ||
      lower.includes('spouse') || lower.includes('children')) {
    return "Got it, for the family. I'll need the date of birth for anyone else you'd like covered. Can you send those over?";
  }
  if (lower.includes('dental') || lower.includes('vision')) {
    return "I can definitely look into that for you. A lot of plans bundle dental and vision in — let me check what's available. " + nextAsk;
  }

  // They asked about enrollment/timing
  if (lower.includes('when') || lower.includes('open enrollment') || lower.includes('deadline') ||
      lower.includes('too late') || lower.includes('still enroll')) {
    return "You're still good — there are options available right now. Let me see what fits. " + nextAsk;
  }

  // Simple affirmative (yes, sure, interested, ok, etc.)
  if (lower.includes('yes') || lower.includes('sure') || lower.includes('interested') ||
      lower.includes('tell me more') || lower.includes('info') || lower.includes('si') ||
      lower.includes('sí') || lower.includes('ok') || lower.includes('yeah') ||
      lower.includes('yep') || lower === 'y') {
    return `Sounds good! Let me find the best options for you. ${nextAsk}`;
  }

  // They asked a question
  if (lower.includes('?')) {
    return `Good question! Let me look into that for you. To get you the most accurate info — ${nextAsk.toLowerCase()}`;
  }

  // Default fallback
  return `Thanks for reaching out! I'd love to help you find the right coverage. ${nextAsk}`;
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
        // IMMEDIATELY respond 200 to Slack to prevent retries (Slack retries after 3s)
        res.writeHead(200);
        res.end();

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
              return;
            }

            const { leadId, draft, contact } = pending;

            // PRE-INITIALIZE conversation before any sendMessage calls
            // This separates init from send to prevent the double-send bug
            const btnPhoneId = contact?.phoneProfiles?.[0] || contact?.defaultPhoneNumber;
            if (btnPhoneId && activeConversationLeadId !== leadId) {
              try {
                await new Promise((resolve) => {
                  const timeout = setTimeout(resolve, 3000);
                  socket.emit('conversationInit', {
                    leadId,
                    phoneId: btnPhoneId,
                    isTransferred: false,
                  }, (response) => {
                    clearTimeout(timeout);
                    console.log(`[Slack] Pre-init ack for lead ${leadId}`);
                    resolve(response);
                  });
                });
                activeConversationLeadId = leadId;
                console.log(`[Slack] Conversation pre-initialized for lead ${leadId}`);
              } catch (err) {
                console.error(`[Slack] Pre-init error: ${err.message}`);
              }
            }

            switch (actionType) {
              case 'approve': {
                // Send the draft message, then auto-start qualification
                if (draft) {
                  await sendMessage(leadId, draft, contact);
                  console.log(`[Slack] Approved and sent draft to ${leadId}`);
                }
                pendingApprovals.delete(actionId);

                // Auto-start qualification flow, passing the lead's original message
                // so we can skip questions they already answered
                const originalMsg = pending.content || '';
                const approveFlow = startQualificationFlow(leadId, contact, originalMsg);
                const skippedCount = approveFlow.step;
                const remainingSteps = approveFlow.steps.length - approveFlow.step;
                console.log(`[Slack] Qualification flow started for ${leadId} — pre-filled ${skippedCount} steps, ${remainingSteps} remaining`);

                await respondToSlackInteraction(payload.response_url,
                  `*Sent* to ${contact?.firstName || 'lead'}. Qualification started (${skippedCount} already answered, ${remainingSteps} to go).`
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

        } catch (err) {
          console.error('[HTTP] Error handling interaction:', err);
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

    // Only log connects — no Slack notification (too noisy with frequent reconnects/deploys)
    console.log('[Socket] Connected — listening for messages');
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

  // Auto-detect the "Positive" / "Interested" tag ID from OnlySales
  await fetchAndSetInterestedTag();

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
