// Collectible Submission – Status-Check Backend
// Nimmt die CS-Submission-Nummer entgegen, zieht die PSA-Nummer heraus,
// fragt den Fortschritt bei der PSA Public API ab und liefert ihn aufbereitet zurück.
// Der PSA-Token bleibt dabei immer auf dem Server und landet nie im Shop.

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import path from "node:path";
import { mountOrders } from "./orders.js";

const {
  PORT = 3000,
  PSA_TOKEN,
  ALLOWED_ORIGINS = "",
  CS_NUMBER_PATTERN = "^#?(\\d{6,12})$",
  DATA_DIR = "./data",
  PSA_DAILY_LIMIT = "135",
  ADMIN_KEY,
} = process.env;

if (!PSA_TOKEN) {
  console.error("PSA_TOKEN fehlt. Bitte als Umgebungsvariable setzen.");
  process.exit(1);
}

const PSA_BASE = "https://api.psacard.com/publicapi";
const csPattern = new RegExp(CS_NUMBER_PATTERN, "i");
// ---------- Tages-Speicher ----------
// Jede Nummer wird höchstens einmal pro Tag (deutsche Zeit) bei PSA abgefragt.
// Alle weiteren Abfragen am selben Tag bekommen den gespeicherten Stand.
// Der Speicher liegt in einer Datei, damit er einen Neustart übersteht.
const berlinDay = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(new Date());

const storeFile = path.join(DATA_DIR, "status-cache.json");
let store = {};
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
} catch { store = {}; }

const inflight = new Map();
let saveTimer = null;
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Einträge älter als 30 Tage aufräumen
    const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
    for (const [k, v] of Object.entries(store)) if (v.at < cutoff) delete store[k];
    fs.writeFile(storeFile, JSON.stringify({ ...store, __budget: budget }), (err) => err && console.error("Speichern fehlgeschlagen:", err.message));
  }, 1000);
}

// PSA erlaubt nur 100 Abrufe pro Tag und Token. Wir zählen mit und bleiben darunter.
let budget = { day: new Date().toISOString().slice(0, 10), used: 0, blockedUntil: 0 };
// Zähler aus dem Speicher übernehmen, damit ein Neustart das Tageslimit nicht zurücksetzt
if (store.__budget && store.__budget.day === budget.day) budget = store.__budget;
delete store.__budget;
function takeBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (budget.day !== today) budget = { day: today, used: 0, blockedUntil: 0 };
  if (Date.now() < budget.blockedUntil) return false;
  if (budget.used >= Number(PSA_DAILY_LIMIT)) return false;
  budget.used += 1;
  saveStore();
  return true;
}

const app = express();
app.set("trust proxy", 1);

const origins = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : false }));

app.use(
  "/api/status",
  rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false })
);

// ---------- Nummer prüfen ----------
function extractPsaNumber(input) {
  const clean = String(input || "").trim().replace(/\s+/g, "").toUpperCase();
  const m = clean.match(csPattern);
  if (m && m[1]) return m[1];
  return null;
}

