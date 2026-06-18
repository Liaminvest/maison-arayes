const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;

app.use(express.json());
app.use(express.static(__dirname));

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { classique, epice, nom, telephone, mode, adresse } = req.body;

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
    if (epice > 0) {
      line_items.push({
        price_data: {
          currency: 'chf',
          product_data: { name: 'Arayes Épicé' },
          unit_amount: 1495
        },
        quantity: epice
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      metadata: { nom, telephone, mode, adresse },
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

app.get('*', (req, res) => {
  res.sendFile(__dirname + "/Maison de l'arayes.html");
});

app.listen(PORT, () => {
  console.log(`Site live sur le port ${PORT}`);
});
