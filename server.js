require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// Run migrations
const initSql = fs.readFileSync(path.join(__dirname, 'migrations', 'init.sql'), 'utf8');
db.exec(initSql, (err) => {
  if (err) console.error('DB init error', err);
  else console.log('DB ready');
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.get('/', (req, res) => {
  res.send('Backend is live!');
});

// Optionally protect routes with middleware/auth.js
// const authMiddleware = require('./middleware/auth');
// app.use('/api/products', authMiddleware, require('./routes/products'));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Inventory backend listening on ${PORT}`));