export interface InventoryCalculationOptions {
  startingInventory?: number;
  annualDemand?: number;
  costPerOrder?: number;
  holdingCostPerUnit?: number;
  maxMonthlySales?: number;
  maxLeadTime?: number;
  averageMonthlySales?: number;
  averageLeadTime?: number;
  startDate?: Date;
}

export interface InventoryMonthlyRecord {
  month: Date;
  fulfillment: number;
  beginningInventory: number;
  receipts: number;
  endingInventory: number;
  safetyStock: number;
}

export interface InventoryCalculationResult {
  eoq: number;
  safetyStock: number;
  months: InventoryMonthlyRecord[];
}

const DEFAULTS = {
  startingInventory: 2000,
  annualDemand: 7000,
  costPerOrder: 500,
  holdingCostPerUnit: 2.5,
  maxMonthlySales: 450,
  maxLeadTime: 4,
  averageMonthlySales: 250,
  averageLeadTime: 2,
} as const;

const SEASONALITY = [
  0.0166666666666667,
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
] as const;

function roundExcelInteger(value: number): number {
  if (value >= 0) {
    return Math.floor(value + 0.5);
  }

  return Math.ceil(value - 0.5);
}

function getMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), 1));
}

export function calculateInventoryData(
  options: InventoryCalculationOptions = {},
): InventoryCalculationResult {
  const startingInventory = options.startingInventory ?? DEFAULTS.startingInventory;
  const annualDemand = options.annualDemand ?? DEFAULTS.annualDemand;
  const costPerOrder = options.costPerOrder ?? DEFAULTS.costPerOrder;
  const holdingCostPerUnit = options.holdingCostPerUnit ?? DEFAULTS.holdingCostPerUnit;
  const maxMonthlySales = options.maxMonthlySales ?? DEFAULTS.maxMonthlySales;
  const maxLeadTime = options.maxLeadTime ?? DEFAULTS.maxLeadTime;
  const averageMonthlySales = options.averageMonthlySales ?? DEFAULTS.averageMonthlySales;
  const averageLeadTime = options.averageLeadTime ?? DEFAULTS.averageLeadTime;
  const startDate = options.startDate ?? new Date();

  const safetyStock =
    maxMonthlySales * maxLeadTime - averageMonthlySales * averageLeadTime;
  const eoqIntermediate = (2 * annualDemand * costPerOrder) / holdingCostPerUnit;
  const eoq = roundExcelInteger(Math.sqrt(eoqIntermediate));
  const firstMonth = getMonthStart(startDate);

  const months: InventoryMonthlyRecord[] = [];

  for (let monthIndex = 0; monthIndex < SEASONALITY.length; monthIndex += 1) {
    const month = new Date(
      Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + monthIndex, 1),
    );
    const fulfillment = roundExcelInteger(annualDemand * SEASONALITY[monthIndex]);
    const beginningInventory =
      monthIndex === 0 ? startingInventory : months[monthIndex - 1].endingInventory;
    const receipts = safetyStock > beginningInventory ? eoq : 0;
    const endingInventory = beginningInventory + receipts - fulfillment;

    months.push({
      month,
      fulfillment,
      beginningInventory,
      receipts,
      endingInventory,
      safetyStock,
    });
  }

  return {
    eoq,
    safetyStock,
    months,
  };
}
