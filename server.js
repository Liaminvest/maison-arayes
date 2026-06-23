const express = require('express');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const LIVREUR_PASSWORD = process.env.LIVREUR_PASSWORD;
const KITCHEN_ADDRESS = process.env.KITCHEN_ADDRESS;
const PROMO_CODE = process.env.PROMO;
const PROMO_DISCOUNT_PERCENT = 10;
const AVERAGE_SPEED_KMH = 30;

let KITCHEN_LAT = null;
let KITCHEN_LNG = null;

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
  await pool.query(`ALTER TABLE orders DROP COLUMN IF EXISTS eta`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta_minutes INT`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta_set_at TIMESTAMP`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for TIMESTAMP`);
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

function checkAdminPassword(req, res, next) {
  if (ADMIN_PASSWORD && req.header('x-admin-password') === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function checkLivreurPassword(req, res, next) {
  if (LIVREUR_PASSWORD && req.header('x-livreur-password') === LIVREUR_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function checkAdminOrLivreurPassword(req, res, next) {
  if (ADMIN_PASSWORD && req.header('x-admin-password') === ADMIN_PASSWORD) return next();
  if (LIVREUR_PASSWORD && req.header('x-livreur-password') === LIVREUR_PASSWORD) return next();
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
    const thina = parseInt(metadata.thina || '0', 10);
    const total = (session.amount_total || 0) / 100;
    const scheduledFor = metadata.scheduledFor ? new Date(metadata.scheduledFor) : null;

    try {
      const inserted = await pool.query(
        `INSERT INTO orders (nom, telephone, mode, adresse, classique, thina, total, scheduled_for)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [metadata.nom, metadata.telephone, metadata.mode, metadata.adresse, classique, thina, total, scheduledFor]
      );
      const orderId = inserted.rows[0].id;

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
    const { classique, thina, nom, telephone, mode, adresse, promoCode, scheduledFor } = req.body;

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
      metadata: { nom, telephone, mode, adresse, classique: String(classique), thina: String(thina), scheduledFor: scheduledFor || '' },
      success_url: BASE_URL + '/success.html',
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
    await pool.query('UPDATE orders SET statut = $1 WHERE id = $2', [statut, req.params.id]);
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
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/orders/route', checkLivreurPassword, async (req, res) => {
  try {
    if (KITCHEN_LAT === null || KITCHEN_LNG === null) {
      return res.json({ stops: [], wait_suggestion: null, message: 'Tournée indisponible : adresse de la cuisine non géolocalisée' });
    }

    const readyResult = await pool.query(
      "SELECT * FROM orders WHERE mode = 'livraison' AND statut = 'pret' AND lat IS NOT NULL ORDER BY created_at ASC"
    );
    const readyOrders = readyResult.rows;

    if (readyOrders.length === 0) {
      return res.json({ stops: [], wait_suggestion: null, message: 'Aucune livraison prête pour le moment' });
    }

    let orderedOrders;
    let cumulativeMinutes;

    try {
      const coords = [`${KITCHEN_LNG},${KITCHEN_LAT}`, ...readyOrders.map(o => `${o.lng},${o.lat}`)].join(';');
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
      let currentLat = KITCHEN_LAT;
      let currentLng = KITCHEN_LNG;
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

    const stops = orderedOrders.map((o, i) => ({
      id: o.id,
      nom: o.nom,
      telephone: o.telephone,
      adresse: o.adresse,
      classique: o.classique,
      thina: o.thina,
      total: o.total,
      minutes_trajet: Math.round(cumulativeMinutes[i])
    }));

    const prepResult = await pool.query(
      "SELECT * FROM orders WHERE mode = 'livraison' AND statut = 'en_preparation' AND eta_minutes IS NOT NULL AND eta_set_at IS NOT NULL AND lat IS NOT NULL"
    );

    const lastPoint = orderedOrders.length > 0
      ? { lat: orderedOrders[orderedOrders.length - 1].lat, lng: orderedOrders[orderedOrders.length - 1].lng }
      : { lat: KITCHEN_LAT, lng: KITCHEN_LNG };

    let bestCandidate = null;
    for (const row of prepResult.rows) {
      const readyAt = new Date(row.eta_set_at).getTime() + row.eta_minutes * 60000;
      const minutesRestantes = (readyAt - Date.now()) / 60000;
      if (minutesRestantes >= 0 && minutesRestantes <= 3) {
        const dist = haversineDistance(lastPoint.lat, lastPoint.lng, row.lat, row.lng);
        if (dist <= 1.5 && (!bestCandidate || minutesRestantes < bestCandidate.minutesRestantes)) {
          bestCandidate = { id: row.id, minutesRestantes };
        }
      }
    }

    let wait_suggestion = null;
    if (bestCandidate) {
      const rounded = Math.round(bestCandidate.minutesRestantes);
      wait_suggestion = {
        commande_id: bestCandidate.id,
        minutes_restantes: rounded,
        message: `Attends encore ~${rounded} min, une commande proche sera prête`
      };
    }

    res.json({ stops, wait_suggestion });
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
    const header = ['date', 'nom', 'telephone', 'mode', 'adresse', 'classique', 'thina', 'total', 'statut'];
    const lines = [header.map(csvField).join(',')];
    for (const r of result.rows) {
      lines.push([r.created_at, r.nom, r.telephone, r.mode, r.adresse, r.classique, r.thina, r.total, r.statut].map(csvField).join(','));
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
