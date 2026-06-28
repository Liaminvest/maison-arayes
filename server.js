const express = require('express');
const { Pool } = require('pg');
const { Resend } = require('resend');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KITCHEN_ADDRESS = process.env.KITCHEN_ADDRESS;
const PROMO_CODE = process.env.PROMO;
// Adresse de notification des avis clients — jamais transmise au navigateur,
// utilisée uniquement côté serveur pour l'envoi par Resend.
const REVIEW_NOTIFY_EMAIL = process.env.REVIEW_NOTIFY_EMAIL;
const RESEND_FROM = process.env.RESEND_FROM || 'onboarding@resend.dev';
const PROMO_DISCOUNT_PERCENT = 10;
const AVERAGE_SPEED_KMH = 30;
// Réalité de la cuisson : 3 poêles × 2 triangles = 6 triangles = 2 commandes
// (1 commande = 3 triangles) traitées par cycle de four + poêle + emballage.
const CYCLE_MINUTES = 9;
const BATCH_SIZE = 2;
const LIVREUR_POSITION_MAX_AGE_MS = 3 * 60 * 1000;
const LIVREUR_HEARTBEAT_TIMEOUT_MS = 45 * 1000;
const PROPOSAL_TIMEOUT_MS = 60 * 1000;
// Capacité réelle de la cuisine : 25 commandes par soir (une commande = une
// session payée, quel que soit le nombre d'Arayes qu'elle contient).
const DAILY_ORDER_CAPACITY = 25;
const OPEN_WEEKDAYS = new Set([0, 1, 2, 3, 4]); // Dim-Jeu ouverts, Ven/Sam fermés

let KITCHEN_LAT = null;
let KITCHEN_LNG = null;

// Un livreur par variable d'env LIVREUR_PASSWORD_<NOM> — autant qu'on en définit.
const LIVREUR_PASSWORDS = {};
Object.keys(process.env).forEach(key => {
  const match = key.match(/^LIVREUR_PASSWORD_(.+)$/);
  if (match && process.env[key]) LIVREUR_PASSWORDS[match[1]] = process.env[key];
});

// État en mémoire de chaque livreur connu : position, dernière activité, en ligne ou pas.
const livreurs = {};
function ensureLivreurEntry(name) {
  if (!livreurs[name]) livreurs[name] = { lat: null, lng: null, lastSeen: 0, online: false };
  return livreurs[name];
}

function getOnlineLivreurNames() {
  const now = Date.now();
  return Object.keys(livreurs).filter(name => livreurs[name].online && (now - livreurs[name].lastSeen) < LIVREUR_HEARTBEAT_TIMEOUT_MS);
}