// ---------- PSA-Aufrufe ----------
async function psaGet(path) {
  if (!takeBudget()) throw new Error("PSA_QUOTA");
  const token = PSA_TOKEN.trim().replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "");
  const res = await fetch(`${PSA_BASE}${path}`, {
    headers: {
      Authorization: `bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; CollectibleSubmission-StatusCheck/1.0)",
    },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    console.error(`PSA ${res.status} bei ${path}: ${body}`);
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || 3600;
      budget.blockedUntil = Date.now() + wait * 1000;
      throw new Error("PSA_QUOTA");
    }
    if (res.status === 500) throw new Error("PSA_AUTH_OR_SERVER");
    throw new Error(`PSA_HTTP_${res.status}`);
  }
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function hasData(json) {
  if (!json) return false;
  if (Array.isArray(json.orderProgressSteps)) return true;
  if (json.IsValidRequest === false) return false;
  if (typeof json.ServerMessage === "string" && /no data/i.test(json.ServerMessage)) return false;
  return true;
}

// Genau EIN PSA-Abruf pro Nummer.
async function fetchProgress(psaNumber) {
  const sub = await psaGet(`/order/GetSubmissionProgress/${psaNumber}`);
  if (hasData(sub)) return { source: "submission", raw: sub };
  return null;
}

// ---------- Aufbereitung ----------
// PSA liefert die Schritte als Nummern (orderProgressSteps[].step).
// Reihenfolge wie im PSA-Konto. Falls PSA andere Nummern nutzt: hier anpassen
// (prüfen über /api/debug/<PSA-Nummer>?key=ADMIN_KEY).
// PSA liefert die Schritte je nach Konto als Text (z. B. "Grading") oder als Nummer.
// Beides wird hier in verständliche deutsche Namen übersetzt.
const STEP_BY_NUMBER = [
  "Bei PSA eingegangen",
  "Auftrag wird vorbereitet",
  "Karten werden identifiziert",
  "Im Grading",
  "Karten werden eingeschweißt",
  "Qualitätskontrolle",
  "Grading abgeschlossen",
  "Von PSA versendet",
];
const STEP_BY_TEXT = [
  [/arriv|receiv|eingang/i, "Bei PSA eingegangen"],
  [/prep|vorbereit/i, "Auftrag wird vorbereitet"],
  [/research|identif|\bid\b/i, "Karten werden identifiziert"],
  [/photo|image|imaging|foto/i, "Fotos werden erstellt"],
  [/grad/i, "Im Grading"],
  [/assembl|encaps|slab|label/i, "Karten werden eingeschweißt"],
  [/qa|quality|check|kontroll/i, "Qualitätskontrolle"],
  [/complet|done|finish|abgeschl/i, "Grading abgeschlossen"],
  [/ship|versand|versend/i, "Von PSA versendet"],
];

function stepName(step, i) {
  if (typeof step === "number" || /^\d+$/.test(String(step))) {
    return STEP_BY_NUMBER[Number(step)] || `Schritt ${i + 1}`;
  }
  const t = String(step || "").trim();
  if (!t) return `Schritt ${i + 1}`;
  for (const [re, de] of STEP_BY_TEXT) if (re.test(t)) return de;
  // Unbekannter Text: lesbar machen, z. B. "OrderPrep" -> "Order Prep"
  return t.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

function buildFromPsa(psaNumber, raw, fetchedAt) {
  const steps = (raw.orderProgressSteps || [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((s, i) => ({
      name: stepName(s.step ?? s.name ?? s.stepName, i),
      done: Boolean(s.completed),
      raw: String(s.step ?? s.name ?? s.stepName ?? ""),
    }));

  // Doppelte Namen vermeiden (PSA hat z. B. zwei Prüfschritte)
  const SECOND = {
    "Qualitätskontrolle": "Abschließende Kontrolle",
    "Im Grading": "Grading wird geprüft",
    "Karten werden identifiziert": "Angaben werden geprüft",
    "Auftrag wird vorbereitet": "Auftrag wird weiter vorbereitet",
  };
  const seen = new Set();
  for (const st of steps) {
    if (seen.has(st.name)) {
      const pretty = st.raw && !/^\d+$/.test(st.raw) ? st.raw.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ") : "";
      st.name = SECOND[st.name] || pretty || st.name + " (2)";
    }
    seen.add(st.name);
    delete st.raw;
  }

  // Interne PSA-Flags (accountingHold) werden bewusst NICHT an Kunden ausgegeben.
  if (raw.accountingHold) console.warn(`Accounting Hold bei PSA-Nummer ${psaNumber}`);

  return {
    psaNumber,
    steps,
    gradesReady: Boolean(raw.gradesReady),
    needsAttention: Boolean(raw.problemOrder),
    shipped: Boolean(raw.shipped),
    tracking: raw.shipped && raw.shipTrackingNumber
      ? { number: raw.shipTrackingNumber, carrier: raw.shipCarrier || null }
      : null,
    updatedAt: new Date(fetchedAt || Date.now()).toISOString(),
  };
}

async function buildStatus(psaNumber) {
  const result = await fetchProgress(psaNumber);
  if (!result) return null;
  return result.raw;
}

// ---------- Routen ----------
// Status einer PSA-Nummer holen: höchstens EIN PSA-Abruf pro Nummer und Tag.
// Wird von der Kundenabfrage UND von den automatischen Mails genutzt.
async function getStatus(psaNumber) {
  const today = berlinDay();
  const hit = store[psaNumber];
  const usable = hit && (hit.notFound || hit.raw);
  if (usable && hit.day === today) {
    return hit.notFound ? { notFound: true } : { raw: hit.raw, at: hit.at };
  }
  try {
    if (!inflight.has(psaNumber)) {
      inflight.set(psaNumber, buildStatus(psaNumber).finally(() => inflight.delete(psaNumber)));
    }
    const raw = await inflight.get(psaNumber);
    if (!raw) {
      store[psaNumber] = { day: today, at: Date.now(), notFound: true, raw: hit?.raw, lastAt: hit?.at };
      saveStore();
      return { notFound: true };
    }
    store[psaNumber] = { day: today, at: Date.now(), raw };
    saveStore();
    return { raw, at: store[psaNumber].at };
  } catch (err) {
    if (hit?.raw) return { raw: hit.raw, at: hit.lastAt || hit.at, stale: true };
    throw err;
  }
}

app.get("/api/status/:number", async (req, res) => {
  const psaNumber = extractPsaNumber(req.params.number);
  if (!psaNumber) return res.status(400).json({ error: "INVALID_NUMBER" });
  try {
    const r = await getStatus(psaNumber);
    if (r.notFound) return res.status(404).json({ error: "NOT_FOUND" });
    res.json(buildFromPsa(psaNumber, r.raw, r.at));
  } catch (err) {
    console.error(err.message);
    res.status(503).json({ error: err.message === "PSA_QUOTA" ? "PSA_QUOTA" : "PSA_UNAVAILABLE" });
  }
});

// Gespeicherte Rohdaten ansehen, OHNE PSA-Abruf: /api/cache/14663791?key=ADMIN_KEY
app.get("/api/cache/:psaNumber", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).end();
  const nr = extractPsaNumber(req.params.psaNumber);
  const hit = nr && store[nr];
  if (!hit) return res.status(404).json({ error: "nicht im Speicher" });
  res.json({ abgerufen: new Date(hit.at).toISOString(), tag: hit.day, raw: hit.raw || null, alterEintrag: !hit.raw });
});

// Roh-Antwort von PSA ansehen, zum Feinjustieren der Anzeige.
// Aufruf: /api/debug/12345678?key=ADMIN_KEY
app.get("/api/debug/:psaNumber", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).end();
  try {
    const sub = await psaGet(`/order/GetSubmissionProgress/${req.params.psaNumber}`);
    res.json({ submissionProgress: sub });
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
});

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    psaCallsToday: budget.used,
    dailyLimit: Number(PSA_DAILY_LIMIT),
    numbersCheckedToday: Object.values(store).filter((v) => v.day === berlinDay()).length,
  })
);

// Auftragsübersicht und Status-Mails (Plan B ohne Google)
mountOrders(app, { DATA_DIR, getStatus, berlinDay, extractPsaNumber });

app.listen(PORT, () => console.log(`Status-Check läuft auf Port ${PORT}`));
