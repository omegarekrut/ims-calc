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
}

function createCanvasContextStub() {
  return {
    beginPath() {},
    clearRect() {},
    fillRect() {},
    fillText() {},
    lineTo() {},
    moveTo() {},
    setTransform() {},
    stroke() {},
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
    }

    getContext(kind) {
      return kind === '2d' ? this._context : null;
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
  const windowStub = {
    devicePixelRatio: 1,
    addEventListener() {},
    removeEventListener() {},
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
  assert.equal(typeof handle.redraw, 'function', 'Mount handle is missing redraw().');
  assert.equal(typeof handle.destroy, 'function', 'Mount handle is missing destroy().');

  handle.redraw();
  handle.destroy();

  assert.equal(container.children.length, 0, 'Destroy did not clean up the owned canvas.');
}

async function main() {
  const workbook = verifyWorkbookProof();
  const calculations = await verifyCalculationParity();
  runBuild();
  verifyBundleSmoke();
  verifyDemoHtml();

  const summary = {
    verifiedAt: new Date().toISOString(),
    workbook,
    calculations,
    buildOutput: 'dist/inventory-graph.min.js',
    demoHtmlChecked: true,
    bundleSmokeChecked: true,
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
