const express = require('express');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const KITCHEN_ADDRESS = process.env.KITCHEN_ADDRESS;
const PROMO_CODE = process.env.PROMO;
const PROMO_DISCOUNT_PERCENT = 10;
const AVERAGE_SPEED_KMH = 30;
const KITCHEN_CAPACITY = 4;
const PREP_TIME_MIN = 10;
const LIVREUR_POSITION_MAX_AGE_MS = 3 * 60 * 1000;
const LIVREUR_HEARTBEAT_TIMEOUT_MS = 45 * 1000;
const PROPOSAL_TIMEOUT_MS = 60 * 1000;

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
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS eta`);
  // eta_minutes/eta_set_at étaient renseignés manuellement par un endpoint
  // jamais appelé depuis l'admin ; remplacés par l'estimation automatique
  // basée sur order_status_log (cf. getCookingOrdersWithRemaining).
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS eta_minutes`);
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS eta_set_at`);
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

// Simule une cuisine à capacité limitée (plusieurs commandes en parallèle) :
// renvoie le nombre de minutes avant que la (queuePosition + 1)-ème commande
// en attente obtienne une place sur le grill et termine de cuire.
function simulateKitchenQueue(queuePosition, cookingRemaining, capacity, ownCookTime) {
  const freeEvents = cookingRemaining.slice();
  let freeSlotsNow = Math.max(0, capacity - cookingRemaining.length);
  const ordersToProcess = queuePosition + 1;
  let lastStart = 0;

  for (let i = 0; i < ordersToProcess; i++) {
    let startTime;
    if (freeSlotsNow > 0) {
      startTime = 0;
      freeSlotsNow--;
    } else {
      freeEvents.sort((a, b) => a - b);
      startTime = freeEvents.shift();
      freeEvents.push(startTime + ownCookTime);
    }
    lastStart = startTime;
  }
  return lastStart + ownCookTime;
}

async function getKitchenQueueAheadCount(createdAt) {
  const result = await pool.query(
    "SELECT COUNT(*) FROM orders WHERE statut = 'nouvelle' AND created_at < $1",
    [createdAt]
  );
  return parseInt(result.rows[0].count, 10);
}

async function getCookingRemainingMinutes() {
  const result = await pool.query(`
    SELECT o.id, MAX(l.changed_at) AS started_at
    FROM orders o
    LEFT JOIN order_status_log l ON l.order_id = o.id AND l.statut = 'en_preparation'
    WHERE o.statut = 'en_preparation'
    GROUP BY o.id
  `);
  const now = Date.now();
  return result.rows.map(r => {
    if (!r.started_at) return PREP_TIME_MIN;
    const elapsedMin = (now - new Date(r.started_at).getTime()) / 60000;
    return Math.max(0, PREP_TIME_MIN - elapsedMin);
  });
}

// Comme getCookingRemainingMinutes, mais garde l'id et la position de chaque
// commande en cuisson — nécessaire pour suggérer d'attendre une commande
// livraison presque prête et proche du livreur.
async function getCookingOrdersWithRemaining() {
  const result = await pool.query(`
    SELECT o.id, o.lat, o.lng, MAX(l.changed_at) AS started_at
    FROM orders o
    LEFT JOIN order_status_log l ON l.order_id = o.id AND l.statut = 'en_preparation'
    WHERE o.statut = 'en_preparation' AND o.mode = 'livraison' AND o.lat IS NOT NULL AND o.lng IS NOT NULL
    GROUP BY o.id, o.lat, o.lng
  `);
  const now = Date.now();
  return result.rows.map(r => {
    const elapsedMin = r.started_at ? (now - new Date(r.started_at).getTime()) / 60000 : 0;
    return { id: r.id, lat: r.lat, lng: r.lng, remaining: Math.max(0, PREP_TIME_MIN - elapsedMin) };
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

// Estime quand une commande donnée sera prête (et livrée, le cas échéant),
// en tenant compte de la charge actuelle de la cuisine et, pour une
// livraison, de la tournée en cours du livreur.
async function estimateOrderEta(order) {
  const queuePosition = await getKitchenQueueAheadCount(order.created_at);
  const cookingRemaining = await getCookingRemainingMinutes();
  const readyInMinutes = simulateKitchenQueue(queuePosition, cookingRemaining, KITCHEN_CAPACITY, PREP_TIME_MIN);

  if (order.mode !== 'livraison') {
    return Math.round(readyInMinutes);
  }

  if (order.lat === null || order.lng === null || KITCHEN_LAT === null || KITCHEN_LNG === null) {
    return Math.round(readyInMinutes);
  }

  const onlineNames = getOnlineLivreurNames();
  if (onlineNames.length === 0) {
    // Personne en ligne : seule estimation possible, un trajet direct depuis la cuisine.
    const travel = haversineDistance(KITCHEN_LAT, KITCHEN_LNG, order.lat, order.lng) / AVERAGE_SPEED_KMH * 60;
    return Math.round(readyInMinutes + travel);
  }

  // On ne sait pas encore à qui cette commande sera proposée (elle n'est pas
  // encore prête) : on prend le meilleur cas parmi les livreurs en ligne,
  // celui qui pourrait réalistement s'en charger le plus vite.
  let best = Infinity;
  for (const name of onlineNames) {
    const { orderedOrders, cumulativeMinutes } = await computeOptimizedStops(name);
    const remainingRouteTime = cumulativeMinutes.length > 0 ? cumulativeMinutes[cumulativeMinutes.length - 1] : 0;
    const referencePoint = orderedOrders.length > 0
      ? { lat: orderedOrders[orderedOrders.length - 1].lat, lng: orderedOrders[orderedOrders.length - 1].lng }
      : getLivreurPosition(name);
    const travel = haversineDistance(referencePoint.lat, referencePoint.lng, order.lat, order.lng) / AVERAGE_SPEED_KMH * 60;
    const total = Math.max(readyInMinutes, remainingRouteTime) + travel;
    if (total < best) best = total;
  }

  return Math.round(best);
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
    const total = (session.amount_total || 0) / 100;
    const scheduledFor = metadata.scheduledFor ? new Date(metadata.scheduledFor) : null;

    try {
      const inserted = await pool.query(
        `INSERT INTO orders (nom, telephone, mode, adresse, classique, xl, thina, total, scheduled_for, stripe_session_id, remarques)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [metadata.nom, metadata.telephone, metadata.mode, metadata.adresse, classique, xl, thina, total, scheduledFor, session.id, metadata.remarques || '']
      );
      const orderId = inserted.rows[0].id;
      const numeroCommande = `CMD-${String(orderId).padStart(6, '0')}`;
      await pool.query('UPDATE orders SET numero_commande = $1 WHERE id = $2', [numeroCommande, orderId]);
      await logStatusChange(orderId, 'nouvelle');

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
    const { classique, xl, thina, nom, telephone, mode, adresse, remarques, promoCode, scheduledFor } = req.body;

    if (mode === 'livraison' && (!adresse || !adresse.trim())) {
      return res.status(400).json({ error: 'Une adresse est obligatoire pour une livraison à domicile.' });
    }

    const promoValid = !!(PROMO_CODE && promoCode && promoCode.trim().toUpperCase() === PROMO_CODE.trim().toUpperCase());
    const discountFactor = promoValid ? (1 - PROMO_DISCOUNT_PERCENT / 100) : 1;
    const promoSuffix = promoValid ? ` (-${PROMO_DISCOUNT_PERCENT}%)` : '';

    const line_items = [];
    if (classique > 0) {
      line_items.push({
        price_data: {
          currency: 'chf',
          product_data: { name: `Arayes Classique${promoSuffix}` },
          unit_amount: Math.round(1295 * discountFactor)
        },
        quantity: classique
      });
    }
    if (xl > 0) {
      line_items.push({
        price_data: {
          currency: 'chf',
          product_data: { name: `Arayes XL${promoSuffix}` },
          unit_amount: Math.round(1495 * discountFactor)
        },
        quantity: xl
      });
    }
    if (thina > 0) {
      line_items.push({
        price_data: {
          currency: 'chf',
          product_data: { name: `Pot de Thina${promoSuffix}` },
          unit_amount: Math.round(80 * discountFactor)
        },
        quantity: thina
      });
    }
    if (mode === 'livraison') {
      line_items.push({
        price_data: {
          currency: 'chf',
          product_data: { name: 'Frais de livraison' },
          unit_amount: 500
        },
        quantity: 1
      });
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
        remarques: (remarques || '').slice(0, 500)
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
      'SELECT id, created_at, statut, mode, lat, lng, numero_commande FROM orders WHERE stripe_session_id = $1',
      [session_id]
    );
    if (result.rows.length === 0) return res.json({ found: false });

    const order = result.rows[0];
    const doneStatut = order.mode === 'retrait' ? 'pret' : 'livre';
    let eta_minutes = null;
    if (order.statut !== doneStatut) {
      try {
        eta_minutes = await estimateOrderEta(order);
      } catch (err) {
        console.error('Erreur estimation ETA:', err.message);
      }
    }

    res.json({
      found: true,
      statut: order.statut,
      mode: order.mode,
      numero_commande: order.numero_commande,
      eta_minutes
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
    const header = ['numero_commande', 'date', 'nom', 'telephone', 'mode', 'adresse', 'classique', 'xl', 'thina', 'total', 'statut', 'remarques'];
    const lines = [header.map(csvField).join(',')];
    for (const r of result.rows) {
      lines.push([r.numero_commande, r.created_at, r.nom, r.telephone, r.mode, r.adresse, r.classique, r.xl, r.thina, r.total, r.statut, r.remarques].map(csvField).join(','));
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
