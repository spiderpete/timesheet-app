const {
  parseEntriesCsv,
  validateEntryRow,
  CsvImportError,
  MAX_IMPORT_ROWS
} = require('../../utils/csvImport');

describe('CSV import utils', () => {
  describe('parseEntriesCsv', () => {
    test('parses rows keyed by column with their source line numbers', () => {
      const csv = [
        'date,project,hours,description',
        '2024-01-15,Acme,7.5,Planning',
        '2024-01-16,Globex,8,"Review, fixes"'
      ].join('\n');

      expect(parseEntriesCsv(csv)).toEqual([
        {
          line: 2,
          columnError: null,
          fields: { date: '2024-01-15', project: 'Acme', hours: '7.5', description: 'Planning' }
        },
        {
          line: 3,
          columnError: null,
          fields: { date: '2024-01-16', project: 'Globex', hours: '8', description: 'Review, fixes' }
        }
      ]);
    });

    test('accepts a Buffer with BOM, CRLF line endings and mixed-case headers', () => {
      const csv = Buffer.from('\uFEFFDate,PROJECT,Hours,Description\r\n2024-01-15,Acme,2,Work\r\n', 'utf8');

      const rows = parseEntriesCsv(csv);

      expect(rows).toHaveLength(1);
      expect(rows[0].fields).toEqual({ date: '2024-01-15', project: 'Acme', hours: '2', description: 'Work' });
    });

    test('trims cells, skips blank lines and keeps line numbers accurate', () => {
      const csv = 'date,project,hours,description\n\n  2024-01-15 , Acme , 3 , Work \n';

      const rows = parseEntriesCsv(csv);

      expect(rows).toEqual([
        { line: 3, columnError: null, fields: { date: '2024-01-15', project: 'Acme', hours: '3', description: 'Work' } }
      ]);
    });

    test('reports the source line of rows after a multi-line quoted field', () => {
      const csv = 'date,project,hours,description\n2024-01-15,Acme,3,"line one\nline two"\n2024-01-16,Acme,4,Next\n';

      const rows = parseEntriesCsv(csv);

      expect(rows.map((row) => row.line)).toEqual([3, 4]);
      expect(rows[0].fields.description).toBe('line one\nline two');
    });

    test('allows the description column to be omitted and ignores unknown columns', () => {
      const csv = 'project,hours,date,notes\nAcme,3,2024-01-15,ignored\n';

      expect(parseEntriesCsv(csv)[0].fields).toEqual({ date: '2024-01-15', project: 'Acme', hours: '3' });
    });

    test('omits empty cells so validation reports them as required', () => {
      const csv = 'date,project,hours,description\n2024-01-15,,,\n';

      expect(parseEntriesCsv(csv)[0].fields).toEqual({ date: '2024-01-15' });
    });

    test('flags rows whose column count does not match the header', () => {
      const csv = 'date,project,hours,description\n2024-01-15,Acme,3\n2024-01-15,Acme,3,a,b\n';

      const rows = parseEntriesCsv(csv);

      expect(rows[0].columnError).toBe('Expected 4 columns but found 3');
      expect(rows[1].columnError).toBe('Expected 4 columns but found 5');
    });

    test.each([
      ['an empty file', '', 'CSV file is empty'],
      ['only whitespace', '\n\n', 'CSV file is empty'],
      ['a header with no data rows', 'date,project,hours,description\n', 'CSV file has no data rows'],
      ['missing required columns', 'date,description\n2024-01-15,Work\n', 'CSV is missing required column(s): project, hours'],
      ['duplicate columns', 'date,project,hours,hours\n2024-01-15,Acme,1,2\n', 'CSV has duplicate column(s): hours']
    ])('rejects %s', (_label, csv, message) => {
      expect(() => parseEntriesCsv(csv)).toThrow(new CsvImportError(message));
    });

    test('rejects malformed CSV', () => {
      const csv = 'date,project,hours,description\n2024-01-15,"Acme,3,Work\n';

      expect(() => parseEntriesCsv(csv)).toThrow(CsvImportError);
      expect(() => parseEntriesCsv(csv)).toThrow(/^Malformed CSV:/);
    });

    test('rejects files with more data rows than the limit', () => {
      const csv = 'date,project,hours\n2024-01-15,Acme,1\n2024-01-16,Acme,1\n2024-01-17,Acme,1\n';

      expect(() => parseEntriesCsv(csv, { maxRows: 2 })).toThrow('CSV has 3 data rows; the maximum is 2');
      expect(parseEntriesCsv(csv, { maxRows: 3 })).toHaveLength(3);
    });

    test('defaults to a 1000 row limit', () => {
      expect(MAX_IMPORT_ROWS).toBe(1000);
    });

    test('CsvImportError carries a 400 status', () => {
      const err = new CsvImportError('bad');
      expect(err).toBeInstanceOf(Error);
      expect(err.status).toBe(400);
      expect(err.name).toBe('CsvImportError');
    });
  });

  describe('validateEntryRow', () => {
    const row = (fields) => ({ line: 2, columnError: null, fields });
    const valid = { date: '2024-01-15', project: 'Acme', hours: '7.5', description: 'Work' };

    test('returns the converted value for a valid row', () => {
      expect(validateEntryRow(row(valid))).toEqual({
        value: { date: '2024-01-15', project: 'Acme', hours: 7.5, description: 'Work' }
      });
    });

    test('accepts a row without description', () => {
      const { date, project, hours } = valid;
      expect(validateEntryRow(row({ date, project, hours })).value).toEqual({ date, project, hours: 7.5 });
    });

    test.each([
      ['01/15/2024', '"date" must be in YYYY-MM-DD format'],
      ['2024-1-15', '"date" must be in YYYY-MM-DD format'],
      ['2024-01-15T10:00:00Z', '"date" must be in YYYY-MM-DD format'],
      ['2024-02-30', '"date" must be a valid calendar date'],
      ['2023-02-29', '"date" must be a valid calendar date'],
      ['2024-13-01', '"date" must be a valid calendar date']
    ])('rejects date %s', (date, message) => {
      expect(validateEntryRow(row({ ...valid, date }))).toEqual({ errors: [message] });
    });

    test('accepts a leap day', () => {
      expect(validateEntryRow(row({ ...valid, date: '2024-02-29' })).errors).toBeUndefined();
    });

    test.each([
      ['0', '"hours" must be a positive number'],
      ['-2', '"hours" must be a positive number'],
      ['abc', '"hours" must be a number'],
      ['25', '"hours" must be less than or equal to 24']
    ])('rejects hours %s', (hours, message) => {
      expect(validateEntryRow(row({ ...valid, hours }))).toEqual({ errors: [message] });
    });

    test('rejects a description over 1000 characters', () => {
      const { errors } = validateEntryRow(row({ ...valid, description: 'x'.repeat(1001) }));
      expect(errors).toEqual(['"description" length must be less than or equal to 1000 characters long']);
    });

    test('reports every missing required field', () => {
      expect(validateEntryRow(row({}))).toEqual({
        errors: ['"date" is required', '"project" is required', '"hours" is required']
      });
    });

    test('reports a column count mismatch without validating fields', () => {
      const result = validateEntryRow({ line: 2, columnError: 'Expected 4 columns but found 3', fields: {} });
      expect(result).toEqual({ errors: ['Expected 4 columns but found 3'] });
    });
  });
});
