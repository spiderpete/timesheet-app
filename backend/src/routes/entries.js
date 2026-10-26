const express = require('express');
const multer = require('multer');
const { getDatabase } = require('../database/init');
const { authenticateUser } = require('../middleware/auth');
const { parseEntriesCsv, validateEntryRow, CsvImportError } = require('../utils/csvImport');

const MAX_IMPORT_FILE_BYTES = 1024 * 1024;
const CSV_MIME_TYPES = ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const isCsv = CSV_MIME_TYPES.includes(file.mimetype) || /\.csv$/i.test(file.originalname);
    cb(isCsv ? null : new CsvImportError('Uploaded file must be a CSV'), isCsv);
  }
});

const router = express.Router();

// All routes require authentication
router.use(authenticateUser);

function dbAll(db, sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      return err ? reject(err) : resolve(this);
    });
  });
}

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof CsvImportError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? `CSV file exceeds the ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MB limit`
        : `Invalid upload: ${err.message}`;
      return res.status(400).json({ error: message });
    }
    return next(err);
  });
}

// Bulk import work entries from a CSV file (columns: date, project, hours, description)
router.post('/import', handleUpload, async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: 'CSV file is required in the "file" form field' });
  }

  let rows;
  try {
    rows = parseEntriesCsv(req.file.buffer);
  } catch (err) {
    if (err instanceof CsvImportError) {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  }

  const db = getDatabase();
  let inTransaction = false;

  try {
    const clients = await dbAll(db, 'SELECT id, name FROM clients WHERE user_email = ?', [req.userEmail]);
    const clientsByName = new Map();
    clients.forEach((client) => {
      const key = client.name.trim().toLowerCase();
      clientsByName.set(key, [...(clientsByName.get(key) || []), client.id]);
    });

    const toInsert = [];
    const errors = [];

    rows.forEach((row) => {
      const { value, errors: rowErrors } = validateEntryRow(row);
      if (rowErrors) {
        errors.push({ line: row.line, errors: rowErrors });
        return;
      }

      const matches = clientsByName.get(value.project.toLowerCase()) || [];
      if (matches.length === 0) {
        errors.push({ line: row.line, errors: [`Project "${value.project}" not found`] });
        return;
      }
      if (matches.length > 1) {
        errors.push({ line: row.line, errors: [`Project "${value.project}" matches more than one client`] });
        return;
      }

      toInsert.push({ ...value, clientId: matches[0] });
    });

    if (toInsert.length > 0) {
      await dbRun(db, 'BEGIN TRANSACTION');
      inTransaction = true;
      for (const entry of toInsert) {
        await dbRun(
          db,
          'INSERT INTO work_entries (client_id, user_email, hours, description, date) VALUES (?, ?, ?, ?, ?)',
          [entry.clientId, req.userEmail, entry.hours, entry.description || null, entry.date]
        );
      }
      await dbRun(db, 'COMMIT');
      inTransaction = false;
    }

    res.json({
      message: 'Import completed',
      imported: toInsert.length,
      skipped: errors.length,
      errors
    });
  } catch (err) {
    console.error('Database error:', err);
    if (inTransaction) {
      await dbRun(db, 'ROLLBACK').catch((rollbackErr) => console.error('Rollback failed:', rollbackErr));
    }
    res.status(500).json({ error: 'Failed to import work entries' });
  }
});

module.exports = router;
