import {
  calculateInventoryData,
  type InventoryCalculationOptions,
} from './inventoryFormulas';
import { mountInventoryChart, type InventoryChartHandle } from './inventoryCanvas';

export interface InventoryGraphApi {
  mount: (
    selector: string,
    options?: InventoryCalculationOptions,
  ) => InventoryChartHandle;
}

function resolveTarget(selector: string): Element {
  if (typeof selector !== 'string') {
    throw new Error('InventoryGraph.mount requires a CSS selector string.');
  }

  let target: Element | null;

  try {
    target = document.querySelector(selector);
  } catch {
    throw new Error(`InventoryGraph.mount could not query selector "${selector}".`);
  }

  if (!target) {
    throw new Error(`InventoryGraph.mount could not find an element for selector "${selector}".`);
  }

  return target;
}

function mount(
  selector: string,
  options?: InventoryCalculationOptions,
): InventoryChartHandle {
  const target = resolveTarget(selector);

  if (!(target instanceof HTMLElement)) {
    throw new Error(`InventoryGraph.mount requires an HTMLElement for selector "${selector}".`);
  }

  const data = calculateInventoryData(options);
  return mountInventoryChart(target, data);
}

const inventoryGraph: InventoryGraphApi = { mount };

declare global {
  interface Window {
    InventoryGraph: InventoryGraphApi;
  }
}

window.InventoryGraph = inventoryGraph;