// Position réelle d'un livreur si reçue récemment, sinon la cuisine.
function getLivreurPosition(name) {
  const entry = livreurs[name];
  if (entry && entry.lat !== null && (Date.now() - entry.lastSeen) < LIVREUR_POSITION_MAX_AGE_MS) {
    return { lat: entry.lat, lng: entry.lng };
  }
  return { lat: KITCHEN_LAT, lng: KITCHEN_LNG };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT NOW(),
      nom TEXT,
      telephone TEXT,
      mode TEXT,
      adresse TEXT,
      classique INT DEFAULT 0,
      epice INT DEFAULT 0,
      total NUMERIC(10,2),
      statut TEXT DEFAULT 'nouvelle'
    )
  `);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS thina INT DEFAULT 0`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS xl INT DEFAULT 0`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_online NUMERIC(10,2)`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_on_pickup BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS eta`);
  // eta_minutes/eta_set_at : calculés automatiquement à la création de la
  // commande (webhook), ajustés à chaque commande qui passe pret/livre, et
  // modifiables manuellement par la cuisine (POST /api/orders/:id/eta).
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta_minutes INT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta_set_at TIMESTAMP`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMP`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS numero_commande TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_session_id TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS remarques TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_livreur TEXT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS proposal_accepted BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS declined_by TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS proposed_at TIMESTAMP`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_status_log (
      id SERIAL PRIMARY KEY,
      order_id INT NOT NULL,
      statut TEXT NOT NULL,
      changed_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

async function logStatusChange(orderId, statut) {
  await pool.query(
    'INSERT INTO order_status_log (order_id, statut) VALUES ($1, $2)',
    [orderId, statut]
  );
}

async function geocodeAddress(adresse) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(adresse)}&limit=1`;
    const response = await fetch(url, { headers: { 'User-Agent': 'MaisonArayesGeneve/1.0' } });
    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) {
      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    }
    return null;
  } catch (err) {
    console.error('Erreur de géocodage:', err.message);
    return null;
  }
}

async function initKitchenLocation() {
  if (!KITCHEN_ADDRESS) {
    console.error('KITCHEN_ADDRESS non définie : les fonctionnalités de tournée sont désactivées.');
    return;
  }
  const coords = await geocodeAddress(KITCHEN_ADDRESS);
  if (coords) {
    KITCHEN_LAT = coords.lat;
    KITCHEN_LNG = coords.lng;
    console.log(`Cuisine géolocalisée à ${KITCHEN_LAT}, ${KITCHEN_LNG}`);
  } else {
    console.error(`Échec du géocodage de KITCHEN_ADDRESS ("${KITCHEN_ADDRESS}") : les fonctionnalités de tournée sont désactivées.`);
  }
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Date du jour à Genève, au format 'YYYY-MM-DD'.
function zurichDateStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'Europe/Zurich' });
}

// Jour de la semaine (0=dimanche) d'une date 'YYYY-MM-DD', sans ambiguïté
// de fuseau horaire (ancrée à midi UTC, jamais à plus de 2h de Genève).
function weekdayOfDateStr(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay();
}

// Nombre de commandes déjà comptabilisées pour un soir donné : une commande
// programmée compte pour son scheduled_for, une commande immédiate pour son
// created_at — les deux convertis en date locale de Genève.
async function getOrderCountForDate(dateStr) {
  const result = await pool.query(
    `SELECT COUNT(*) FROM orders
     WHERE to_char((COALESCE(scheduled_for, created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Zurich', 'YYYY-MM-DD') = $1`,
    [dateStr]
  );
  return parseInt(result.rows[0].count, 10);
}

// Premier soir ouvert et non complet après la date donnée — utilisé pour
// proposer une précommande quand le soir même est plein.
async function findNextAvailableDate(afterDateStr) {
  const start = new Date(afterDateStr + 'T12:00:00Z');
  for (let i = 1; i <= 30; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    if (!OPEN_WEEKDAYS.has(d.getUTCDay())) continue;
    const dateStr = d.toISOString().slice(0, 10);
    const count = await getOrderCountForDate(dateStr);
    if (count < DAILY_ORDER_CAPACITY) return dateStr;
  }
  return null;
}

// Combien de commandes sont déjà en file (pas encore prêtes) avant celle-ci.
async function computeQueueAheadCount(excludeOrderId) {
  const result = await pool.query(
    "SELECT COUNT(*) FROM orders WHERE statut IN ('nouvelle', 'en_preparation') AND id != $1",
    [excludeOrderId]
  );
  return parseInt(result.rows[0].count, 10);
}

// 2 commandes traitées par cycle de 9 min (four + poêle + emballage).
function etaMinutesForQueuePosition(positionDansLaQueue) {
  const cyclesAvant = Math.ceil((positionDansLaQueue + 1) / BATCH_SIZE);
  return cyclesAvant * CYCLE_MINUTES;
}

// Chaque fois qu'une commande passe à 'pret' ou 'livre', la file entière
// avance d'un cycle : pas de recalcul complexe, juste -9 min pour les autres.
async function decrementQueueEta(excludeOrderId) {
  await pool.query(
    `UPDATE orders SET eta_minutes = GREATEST(eta_minutes - ${CYCLE_MINUTES}, ${CYCLE_MINUTES})
     WHERE statut IN ('nouvelle', 'en_preparation') AND eta_minutes IS NOT NULL AND id != $1`,
    [excludeOrderId]
  );
}

// Commandes livraison en cuisson, avec leur ETA stocké — nécessaire pour
// suggérer au livreur d'attendre une commande presque prête et proche.
async function getCookingOrdersWithRemaining() {
  const result = await pool.query(`
    SELECT id, lat, lng, eta_minutes, eta_set_at
    FROM orders
    WHERE statut = 'en_preparation' AND mode = 'livraison'
      AND lat IS NOT NULL AND lng IS NOT NULL
      AND eta_minutes IS NOT NULL AND eta_set_at IS NOT NULL
  `);
  const now = Date.now();
  return result.rows.map(r => {
    const readyAt = new Date(r.eta_set_at).getTime() + r.eta_minutes * 60000;
    return { id: r.id, lat: r.lat, lng: r.lng, remaining: Math.max(0, (readyAt - now) / 60000) };
  });
}

// Cœur de la tournée optimisée d'UN livreur donné : ses commandes prêtes et
// acceptées, ordonnées via OSRM depuis sa position réelle (repli plus-proche-
// voisin si indisponible), plus celles dont l'adresse n'a pas pu être géolocalisée.
async function computeOptimizedStops(livreurName) {
  const readyResult = await pool.query(
    "SELECT * FROM orders WHERE mode = 'livraison' AND statut = 'pret' AND assigned_livreur = $1 AND proposal_accepted = true ORDER BY created_at ASC",
    [livreurName]
  );
  const allReady = readyResult.rows;
  const readyOrders = allReady.filter(o => o.lat !== null && o.lng !== null);
  const unlocatedOrders = allReady.filter(o => o.lat === null || o.lng === null);

  let orderedOrders = [];
  let cumulativeMinutes = [];

  if (readyOrders.length > 0 && KITCHEN_LAT !== null && KITCHEN_LNG !== null) {
    const startPoint = getLivreurPosition(livreurName);
    try {
      const coords = [`${startPoint.lng},${startPoint.lat}`, ...readyOrders.map(o => `${o.lng},${o.lat}`)].join(';');
      const osrmUrl = `https://router.project-osrm.org/trip/v1/driving/${coords}?source=first&roundtrip=false&overview=false`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const osrmRes = await fetch(osrmUrl, { signal: controller.signal });
      clearTimeout(timeout);
      const osrmData = await osrmRes.json();

      if (osrmData.code !== 'Ok') throw new Error('Réponse OSRM invalide');

      const waypoints = osrmData.waypoints;
      const legs = osrmData.trips[0].legs;

      const indexed = readyOrders.map((order, i) => ({
        order,
        tripIndex: waypoints[i + 1].waypoint_index
      }));
      indexed.sort((a, b) => a.tripIndex - b.tripIndex);
      orderedOrders = indexed.map(x => x.order);

      let cumSeconds = 0;
      cumulativeMinutes = orderedOrders.map((_, i) => {
        cumSeconds += legs[i].duration;
        return cumSeconds / 60;
      });
    } catch (err) {
      console.error('OSRM indisponible, repli sur le plus proche voisin:', err.message);
      const remaining = [...readyOrders];
      orderedOrders = [];
      cumulativeMinutes = [];
      let currentLat = startPoint.lat;
      let currentLng = startPoint.lng;
      let cumKm = 0;
      while (remaining.length > 0) {
        let nearestIdx = 0;
        let nearestDist = Infinity;
        remaining.forEach((o, i) => {
          const d = haversineDistance(currentLat, currentLng, o.lat, o.lng);
          if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
        });
        const next = remaining.splice(nearestIdx, 1)[0];
        cumKm += nearestDist;
        orderedOrders.push(next);
        cumulativeMinutes.push((cumKm / AVERAGE_SPEED_KMH) * 60);
        currentLat = next.lat;
        currentLng = next.lng;
      }
    }
  }

  return { orderedOrders, cumulativeMinutes, unlocatedOrders };
}

async function getActiveOrderCountsByLivreur() {
  const result = await pool.query(`
    SELECT assigned_livreur, COUNT(*) AS count FROM orders
    WHERE mode = 'livraison' AND statut = 'pret' AND proposal_accepted = true AND assigned_livreur IS NOT NULL
    GROUP BY assigned_livreur
  `);
  const counts = {};
  result.rows.forEach(r => { counts[r.assigned_livreur] = parseInt(r.count, 10); });
  return counts;
}

// Choisit, parmi les livreurs en ligne n'ayant pas déjà décliné cette commande,
// celui à qui la proposer : le plus proche de la cuisine (position réelle si
// connue, sinon en supposant qu'il est à la cuisine s'il n'a aucune livraison
// en cours, sinon en l'excluant car on ne sait pas où il est).
async function assignNextLivreur(orderId) {
  const orderResult = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
  const order = orderResult.rows[0];
  if (!order || order.statut !== 'pret' || order.mode !== 'livraison') return;

  const declined = order.declined_by ? order.declined_by.split(',').filter(Boolean) : [];
  let candidates = getOnlineLivreurNames().filter(n => !declined.includes(n));

  // Si tout le monde en ligne a déjà décliné ou laissé filer le délai, on
  // relance le cycle plutôt que de laisser la commande bloquée indéfiniment.
  if (candidates.length === 0) {
    candidates = getOnlineLivreurNames();
    if (candidates.length === 0) return;
    await pool.query("UPDATE orders SET declined_by = '' WHERE id = $1", [orderId]);
  }

  const activeCounts = await getActiveOrderCountsByLivreur();

  const scored = candidates.map(name => {
    const entry = livreurs[name];
    const hasFreshPosition = entry && entry.lat !== null && (Date.now() - entry.lastSeen) < LIVREUR_POSITION_MAX_AGE_MS;
    let distance;
    if (hasFreshPosition && KITCHEN_LAT !== null && KITCHEN_LNG !== null) {
      distance = haversineDistance(KITCHEN_LAT, KITCHEN_LNG, entry.lat, entry.lng);
    } else {
      distance = (activeCounts[name] || 0) === 0 ? 0 : Infinity;
    }
    return { name, distance };
  }).sort((a, b) => a.distance - b.distance);

  const chosen = scored[0];
  if (!chosen || chosen.distance === Infinity) return;

  await pool.query(
    'UPDATE orders SET assigned_livreur = $1, proposal_accepted = false, proposed_at = NOW() WHERE id = $2',
    [chosen.name, orderId]
  );
}

// À appeler à chaque interrogation par un livreur : relance les propositions
// restées sans réponse trop longtemps, et tente d'assigner toute commande
// prête qui n'a encore personne.
async function reconcileLivreurAssignments() {
  const staleResult = await pool.query(
    `SELECT id, assigned_livreur, declined_by FROM orders
     WHERE mode = 'livraison' AND statut = 'pret' AND proposal_accepted = false
       AND assigned_livreur IS NOT NULL
       AND proposed_at < NOW() - INTERVAL '${Math.round(PROPOSAL_TIMEOUT_MS / 1000)} seconds'`
  );
  for (const row of staleResult.rows) {
    const declined = row.declined_by ? row.declined_by.split(',').filter(Boolean) : [];
    if (!declined.includes(row.assigned_livreur)) declined.push(row.assigned_livreur);
    await pool.query(
      'UPDATE orders SET declined_by = $1, assigned_livreur = NULL, proposal_accepted = false, proposed_at = NULL WHERE id = $2',
      [declined.join(','), row.id]
    );
    await assignNextLivreur(row.id);
  }

  const unassignedResult = await pool.query(
    "SELECT id FROM orders WHERE mode = 'livraison' AND statut = 'pret' AND assigned_livreur IS NULL"
  );
  for (const row of unassignedResult.rows) {
    await assignNextLivreur(row.id);
  }
}


function checkAdminPassword(req, res, next) {
  if (ADMIN_PASSWORD && req.header('x-admin-password') === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function findLivreurByPassword(pwd) {
  if (!pwd) return null;
  return Object.keys(LIVREUR_PASSWORDS).find(name => LIVREUR_PASSWORDS[name] === pwd) || null;
}

function checkLivreurPassword(req, res, next) {
  const name = findLivreurByPassword(req.header('x-livreur-password'));
  if (name) {
    req.livreurName = name;
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function checkAdminOrLivreurPassword(req, res, next) {
  if (ADMIN_PASSWORD && req.header('x-admin-password') === ADMIN_PASSWORD) return next();
  const name = findLivreurByPassword(req.header('x-livreur-password'));
  if (name) {
    req.livreurName = name;
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return '"' + str.replace(/"/g, '""') + '"';
}

// Stripe webhook needs the raw body for signature verification, so it must
// be registered before the global express.json() middleware.
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature invalid:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const classique = parseInt(metadata.classique || '0', 10);
    const xl = parseInt(metadata.xl || '0', 10);
    const thina = parseInt(metadata.thina || '0', 10);
    const paidOnline = (session.amount_total || 0) / 100;
    const total = metadata.fullTotal ? parseFloat(metadata.fullTotal) : paidOnline;
    const cashOnPickup = metadata.cashOnPickup === 'true';
    const scheduledFor = metadata.scheduledFor ? new Date(metadata.scheduledFor) : null;

    try {
      const inserted = await pool.query(
        `INSERT INTO orders (nom, telephone, mode, adresse, classique, xl, thina, total, scheduled_for, stripe_session_id, remarques, paid_online, cash_on_pickup)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [metadata.nom, metadata.telephone, metadata.mode, metadata.adresse, classique, xl, thina, total, scheduledFor, session.id, metadata.remarques || '', paidOnline, cashOnPickup]
      );
      const orderId = inserted.rows[0].id;
      const numeroCommande = `CMD-${String(orderId).padStart(6, '0')}`;
      await pool.query('UPDATE orders SET numero_commande = $1 WHERE id = $2', [numeroCommande, orderId]);
      await logStatusChange(orderId, 'nouvelle');

      // Calcul automatique de l'ETA cuisine dès la création de la commande,
      // basé sur la position réelle dans la file (2 commandes / cycle de 9 min).
      const queueAhead = await computeQueueAheadCount(orderId);
      const etaMinutes = etaMinutesForQueuePosition(queueAhead);
      await pool.query('UPDATE orders SET eta_minutes = $1, eta_set_at = NOW() WHERE id = $2', [etaMinutes, orderId]);

      if (metadata.mode === 'livraison' && metadata.adresse) {
        const coords = await geocodeAddress(metadata.adresse);
        if (coords) {
          await pool.query('UPDATE orders SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, orderId]);
        }
      }
    } catch (err) {
      console.error('Failed to insert order:', err);
    }
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(__dirname));

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { classique, xl, thina, nom, telephone, mode, adresse, remarques, promoCode, scheduledFor, payOnPickup } = req.body;

    if (mode === 'livraison' && (!adresse || !adresse.trim())) {
      return res.status(400).json({ error: 'Une adresse est obligatoire pour une livraison à domicile.' });
    }

    // Capacité de 25 commandes par soir : on vérifie le soir visé par CETTE
    // commande (programmée ou immédiate) avant de créer la session Stripe.
    const serviceDateStr = scheduledFor ? zurichDateStr(new Date(scheduledFor)) : zurichDateStr(new Date());
    if (!OPEN_WEEKDAYS.has(weekdayOfDateStr(serviceDateStr))) {
      return res.status(400).json({ error: 'Nous sommes fermés ce jour-là.' });
    }
    const countForServiceDate = await getOrderCountForDate(serviceDateStr);
    if (countForServiceDate >= DAILY_ORDER_CAPACITY) {
      const nextAvailableDate = await findNextAvailableDate(serviceDateStr);
      return res.status(409).json({
        error: 'Désolé, nous sommes victimes de notre succès : il n\'y a plus d\'Arayes disponibles ce soir-là.',
        full: true,
        nextAvailableDate
      });
    }

    // Payer le solde en espèces/Twint sur place n'est proposé que pour le retrait.
    const cashOnPickup = !!(payOnPickup && mode === 'retrait');

    const promoValid = !!(PROMO_CODE && promoCode && promoCode.trim().toUpperCase() === PROMO_CODE.trim().toUpperCase());
    const discountFactor = promoValid ? (1 - PROMO_DISCOUNT_PERCENT / 100) : 1;
    const promoSuffix = promoValid ? ` (-${PROMO_DISCOUNT_PERCENT}%)` : '';

    const items = [];
    if (classique > 0) items.push({ name: `Arayes Classique${promoSuffix}`, unit_amount: Math.round(1295 * discountFactor), quantity: classique });
    if (xl > 0) items.push({ name: `Arayes XL${promoSuffix}`, unit_amount: Math.round(1595 * discountFactor), quantity: xl });
    if (thina > 0) items.push({ name: `Pot de Thina${promoSuffix}`, unit_amount: Math.round(80 * discountFactor), quantity: thina });
    if (mode === 'livraison') items.push({ name: 'Frais de livraison', unit_amount: 500, quantity: 1 });

    const fullTotalCents = items.reduce((sum, it) => sum + it.unit_amount * it.quantity, 0);

    let line_items;
    if (cashOnPickup) {
      const depositCents = Math.max(200, Math.round(fullTotalCents * 0.15));
      line_items = [{
        price_data: {
          currency: 'chf',
          product_data: { name: 'Acompte (15%) — solde à régler sur place en espèces/Twint' },
          unit_amount: depositCents
        },
        quantity: 1
      }];
    } else {
      line_items = items.map(it => ({
        price_data: {
          currency: 'chf',
          product_data: { name: it.name },
          unit_amount: it.unit_amount
        },
        quantity: it.quantity
      }));
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      metadata: {
        nom, telephone, mode, adresse,
        classique: String(classique),
        xl: String(xl),
        thina: String(thina),
        scheduledFor: scheduledFor || '',
        remarques: (remarques || '').slice(0, 500),
        cashOnPickup: cashOnPickup ? 'true' : 'false',
        fullTotal: (fullTotalCents / 100).toFixed(2)
      },
      success_url: BASE_URL + '/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: BASE_URL + '/cancel.html'
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/success.html', (req, res) => {
  res.sendFile(__dirname + '/success.html');
});

app.get('/api/order-status', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id requis' });
    const result = await pool.query(
      'SELECT statut, mode, numero_commande, eta_minutes, eta_set_at FROM orders WHERE stripe_session_id = $1',
      [session_id]
    );
    if (result.rows.length === 0) return res.json({ found: false });

    const order = result.rows[0];
    res.json({
      found: true,
      statut: order.statut,
      mode: order.mode,
      numero_commande: order.numero_commande,
      eta_minutes: order.eta_minutes,
      eta_set_at: order.eta_set_at
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/cancel.html', (req, res) => {
  res.sendFile(__dirname + '/cancel.html');
});

app.get('/admin', (req, res) => {
  res.sendFile(__dirname + '/admin.html');
});

app.get('/livreur', (req, res) => {
  res.sendFile(__dirname + '/livreur.html');
});

app.get('/avis', (req, res) => {
  res.sendFile(__dirname + '/avis.html');
});

// État de la capacité (25 commandes/soir) : utilisé par le site pour
// afficher le compteur et limiter les créneaux de précommande proposés
// aux soirs encore disponibles.
app.get('/api/capacity', async (req, res) => {
  try {
    const todayStr = zurichDateStr(new Date());
    const todayOpen = OPEN_WEEKDAYS.has(weekdayOfDateStr(todayStr));
    const todayCount = await getOrderCountForDate(todayStr);
    const todayFull = todayOpen && todayCount >= DAILY_ORDER_CAPACITY;

    const days = [];
    for (let i = 0; i <= 14; i++) {
      const d = new Date(todayStr + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      if (!OPEN_WEEKDAYS.has(d.getUTCDay())) continue;
      const dateStr = d.toISOString().slice(0, 10);
      const count = await getOrderCountForDate(dateStr);
      days.push({
        date: dateStr,
        remaining: Math.max(0, DAILY_ORDER_CAPACITY - count),
        full: count >= DAILY_ORDER_CAPACITY
      });
    }

    const nextAvailableDate = todayFull ? await findNextAvailableDate(todayStr) : null;

    res.json({
      today: {
        date: todayStr,
        open: todayOpen,
        count: todayCount,
        capacity: DAILY_ORDER_CAPACITY,
        remaining: Math.max(0, DAILY_ORDER_CAPACITY - todayCount),
        full: todayFull
      },
      days,
      nextAvailableDate
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/avis', async (req, res) => {
  try {
    const { message, rating } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Merci d'écrire un message." });
    }

    const ratingNum = Number.isInteger(rating) && rating >= 0 && rating <= 5 ? rating : null;
    const stars = ratingNum !== null ? '⭐'.repeat(ratingNum) + '☆'.repeat(5 - ratingNum) + ` (${ratingNum}/5)` : 'Non noté';

    if (REVIEW_NOTIFY_EMAIL && process.env.RESEND_API_KEY) {
      await resend.emails.send({
        from: RESEND_FROM,
        to: REVIEW_NOTIFY_EMAIL,
        subject: `Nouvel avis — ${stars}`,
        text: `Note : ${stars}\n\nMessage :\n${message.trim()}`
      });
    } else {
      console.error('Avis reçu mais RESEND_API_KEY ou REVIEW_NOTIFY_EMAIL non configuré.');
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erreur lors de l'envoi de l'avis:", err.message);
    res.status(500).json({ error: 'Une erreur est survenue, merci de réessayer.' });
  }
});

app.get('/api/orders', checkAdminPassword, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/status', checkAdminOrLivreurPassword, async (req, res) => {
  try {
    const { statut } = req.body;

    if (req.livreurName) {
      const check = await pool.query('SELECT assigned_livreur FROM orders WHERE id = $1', [req.params.id]);
      if (check.rows.length === 0 || check.rows[0].assigned_livreur !== req.livreurName) {
        return res.status(403).json({ error: "Cette commande ne vous est pas assignée." });
      }
    }

    await pool.query('UPDATE orders SET statut = $1 WHERE id = $2', [statut, req.params.id]);
    await logStatusChange(req.params.id, statut);
    if (statut === 'pret' || statut === 'livre') {
      await decrementQueueEta(req.params.id);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/eta', checkAdminPassword, async (req, res) => {
  try {
    const { eta } = req.body;
    await pool.query('UPDATE orders SET eta_minutes = $1, eta_set_at = NOW() WHERE id = $2', [eta, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/pret', checkAdminPassword, async (req, res) => {
  try {
    const result = await pool.query("UPDATE orders SET statut = 'pret' WHERE id = $1 RETURNING *", [req.params.id]);
    await logStatusChange(req.params.id, 'pret');
    await decrementQueueEta(req.params.id);
    if (result.rows[0] && result.rows[0].mode === 'livraison') {
      await assignNextLivreur(req.params.id);
    }
    const updated = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/accept', checkLivreurPassword, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE orders SET proposal_accepted = true WHERE id = $1 AND assigned_livreur = $2 RETURNING *',
      [req.params.id, req.livreurName]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: "Cette commande ne vous est plus proposée." });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:id/decline', checkLivreurPassword, async (req, res) => {
  try {
    const orderResult = await pool.query(
      'SELECT * FROM orders WHERE id = $1 AND assigned_livreur = $2 AND proposal_accepted = false',
      [req.params.id, req.livreurName]
    );
    if (orderResult.rows.length === 0) {
      return res.status(409).json({ error: "Cette commande ne vous est plus proposée." });
    }

    const canDecline = getOnlineLivreurNames().filter(n => n !== req.livreurName).length > 0;
    if (!canDecline) {
      return res.status(400).json({ error: 'Aucun autre livreur disponible pour reprendre cette commande.' });
    }

    const order = orderResult.rows[0];
    const declined = order.declined_by ? order.declined_by.split(',').filter(Boolean) : [];
    if (!declined.includes(req.livreurName)) declined.push(req.livreurName);

    await pool.query(
      'UPDATE orders SET declined_by = $1, assigned_livreur = NULL, proposal_accepted = false, proposed_at = NULL WHERE id = $2',
      [declined.join(','), req.params.id]
    );
    await assignNextLivreur(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/livreur/heartbeat', checkLivreurPassword, (req, res) => {
  const entry = ensureLivreurEntry(req.livreurName);
  entry.online = true;
  entry.lastSeen = Date.now();
  res.json({ ok: true });
});

app.post('/api/livreur/position', checkLivreurPassword, (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat et lng (nombres) requis' });
  }
  const entry = ensureLivreurEntry(req.livreurName);
  entry.lat = lat;
  entry.lng = lng;
  entry.online = true;
  entry.lastSeen = Date.now();
  res.json({ ok: true });
});

app.post('/api/livreur/logout', checkLivreurPassword, (req, res) => {
  const entry = ensureLivreurEntry(req.livreurName);
  entry.online = false;
  res.json({ ok: true });
});

app.get('/api/orders/route', checkLivreurPassword, async (req, res) => {
  try {
    const entry = ensureLivreurEntry(req.livreurName);
    entry.online = true;
    entry.lastSeen = Date.now();

    await reconcileLivreurAssignments();

    if (KITCHEN_LAT === null || KITCHEN_LNG === null) {
      return res.json({ stops: [], wait_suggestion: null, proposal: null, message: 'Tournée indisponible : adresse de la cuisine non géolocalisée' });
    }

    const proposalResult = await pool.query(
      "SELECT * FROM orders WHERE mode = 'livraison' AND statut = 'pret' AND assigned_livreur = $1 AND proposal_accepted = false",
      [req.livreurName]
    );
    const canDecline = getOnlineLivreurNames().filter(n => n !== req.livreurName).length > 0;
    const proposal = proposalResult.rows.length > 0 ? {
      id: proposalResult.rows[0].id,
      numero_commande: proposalResult.rows[0].numero_commande,
      nom: proposalResult.rows[0].nom,
      adresse: proposalResult.rows[0].adresse,
      classique: proposalResult.rows[0].classique,
      xl: proposalResult.rows[0].xl,
      thina: proposalResult.rows[0].thina,
      total: proposalResult.rows[0].total,
      remarques: proposalResult.rows[0].remarques,
      can_decline: canDecline
    } : null;

    const { orderedOrders, cumulativeMinutes, unlocatedOrders } = await computeOptimizedStops(req.livreurName);

    if (orderedOrders.length === 0 && unlocatedOrders.length === 0) {
      return res.json({ stops: [], wait_suggestion: null, proposal, message: 'Aucune livraison prête pour le moment' });
    }

    const stops = orderedOrders.map((o, i) => ({
      id: o.id,
      numero_commande: o.numero_commande,
      nom: o.nom,
      telephone: o.telephone,
      adresse: o.adresse,
      classique: o.classique,
      xl: o.xl,
      thina: o.thina,
      total: o.total,
      remarques: o.remarques,
      minutes_trajet: Math.round(cumulativeMinutes[i]),
      localisation_inconnue: false
    }));

    // Commandes prêtes dont l'adresse n'a pas pu être géocodée : on ne peut pas les
    // intégrer à la tournée optimisée, mais elles ne doivent jamais disparaître.
    unlocatedOrders.forEach(o => {
      stops.push({
        id: o.id,
        numero_commande: o.numero_commande,
        nom: o.nom,
        telephone: o.telephone,
        adresse: o.adresse,
        classique: o.classique,
        xl: o.xl,
        thina: o.thina,
        total: o.total,
        remarques: o.remarques,
        minutes_trajet: null,
        localisation_inconnue: true
      });
    });

    const cookingOrders = await getCookingOrdersWithRemaining();

    const lastPoint = orderedOrders.length > 0
      ? { lat: orderedOrders[orderedOrders.length - 1].lat, lng: orderedOrders[orderedOrders.length - 1].lng }
      : { lat: KITCHEN_LAT, lng: KITCHEN_LNG };

    let bestCandidate = null;
    for (const c of cookingOrders) {
      if (c.remaining <= 3) {
        const dist = haversineDistance(lastPoint.lat, lastPoint.lng, c.lat, c.lng);
        if (dist <= 1.5 && (!bestCandidate || c.remaining < bestCandidate.remaining)) {
          bestCandidate = { id: c.id, remaining: c.remaining };
        }
      }
    }

    let wait_suggestion = null;
    if (bestCandidate) {
      const rounded = Math.round(bestCandidate.remaining);
      wait_suggestion = {
        commande_id: bestCandidate.id,
        minutes_restantes: rounded,
        message: `Attends encore ~${rounded} min, une commande proche sera prête`
      };
    }

    res.json({ stops, wait_suggestion, proposal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/livraison', checkLivreurPassword, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM orders WHERE mode = 'livraison' AND statut != 'livre' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/export', checkAdminPassword, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    const header = ['numero_commande', 'date', 'nom', 'telephone', 'mode', 'adresse', 'classique', 'xl', 'thina', 'total', 'statut', 'remarques', 'paid_online', 'cash_on_pickup'];
    const lines = [header.map(csvField).join(',')];
    for (const r of result.rows) {
      lines.push([r.numero_commande, r.created_at, r.nom, r.telephone, r.mode, r.adresse, r.classique, r.xl, r.thina, r.total, r.statut, r.remarques, r.paid_online, r.cash_on_pickup].map(csvField).join(','));
    }
    const csv = lines.join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="commandes-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(__dirname + "/Maison de l'arayes.html");
});

initDb()
  .then(() => initKitchenLocation())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Site live sur le port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Erreur de connexion à la base de données:', err);
    process.exit(1);
  });
