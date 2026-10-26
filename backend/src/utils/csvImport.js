const { parse } = require('csv-parse/sync');
const { importEntryRowSchema } = require('../validation/schemas');

const REQUIRED_COLUMNS = ['date', 'project', 'hours'];
const OPTIONAL_COLUMNS = ['description'];
const MAX_IMPORT_ROWS = 1000;

class CsvImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvImportError';
    this.status = 400;
  }
}

// Parses CSV text into rows keyed by the known columns, keeping each row's source line number.
function parseEntriesCsv(input, { maxRows = MAX_IMPORT_ROWS } = {}) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');

  let records;
  try {
    records = parse(text, {
      bom: true,
      info: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true
    });
  } catch (err) {
    throw new CsvImportError(`Malformed CSV: ${err.message}`);
  }

  if (records.length === 0) {
    throw new CsvImportError('CSV file is empty');
  }

  const header = records[0].record.map((name) => name.toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new CsvImportError(`CSV is missing required column(s): ${missing.join(', ')}`);
  }
  const duplicates = header.filter((name, i) => name && header.indexOf(name) !== i);
  if (duplicates.length > 0) {
    throw new CsvImportError(`CSV has duplicate column(s): ${[...new Set(duplicates)].join(', ')}`);
  }

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    throw new CsvImportError('CSV file has no data rows');
  }
  if (dataRecords.length > maxRows) {
    throw new CsvImportError(`CSV has ${dataRecords.length} data rows; the maximum is ${maxRows}`);
  }

  const columnIndex = {};
  [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].forEach((column) => {
    const index = header.indexOf(column);
    if (index !== -1) columnIndex[column] = index;
  });

  return dataRecords.map(({ record, info }) => {
    const fields = {};
    Object.entries(columnIndex).forEach(([column, index]) => {
      const cell = record[index];
      if (cell !== undefined && cell !== '') fields[column] = cell;
    });
    return {
      line: info.lines,
      columnError: record.length === header.length
        ? null
        : `Expected ${header.length} columns but found ${record.length}`,
      fields
    };
  });
}

function validateEntryRow(row) {
  if (row.columnError) {
    return { errors: [row.columnError] };
  }
  const { error, value } = importEntryRowSchema.validate(row.fields, { abortEarly: false });
  if (error) {
    return { errors: error.details.map((detail) => detail.message) };
  }
  return { value };
}

module.exports = {
  parseEntriesCsv,
  validateEntryRow,
  CsvImportError,
  MAX_IMPORT_ROWS,
  REQUIRED_COLUMNS
};
