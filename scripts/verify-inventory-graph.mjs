import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workbookPath = path.join(repoRoot, 'Inventory Calculator.xlsx');
const taskDir = path.join(
  repoRoot,
  '.agent/tasks/2026-06-15-inventory-excel-verification',
);
const rawDir = path.join(taskDir, 'raw');
const artifactPath = path.join(rawDir, 'verification-summary.json');

const expectedChartRanges = {
  months: 'Sheet1!$G$2:$R$2',
  endingInventory: 'Sheet1!$G$6:$R$6',
  safetyStock: 'Sheet1!$G$8:$R$8',
};

const expectedWorkbook = {
  monthSerials: [46174, 46204, 46235, 46266, 46296, 46327, 46357, 46388, 46419, 46447, 46478, 46508],
  fulfillment: [117, 233, 443, 583, 583, 443, 443, 723, 723, 723, 1050, 933],
  beginningInventory: [2000, 1883, 1650, 1207, 2297, 1714, 1271, 2501, 1778, 1055, 2005, 955],
  receipts: [0, 0, 0, 1673, 0, 0, 1673, 0, 0, 1673, 0, 1673],
  endingInventory: [1883, 1650, 1207, 2297, 1714, 1271, 2501, 1778, 1055, 2005, 955, 1695],
  safetyStock: [1300, 1300, 1300, 1300, 1300, 1300, 1300, 1300, 1300, 1300, 1300, 1300],
  eoq: 1673,
  monthLabels: [
    { year: 2026, month: 5 },
    { year: 2026, month: 6 },
    { year: 2026, month: 7 },
    { year: 2026, month: 8 },
    { year: 2026, month: 9 },
    { year: 2026, month: 10 },
    { year: 2026, month: 11 },
    { year: 2027, month: 0 },
    { year: 2027, month: 1 },
    { year: 2027, month: 2 },
    { year: 2027, month: 3 },
    { year: 2027, month: 4 },
  ],
};

const expectedDemoFields = [
  { name: 'startingInventory', value: '2000', min: '0', step: '1' },
  { name: 'annualDemand', value: '7000', min: '0', step: '1' },
  { name: 'costPerOrder', value: '500', min: '0', step: '0.01' },
  { name: 'holdingCostPerUnit', value: '2.5', min: '0.01', step: '0.01' },
  { name: 'maxMonthlySales', value: '450', min: '0', step: '1' },
  { name: 'maxLeadTime', value: '4', min: '0', step: '1' },
  { name: 'averageMonthlySales', value: '250', min: '0', step: '1' },
  { name: 'averageLeadTime', value: '2', min: '0', step: '1' },
];

const demoSeasonalityMonthsAfterFirst = [
  0.0333333333333333,
  0.0633333333333333,
  0.0833333333333333,
  0.0833333333333333,
  0.0633333333333333,
  0.0633333333333333,
  0.1033333333333333,
  0.1033333333333333,
  0.1033333333333333,
  0.15,
  0.1333333333333333,
];

const demoFirstSeasonality =
  1 -
  demoSeasonalityMonthsAfterFirst.reduce(
    (sum, monthSeasonality) => sum + monthSeasonality,
    0,
  );

const demoSeasonality = [demoFirstSeasonality, ...demoSeasonalityMonthsAfterFirst];

function ensureArtifactDirectory() {
  fs.mkdirSync(rawDir, { recursive: true });
}

function writeArtifact(name, content) {
  ensureArtifactDirectory();
  fs.writeFileSync(path.join(rawDir, name), content);
}

