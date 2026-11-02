// Collectible Submission – Auftragsübersicht und Status-Mails (ohne Google)
//
// - Shopify meldet neue Bestellungen per Webhook -> landen automatisch in der Übersicht
// - Übersicht unter /admin (Passwort geschützt): Haken setzen = Mail an den Kunden, jede Stufe genau einmal
// - Automatisch: Sobald PSA "Grades fertig" meldet, bekommt der Kunde eine Mail
// - Versand über euer eigenes Postfach (SMTP)

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";

const E = process.env;
const CFG = {
  adminUser: E.ADMIN_USER || "admin",
  adminPass: E.ADMIN_PASSWORD || "",
  webhookSecret: E.SHOPIFY_WEBHOOK_SECRET || "",
  shopName: E.SHOP_NAME || "Collectible Submission",
  statusUrl: E.STATUS_PAGE_URL || "https://collectible-submission.com/pages/status-check",
  storeAddress: E.STORE_ADDRESS || "Loisnitzer Str. 2, 93158 Teublitz",
  trackingUrl: E.TRACKING_URL || "https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=",
  mailFrom: E.MAIL_FROM || E.SMTP_USER || "",
  replyTo: E.MAIL_REPLY_TO || "",
  autoPsa: (E.AUTO_PSA_MAILS || "true") !== "false",
};

// ---------- Stufen ----------
// {G} wird durch PSA oder GSG ersetzt.
const STAGES = [
  { key: "eingang", label: "Eingegangen", step: "Bei uns eingegangen",
    subject1: "Deine Karte ist bei uns angekommen", subject: "Deine Karten sind bei uns angekommen",
    text1: "deine Karte ist sicher bei uns angekommen. Wir prüfen alles und bereiten die Einreichung vor.",
    text: "deine Karten sind sicher bei uns angekommen. Wir prüfen alles und bereiten die Einreichung vor." },
  { key: "an_grader", label: "An {G} versendet", step: "Unterwegs zu {G}",
    subject1: "Deine Karte ist unterwegs zu {G}", subject: "Deine Karten sind unterwegs zu {G}",
    text1: "deine Karte ist versichert auf dem Weg zu {G}. Sobald sie dort angekommen ist, melden wir uns wieder.",
    text: "deine Karten sind versichert auf dem Weg zu {G}. Sobald sie dort angekommen sind, melden wir uns wieder." },
  { key: "bei_grader", label: "Bei {G}", step: "Bei {G} im Grading", needsPsa: true,
    subject1: "Deine Karte ist bei {G}", subject: "Deine Karten sind bei {G}",
    subjectPsa: " – hier ist deine Submission-Nummer",
    text1: "deine Karte ist bei {G} angekommen und wird jetzt gegradet.",
    text: "deine Karten sind bei {G} angekommen und werden jetzt gegradet.",
    textPsa: " Mit deiner Submission-Nummer kannst du ab jetzt jederzeit selbst nachsehen, in welchem Schritt sie gerade {sind}." },
  { key: "zurueck", label: "Zurück bei uns", step: "Gegradet zurück bei uns", stepStore: "Abholbereit im Laden",
    subject1: "Deine Karte ist gegradet zurück", subject: "Deine Karten sind gegradet zurück",
    text1: "deine Karte ist gegradet zurück bei uns. Wir prüfen alles und bereiten jetzt den versicherten Rückversand vor.",
    text: "deine Karten sind gegradet zurück bei uns. Wir prüfen alles und bereiten jetzt den versicherten Rückversand vor.",
    textStore1: "deine Karte ist gegradet zurück. Du kannst sie ab sofort im Laden abholen: {ADDR}. Bitte bring einen Ausweis mit.",
    textStore: "deine Karten sind gegradet zurück. Du kannst sie ab sofort im Laden abholen: {ADDR}. Bitte bring einen Ausweis mit." },
  { key: "versendet", label: "Versendet", step: "Auf dem Weg zu dir", stepStore: "Abgeholt", noMailStore: true,
    subject1: "Deine gegradete Karte ist auf dem Weg zu dir", subject: "Deine gegradeten Karten sind auf dem Weg zu dir",
    text1: "deine gegradete Karte ist versichert auf dem Weg zu dir. Viel Freude damit!",
    text: "deine gegradeten Karten sind versichert auf dem Weg zu dir. Viel Freude damit!" },
];
const GRADES_MAIL = {
  subject1: "Deine Grades sind da", subject: "Deine Grades sind da",
  text1: "PSA hat deine Karte gegradet, die Note steht fest. Die Karte wird jetzt fertiggestellt und an uns zurückgeschickt.",
  text: "PSA hat deine Karten gegradet, die Noten stehen fest. Die Karten werden jetzt fertiggestellt und an uns zurückgeschickt.",
};

