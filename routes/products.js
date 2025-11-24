const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const { body, validationResult } = require('express-validator');

const upload = multer({ dest: 'uploads/' });

// helpers (promisified)
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/* GET /api/products
   Support query params: page, limit, sortBy, sortDir, name, category, status, inStock
*/
router.get('/', async (req, res) => {
  try {
    let { page = 1, limit = 20, sortBy = 'id', sortDir = 'desc', name, category, status, inStock } = req.query;
    page = Number(page) || 1;
    limit = Number(limit) || 20;
    const offset = (page - 1) * limit;

    const allowed = ['id', 'name', 'brand', 'category', 'stock', 'created_at', 'updated_at'];
    if (!allowed.includes(sortBy)) sortBy = 'id';
    sortDir = sortDir === 'asc' ? 'ASC' : 'DESC';

    let where = 'WHERE 1=1';
    const params = [];
    if (name) { where += ' AND LOWER(name) LIKE LOWER(?)'; params.push(`%${name}%`); }
    if (category) { where += ' AND LOWER(category) LIKE LOWER(?)'; params.push(`%${category}%`); }
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (inStock === 'true') { where += ' AND stock > 0'; }
    if (inStock === 'false') { where += ' AND stock = 0'; }

    const totalRow = await getAsync(`SELECT COUNT(*) as cnt FROM products ${where}`, params);
    const total = totalRow ? totalRow.cnt : 0;

    const rows = await allAsync(
      `SELECT * FROM products ${where} ORDER BY ${sortBy} ${sortDir} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ data: rows, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* GET categories list */
router.get('/categories/list', async (req, res) => {
  try {
    const rows = await allAsync('SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != ""');
    res.json(rows.map(r => r.category));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* POST create product */
router.post(
  '/',
  body('name').notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    try {
      const { name, unit = null, category = null, brand = null, stock = 0, status = null, image = null } = req.body;
      const result = await runAsync(
        `INSERT INTO products (name,unit,category,brand,stock,status,image,created_at,updated_at) VALUES (?,?,?,?,?,?,?, datetime('now'), datetime('now'))`,
        [name, unit, category, brand, stock, status, image]
      );
      const id = result.lastID;
      const product = await getAsync('SELECT * FROM products WHERE id = ?', [id]);
      res.status(201).json(product);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/* POST /bulk — insert array of products (JSON) */
router.post('/bulk', async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected array' });
    const stmt = db.prepare(`INSERT OR IGNORE INTO products (name,unit,category,brand,stock,status,image,created_at,updated_at) VALUES (?,?,?,?,?,?,?, datetime('now'), datetime('now'))`);
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      for (const it of items) {
        const name = it.name || null;
        if (!name) continue;
        stmt.run([name, it.unit || null, it.category || null, it.brand || null, Number(it.stock || 0), it.status || null, it.image || null]);
      }
      db.run('COMMIT', err => {
        stmt.finalize();
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, imported: items.length });
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* PUT update product and track inventory_history if stock changed */
router.put('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const current = await getAsync('SELECT * FROM products WHERE id = ?', [id]);
    if (!current) return res.status(404).json({ error: 'Product not found' });

    const allowed = ['name', 'unit', 'category', 'brand', 'stock', 'status', 'image'];
    const updates = [];
    const params = [];
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        updates.push(`${k} = ?`);
        params.push(req.body[k]);
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push(`updated_at = datetime('now')`);
    params.push(id);

    await runAsync(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, params);

    if (Object.prototype.hasOwnProperty.call(req.body, 'stock')) {
      const before = Number(current.stock || 0);
      const after = Number(req.body.stock || 0);
      if (before !== after) {
        const change = after - before;
        await runAsync(
          `INSERT INTO inventory_history (product_id, change_amount, reason, before_qty, after_qty, change_date) VALUES (?,?,?,?,?, datetime('now'))`,
          [id, change, req.body.reason || 'update', before, after]
        );
      }
    }

    const updated = await getAsync('SELECT * FROM products WHERE id = ?', [id]);
    res.json({ product: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* DELETE */
router.delete('/:id', async (req, res) => {
  try {
    await runAsync('DELETE FROM products WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* GET product history */
router.get('/:id/history', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM inventory_history WHERE product_id = ? ORDER BY change_date DESC', [req.params.id]);
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* CSV import (expects field name csvFile) with columns: name,unit,category,brand,stock,status,image */
router.post('/import', upload.single('csvFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (csvFile)' });
    const rows = [];
    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on('data', (data) => rows.push(data))
      .on('end', () => {
        const stmt = db.prepare(`INSERT OR IGNORE INTO products (name,unit,category,brand,stock,status,image,created_at,updated_at) VALUES (?,?,?,?,?,?,?, datetime('now'), datetime('now'))`);
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          for (const r of rows) {
            const name = r.name || r.NAME || null;
            if (!name) continue;
            stmt.run([name, r.unit || null, r.category || null, r.brand || null, Number(r.stock || 0), r.status || null, r.image || null]);
          }
          db.run('COMMIT', () => {
            stmt.finalize();
            fs.unlink(req.file.path, () => {});
            res.json({ success: true, imported: rows.length });
          });
        });
      });
  } catch (err) {
    if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message });
  }
});

/* Export CSV */
router.get('/export', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM products ORDER BY id ASC');
    const headers = ['id', 'name', 'unit', 'category', 'brand', 'stock', 'status', 'image', 'created_at', 'updated_at'];
    const escape = v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return (s.includes('"') || s.includes(',') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = rows.map(r => headers.map(h => escape(r[h])).join(','));
    const csvData = headers.join(',') + '\n' + lines.join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
    res.status(200).send(csvData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;