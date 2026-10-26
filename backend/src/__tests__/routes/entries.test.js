const request = require('supertest');
const express = require('express');
const entryRoutes = require('../../routes/entries');
const { getDatabase } = require('../../database/init');

jest.mock('../../database/init');
jest.mock('../../middleware/auth', () => ({
  authenticateUser: (req, res, next) => {
    req.userEmail = 'test@example.com';
    next();
  }
}));

const app = express();
app.use('/api/entries', entryRoutes);
app.use((err, req, res, next) => {
  res.status(500).json({ error: 'Internal server error' });
});

const HEADER = 'date,project,hours,description\n';
const upload = (csv, filename = 'entries.csv', contentType = 'text/csv') =>
  request(app).post('/api/entries/import').attach('file', Buffer.from(csv), { filename, contentType });

describe('Entry Import Routes', () => {
  let mockDb;

  beforeEach(() => {
    mockDb = {
      all: jest.fn((query, params, callback) => callback(null, [{ id: 1, name: 'Acme' }])),
      run: jest.fn((query, params, callback) => callback.call({ lastID: 1, changes: 1 }, null))
    };
    getDatabase.mockReturnValue(mockDb);
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  test('imports valid rows inside a transaction scoped to the user', async () => {
    const response = await upload(`${HEADER}2024-01-15,acme,2.5,Work\n2024-01-16,Acme,3,\n`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: 'Import completed', imported: 2, skipped: 0, errors: [] });
    expect(mockDb.all).toHaveBeenCalledWith(
      'SELECT id, name FROM clients WHERE user_email = ?',
      ['test@example.com'],
      expect.any(Function)
    );
    const statements = mockDb.run.mock.calls.map(([sql, params]) => [sql, params]);
    expect(statements).toEqual([
      ['BEGIN TRANSACTION', []],
      [expect.stringContaining('INSERT INTO work_entries'), [1, 'test@example.com', 2.5, 'Work', '2024-01-15']],
      [expect.stringContaining('INSERT INTO work_entries'), [1, 'test@example.com', 3, null, '2024-01-16']],
      ['COMMIT', []]
    ]);
  });

  test('skips rows whose project name matches more than one client', async () => {
    mockDb.all.mockImplementation((query, params, callback) =>
      callback(null, [{ id: 1, name: 'Acme' }, { id: 2, name: 'ACME ' }]));

    const response = await upload(`${HEADER}2024-01-15,Acme,1,Work\n`);

    expect(response.body).toEqual({
      message: 'Import completed',
      imported: 0,
      skipped: 1,
      errors: [{ line: 2, errors: ['Project "Acme" matches more than one client'] }]
    });
    expect(mockDb.run).not.toHaveBeenCalled();
  });

  test('returns 400 when no file is uploaded', async () => {
    const response = await request(app).post('/api/entries/import').field('note', 'no file');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'CSV file is required in the "file" form field' });
  });

  test('returns 400 for a non-CSV upload', async () => {
    const response = await upload('{}', 'entries.json', 'application/json');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Uploaded file must be a CSV' });
  });

  test('accepts a .csv file regardless of reported mime type', async () => {
    const response = await upload(`${HEADER}2024-01-15,Acme,1,Work\n`, 'entries.csv', 'application/octet-stream');

    expect(response.status).toBe(200);
    expect(response.body.imported).toBe(1);
  });

  test('returns 400 when the file exceeds the size limit', async () => {
    const response = await upload(HEADER + 'x'.repeat(1024 * 1024));

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'CSV file exceeds the 1 MB limit' });
  });

  test('returns 400 when more than one file is uploaded', async () => {
    const response = await request(app)
      .post('/api/entries/import')
      .attach('file', Buffer.from(HEADER), 'a.csv')
      .attach('file', Buffer.from(HEADER), 'b.csv');

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/^Invalid upload:/);
  });

  test('returns 400 for malformed CSV', async () => {
    const response = await upload(`${HEADER}2024-01-15,"Acme,1,Work\n`);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/^Malformed CSV:/);
  });

  test('returns 500 when loading clients fails', async () => {
    mockDb.all.mockImplementation((query, params, callback) => callback(new Error('db down')));

    const response = await upload(`${HEADER}2024-01-15,Acme,1,Work\n`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to import work entries' });
    expect(mockDb.run).not.toHaveBeenCalled();
  });

  test('rolls back and returns 500 when an insert fails', async () => {
    mockDb.run.mockImplementation((query, params, callback) =>
      callback(query.startsWith('INSERT') ? new Error('insert failed') : null));

    const response = await upload(`${HEADER}2024-01-15,Acme,1,Work\n`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to import work entries' });
    expect(mockDb.run.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN TRANSACTION',
      expect.stringContaining('INSERT INTO work_entries'),
      'ROLLBACK'
    ]);
  });

  test('still returns 500 when the rollback itself fails', async () => {
    mockDb.run.mockImplementation((query, params, callback) =>
      callback(query === 'BEGIN TRANSACTION' ? null : new Error('failed')));

    const response = await upload(`${HEADER}2024-01-15,Acme,1,Work\n`);

    expect(response.status).toBe(500);
    expect(console.error).toHaveBeenCalledWith('Rollback failed:', expect.any(Error));
  });
});
