// Collectible Submission – Status-Check Backend
// Nimmt die CS-Submission-Nummer entgegen, zieht die PSA-Nummer heraus,
// fragt den Fortschritt bei der PSA Public API ab und liefert ihn aufbereitet zurück.
// Der PSA-Token bleibt dabei immer auf dem Server und landet nie im Shop.

import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

const {
  PORT = 3000,
  PSA_TOKEN,
  ALLOWED_ORIGINS = "",
  CS_NUMBER_PATTERN = "^#?(\\d{6,12})$",
  CACHE_MINUTES = "15",
  ADMIN_KEY,
} = process.env;

if (!PSA_TOKEN) {
  console.error("PSA_TOKEN fehlt. Bitte als Umgebungsvariable setzen.");
  process.exit(1);
}

const PSA_BASE = "https://api.psacard.com/publicapi";
const csPattern = new RegExp(CS_NUMBER_PATTERN, "i");
const cacheMs = Number(CACHE_MINUTES) * 60 * 1000;
const cache = new Map();

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

async function fetchProgress(psaNumber) {
  const sub = await psaGet(`/order/GetSubmissionProgress/${psaNumber}`);
  if (hasData(sub)) return { source: "submission", raw: sub };
  const order = await psaGet(`/order/GetProgress/${psaNumber}`);
  if (hasData(order)) return { source: "order", raw: order };
  return null;
}

// ---------- Aufbereitung ----------
// PSA liefert die Schritte als Nummern (orderProgressSteps[].step).
// Reihenfolge wie im PSA-Konto. Falls PSA andere Nummern nutzt: hier anpassen
// (prüfen über /api/debug/<PSA-Nummer>?key=ADMIN_KEY).
const STEP_NAMES_DE = [
  "Bei PSA eingegangen",
  "Auftrag wird vorbereitet",
  "Karten werden identifiziert",
  "Im Grading",
  "Karten werden eingeschweißt",
  "Qualitätskontrolle",
  "Von PSA versendet",
];

function buildFromPsa(psaNumber, raw) {
  const steps = (raw.orderProgressSteps || [])
    .slice()
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((s) => ({
      name: STEP_NAMES_DE[s.step] || `Schritt ${Number(s.step) + 1}`,
      done: Boolean(s.completed),
    }));

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
    updatedAt: new Date().toISOString(),
  };
}

async function buildStatus(psaNumber) {
  const result = await fetchProgress(psaNumber);
  if (!result) return null;
  return buildFromPsa(psaNumber, result.raw);
}

// ---------- Routen ----------
app.get("/api/status/:number", async (req, res) => {
  const psaNumber = extractPsaNumber(req.params.number);
  if (!psaNumber) {
    return res.status(400).json({ error: "INVALID_NUMBER" });
  }

  const hit = cache.get(psaNumber);
  if (hit && Date.now() - hit.at < cacheMs) return res.json(hit.data);

  try {
    const data = await buildStatus(psaNumber);
    if (!data) return res.status(404).json({ error: "NOT_FOUND" });
    cache.set(psaNumber, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "PSA_UNAVAILABLE" });
  }
});

// Roh-Antwort von PSA ansehen, zum Feinjustieren der Anzeige.
// Aufruf: /api/debug/12345678?key=ADMIN_KEY
app.get("/api/debug/:psaNumber", async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).end();
  try {
    const sub = await psaGet(`/order/GetSubmissionProgress/${req.params.psaNumber}`);
    const order = await psaGet(`/order/GetProgress/${req.params.psaNumber}`);
    res.json({ submissionProgress: sub, orderProgress: order });
  } catch (err) {
    res.status(502).json({ error: String(err.message) });
  }
});

app.get("/health", (_req, res) => res.send("ok"));

app.listen(PORT, () => console.log(`Status-Check läuft auf Port ${PORT}`));