function readZipEntry(zipBuffer, entryPath) {
  const eocdSignature = 0x06054b50;
  const centralDirectorySignature = 0x02014b50;
  const localFileHeaderSignature = 0x04034b50;
  const eocdMinimumOffset = Math.max(0, zipBuffer.length - 0xffff - 22);

  let eocdOffset = -1;

  for (let offset = zipBuffer.length - 22; offset >= eocdMinimumOffset; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Could not locate ZIP end of central directory.');
  }

  const centralDirectoryOffset = zipBuffer.readUInt32LE(eocdOffset + 16);
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  let directoryOffset = centralDirectoryOffset;

  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex += 1) {
    if (zipBuffer.readUInt32LE(directoryOffset) !== centralDirectorySignature) {
      throw new Error('Invalid central directory entry in workbook ZIP.');
    }

    const compressionMethod = zipBuffer.readUInt16LE(directoryOffset + 10);
    const compressedSize = zipBuffer.readUInt32LE(directoryOffset + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(directoryOffset + 24);
    const fileNameLength = zipBuffer.readUInt16LE(directoryOffset + 28);
    const extraFieldLength = zipBuffer.readUInt16LE(directoryOffset + 30);
    const fileCommentLength = zipBuffer.readUInt16LE(directoryOffset + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(directoryOffset + 42);
    const fileName = zipBuffer
      .subarray(directoryOffset + 46, directoryOffset + 46 + fileNameLength)
      .toString('utf8');

    if (fileName === entryPath) {
      if (zipBuffer.readUInt32LE(localHeaderOffset) !== localFileHeaderSignature) {
        throw new Error(`Invalid local file header for ZIP entry ${entryPath}.`);
      }

      const localFileNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraFieldLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
      const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize);

      if (compressionMethod === 0) {
        return compressedData.toString('utf8');
      }

      if (compressionMethod === 8) {
        const inflated = zlib.inflateRawSync(compressedData);

        if (inflated.length !== uncompressedSize) {
          throw new Error(`Unexpected inflated size for ZIP entry ${entryPath}.`);
        }

        return inflated.toString('utf8');
      }

      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${entryPath}.`);
    }

    directoryOffset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }

  throw new Error(`Could not find ZIP entry ${entryPath}.`);
}

function extractTagValues(xml, tagName) {
  const pattern = new RegExp(`<${tagName}>([^<]+)</${tagName}>`, 'g');
  const values = [];

  for (const match of xml.matchAll(pattern)) {
    values.push(match[1]);
  }

  return values;
}

function extractNumericCellValues(sheetXml, refs) {
  return refs.map((ref) => {
    const match = sheetXml.match(new RegExp(`<c r="${ref}"[^>]*>[\\s\\S]*?<v>([^<]+)</v>[\\s\\S]*?</c>`));

    if (!match) {
      throw new Error(`Could not find workbook cell ${ref}.`);
    }

    return Number(match[1]);
  });
}

function excelSerialToIsoDate(serial) {
  const excelEpochUtc = Date.UTC(1899, 11, 30);
  return new Date(excelEpochUtc + serial * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function loadCalculationModule() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ims-calc-verify-'));
  const outfile = path.join(tempDir, 'inventoryFormulas.mjs');

  await esbuild.build({
    entryPoints: [path.join(repoRoot, 'src/inventoryFormulas.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'silent',
  });

  return import(pathToFileURL(outfile).href);
}

function runBuild() {
  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function verifyWorkbookProof() {
  const workbookZip = fs.readFileSync(workbookPath);
  const chartXml = readZipEntry(workbookZip, 'xl/charts/chart1.xml');
  const sheetXml = readZipEntry(workbookZip, 'xl/worksheets/sheet1.xml');

  writeArtifact('workbook-chart1.xml', chartXml);
  writeArtifact('workbook-sheet1.xml', sheetXml);

  const formulaRefs = extractTagValues(chartXml, 'c:f');
  const monthRange = formulaRefs.find((value) => value === expectedChartRanges.months);
  const endingRange = formulaRefs.find((value) => value === expectedChartRanges.endingInventory);
  const safetyRange = formulaRefs.find((value) => value === expectedChartRanges.safetyStock);

  assert.equal(monthRange, expectedChartRanges.months, 'Workbook month chart range changed.');
  assert.equal(
    endingRange,
    expectedChartRanges.endingInventory,
    'Workbook ending inventory chart range changed.',
  );
  assert.equal(
    safetyRange,
    expectedChartRanges.safetyStock,
    'Workbook safety stock chart range changed.',
  );

  const monthSerials = extractNumericCellValues(
    sheetXml,
    ['G2', 'H2', 'I2', 'J2', 'K2', 'L2', 'M2', 'N2', 'O2', 'P2', 'Q2', 'R2'],
  );
  const fulfillment = extractNumericCellValues(
    sheetXml,
    ['G5', 'H5', 'I5', 'J5', 'K5', 'L5', 'M5', 'N5', 'O5', 'P5', 'Q5', 'R5'],
  );
  const beginningInventory = extractNumericCellValues(
    sheetXml,
    ['G3', 'H3', 'I3', 'J3', 'K3', 'L3', 'M3', 'N3', 'O3', 'P3', 'Q3', 'R3'],
  );
  const receipts = extractNumericCellValues(
    sheetXml,
    ['G4', 'H4', 'I4', 'J4', 'K4', 'L4', 'M4', 'N4', 'O4', 'P4', 'Q4', 'R4'],
  );
  const endingInventory = extractNumericCellValues(
    sheetXml,
    ['G6', 'H6', 'I6', 'J6', 'K6', 'L6', 'M6', 'N6', 'O6', 'P6', 'Q6', 'R6'],
  );
  const safetyStock = extractNumericCellValues(
    sheetXml,
    ['G8', 'H8', 'I8', 'J8', 'K8', 'L8', 'M8', 'N8', 'O8', 'P8', 'Q8', 'R8'],
  );
  const [eoq] = extractNumericCellValues(sheetXml, ['C10']);

  assert.deepEqual(monthSerials, expectedWorkbook.monthSerials, 'Workbook month serials changed.');
  assert.deepEqual(fulfillment, expectedWorkbook.fulfillment, 'Workbook fulfillment values changed.');
  assert.deepEqual(
    beginningInventory,
    expectedWorkbook.beginningInventory,
    'Workbook beginning inventory values changed.',
  );
  assert.deepEqual(receipts, expectedWorkbook.receipts, 'Workbook receipts values changed.');
  assert.deepEqual(
    endingInventory,
    expectedWorkbook.endingInventory,
    'Workbook ending inventory values changed.',
  );
  assert.deepEqual(safetyStock, expectedWorkbook.safetyStock, 'Workbook safety stock values changed.');
  assert.equal(eoq, expectedWorkbook.eoq, 'Workbook EOQ changed.');

  const monthIsoDates = monthSerials.map(excelSerialToIsoDate);
  return {
    chartRanges: expectedChartRanges,
    monthSerials,
    monthIsoDates,
    fulfillment,
    beginningInventory,
    receipts,
    endingInventory,
    safetyStock,
    eoq,
  };
}

async function verifyCalculationParity() {
  const { calculateInventoryData } = await loadCalculationModule();
  const result = calculateInventoryData({ startDate: new Date(2026, 5, 1) });

  assert.equal(result.eoq, expectedWorkbook.eoq, 'Calculated EOQ does not match workbook.');
  assert.equal(
    result.safetyStock,
    expectedWorkbook.safetyStock[0],
    'Calculated safety stock does not match workbook.',
  );
  assert.equal(result.months.length, 12, 'Expected 12 monthly data points.');

  const monthLabels = result.months.map((month) => ({
    year: month.month.getFullYear(),
    month: month.month.getMonth(),
  }));
  const fulfillment = result.months.map((month) => month.fulfillment);
  const beginningInventory = result.months.map((month) => month.beginningInventory);
  const receipts = result.months.map((month) => month.receipts);
  const endingInventory = result.months.map((month) => month.endingInventory);
  const safetyStock = result.months.map((month) => month.safetyStock);

  assert.deepEqual(monthLabels, expectedWorkbook.monthLabels, 'Generated months are not pinned to Jun 2026 through May 2027.');
  assert.deepEqual(fulfillment, expectedWorkbook.fulfillment, 'Calculated fulfillment does not match workbook.');
  assert.deepEqual(
    beginningInventory,
    expectedWorkbook.beginningInventory,
    'Calculated beginning inventory does not match workbook.',
  );
  assert.deepEqual(receipts, expectedWorkbook.receipts, 'Calculated receipts do not match workbook.');
  assert.deepEqual(
    endingInventory,
    expectedWorkbook.endingInventory,
    'Calculated ending inventory does not match workbook.',
  );
  assert.deepEqual(
    safetyStock,
    expectedWorkbook.safetyStock,
    'Calculated safety stock series does not match workbook.',
  );

  return {
    eoq: result.eoq,
    safetyStock: result.safetyStock,
    monthLabels: monthLabels.map(({ year, month }) => `${year}-${String(month + 1).padStart(2, '0')}`),
    fulfillment,
    beginningInventory,
    receipts,
    endingInventory,
    safetyStockSeries: safetyStock,
  };
}

function verifyDemoHtml() {
  const demoHtml = fs.readFileSync(path.join(repoRoot, 'demo.html'), 'utf8');

  assert.match(
    demoHtml,
    /<script\s+src="\.\/dist\/inventory-graph\.min\.js"><\/script>/,
    'demo.html must reference ./dist/inventory-graph.min.js.',
  );
  assert.match(
    demoHtml,
    /InventoryGraph\.mount\(\s*"#inventory-graph"\s*,/,
    'demo.html must call InventoryGraph.mount("#inventory-graph", options).',
  );
  assert.doesNotMatch(
    demoHtml,
    /innerHTML|insertAdjacentHTML/,
    'demo.html must not dynamically build modal, form, or result markup.',
  );
  assert.match(
    demoHtml,
    /<fieldset[^>]*(id="inventory-controls"[^>]*class="controls-frame"|class="controls-frame"[^>]*id="inventory-controls")[^>]*>/,
    'demo.html must use a non-submitting fieldset container for the controls.',
  );
  assert.doesNotMatch(
    demoHtml,
    /<form[^>]*id="inventory-controls"/,
    'demo.html must not use a submitting form wrapper for the controls.',
  );
  assert.match(
    demoHtml,
    /<button[^>]*id="inventory-calculate"[^>]*type="button"[^>]*>\s*Calculate\s*<\/button>/,
    'demo.html must contain a static Calculate button.',
  );
  assert.match(
    demoHtml,
    /<div[^>]*class="calc_modal"[^>]*>/,
    'demo.html must contain static .calc_modal markup.',
  );
  assert.match(
    demoHtml,
    /<form[^>]*id="calc-unlock-form"[^>]*>/,
    'demo.html must contain a static modal unlock form.',
  );
  assert.match(
    demoHtml,
    /<input[^>]*id="calc-unlock-email"[^>]*name="email"[^>]*type="email"[^>]*>/,
    'demo.html must contain a static modal email field for the unlock flow.',
  );
  assert.doesNotMatch(
    demoHtml,
    /<input[^>]*id="calc-unlock-email"[^>]*\bvalue=/,
    'demo.html must not prefill the modal email field.',
  );
  assert.match(
    demoHtml,
    /<div[^>]*class="w-form-done"[^>]*>/,
    'demo.html must contain a static .w-form-done placeholder.',
  );
  assert.doesNotMatch(
    demoHtml,
    /<div[^>]*class="w-form-done"[^>]*hidden[^>]*>/,
    'demo.html must not rely on the hidden attribute for the Webflow success block.',
  );
  assert.match(
    demoHtml,
    /\.calc_modal\s*\{[\s\S]*?display:\s*none;/,
    'demo.html must hide .calc_modal by default with static CSS.',
  );
  assert.match(
    demoHtml,
    /\.calc_modal\.show\s*\{[\s\S]*?display:\s*flex;/,
    'demo.html must show .calc_modal.show with display: flex.',
  );
  assert.doesNotMatch(
    demoHtml,
    /document\.createElement\((?!['"]canvas['"]\))/,
    'demo.html must not dynamically create non-canvas UI elements.',
  );
  assert.match(
    demoHtml,
    /<span[^>]*id="inventory-results-annual-demand"[^>]*>/,
    'demo.html must contain a static annual demand summary placeholder.',
  );
  assert.match(
    demoHtml,
    /<span[^>]*id="inventory-results-eoq"[^>]*>/,
    'demo.html must contain a static EOQ summary placeholder.',
  );
  assert.match(
    demoHtml,
    /<span[^>]*id="inventory-results-safety-stock"[^>]*>/,
    'demo.html must contain a static safety stock summary placeholder.',
  );
  assert.match(
    demoHtml,
    /<p[^>]*id="inventory-results-order-timing"[^>]*>/,
    'demo.html must contain a static order-timing empty-state placeholder.',
  );
  assert.match(
    demoHtml,
    /<div[^>]*id="inventory-results-order-list"[^>]*>/,
    'demo.html must contain a static order-timing list container.',
  );
  assert.match(
    demoHtml,
    /\.results-order-row\[hidden\][\s\S]*?display:\s*none;/,
    'demo.html must explicitly hide unused static order-timing rows.',
  );
  assert.equal(
    (demoHtml.match(/class="results-order-row"/g) ?? []).length,
    12,
    'demo.html must contain 12 static order-timing rows.',
  );
  assert.equal(
    (demoHtml.match(/class="inventory-results-row"/g) ?? []).length,
    12,
    'demo.html must contain 12 static monthly result rows.',
  );
  assert.doesNotMatch(
    demoHtml,
    /calc-demo-unlock|Demo Only:\s*Simulate Webflow Success|revealLatestSuccessElement/,
    'demo.html must not expose a demo-only unlock path.',
  );

  expectedDemoFields.forEach(({ name, value, min, step }) => {
    assert.match(
      demoHtml,
      new RegExp(
        `<input[^>]*name="${name}"[^>]*type="number"[^>]*min="${min}"[^>]*step="${step}"[^>]*value="${value}"`,
      ),
      `demo.html is missing the static ${name} number input.`,
    );
  });
}

function extractInlineDemoScript(demoHtml) {
  const match = demoHtml.match(
    /<script\s+src="\.\/dist\/inventory-graph\.min\.js"><\/script>\s*<script>([\s\S]*?)<\/script>\s*<\/body>/,
  );

  assert.ok(match?.[1], 'Could not extract the inline demo script from demo.html.');
  return match[1];
}

function createDemoInput({ name, value, defaultValue }) {
  return {
    name,
    value,
    defaultValue,
  };
}

function normalizeDemoOptions(options) {
  return {
    ...JSON.parse(JSON.stringify(options)),
    startDate: options.startDate instanceof Date ? options.startDate.toISOString() : options.startDate,
  };
}

function addUtcMonths(isoString, monthOffset) {
  const date = new Date(isoString);
  date.setUTCMonth(date.getUTCMonth() + monthOffset);
  return date.toISOString();
}

function roundDemoInteger(value) {
  if (value >= 0) {
    return Math.floor(value + 0.5);
  }

  return Math.ceil(value - 0.5);
}

function createSerializedDemoMonths(startDate, options) {
  const safetyStock =
    options.maxMonthlySales * options.maxLeadTime -
    options.averageMonthlySales * options.averageLeadTime;
  const eoq = roundDemoInteger(
    Math.sqrt((2 * options.annualDemand * options.costPerOrder) / options.holdingCostPerUnit),
  );
  const months = [];

  demoSeasonality.forEach((seasonality, index) => {
    const fulfillment = roundDemoInteger(options.annualDemand * seasonality);
    const beginningInventory =
      index === 0 ? options.startingInventory : months[index - 1].endingInventory;
    const receipts = safetyStock > beginningInventory ? eoq : 0;
    const endingInventory = beginningInventory + receipts - fulfillment;

    months.push({
      month: addUtcMonths(startDate, index),
      fulfillment,
      beginningInventory,
      receipts,
      endingInventory,
      safetyStock,
    });
  });

  return months;
}

function createDemoResult(options) {
  const safetyStock =
    options.maxMonthlySales * options.maxLeadTime -
    options.averageMonthlySales * options.averageLeadTime;
  const eoq = roundDemoInteger(
    Math.sqrt((2 * options.annualDemand * options.costPerOrder) / options.holdingCostPerUnit),
  );

  return {
    eoq,
    safetyStock,
    months: createSerializedDemoMonths(options.startDate.toISOString(), options).map((month) => ({
      ...month,
      month: new Date(month.month),
    })),
  };
}

function formatDemoNumber(value) {
  return value.toLocaleString('en-US');
}

function formatDemoUnits(value) {
  return `${formatDemoNumber(value)} units`;
}

function formatDemoMonthLabel(date) {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDemoOrderTiming(result) {
  const receiptMonths = result.months
    .filter((month) => month.receipts > 0)
    .map((month) => ({
      month: formatDemoMonthLabel(month.month),
      action: `Order ${formatDemoUnits(month.receipts)}`,
    }));

  return receiptMonths;
}

class FakeClassList {
  constructor(owner, initial = []) {
    this.owner = owner;
    this.tokens = new Set(initial);
  }

  add(...tokens) {
    let changed = false;

    tokens.forEach((token) => {
      if (!this.tokens.has(token)) {
        this.tokens.add(token);
        changed = true;
      }
    });

    if (changed) {
      this.owner.notifyAttributeMutation('class');
    }
  }

  remove(...tokens) {
    let changed = false;

    tokens.forEach((token) => {
      if (this.tokens.delete(token)) {
        changed = true;
      }
    });

    if (changed) {
      this.owner.notifyAttributeMutation('class');
    }
  }

  contains(token) {
    return this.tokens.has(token);
  }
}

function createFakeTextElement(mutationObservers, options = {}) {
  const element = new FakeElement(options, mutationObservers);
  element.textContent = '';
  return element;
}

function createResultsRow(mutationObservers) {
  const row = new FakeElement({ classNames: ['inventory-results-row'] }, mutationObservers);
  const month = createFakeTextElement(mutationObservers, { classNames: ['inventory-results-month'] });
  const demand = createFakeTextElement(mutationObservers, { classNames: ['inventory-results-demand'] });
  const beginning = createFakeTextElement(mutationObservers, { classNames: ['inventory-results-beginning'] });
  const receipts = createFakeTextElement(mutationObservers, { classNames: ['inventory-results-receipts'] });
  const ending = createFakeTextElement(mutationObservers, { classNames: ['inventory-results-ending'] });
  const safety = createFakeTextElement(mutationObservers, { classNames: ['inventory-results-safety'] });

  row.appendChild(month);
  row.appendChild(demand);
  row.appendChild(beginning);
  row.appendChild(receipts);
  row.appendChild(ending);
  row.appendChild(safety);

  return row;
}

function createOrderTimingRow(mutationObservers) {
  const row = new FakeElement({ classNames: ['results-order-row'] }, mutationObservers);
  const month = createFakeTextElement(mutationObservers, { classNames: ['results-order-month'] });
  const action = createFakeTextElement(mutationObservers, { classNames: ['results-order-action'] });

  row.hidden = true;
  row.appendChild(month);
  row.appendChild(action);

  return row;
}

class FakeElement {
  constructor({ id = '', classNames = [] } = {}, mutationObservers) {
    this.id = id;
    this.children = [];
    this.parentElement = null;
    this.style = new Proxy(
      {},
      {
        set: (target, property, value) => {
          if (target[property] === value) {
            return true;
          }

          target[property] = value;
          this.notifyAttributeMutation('style');
          return true;
        },
        deleteProperty: (target, property) => {
          if (!(property in target)) {
            return true;
          }

          delete target[property];
          this.notifyAttributeMutation('style');
          return true;
        },
      },
    );
    this._listeners = new Map();
    this._mutationObservers = mutationObservers;
    this.classList = new FakeClassList(this, classNames);
    this._hidden = false;
  }

  get hidden() {
    return this._hidden;
  }

  set hidden(value) {
    const normalized = Boolean(value);

    if (this._hidden !== normalized) {
      this._hidden = normalized;
      this.notifyAttributeMutation('hidden');
    }
  }

  addEventListener(type, handler) {
    this._listeners.set(type, handler);
  }

  dispatch(type, event = {}) {
    const listener = this._listeners.get(type);

    if (listener) {
      listener(event);
    }
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    this.notifyChildMutation(child);
  }

  contains(node) {
    if (node === this) {
      return true;
    }

    return this.children.some((child) => typeof child.contains === 'function' && child.contains(node));
  }

  querySelector(selector) {
    if (!selector.startsWith('.')) {
      return null;
    }

    const className = selector.slice(1);

    for (const child of this.children) {
      if (child.classList?.contains(className)) {
        return child;
      }

      const nestedMatch =
        typeof child.querySelector === 'function' ? child.querySelector(selector) : null;

      if (nestedMatch) {
        return nestedMatch;
      }
    }

    return null;
  }

  querySelectorAll(selector) {
    if (!selector.startsWith('.')) {
      return [];
    }

    const className = selector.slice(1);
    const matches = [];

    for (const child of this.children) {
      if (child.classList?.contains(className)) {
        matches.push(child);
      }

      if (typeof child.querySelectorAll === 'function') {
        matches.push(...child.querySelectorAll(selector));
      }
    }

    return matches;
  }

  notifyAttributeMutation(attributeName) {
    this._mutationObservers.forEach((record) => {
      if (!record.active || !record.options.attributes) {
        return;
      }

      if (
        record.options.attributeFilter &&
        !record.options.attributeFilter.includes(attributeName)
      ) {
        return;
      }

      if (record.target === this || (record.options.subtree && record.target.contains(this))) {
        record.callback([{ type: 'attributes', target: this, attributeName }]);
      }
    });
  }

  notifyChildMutation(addedNode) {
    this._mutationObservers.forEach((record) => {
      if (!record.active || !record.options.childList) {
        return;
      }

      if (record.target === this || (record.options.subtree && record.target.contains(this))) {
        record.callback([{ type: 'childList', target: this, addedNodes: [addedNode] }]);
      }
    });
  }
}

class FakeFormElement extends FakeElement {
  constructor(options, mutationObservers) {
    super(options, mutationObservers);
    this.elements = {
      namedItem: (name) => this.children.find((child) => child.name === name) ?? null,
    };
  }
}

function createDemoHarness({ savedValue } = {}) {
  const demoHtml = fs.readFileSync(path.join(repoRoot, 'demo.html'), 'utf8');
  const inlineScript = extractInlineDemoScript(demoHtml);
  const controls = new Map(
    expectedDemoFields.map(({ name, value }) => [
      name,
      createDemoInput({ name, value, defaultValue: value }),
    ]),
  );
  const mountCalls = [];
  const destroyedHandles = [];
  let nextHandleId = 0;
  const storage = new Map();
  const mutationObservers = [];

  if (savedValue !== undefined) {
    storage.set('imsCalcResults:v1', savedValue);
  }

  const controlsForm = {
    elements: {
      namedItem(name) {
        return controls.get(name) ?? null;
      },
    },
  };
  const calculateButton = new FakeElement({ id: 'inventory-calculate' }, mutationObservers);
  const resultsFrame = new FakeElement({ id: 'inventory-results' }, mutationObservers);
  const annualDemandValue = createFakeTextElement(mutationObservers, {
    id: 'inventory-results-annual-demand',
  });
  const eoqValue = createFakeTextElement(mutationObservers, { id: 'inventory-results-eoq' });
  const safetyStockValue = createFakeTextElement(mutationObservers, {
    id: 'inventory-results-safety-stock',
  });
  const orderTimingValue = createFakeTextElement(mutationObservers, {
    id: 'inventory-results-order-timing',
  });
  const orderTimingList = new FakeElement({ id: 'inventory-results-order-list' }, mutationObservers);
  const resultsRows = Array.from({ length: 12 }, () => createResultsRow(mutationObservers));
  const orderTimingRows = Array.from({ length: 12 }, () => createOrderTimingRow(mutationObservers));
  const modalElement = new FakeElement({ classNames: ['calc_modal'] }, mutationObservers);
  const modalCard = new FakeElement({ classNames: ['calc_modal-card'] }, mutationObservers);
  const unlockForm = new FakeFormElement({ id: 'calc-unlock-form' }, mutationObservers);
  const unlockEmailInput = createDemoInput({
    name: 'email',
    value: '',
    defaultValue: '',
  });
  const successElement = new FakeElement({ classNames: ['w-form-done'] }, mutationObservers);
  successElement.style.display = 'none';
  resultsFrame.appendChild(annualDemandValue);
  resultsFrame.appendChild(eoqValue);
  resultsFrame.appendChild(safetyStockValue);
  resultsFrame.appendChild(orderTimingValue);
  orderTimingRows.forEach((row) => orderTimingList.appendChild(row));
  resultsFrame.appendChild(orderTimingList);
  resultsRows.forEach((row) => resultsFrame.appendChild(row));
  modalElement.appendChild(modalCard);
  modalCard.appendChild(unlockForm);
  unlockForm.appendChild(unlockEmailInput);
  modalCard.appendChild(successElement);

  const documentStub = {
    getElementById(id) {
      if (id === 'inventory-controls') {
        return controlsForm;
      }

      if (id === 'inventory-calculate') {
        return calculateButton;
      }

      if (id === 'inventory-results') {
        return resultsFrame;
      }

      if (id === 'inventory-results-annual-demand') {
        return annualDemandValue;
      }

      if (id === 'inventory-results-eoq') {
        return eoqValue;
      }

      if (id === 'inventory-results-safety-stock') {
        return safetyStockValue;
      }

      if (id === 'inventory-results-order-timing') {
        return orderTimingValue;
      }

      if (id === 'inventory-results-order-list') {
        return orderTimingList;
      }

      if (id === 'calc-unlock-form') {
        return unlockForm;
      }
      throw new Error(`Demo script queried an unexpected element id: ${id}`);
    },
    querySelector(selector) {
      assert.equal(selector, '.calc_modal', 'Demo script queried an unexpected selector.');
      return modalElement;
    },
  };

  const InventoryGraph = {
    mount(selector, options) {
      assert.equal(
        resultsFrame.hidden,
        false,
        'Demo must reveal #inventory-results before InventoryGraph.mount runs.',
      );
      mountCalls.push({ selector, options });
      const handleId = nextHandleId;
      nextHandleId += 1;

      return {
        canvas: { id: handleId },
        redraw() {},
        destroy() {
          destroyedHandles.push(handleId);
        },
        result: createDemoResult(options),
      };
    },
  };

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.record = null;
    }

    observe(target, options) {
      this.record = {
        callback: this.callback,
        target,
        options,
        active: true,
      };
      mutationObservers.push(this.record);
    }

    disconnect() {
      if (this.record) {
        this.record.active = false;
      }
    }
  }

  const windowStub = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
    },
    getComputedStyle(element) {
      return {
        display: element.style.display || 'block',
        visibility: element.style.visibility || 'visible',
        opacity: element.style.opacity || '1',
      };
    },
  };
  windowStub.window = windowStub;

  const context = vm.createContext({
    document: documentStub,
    InventoryGraph,
    MutationObserver,
    Number,
    Date,
    JSON,
    window: windowStub,
  });

  vm.runInContext(inlineScript, context, { filename: 'demo-inline-script.js' });

  return {
    calculateButton,
    controls,
    destroyedHandles,
    modalCard,
    modalElement,
    mountCalls,
    mutationObservers,
    resultsFrame,
    annualDemandValue,
    eoqValue,
    safetyStockValue,
    orderTimingValue,
    orderTimingList,
    orderTimingRows,
    resultsRows,
    storage,
    unlockEmailInput,
    unlockForm,
    successElement,
  };
}

function verifyDemoFlow() {
  const lockedHarness = createDemoHarness();

  assert.equal(
    lockedHarness.mountCalls.length,
    0,
    'With empty localStorage, the demo must not mount the graph on initial load.',
  );
  assert.equal(
    lockedHarness.resultsFrame.hidden,
    true,
    'With empty localStorage, results should stay hidden on initial load.',
  );

  lockedHarness.calculateButton.dispatch('click');

  assert.equal(
    lockedHarness.modalElement.classList.contains('show'),
    true,
    'Locked Calculate should open .calc_modal by adding .show.',
  );
  assert.equal(
    lockedHarness.mountCalls.length,
    0,
    'Locked Calculate must not mount results before modal success.',
  );

  const modalObserver = lockedHarness.mutationObservers.find((record) => record.active);
  assert.ok(modalObserver, 'Locked Calculate should attach a MutationObserver to .calc_modal.');
  assert.equal(modalObserver.target, lockedHarness.modalElement, 'MutationObserver should watch .calc_modal.');
  assert.equal(modalObserver.options.childList, true, 'MutationObserver should watch childList changes.');
  assert.equal(modalObserver.options.subtree, true, 'MutationObserver should watch subtree changes.');
  assert.equal(modalObserver.options.attributes, true, 'MutationObserver should watch attribute changes.');
  assert.deepEqual(
    Array.from(modalObserver.options.attributeFilter),
    ['class', 'style'],
    'MutationObserver should watch class/style changes.',
  );

  lockedHarness.controls.get('annualDemand').value = '8100';
  lockedHarness.controls.get('averageMonthlySales').value = '321';
  let didPreventDefault = false;
  lockedHarness.unlockForm.dispatch('submit', {
    preventDefault() {
      didPreventDefault = true;
    },
  });

  assert.equal(
    didPreventDefault,
    true,
    'Local demo unlock submit should prevent native form navigation.',
  );
  assert.equal(
    lockedHarness.successElement.style.display,
    'block',
    'Local demo unlock submit should reveal the existing .w-form-done block.',
  );
  assert.equal(
    lockedHarness.mountCalls.length,
    1,
    'Local demo unlock submit should unlock after revealing .w-form-done.',
  );
  assert.equal(
    lockedHarness.resultsFrame.hidden,
    false,
    'Visible Webflow success should reveal the results frame.',
  );
  assert.equal(
    lockedHarness.modalElement.classList.contains('show'),
    true,
    'Modal success should leave .calc_modal.show in place.',
  );
  assert.equal(
    lockedHarness.successElement.style.display,
    'block',
    'Visible Webflow success should reveal .w-form-done.',
  );
  const unlockedResult = createDemoResult(lockedHarness.mountCalls[0].options);
  assert.equal(
    lockedHarness.annualDemandValue.textContent,
    formatDemoUnits(7000),
    'Unlocked results should show the Annual Demand input value.',
  );
  assert.equal(
    lockedHarness.eoqValue.textContent,
    formatDemoUnits(unlockedResult.eoq),
    'Unlocked results should show the mount handle EOQ value.',
  );
  assert.equal(
    lockedHarness.safetyStockValue.textContent,
    formatDemoUnits(unlockedResult.safetyStock),
    'Unlocked results should show the mount handle safety stock value.',
  );
  assert.equal(
    lockedHarness.orderTimingValue.hidden,
    true,
    'Unlocked results should hide the empty-state copy when orders exist.',
  );
  assert.equal(
    lockedHarness.orderTimingList.hidden,
    false,
    'Unlocked results should reveal the stacked order list when orders exist.',
  );
  const unlockedOrderTiming = formatDemoOrderTiming(unlockedResult);
  assert.equal(
    lockedHarness.orderTimingRows[0].querySelector('.results-order-month').textContent,
    unlockedOrderTiming[0].month,
    'Unlocked results should render the first order month in its own row.',
  );
  assert.equal(
    lockedHarness.orderTimingRows[0].querySelector('.results-order-action').textContent,
    unlockedOrderTiming[0].action,
    'Unlocked results should render action wording per order row.',
  );
  assert.equal(
    lockedHarness.orderTimingRows[4].hidden,
    true,
    'Unlocked results should hide unused static order rows.',
  );
  assert.equal(
    lockedHarness.resultsRows[0].querySelector('.inventory-results-month').textContent,
    formatDemoMonthLabel(unlockedResult.months[0].month),
    'Unlocked results should render the first month label in the static table.',
  );
  assert.equal(
    lockedHarness.resultsRows[0].querySelector('.inventory-results-demand').textContent,
    formatDemoUnits(unlockedResult.months[0].fulfillment),
    'Unlocked results should render projected monthly demand in the static table.',
  );
  assert.equal(
    lockedHarness.resultsRows[0].querySelector('.inventory-results-receipts').textContent,
    formatDemoUnits(unlockedResult.months[0].receipts),
    'Unlocked results should render receipt quantities in the static table.',
  );

  const firstMountOptions = normalizeDemoOptions(lockedHarness.mountCalls[0].options);
  assert.equal(
    typeof lockedHarness.mountCalls[0].options.startDate?.toISOString,
    'function',
    'New calculations should pass an explicit Date startDate into InventoryGraph.mount.',
  );
  assert.deepEqual(
    firstMountOptions,
    {
      startingInventory: 2000,
      annualDemand: 7000,
      costPerOrder: 500,
      holdingCostPerUnit: 2.5,
      maxMonthlySales: 450,
      maxLeadTime: 4,
      averageMonthlySales: 250,
      averageLeadTime: 2,
      startDate: firstMountOptions.startDate,
    },
    'Modal unlock must use the pending Calculate snapshot, not later input edits.',
  );

  const savedAfterUnlock = JSON.parse(lockedHarness.storage.get('imsCalcResults:v1'));
  assert.equal(savedAfterUnlock.version, 1, 'Unlock should persist versioned localStorage access data.');
  assert.equal(
    savedAfterUnlock.startDate,
    firstMountOptions.startDate,
    'Unlock should persist the same startDate passed into InventoryGraph.mount.',
  );
  assert.deepEqual(
    savedAfterUnlock.inputs,
    {
      startingInventory: 2000,
      annualDemand: 7000,
      costPerOrder: 500,
      holdingCostPerUnit: 2.5,
      maxMonthlySales: 450,
      maxLeadTime: 4,
      averageMonthlySales: 250,
      averageLeadTime: 2,
    },
    'Unlock should persist the pending Calculate input snapshot.',
  );
  assert.equal(
    savedAfterUnlock.results.months[0].month,
    firstMountOptions.startDate,
    'Unlock should serialize result month dates as ISO strings.',
  );

  const restoredStartDate = '2026-06-01T00:00:00.000Z';
  const restoredState = JSON.stringify({
    version: 1,
    savedAt: '2026-06-17T00:00:00.000Z',
    startDate: restoredStartDate,
    inputs: {
      startingInventory: 900,
      annualDemand: 1200,
      costPerOrder: 75,
      holdingCostPerUnit: 3,
      maxMonthlySales: 90,
      maxLeadTime: 5,
      averageMonthlySales: 70,
      averageLeadTime: 2,
    },
    results: {
      eoq: 9999,
      safetyStock: 8888,
      months: createSerializedDemoMonths(restoredStartDate, {
        startingInventory: 900,
        annualDemand: 1200,
        costPerOrder: 75,
        holdingCostPerUnit: 3,
        maxMonthlySales: 90,
        maxLeadTime: 5,
        averageMonthlySales: 70,
        averageLeadTime: 2,
      }).map((month) => ({
        ...month,
        fulfillment: 7777,
        receipts: 6666,
        safetyStock: 5555,
      })),
    },
  });
  const restoredHarness = createDemoHarness({ savedValue: restoredState });

  assert.equal(
    restoredHarness.mountCalls.length,
    1,
    'Valid saved localStorage should mount the graph immediately on load.',
  );
  assert.equal(
    restoredHarness.resultsFrame.hidden,
    false,
    'Valid saved localStorage should reveal results immediately on load.',
  );
  assert.equal(
    restoredHarness.controls.get('startingInventory').value,
    '900',
    'Valid saved localStorage should restore input values before showing results.',
  );
  assert.deepEqual(
    normalizeDemoOptions(restoredHarness.mountCalls[0].options),
    {
      startingInventory: 900,
      annualDemand: 1200,
      costPerOrder: 75,
      holdingCostPerUnit: 3,
      maxMonthlySales: 90,
      maxLeadTime: 5,
      averageMonthlySales: 70,
      averageLeadTime: 2,
      startDate: restoredStartDate,
    },
    'Restored mount should reuse the saved startDate and inputs.',
  );
  assert.equal(
    restoredHarness.annualDemandValue.textContent,
    formatDemoUnits(1200),
    'Restored results should show the restored Annual Demand input value.',
  );
  const restoredResult = createDemoResult(restoredHarness.mountCalls[0].options);
  assert.equal(
    restoredHarness.eoqValue.textContent,
    formatDemoUnits(restoredResult.eoq),
    'Restored visible EOQ must come from the fresh mount handle, not serialized saved results.',
  );
  assert.equal(
    restoredHarness.safetyStockValue.textContent,
    formatDemoUnits(restoredResult.safetyStock),
    'Restored visible safety stock must come from the fresh mount handle, not serialized saved results.',
  );
  assert.equal(
    restoredHarness.orderTimingValue.hidden,
    true,
    'Restored results should keep the empty-state copy hidden when orders exist.',
  );
  const restoredOrderTiming = formatDemoOrderTiming(restoredResult);
  assert.equal(
    restoredHarness.orderTimingRows[0].querySelector('.results-order-month').textContent,
    restoredOrderTiming[0].month,
    'Restored visible order timing month must come from the fresh mount handle receipts.',
  );
  assert.equal(
    restoredHarness.orderTimingRows[0].querySelector('.results-order-action').textContent,
    restoredOrderTiming[0].action,
    'Restored visible order timing action must come from the fresh mount handle receipts.',
  );
  assert.equal(
    restoredHarness.resultsRows[0].querySelector('.inventory-results-demand').textContent,
    formatDemoUnits(restoredResult.months[0].fulfillment),
    'Restored visible monthly demand must come from the fresh mount handle result.',
  );

  restoredHarness.controls.get('startingInventory').value = '1111';
  restoredHarness.controls.get('annualDemand').value = '2222';
  restoredHarness.calculateButton.dispatch('click');

  assert.equal(
    restoredHarness.modalElement.classList.contains('show'),
    false,
    'Returning users with saved access must not reopen .calc_modal on Calculate.',
  );
  assert.equal(
    restoredHarness.mountCalls.length,
    2,
    'Returning users should recalculate immediately on Calculate.',
  );
  assert.deepEqual(
    restoredHarness.destroyedHandles,
    [0],
    'Recalculation should destroy the previous chart handle before remounting.',
  );

  const savedAfterRecalc = JSON.parse(restoredHarness.storage.get('imsCalcResults:v1'));
  const recalculatedOptions = normalizeDemoOptions(restoredHarness.mountCalls[1].options);
  assert.equal(
    savedAfterRecalc.startDate,
    recalculatedOptions.startDate,
    'Recalculation should persist the same explicit startDate used for the remount.',
  );
  assert.equal(savedAfterRecalc.inputs.startingInventory, 1111, 'Recalculation should persist updated input values.');
  assert.equal(savedAfterRecalc.inputs.annualDemand, 2222, 'Recalculation should persist current Annual Demand.');
  assert.equal(
    restoredHarness.annualDemandValue.textContent,
    formatDemoUnits(2222),
    'Recalculation should update the visible Annual Demand summary.',
  );
  const recalculatedResult = createDemoResult(restoredHarness.mountCalls[1].options);
  assert.equal(
    restoredHarness.eoqValue.textContent,
    formatDemoUnits(recalculatedResult.eoq),
    'Recalculation should update the visible EOQ summary when Annual Demand changes.',
  );
  assert.equal(
    restoredHarness.safetyStockValue.textContent,
    formatDemoUnits(recalculatedResult.safetyStock),
    'Recalculation should keep visible safety stock unchanged when safety-stock inputs are unchanged.',
  );
  assert.equal(
    restoredHarness.resultsRows[0].querySelector('.inventory-results-demand').textContent,
    formatDemoUnits(recalculatedResult.months[0].fulfillment),
    'Recalculation should update visible projected monthly demand when Annual Demand changes.',
  );

  const noOrderHarness = createDemoHarness({
    savedValue: JSON.stringify({
      version: 1,
      savedAt: '2026-06-17T00:00:00.000Z',
      startDate: restoredStartDate,
      inputs: {
        startingInventory: 10000,
        annualDemand: 1200,
        costPerOrder: 75,
        holdingCostPerUnit: 3,
        maxMonthlySales: 90,
        maxLeadTime: 5,
        averageMonthlySales: 70,
        averageLeadTime: 2,
      },
      results: {
        eoq: 0,
        safetyStock: 0,
        months: createSerializedDemoMonths(restoredStartDate, {
          startingInventory: 10000,
          annualDemand: 1200,
          costPerOrder: 75,
          holdingCostPerUnit: 3,
          maxMonthlySales: 90,
          maxLeadTime: 5,
          averageMonthlySales: 70,
          averageLeadTime: 2,
        }),
      },
    }),
  });
  assert.equal(
    noOrderHarness.orderTimingValue.hidden,
    false,
    'No-order results should keep the simple empty-state copy visible.',
  );
  assert.equal(
    noOrderHarness.orderTimingValue.textContent,
    'No projected orders.',
    'No-order results should keep the existing simple empty state.',
  );
  assert.equal(
    noOrderHarness.orderTimingList.hidden,
    true,
    'No-order results should hide the stacked order list.',
  );

  const malformedHarness = createDemoHarness({ savedValue: '{"version":' });
  assert.equal(
    malformedHarness.mountCalls.length,
    0,
    'Malformed localStorage data should be treated as no saved access.',
  );

  const wrongVersionHarness = createDemoHarness({
    savedValue: JSON.stringify({ version: 2 }),
  });
  assert.equal(
    wrongVersionHarness.mountCalls.length,
    0,
    'Wrong-version localStorage data should be treated as no saved access.',
  );

  const multipleSuccessHarness = createDemoHarness();
  multipleSuccessHarness.calculateButton.dispatch('click');
  const appendedSuccessElement = new FakeElement({ classNames: ['w-form-done'] }, multipleSuccessHarness.mutationObservers);
  appendedSuccessElement.style.display = 'block';
  multipleSuccessHarness.modalCard.appendChild(appendedSuccessElement);
  assert.equal(
    multipleSuccessHarness.mountCalls.length,
    1,
    'A later visible .w-form-done should unlock even when an earlier placeholder remains hidden.',
  );

  const nonIsoSavedAtHarness = createDemoHarness({
    savedValue: JSON.stringify({
      version: 1,
      savedAt: '2026-06-17',
      startDate: restoredStartDate,
      inputs: {
        startingInventory: 900,
        annualDemand: 1200,
        costPerOrder: 75,
        holdingCostPerUnit: 3,
        maxMonthlySales: 90,
        maxLeadTime: 5,
        averageMonthlySales: 70,
        averageLeadTime: 2,
      },
      results: {
        eoq: 1275,
        safetyStock: 95,
        months: createSerializedDemoMonths(restoredStartDate, {
          startingInventory: 900,
          annualDemand: 1200,
          costPerOrder: 75,
          holdingCostPerUnit: 3,
          maxMonthlySales: 90,
          maxLeadTime: 5,
          averageMonthlySales: 70,
          averageLeadTime: 2,
        }),
      },
    }),
  });
  assert.equal(
    nonIsoSavedAtHarness.mountCalls.length,
    0,
    'Saved localStorage data with a non-ISO savedAt should be treated as no saved access.',
  );

  const nonIsoStartDateHarness = createDemoHarness({
    savedValue: JSON.stringify({
      version: 1,
      savedAt: '2026-06-17T00:00:00.000Z',
      startDate: '2026-06-01',
      inputs: {
        startingInventory: 900,
        annualDemand: 1200,
        costPerOrder: 75,
        holdingCostPerUnit: 3,
        maxMonthlySales: 90,
        maxLeadTime: 5,
        averageMonthlySales: 70,
        averageLeadTime: 2,
      },
      results: {
        eoq: 1275,
        safetyStock: 95,
        months: createSerializedDemoMonths(restoredStartDate, {
          startingInventory: 900,
          annualDemand: 1200,
          costPerOrder: 75,
          holdingCostPerUnit: 3,
          maxMonthlySales: 90,
          maxLeadTime: 5,
          averageMonthlySales: 70,
          averageLeadTime: 2,
        }),
      },
    }),
  });
  assert.equal(
    nonIsoStartDateHarness.mountCalls.length,
    0,
    'Saved localStorage data with a non-ISO startDate should be treated as no saved access.',
  );

  const incompleteResultsHarness = createDemoHarness({
    savedValue: JSON.stringify({
      version: 1,
      savedAt: '2026-06-17T00:00:00.000Z',
      startDate: restoredStartDate,
      inputs: {
        startingInventory: 900,
        annualDemand: 1200,
        costPerOrder: 75,
        holdingCostPerUnit: 3,
        maxMonthlySales: 90,
        maxLeadTime: 5,
        averageMonthlySales: 70,
        averageLeadTime: 2,
      },
      results: {
        eoq: 1275,
        safetyStock: 95,
        months: createSerializedDemoMonths(restoredStartDate, {
          startingInventory: 900,
          annualDemand: 1200,
          costPerOrder: 75,
          holdingCostPerUnit: 3,
          maxMonthlySales: 90,
          maxLeadTime: 5,
          averageMonthlySales: 70,
          averageLeadTime: 2,
        }).slice(0, 1),
      },
    }),
  });
  assert.equal(
    incompleteResultsHarness.mountCalls.length,
    0,
    'Saved localStorage data with fewer than 12 months should be treated as no saved access.',
  );

  const nonIsoMonthHarness = createDemoHarness({
    savedValue: JSON.stringify({
      version: 1,
      savedAt: '2026-06-17T00:00:00.000Z',
      startDate: restoredStartDate,
      inputs: {
        startingInventory: 900,
        annualDemand: 1200,
        costPerOrder: 75,
        holdingCostPerUnit: 3,
        maxMonthlySales: 90,
        maxLeadTime: 5,
        averageMonthlySales: 70,
        averageLeadTime: 2,
      },
      results: {
        eoq: 1275,
        safetyStock: 95,
        months: createSerializedDemoMonths(restoredStartDate, {
          startingInventory: 900,
          annualDemand: 1200,
          costPerOrder: 75,
          holdingCostPerUnit: 3,
          maxMonthlySales: 90,
          maxLeadTime: 5,
          averageMonthlySales: 70,
          averageLeadTime: 2,
        }).map((month, index) =>
          index === 0
            ? {
                ...month,
                month: '2026-06-01',
              }
            : month,
        ),
      },
    }),
  });
  assert.equal(
    nonIsoMonthHarness.mountCalls.length,
    0,
    'Saved localStorage data with non-ISO month strings should be treated as no saved access.',
  );
}

function createCanvasContextStub() {
  const operations = [];
  let currentPath = [];

  const stub = {
    operations,
    beginPath() {},
    clearRect() {},
    fill() {},
    fillRect() {},
    fillText() {},
    lineTo() {},
    moveTo() {},
    setTransform() {},
    stroke() {},
    arc() {},
    measureText(text) {
      return { width: String(text).length * 7 };
    },
    strokeStyle: '#000000',
    fillStyle: '#000000',
    lineWidth: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    font: '12px sans-serif',
  };

  stub.beginPath = () => {
    currentPath = [];
    operations.push({ type: 'beginPath' });
  };
  stub.clearRect = (x, y, width, height) => {
    operations.push({ type: 'clearRect', x, y, width, height });
  };
  stub.fillRect = (x, y, width, height) => {
    operations.push({ type: 'fillRect', x, y, width, height, fillStyle: stub.fillStyle });
  };
  stub.fill = () => {
    operations.push({
      type: 'fill',
      fillStyle: stub.fillStyle,
      path: currentPath.map((segment) => ({ ...segment })),
    });
  };
  stub.fillText = (text, x, y) => {
    operations.push({
      type: 'fillText',
      text,
      x,
      y,
      fillStyle: stub.fillStyle,
      font: stub.font,
      textAlign: stub.textAlign,
    });
  };
  stub.lineTo = (x, y) => {
    currentPath.push({ type: 'lineTo', x, y });
    operations.push({ type: 'lineTo', x, y });
  };
  stub.moveTo = (x, y) => {
    currentPath.push({ type: 'moveTo', x, y });
    operations.push({ type: 'moveTo', x, y });
  };
  stub.setTransform = (a, b, c, d, e, f) => {
    operations.push({ type: 'setTransform', a, b, c, d, e, f });
  };
  stub.stroke = () => {
    operations.push({
      type: 'stroke',
      strokeStyle: stub.strokeStyle,
      lineWidth: stub.lineWidth,
      path: currentPath.map((segment) => ({ ...segment })),
    });
  };
  stub.arc = (x, y, radius, startAngle, endAngle) => {
    currentPath.push({ type: 'arc', x, y, radius, startAngle, endAngle });
    operations.push({ type: 'arc', x, y, radius, startAngle, endAngle });
  };
  stub.resetOperations = () => {
    operations.length = 0;
    currentPath = [];
  };

  return stub;
}

function getSeriesPath(contextStub, color) {
  const matchingStrokes = contextStub.operations.filter(
    (operation) =>
      operation.type === 'stroke' &&
      operation.strokeStyle === color &&
      operation.path.filter(
        (segment) => segment.type === 'moveTo' || segment.type === 'lineTo',
      ).length > 1,
  );

  assert.ok(matchingStrokes.length > 0, `Could not find a stroked path for ${color}.`);

  return matchingStrokes.reduce((longest, candidate) =>
    candidate.path.length > longest.path.length ? candidate : longest,
  );
}

function getSeriesPolylinePoints(pathOperation) {
  return pathOperation.path.filter(
    (segment) => segment.type === 'moveTo' || segment.type === 'lineTo',
  );
}

function getTooltipTexts(contextStub) {
  return contextStub.operations
    .filter((operation) => operation.type === 'fillText')
    .map((operation) => operation.text)
    .filter((text) => text.startsWith('Month:') || text.startsWith('End Inv:'));
}

function getFillTextOperation(contextStub, text) {
  return contextStub.operations.find(
    (operation) => operation.type === 'fillText' && operation.text === text,
  );
}

function verifyBundleSmoke() {
  const bundlePath = path.join(repoRoot, 'dist/inventory-graph.min.js');
  assert.ok(fs.existsSync(bundlePath), 'Build output dist/inventory-graph.min.js was not generated.');

  class HTMLElement {
    constructor() {
      this.style = {};
      this.parentElement = null;
      this.clientWidth = 0;
      this.clientHeight = 0;
    }
  }

  class HTMLCanvasElement extends HTMLElement {
    constructor() {
      super();
      this.style = { width: '', height: '', display: '' };
      this.width = 0;
      this.height = 0;
      this.clientWidth = 640;
      this.clientHeight = 360;
      this._context = createCanvasContextStub();
      this._listeners = new Map();
    }

    getContext(kind) {
      return kind === '2d' ? this._context : null;
    }

    addEventListener(type, handler) {
      this._listeners.set(type, handler);
    }

    removeEventListener(type, handler) {
      if (this._listeners.get(type) === handler) {
        this._listeners.delete(type);
      }
    }

    getBoundingClientRect() {
      const width = this.style.width.endsWith('%')
        ? this.parentElement?.clientWidth ?? this.clientWidth
        : Number.parseFloat(this.style.width) || this.clientWidth;
      const height = this.style.height.endsWith('%')
        ? this.parentElement?.clientHeight ?? this.clientHeight
        : Number.parseFloat(this.style.height) || this.clientHeight;

      return {
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        width,
        height,
      };
    }
  }

  class HTMLDivElement extends HTMLElement {
    constructor() {
      super();
      this.clientWidth = 900;
      this.clientHeight = 0;
      this.children = [];
    }

    replaceChildren(...children) {
      this.children.forEach((child) => {
        child.parentElement = null;
      });
      this.children = children;
      children.forEach((child) => {
        child.parentElement = this;
      });
    }
  }

  const container = new HTMLDivElement();
  const createdElements = [];
  const windowListeners = new Map();
  const windowStub = {
    devicePixelRatio: 1,
    addEventListener(type, handler) {
      windowListeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      if (windowListeners.get(type) === handler) {
        windowListeners.delete(type);
      }
    },
  };
  const documentStub = {
    querySelector(selector) {
      assert.equal(selector, '#inventory-graph', 'Smoke test queried an unexpected selector.');
      return container;
    },
    createElement(tagName) {
      assert.equal(tagName, 'canvas', 'Smoke test only expects canvas creation.');
      const canvas = new HTMLCanvasElement();
      createdElements.push(canvas);
      return canvas;
    },
  };

  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    HTMLElement,
    HTMLCanvasElement,
    HTMLDivElement,
    Intl,
    Date,
    Math,
    Error,
    ResizeObserver: undefined,
  });
  const bundleSource = fs.readFileSync(bundlePath, 'utf8');

  vm.runInContext(bundleSource, context, { filename: 'inventory-graph.min.js' });

  assert.equal(typeof windowStub.InventoryGraph?.mount, 'function', 'Bundle did not expose window.InventoryGraph.mount.');

  const handle = windowStub.InventoryGraph.mount('#inventory-graph', {
    startDate: new Date(2026, 5, 1),
  });

  assert.equal(createdElements.length, 1, 'Mount did not create a canvas for the demo container path.');
  assert.equal(handle.canvas, createdElements[0], 'Mount did not return the created canvas.');
  assert.equal(container.children.length, 1, 'Mount did not attach the created canvas to the container.');
  assert.equal(container.children[0], handle.canvas, 'Mount attached an unexpected child to the container.');
  assert.equal(handle.canvas.parentElement, container, 'Created canvas was not parented to the container.');
  assert.equal(handle.canvas.style.width, '100%', 'Owned canvas did not receive responsive width styling.');
  assert.equal(typeof handle.result?.eoq, 'number', 'Mount handle is missing the calculated result.');
  assert.equal(typeof handle.redraw, 'function', 'Mount handle is missing redraw().');
  assert.equal(typeof handle.destroy, 'function', 'Mount handle is missing destroy().');
  assert.equal(
    typeof handle.canvas._listeners.get('pointermove'),
    'function',
    'Canvas is missing pointermove hover handling.',
  );
  assert.equal(
    typeof handle.canvas._listeners.get('pointerleave'),
    'function',
    'Canvas is missing pointerleave hover handling.',
  );
  assert.equal(typeof windowListeners.get('resize'), 'function', 'Mount should register a window resize listener.');

  const pointerMove = handle.canvas._listeners.get('pointermove');
  const pointerLeave = handle.canvas._listeners.get('pointerleave');
  const contextStub = handle.canvas._context;
  const endInvPath = getSeriesPath(contextStub, '#2563eb');
  const safetyStockPath = getSeriesPath(contextStub, '#dc2626');
  const endInvPoints = getSeriesPolylinePoints(endInvPath);
  const safetyStockPoints = getSeriesPolylinePoints(safetyStockPath);
  const [firstEndInvPoint, secondEndInvPoint] = endInvPoints;
  const [firstSafetyPoint] = safetyStockPoints;

  assert.ok(firstEndInvPoint, 'Could not derive the first End Inv point from drawing operations.');
  assert.ok(secondEndInvPoint, 'Could not derive the second End Inv point from drawing operations.');
  assert.ok(firstSafetyPoint, 'Could not derive the first Safety Stock point from drawing operations.');

  const firstEndInvSegmentMidpoint = {
    x: (firstEndInvPoint.x + secondEndInvPoint.x) / 2,
    y: (firstEndInvPoint.y + secondEndInvPoint.y) / 2,
  };

  contextStub.resetOperations();
  pointerMove({
    clientX: firstEndInvSegmentMidpoint.x,
    clientY: firstEndInvSegmentMidpoint.y,
  });

  const hoverTexts = getTooltipTexts(contextStub);
  assert.equal(
    contextStub.operations.some((operation) => operation.type === 'clearRect'),
    true,
    'Hover should redraw the canvas even when size and DPR are unchanged.',
  );
  assert.equal(
    contextStub.operations.some(
      (operation) => operation.type === 'arc' && operation.radius > 0,
    ),
    true,
    'Hovering near an End Inv line segment should draw a point marker.',
  );
  assert.deepEqual(
    hoverTexts,
    ['Month: Jun 2026', 'End Inv: 1,883'],
    'Hovering near the first End Inv segment should resolve to the nearest existing month point.',
  );
  assert.equal(
    getFillTextOperation(contextStub, 'End Inv')?.textAlign,
    'left',
    'Hover redraw should render the legend label with left-aligned text.',
  );
  assert.equal(
    getFillTextOperation(contextStub, 'Safety Stock')?.textAlign,
    'left',
    'Hover redraw should keep all legend labels left-aligned.',
  );

  contextStub.resetOperations();
  pointerLeave();
  contextStub.resetOperations();
  pointerMove({ clientX: firstEndInvPoint.x + 4, clientY: firstEndInvPoint.y + 2 });
  assert.deepEqual(
    getTooltipTexts(contextStub),
    ['Month: Jun 2026', 'End Inv: 1,883'],
    'Hover tooltip should still show the hovered End Inv point month and value.',
  );

  contextStub.resetOperations();
  pointerLeave();
  assert.equal(
    contextStub.operations.some((operation) => operation.type === 'clearRect'),
    true,
    'Pointer leave should redraw the canvas to clear hover state.',
  );
  assert.deepEqual(getTooltipTexts(contextStub), [], 'Pointer leave should clear the hover tooltip.');

  contextStub.resetOperations();
  pointerMove({ clientX: firstSafetyPoint.x, clientY: firstSafetyPoint.y });
  assert.deepEqual(
    getTooltipTexts(contextStub),
    [],
    'Hovering near the Safety Stock line alone should not show an End Inv tooltip.',
  );

  handle.redraw();
  handle.destroy();

  assert.equal(
    handle.canvas._listeners.has('pointermove'),
    false,
    'Destroy should remove the pointermove listener.',
  );
  assert.equal(
    handle.canvas._listeners.has('pointerleave'),
    false,
    'Destroy should remove the pointerleave listener.',
  );
  assert.equal(windowListeners.has('resize'), false, 'Destroy should remove the window resize listener.');
  assert.equal(container.children.length, 0, 'Destroy did not clean up the owned canvas.');
}

async function main() {
  const workbook = verifyWorkbookProof();
  const calculations = await verifyCalculationParity();
  runBuild();
  verifyBundleSmoke();
  verifyDemoHtml();
  verifyDemoFlow();

  const summary = {
    verifiedAt: new Date().toISOString(),
    workbook,
    calculations,
    buildOutput: 'dist/inventory-graph.min.js',
    demoHtmlChecked: true,
    bundleSmokeChecked: true,
    demoFlowChecked: true,
  };

  ensureArtifactDirectory();
  fs.writeFileSync(artifactPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log('Inventory graph verification passed.');
  console.log(`Artifact: ${path.relative(repoRoot, artifactPath)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