// ---------- Speicher ----------
export function mountOrders(app, { DATA_DIR, getStatus, berlinDay, extractPsaNumber }) {
  const file = path.join(DATA_DIR, "orders.json");
  let db = { orders: {}, lastAutoDay: "" };
  try { db = JSON.parse(fs.readFileSync(file, "utf8")); db.orders = db.orders || {}; } catch { /* neu */ }
  let t = null;
  const save = () => { clearTimeout(t); t = setTimeout(() => fs.writeFile(file, JSON.stringify(db), (e) => e && console.error("orders.json:", e.message)), 300); };

  const now = () => new Date().toISOString();
  const psaList = (s) => String(s || "").split(/[\s,;\/|]+/).map((x) => x.replace(/\D/g, "")).filter((x) => x.length >= 6 && x.length <= 12);
  const qtyOf = (o) => o.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  const graderOf = (items) => (items.length && items.every((i) => /gsg|gold standard/i.test(i.title)) ? "GSG" : "PSA");

  // ---------- Mail ----------
  // Drei Wege: BREVO_API_KEY (empfohlen auf Railway), RESEND_API_KEY oder SMTP (z. B. Gmail, braucht Railway Pro).
  const provider = E.BREVO_API_KEY ? "brevo" : E.RESEND_API_KEY ? "resend" : (E.SMTP_HOST && E.SMTP_USER && E.SMTP_PASS) ? "smtp" : "";
  const smtpReady = Boolean(provider);
  const transport = provider === "smtp"
    ? nodemailer.createTransport({ host: E.SMTP_HOST, port: Number(E.SMTP_PORT || 587), secure: String(E.SMTP_SECURE || "false") === "true",
        auth: { user: E.SMTP_USER, pass: E.SMTP_PASS }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000 })
    : null;
  if (!provider) console.warn("Mail-Versand nicht eingerichtet: Mails werden NICHT versendet, nur protokolliert.");
  else console.log("Mail-Versand über:", provider);

  async function deliver({ to, subject, html, text }) {
    const fromName = CFG.shopName, fromMail = CFG.mailFrom;
    if (!fromMail) throw new Error("MAIL_FROM fehlt");
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 20000);
    try {
      if (provider === "brevo") {
        const r = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", signal: ctl.signal,
          headers: { "api-key": E.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ sender: { name: fromName, email: fromMail }, to: [{ email: to }], replyTo: CFG.replyTo ? { email: CFG.replyTo } : undefined, subject, htmlContent: html, textContent: text }) });
        if (!r.ok) throw new Error("Brevo " + r.status + ": " + (await r.text()).slice(0, 200));
        return;
      }
      if (provider === "resend") {
        const r = await fetch("https://api.resend.com/emails", { method: "POST", signal: ctl.signal,
          headers: { authorization: "Bearer " + E.RESEND_API_KEY, "content-type": "application/json" },
          body: JSON.stringify({ from: `${fromName} <${fromMail}>`, to: [to], reply_to: CFG.replyTo || undefined, subject, html, text }) });
        if (!r.ok) throw new Error("Resend " + r.status + ": " + (await r.text()).slice(0, 200));
        return;
      }
      await transport.sendMail({ from: `"${fromName}" <${fromMail}>`, to, replyTo: CFG.replyTo || undefined, subject, html, text });
    } catch (e) {
      if (e.name === "AbortError" || /timeout|ETIMEDOUT|ECONNREFUSED|Greeting never received/i.test(e.message || "")) {
        throw new Error(provider === "smtp"
          ? "Keine Verbindung zum Mailserver. Railway blockiert SMTP im aktuellen Tarif. Lösung: BREVO_API_KEY verwenden oder Railway Pro."
          : "Zeitüberschreitung beim Mail-Dienst. Bitte später erneut versuchen.");
      }
      throw e;
    } finally { clearTimeout(timer); }
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" }) : "");

  function buildMail(o, kind) {
    const G = o.grader || "PSA";
    const one = qtyOf(o) <= 1;
    const store = o.pickup;
    const subs = psaList(o.psa);
    const fill = (s) => String(s || "").replace(/\{G\}/g, G).replace(/\{ADDR\}/g, CFG.storeAddress).replace(/\{sind\}/g, one ? "ist" : "sind");
    let st, subject, text, si;
    if (kind === "grades") {
      st = GRADES_MAIL; subject = one ? st.subject1 : st.subject; text = one ? st.text1 : st.text;
      si = STAGES.findIndex((x) => x.key === "bei_grader");
    } else {
      si = STAGES.findIndex((x) => x.key === kind); st = STAGES[si];
      subject = one ? st.subject1 : st.subject;
      text = store && st.textStore ? (one ? st.textStore1 : st.textStore) : (one ? st.text1 : st.text);
      if (kind === "bei_grader" && G === "PSA" && subs.length) { subject += st.subjectPsa; text += st.textPsa; }
    }
    subject = fill(subject); text = fill(text);
    const first = String(o.name || "").split(" ")[0];
    const showSubs = G === "PSA" && subs.length && si >= 2;
    const link = (n) => `${CFG.statusUrl}?nr=${encodeURIComponent(n)}`;
    const C = { bg: "#05080C", card: "#0B1016", line: "#1C2631", ink: "#F2F6F8", muted: "#8E9BAA", cyan: "#1EC8F0", ok: "#2FD07F" };

    const steps = STAGES.map((s, i) => {
      const label = fill(store && s.stepStore ? s.stepStore : s.step);
      const done = i <= si || Boolean(o.stages[s.key]);
      const date = fmt(o.stages[s.key] || (i === si ? now() : ""));
      return `<tr><td style="width:30px;padding:6px 0;vertical-align:top"><div style="width:22px;height:22px;border-radius:50%;text-align:center;font-size:12px;font-weight:bold;${done ? `background:${C.ok};color:#00150A;line-height:22px;` : `border:2px solid ${C.line};color:${C.muted};line-height:18px;width:18px;height:18px;`}">${done ? "&#10003;" : i + 1}</div></td><td style="padding:6px 0 6px 10px;font-size:14px;color:${done ? C.ink : C.muted};${i === si ? "font-weight:bold;" : ""}">${esc(label)}${date && done ? `<br><span style="font-size:12px;color:${C.muted};font-weight:normal">${esc(date)}</span>` : ""}</td></tr>`;
    }).join("");

    const subBox = showSubs ? `<table role="presentation" width="100%" style="border-collapse:collapse;margin:0 0 20px;background:#071A22;border:1px solid ${C.cyan};border-radius:12px"><tr><td style="padding:16px 18px"><p style="margin:0 0 6px;font-size:12px;color:${C.cyan};font-weight:bold;letter-spacing:1px;text-transform:uppercase">PSA Submission-Nummer${subs.length > 1 ? "n" : ""}</p>${subs.map((n) => `<p style="margin:6px 0"><span style="font-size:26px;font-weight:bold;color:${C.ink};letter-spacing:1px">#${esc(n)}</span> &nbsp;<a href="${link(n)}" style="color:${C.cyan};font-size:14px;font-weight:bold">Status ansehen &rarr;</a></p>`).join("")}<p style="margin:8px 0 0;font-size:12px;color:${C.muted}">Speichere dir die Nummer. Damit siehst du im Status-Check jederzeit, wo deine Karten gerade sind.</p></td></tr></table>` : "";
    const items = o.items.map((i) => `<tr><td style="padding:7px 0;border-bottom:1px solid ${C.line};font-size:14px;color:${C.ink}">${esc(i.qty)}× ${esc(i.title)}${i.variant ? ` <span style="color:${C.muted}">(${esc(i.variant)})</span>` : ""}</td></tr>`).join("");
    const track = kind === "versendet" && o.tracking ? `<p style="margin:16px 0 0;font-size:14px;color:${C.ink}">Sendungsnummer: <b>${esc(o.tracking)}</b><br><a href="${CFG.trackingUrl}${encodeURIComponent(o.tracking)}" style="color:${C.cyan}">Sendung verfolgen</a></p>` : "";
    const btn = showSubs ? `<p style="margin:22px 0 6px"><a href="${link(subs[0])}" style="display:inline-block;background:${C.cyan};color:#03131A;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 18px;border-radius:8px">Zum Status-Check</a></p>` : "";

    const html = `<div style="background:${C.bg};padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:${C.ink}"><table role="presentation" width="100%" style="max-width:560px;margin:0 auto;border-collapse:collapse;background:${C.card};border:1px solid ${C.line};border-radius:14px;overflow:hidden"><tr><td style="background:#000;padding:18px 22px;border-bottom:3px solid ${C.cyan}"><span style="font-size:18px;font-weight:bold;font-style:italic;text-transform:uppercase;letter-spacing:.5px;color:${C.ink}">${esc(CFG.shopName)}</span></td></tr><tr><td style="padding:24px 22px 8px"><p style="margin:0 0 4px;font-size:12px;color:${C.muted}">Bestellung ${esc(o.nr)}</p><h1 style="margin:0 0 14px;font-size:24px;line-height:1.15;text-transform:uppercase;font-style:italic;color:${C.ink}">${esc(subject)}</h1><p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:${C.ink}">Hallo${first ? " " + esc(first) : ""},<br>${esc(text)}</p>${subBox}<table role="presentation" style="border-collapse:collapse;margin:0 0 18px">${steps}</table>${items ? `<p style="margin:0 0 4px;font-size:12px;color:${C.muted}">Dein Auftrag</p><table role="presentation" width="100%" style="border-collapse:collapse">${items}</table>` : ""}${track}${btn}</td></tr><tr><td style="padding:16px 22px 22px;font-size:12px;color:${C.muted};border-top:1px solid ${C.line}">Fragen? Antworte einfach auf diese E-Mail.<br>${esc(CFG.shopName)} · ${esc(CFG.storeAddress)}</td></tr></table></div>`;
    const plain = `Hallo${first ? " " + first : ""},\n${text}${showSubs ? `\n\nPSA Submission-Nummer: ${subs.map((n) => "#" + n).join(", ")}\nStatus ansehen: ${link(subs[0])}` : ""}\n\nBestellung ${o.nr}${track && o.tracking ? `\nSendungsnummer: ${o.tracking}` : ""}\n\n${CFG.shopName}`;
    return { subject: `${subject} · Bestellung ${o.nr}`, html, text: plain };
  }

  async function sendMail(o, kind) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email || "")) throw new Error("Keine gültige E-Mail-Adresse");
    const m = buildMail(o, kind);
    if (!provider) { console.log(`[Probelauf] Mail "${m.subject}" an ${o.email}`); return "probelauf"; }
    await deliver({ to: o.email, subject: m.subject, html: m.html, text: m.text });
    return "gesendet";
  }
  const log = (o, msg) => { o.log = o.log || []; o.log.unshift({ at: now(), msg }); o.log = o.log.slice(0, 30); };

  // ---------- Shopify-Webhook: neue Bestellung ----------
  app.post("/webhooks/shopify/orders-create", express.raw({ type: "*/*", limit: "2mb" }), (req, res) => {
    const hmac = req.get("X-Shopify-Hmac-Sha256") || "";
    if (!CFG.webhookSecret) return res.status(500).send("SHOPIFY_WEBHOOK_SECRET fehlt");
    const digest = crypto.createHmac("sha256", CFG.webhookSecret).update(req.body).digest("base64");
    const ok = hmac.length === digest.length && crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(digest));
    if (!ok) return res.status(401).send("ungültige Signatur");
    let p; try { p = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("kein JSON"); }
    const id = String(p.id || p.name);
    if (db.orders[id]) return res.status(200).send("schon vorhanden");
    const items = (p.line_items || []).map((l) => ({ title: l.title || l.name, variant: l.variant_title && l.variant_title !== "Default Title" ? l.variant_title : "", qty: l.quantity || 1 }));
    const ship = (p.shipping_lines || []).map((s) => s.title || "").join(" ");
    const cust = p.customer || {};
    const name = [cust.first_name, cust.last_name].filter(Boolean).join(" ") || p.shipping_address?.name || p.billing_address?.name || "";
    db.orders[id] = {
      id, nr: p.name || "#" + p.order_number, created: p.created_at || now(), name, email: p.email || p.contact_email || cust.email || "",
      items, grader: graderOf(items), pickup: /abhol|laden|pickup|pick-up/i.test(ship),
      psa: "", tracking: "", note: "", stages: {}, mails: {}, log: [{ at: now(), msg: "Bestellung aus Shopify übernommen" }], archived: false,
    };
    save();
    res.status(200).send("ok");
  });

  // ---------- Admin: Passwortschutz ----------
  const guard = (req, res, next) => {
    if (!CFG.adminPass) return res.status(503).send("ADMIN_PASSWORD ist nicht gesetzt.");
    const [u, pw] = Buffer.from(String(req.get("authorization") || "").replace(/^Basic /, ""), "base64").toString().split(":");
    const same = (a, b) => { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && crypto.timingSafeEqual(x, y); };
    if (same(u, CFG.adminUser) && same(pw, CFG.adminPass)) return next();
    res.set("WWW-Authenticate", 'Basic realm="Collectible Submission"').status(401).send("Anmeldung erforderlich");
  };
  app.use("/admin", guard, express.json({ limit: "1mb" }));

  const view = (o) => ({ ...o, qty: qtyOf(o) });
  app.get("/admin/api/orders", (_req, res) => {
    const list = Object.values(db.orders).sort((a, b) => String(b.created).localeCompare(String(a.created))).map(view);
    res.json({ orders: list, smtp: smtpReady, autoPsa: CFG.autoPsa, stages: STAGES.map((s) => ({ key: s.key, label: s.label, needsPsa: !!s.needsPsa })) });
  });

  app.post("/admin/api/orders", (req, res) => {
    const b = req.body || {};
    const nr = String(b.nr || "").trim();
    if (!nr || !b.email) return res.status(400).json({ error: "Bestellnummer und E-Mail sind Pflicht" });
    const id = "m-" + Date.now();
    const items = String(b.items || "").split(/\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^(\d+)\s*[x×]\s*(.+)$/i); return m ? { qty: Number(m[1]), title: m[2].trim(), variant: "" } : { qty: 1, title: l, variant: "" };
    });
    db.orders[id] = { id, nr: nr.startsWith("#") ? nr : "#" + nr, created: now(), name: String(b.name || ""), email: String(b.email).trim(), items,
      grader: b.grader === "GSG" ? "GSG" : (b.grader === "PSA" ? "PSA" : graderOf(items)), pickup: !!b.pickup, psa: "", tracking: "", note: "",
      stages: {}, mails: {}, log: [{ at: now(), msg: "Von Hand angelegt" }], archived: false };
    save(); res.json(view(db.orders[id]));
  });

  app.patch("/admin/api/orders/:id", (req, res) => {
    const o = db.orders[req.params.id]; if (!o) return res.status(404).json({ error: "nicht gefunden" });
    const b = req.body || {};
    for (const k of ["name", "email", "psa", "tracking", "note"]) if (k in b) o[k] = String(b[k] ?? "").trim();
    if ("pickup" in b) o.pickup = !!b.pickup;
    if ("archived" in b) o.archived = !!b.archived;
    if ("grader" in b && ["PSA", "GSG"].includes(b.grader)) o.grader = b.grader;
    save(); res.json(view(o));
  });

  // Haken setzen: frühere Stufen werden mit gesetzt, gemailt wird nur die gewählte Stufe (einmal)
  app.post("/admin/api/orders/:id/stage", async (req, res) => {
    const o = db.orders[req.params.id]; if (!o) return res.status(404).json({ error: "nicht gefunden" });
    const { stage, on = true, resend = false } = req.body || {};
    const si = STAGES.findIndex((s) => s.key === stage); if (si < 0) return res.status(400).json({ error: "unbekannte Stufe" });
    const st = STAGES[si];
    if (!on) { delete o.stages[stage]; log(o, `Haken entfernt: ${st.label.replace("{G}", o.grader)}`); save(); return res.json(view(o)); }
    if (st.needsPsa && o.grader === "PSA" && !psaList(o.psa).length) return res.status(400).json({ error: "Bitte zuerst die PSA-Submission-Nummer eintragen." });
    for (let i = 0; i <= si; i++) o.stages[STAGES[i].key] = o.stages[STAGES[i].key] || now();
    let result = "";
    if (o.pickup && st.noMailStore && !resend) {
      result = "ohne Mail (Abholung)";
    } else if (!o.mails[stage] || resend) {
      try { result = await sendMail(o, stage); o.mails[stage] = now(); }
      catch (e) { result = "Fehler: " + e.message; }
    } else result = "Mail war schon raus";
    log(o, `${st.label.replace("{G}", o.grader)} · ${result}`);
    save(); res.json({ ...view(o), result });
  });

  app.post("/admin/api/orders/:id/delete", (req, res) => { delete db.orders[req.params.id]; save(); res.json({ ok: true }); });

  // ---------- Automatisch: Grades fertig ----------
  async function autoCheck(force = false) {
    if (!CFG.autoPsa && !force) return { skipped: true };
    const today = berlinDay();
    if (!force && db.lastAutoDay === today) return { skipped: "heute schon" };
    const hour = Number(new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "numeric" }).format(new Date()));
    if (!force && hour < 9) return { skipped: "vor 9 Uhr" };
    db.lastAutoDay = today; save();
    const out = [];
    for (const o of Object.values(db.orders)) {
      if (o.archived || o.grader !== "PSA" || !o.stages.bei_grader || o.stages.zurueck || o.mails.grades) continue;
      for (const nr of psaList(o.psa)) {
        try {
          const r = await getStatus(nr);
          if (r.raw && r.raw.gradesReady) {
            try { const res = await sendMail(o, "grades"); o.mails.grades = now(); log(o, `Automatisch: Grades fertig · ${res}`); out.push(o.nr); }
            catch (e) { log(o, "Automatisch: Grades-Mail fehlgeschlagen · " + e.message); }
            break;
          }
        } catch (e) { log(o, `PSA-Abfrage ${nr} fehlgeschlagen · ${e.message}`); }
      }
    }
    save();
    return { checked: true, mails: out };
  }
  setInterval(() => autoCheck().catch((e) => console.error("Auto-Check:", e.message)), 30 * 60 * 1000);
  setTimeout(() => autoCheck().catch(() => {}), 20 * 1000);
  app.post("/admin/api/auto-check", async (_req, res) => res.json(await autoCheck(true)));

  // Test-Mail
  app.post("/admin/api/test-mail", async (req, res) => {
    const to = String(req.body?.to || "").trim();
    const demo = { nr: "#1041", name: "Luca Brenner", email: to, items: [{ qty: 2, title: "PSA Grading Standard" }, { qty: 1, title: "PSA Dual Grading Express – Karte & Autogramm", variant: "Nur Autogrammbewertung" }], grader: "PSA", pickup: false, psa: "14348423", tracking: "", stages: { eingang: now(), an_grader: now() }, mails: {} };
    try { res.json({ result: await sendMail(demo, "bei_grader") }); }
    catch (e) {
      console.error("Test-Mail fehlgeschlagen:", e.message);
      const hint = /535|Invalid login|Username and Password/i.test(e.message) ? "Anmeldung bei Gmail abgelehnt. App-Passwort prüfen (ohne Leerzeichen) und SMTP_USER = Gmail-Adresse."
        : /Brevo 40[01]/.test(e.message) ? "Brevo lehnt ab: API-Schlüssel prüfen bzw. Absender (MAIL_FROM) in Brevo bestätigen."
        : /Resend 40[0-3]/.test(e.message) ? "Resend lehnt ab: API-Schlüssel prüfen bzw. Domain von MAIL_FROM in Resend bestätigen."
        : e.message;
      res.status(400).json({ error: hint });
    }
  });

  // ---------- Admin-Oberfläche ----------
  const page = fs.readFileSync(new URL("./admin.html", import.meta.url), "utf8");
  app.get("/admin", (_req, res) => res.type("html").send(page));
}
