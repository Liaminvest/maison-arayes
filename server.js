const express = require('express');
const { Pool } = require('pg');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

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
}

function checkAdminPassword(req, res, next) {
  if (ADMIN_PASSWORD && req.header('x-admin-password') === ADMIN_PASSWORD) return next();
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

    try {
      await pool.query(
        `INSERT INTO orders (nom, telephone, mode, adresse, classique, thina, total)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [metadata.nom, metadata.telephone, metadata.mode, metadata.adresse, classique, thina, total]
      );
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
    const { classique, thina, nom, telephone, mode, adresse } = req.body;

    const line_items = [];
    if (classique > 0) {
      line_items.push({
        price_data: {
          currency: 'chf',
          product_data: { name: 'Arayes Classique' },
          unit_amount: 1295
        },
        quantity: classique
      });
    }
    if (thina > 0) {
      line_items.push({
        price_data: {
          currency: 'chf',
          product_data: { name: 'Pot de Thina' },
          unit_amount: 80
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
      metadata: { nom, telephone, mode, adresse, classique: String(classique), thina: String(thina) },
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

app.post('/api/orders/:id/status', checkAdminPassword, async (req, res) => {
  try {
    const { statut } = req.body;
    await pool.query('UPDATE orders SET statut = $1 WHERE id = $2', [statut, req.params.id]);
    res.json({ ok: true });
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
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Site live sur le port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Erreur de connexion à la base de données:', err);
    process.exit(1);
  });
