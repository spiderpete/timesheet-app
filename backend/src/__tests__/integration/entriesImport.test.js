// Exercises the real routes, auth middleware and SQLite in-memory database end to end.
jest.unmock('sqlite3');

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const express = require('express');
const clientRoutes = require('../../routes/clients');
const workEntryRoutes = require('../../routes/workEntries');
const entryRoutes = require('../../routes/entries');
const { errorHandler } = require('../../middleware/errorHandler');
const { initializeDatabase, closeDatabase } = require('../../database/init');

const SAMPLE_CSV = path.join(__dirname, '../fixtures/entries-import.csv');
const USER = 'importer@example.com';
const OTHER_USER = 'someone-else@example.com';

const app = express();
app.use(express.json());
app.use('/api/clients', clientRoutes);
app.use('/api/work-entries', workEntryRoutes);
app.use('/api/entries', entryRoutes);
app.use(errorHandler);

const createClient = (email, name) =>
  request(app).post('/api/clients').set('x-user-email', email).send({ name }).expect(201);

describe('POST /api/entries/import (integration)', () => {
  beforeAll(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    await initializeDatabase();
    await createClient(USER, 'Acme Corp');
    await createClient(USER, 'Globex');
    await createClient(OTHER_USER, 'Unknown Project');
  });

  afterAll(async () => {
    await closeDatabase();
    console.log.mockRestore();
  });

  test('imports valid rows from the sample CSV and reports skipped rows', async () => {
    const response = await request(app)
      .post('/api/entries/import')
      .set('x-user-email', USER)
      .attach('file', SAMPLE_CSV, { contentType: 'text/csv' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      message: 'Import completed',
      imported: 3,
      skipped: 6,
      errors: [
        { line: 6, errors: ['"date" must be a valid calendar date'] },
        { line: 7, errors: ['"date" must be in YYYY-MM-DD format'] },
        { line: 8, errors: ['"hours" must be a positive number'] },
        { line: 9, errors: ['Project "Unknown Project" not found'] },
        { line: 10, errors: ['Expected 4 columns but found 3'] },
        { line: 11, errors: ['"hours" must be less than or equal to 24'] }
      ]
    });

    const entries = await request(app).get('/api/work-entries').set('x-user-email', USER).expect(200);
    const imported = entries.body.workEntries
      .map(({ date, client_name, hours, description }) => ({ date, client_name, hours, description }))
      .sort((a, b) => a.date.localeCompare(b.date));

    expect(imported).toEqual([
      { date: '2024-01-15', client_name: 'Acme Corp', hours: 7.5, description: 'Sprint planning' },
      { date: '2024-01-16', client_name: 'Acme Corp', hours: 8, description: 'API work, code review' },
      { date: '2024-01-17', client_name: 'Globex', hours: 4, description: 'Design review' }
    ]);
  });

  test('does not import entries into another user\'s account', async () => {
    const entries = await request(app).get('/api/work-entries').set('x-user-email', OTHER_USER).expect(200);
    expect(entries.body.workEntries).toEqual([]);
  });

  test('returns 400 without importing anything when the header is invalid', async () => {
    const response = await request(app)
      .post('/api/entries/import')
      .set('x-user-email', USER)
      .attach('file', Buffer.from('day,client,time\n2024-01-15,Acme Corp,1\n'), 'bad.csv');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'CSV is missing required column(s): date, project, hours' });
  });

  test('requires authentication', async () => {
    const response = await request(app).post('/api/entries/import').attach('file', SAMPLE_CSV);

    expect(response.status).toBe(401);
  });
});
