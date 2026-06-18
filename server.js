const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(__dirname + "/Maison de l'arayes.html");
});

app.listen(PORT, () => {
  console.log(`Site live sur le port ${PORT}`);
});
