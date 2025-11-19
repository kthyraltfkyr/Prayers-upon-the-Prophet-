/**
 * Codio WhatsApp API - Final Version
 * Combines Express API + Codio Bot authentication style
 */

const fs = require("fs");
const express = require("express");
const chalk = require("chalk").default; // v5+ requires .default
const pino = require("pino");
const NodeCache = require("node-cache");
const readline = require("readline");
const PhoneNumber = require("awesome-phonenumber");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  delay
} = require("@whiskeysockets/baileys");

// Lightweight store
const store = require("./lib/lightweight_store");
store.readFromFile();
const settings = require("./settings");
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000);

const API_PORT = 3000;
const app = express();
app.use(express.json());

let phoneNumberGlobal = "201148795529";
let owner = JSON.parse(fs.readFileSync("./data/owner.json"));
global.botname = "Codio API Bot";
global.themeemoji = "•";

const pairingCode = !!phoneNumberGlobal || process.argv.includes("--pairing-code");
const useMobile = process.argv.includes("--mobile");

// Readline interface for interactive pairing
const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const question = (text) => {
  if (rl) return new Promise(resolve => rl.question(text, resolve));
  return Promise.resolve(settings.ownerNumber || phoneNumberGlobal);
};

// -----------------------------------------
// Start WhatsApp Client with Codio auth
// -----------------------------------------
let waClient = null;
let isConnected = false;

async function startWhatsAppClient() {
  console.log(chalk.blue("Initializing WhatsApp Client..."));

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState("./session");
  const msgRetryCounterCache = new NodeCache();

  waClient = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    printQRInTerminal: !pairingCode,
    browser: ["CodioAPI", "Chrome", "1.0"],
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
    },
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: true,
    getMessage: async (key) => {
      const jid = jidNormalizedUser(key.remoteJid);
      const msg = await store.loadMessage(jid, key.id);
      return msg?.message || "";
    },
    msgRetryCounterCache,
    defaultQueryTimeoutMs: undefined
  });

  store.bind(waClient.ev);

  // Pairing Code logic
  if (pairingCode && !waClient.authState.creds.registered) {
    if (useMobile) throw new Error("Cannot use pairing code with mobile API");

    let phoneNumber = phoneNumberGlobal || await question(chalk.greenBright(`Please type your WhatsApp number (without + or spaces): `));
    phoneNumber = phoneNumber.replace(/[^0-9]/g, "");

    if (!PhoneNumber("+" + phoneNumber).isValid()) {
      console.log(chalk.red("Invalid phone number. Please use full international format."));
      process.exit(1);
    }

    setTimeout(async () => {
      try {
        let code = await waClient.requestPairingCode(phoneNumber);
        code = code?.match(/.{1,4}/g)?.join("-") || code;
        console.log(chalk.bgGreen.black("Your Pairing Code:"), chalk.white(code));
        console.log(chalk.yellow(`Enter this code in WhatsApp: Settings > Linked Devices > Link a Device.`));
      } catch (e) {
        console.error("Failed to get pairing code:", e);
      }
    }, 3000);
  }

  // Connection updates
  waClient.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "open") {
      isConnected = true;
      console.log(chalk.green("✔ WhatsApp Connected!"));
      const botNumber = waClient.user.id.split(":")[0] + "@s.whatsapp.net";
      await waClient.sendMessage(botNumber, {
        text: `🤖 Bot Connected Successfully!\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online`
      });
    }
    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        try { fs.rmSync("./session", { recursive: true, force: true }); } catch {}
        console.log(chalk.red("Session logged out. Please re-authenticate."));
      }
      startWhatsAppClient();
    }
  });

  // Track recent callers for anti-call
  const antiCallNotified = new Set();
  waClient.ev.on("call", async (calls) => {
    for (const call of calls) {
      const callerJid = call.from || call.peerJid || call.chatId;
      if (!callerJid) continue;
      if (!antiCallNotified.has(callerJid)) {
        antiCallNotified.add(callerJid);
        setTimeout(() => antiCallNotified.delete(callerJid), 60000);
        try {
          await waClient.sendMessage(callerJid, { text: "📵 Anticall is enabled. Your call was rejected." });
        } catch {}
      }
      setTimeout(async () => {
        try { await waClient.updateBlockStatus(callerJid, "block"); } catch {}
      }, 800);
    }
  });

  waClient.ev.on("creds.update", saveCreds);
}

startWhatsAppClient().catch(console.error);

// -----------------------------------------
// Express API Endpoints
// -----------------------------------------

// Status
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    user: waClient?.user || null
  });
});

// Send text message
app.get("/send", async (req, res) => {
  if (!isConnected) return res.json({ success: false, msg: "WhatsApp not connected" });

  const to = req.query.to?.replace(/[^0-9]/g, "");
  const msgs = req.query.msg;
  if (!to || !msgs) return res.json({ success: false, error: "to & msg required" });

  const jid = to + "@s.whatsapp.net";
  const messages = Array.isArray(msgs) ? msgs : [msgs];

  let results = [];
  for (let m of messages) {
    await delay(400);
    const sent = await waClient.sendMessage(jid, { text: m });
    results.push(sent.key.id);
  }

  res.json({ success: true, sent_count: results.length, ids: results });
});

// Send image by URL
app.get("/image", async (req, res) => {
  if (!isConnected) return res.json({ success: false, msg: "Not connected" });

  const to = req.query.to?.replace(/[^0-9]/g, "");
  const url = req.query.url;
  const caption = req.query.caption || "";

  if (!to || !url) return res.json({ success: false, error: "to & url required" });

  const jid = to + "@s.whatsapp.net";
  try {
    const msg = await waClient.sendMessage(jid, { image: { url }, caption });
    res.json({ success: true, id: msg.key.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Send file
app.get("/file", async (req, res) => {
  if (!isConnected) return res.json({ success: false, msg: "Not connected" });

  const to = req.query.to?.replace(/[^0-9]/g, "");
  const url = req.query.url;
  const filename = req.query.filename || "file";

  if (!to || !url) return res.json({ success: false, error: "to & url required" });

  const jid = to + "@s.whatsapp.net";
  try {
    const msg = await waClient.sendMessage(jid, { document: { url }, mimetype: "application/octet-stream", fileName: filename });
    res.json({ success: true, id: msg.key.id });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// Start API Server
app.listen(API_PORT, "0.0.0.0", () => {
  console.log(chalk.green("🚀 API is running on port " + API_PORT));
  console.log(chalk.yellow("➡ Send requests to: http://localhost:" + API_PORT));
});
