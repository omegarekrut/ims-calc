import type { InventoryCalculationResult } from './inventoryFormulas';

export interface InventoryChartHandle {
  canvas: HTMLCanvasElement;
  redraw: () => void;
  destroy: () => void;
}

const DEFAULT_HEIGHT = 360;
const DEFAULT_ASPECT_RATIO = 0.56;
const GRIDLINE_COUNT = 5;
const LEGEND_ITEMS = [
  { label: 'End Inv', color: '#2563eb' },
  { label: 'Safety Stock', color: '#dc2626' },
] as const;

function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date);
}

function getTickStep(rawStep: number): number {
  if (rawStep <= 0) {
    return 1;
  }

  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;

  if (normalized <= 1) {
    return magnitude;
  }

  if (normalized <= 2) {
    return 2 * magnitude;
  }

  if (normalized <= 5) {
    return 5 * magnitude;
  }

  return 10 * magnitude;
}

function buildTicks(minValue: number, maxValue: number): number[] {
  if (minValue === maxValue) {
    return [minValue];
  }

  const rawStep = (maxValue - minValue) / GRIDLINE_COUNT;
  const step = getTickStep(rawStep);
  const firstTick = Math.floor(minValue / step) * step;
  const lastTick = Math.ceil(maxValue / step) * step;
  const ticks: number[] = [];

  for (let tick = firstTick; tick <= lastTick; tick += step) {
    ticks.push(tick);
  }

  return ticks;
}

function getContainerSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const container = canvas.parentElement;
  const widthSource = container ?? canvas;
  const heightSource = container ?? canvas;
  const measuredWidth = Math.round(widthSource.clientWidth || canvas.clientWidth);
  const measuredHeight = Math.round(heightSource.clientHeight || canvas.clientHeight);
  const width = Math.max(1, measuredWidth || 640);
  const fallbackHeight = measuredWidth
    ? Math.round(measuredWidth * DEFAULT_ASPECT_RATIO)
    : DEFAULT_HEIGHT;
  const height = Math.max(1, measuredHeight || fallbackHeight);

  return { width, height };
}

function syncCanvasDisplaySize(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  shouldUseResponsiveSize: boolean,
  hasCallerProvidedWidth: boolean,
  hasCallerProvidedHeight: boolean,
): void {
  canvas.style.display = 'block';

  if (shouldUseResponsiveSize) {
    canvas.style.width = '100%';
    canvas.style.height = `${cssHeight}px`;
    return;
  }

  if (!hasCallerProvidedWidth) {
    canvas.style.width = `${cssWidth}px`;
  }

  if (!hasCallerProvidedHeight) {
    canvas.style.height = `${cssHeight}px`;
  }
}

function getYDomain(data: InventoryCalculationResult): { min: number; max: number } {
  let seriesMin = Number.POSITIVE_INFINITY;
  let seriesMax = Number.NEGATIVE_INFINITY;

  data.months.forEach((month) => {
    seriesMin = Math.min(seriesMin, month.endingInventory, month.safetyStock);
    seriesMax = Math.max(seriesMax, month.endingInventory, month.safetyStock);
  });

  const span = seriesMax - seriesMin;
  const padding = span === 0 ? Math.max(1, Math.abs(seriesMax) * 0.1 || 100) : span * 0.12;
  const paddedMin = seriesMin - padding;
  const paddedMax = seriesMax + padding;
  return { min: paddedMin, max: paddedMax };
}

function drawLine(
  context: CanvasRenderingContext2D,
  values: number[],
  color: string,
  getX: (index: number) => number,
  getY: (value: number) => number,
): void {
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = 2;

  values.forEach((value, index) => {
    const x = getX(index);
    const y = getY(value);

    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  });

  context.stroke();
}

export function renderInventoryChart(
  canvas: HTMLCanvasElement,
  data: InventoryCalculationResult,
  options: {
    shouldUseResponsiveSize?: boolean;
    hasCallerProvidedWidth?: boolean;
    hasCallerProvidedHeight?: boolean;
  } = {},
): void {
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Canvas 2D context is not available.');
  }

  const shouldUseResponsiveSize = options.shouldUseResponsiveSize ?? false;
  const hasCallerProvidedWidth = options.hasCallerProvidedWidth ?? false;
  const hasCallerProvidedHeight = options.hasCallerProvidedHeight ?? false;
  const { width: cssWidth, height: cssHeight } = getContainerSize(canvas);
  const devicePixelRatio = window.devicePixelRatio || 1;
  const backingWidth = Math.max(1, Math.round(cssWidth * devicePixelRatio));
  const backingHeight = Math.max(1, Math.round(cssHeight * devicePixelRatio));

  syncCanvasDisplaySize(
    canvas,
    cssWidth,
    cssHeight,
    shouldUseResponsiveSize,
    hasCallerProvidedWidth,
    hasCallerProvidedHeight,
  );

  if (canvas.width !== backingWidth) {
    canvas.width = backingWidth;
  }

  if (canvas.height !== backingHeight) {
    canvas.height = backingHeight;
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, cssWidth, cssHeight);
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, cssWidth, cssHeight);

  const ticksFont = '12px sans-serif';
  const labelFont = '13px sans-serif';
  const legendFont = '13px sans-serif';
  const domain = getYDomain(data);
  const ticks = buildTicks(domain.min, domain.max);
  const scaleDomain = {
    min: ticks[0] ?? domain.min,
    max: ticks[ticks.length - 1] ?? domain.max,
  };
  const longestTickLabel = ticks.reduce(
    (longest, tick) => Math.max(longest, String(Math.round(tick)).length),
    0,
  );
  const yLabelWidth = Math.max(longestTickLabel * 8 + 16, 48);
  const margin = {
    top: 24,
    right: 24,
    bottom: 52,
    left: yLabelWidth,
  };
  const legendY = 12;
  const plotLeft = margin.left;
  const plotTop = margin.top + 18;
  const plotRight = cssWidth - margin.right;
  const plotBottom = cssHeight - margin.bottom;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);
  const xStep = data.months.length > 1 ? plotWidth / (data.months.length - 1) : 0;
  const getX = (index: number) => plotLeft + xStep * index;
  const getY = (value: number) =>
    plotBottom -
    ((value - scaleDomain.min) / (scaleDomain.max - scaleDomain.min || 1)) * plotHeight;

  context.textBaseline = 'middle';

  context.font = legendFont;
  let legendX = plotLeft;
  LEGEND_ITEMS.forEach((item) => {
    context.strokeStyle = item.color;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(legendX, legendY);
    context.lineTo(legendX + 18, legendY);
    context.stroke();

    context.fillStyle = '#111827';
    context.fillText(item.label, legendX + 24, legendY);
    legendX += context.measureText(item.label).width + 56;
  });

  context.font = ticksFont;
  context.fillStyle = '#6b7280';
  context.strokeStyle = '#e5e7eb';
  context.lineWidth = 1;
  context.textAlign = 'right';

  ticks.forEach((tick) => {
    const y = getY(tick);

    context.beginPath();
    context.moveTo(plotLeft, y);
    context.lineTo(plotRight, y);
    context.stroke();

    context.fillText(String(Math.round(tick)), plotLeft - 10, y);
  });

  context.strokeStyle = '#111827';
  context.beginPath();
  context.moveTo(plotLeft, plotTop);
  context.lineTo(plotLeft, plotBottom);
  context.lineTo(plotRight, plotBottom);
  context.stroke();

  context.font = labelFont;
  context.fillStyle = '#111827';
  context.textAlign = 'center';

  data.months.forEach((record, index) => {
    context.fillText(formatMonthLabel(record.month), getX(index), plotBottom + 22);
  });

  drawLine(
    context,
    data.months.map((month) => month.endingInventory),
    LEGEND_ITEMS[0].color,
    getX,
    getY,
  );
  drawLine(
    context,
    data.months.map((month) => month.safetyStock),
    LEGEND_ITEMS[1].color,
    getX,
    getY,
  );
}

export function mountInventoryChart(
  target: HTMLElement | HTMLCanvasElement,
  data: InventoryCalculationResult,
): InventoryChartHandle {
  const canvas = target instanceof HTMLCanvasElement ? target : document.createElement('canvas');
  const ownsCanvas = canvas !== target;
  const hasCallerProvidedWidth = canvas.style.width !== '';
  const hasCallerProvidedHeight = canvas.style.height !== '';

  if (ownsCanvas) {
    canvas.style.width = '100%';
    target.replaceChildren(canvas);
  }

  const observedElement = canvas.parentElement ?? canvas;

  let lastWidth = 0;
  let lastHeight = 0;
  let lastDevicePixelRatio = 0;

  const redraw = (): void => {
    const { width, height } = getContainerSize(canvas);
    const devicePixelRatio = window.devicePixelRatio || 1;

    if (
      width === lastWidth &&
      height === lastHeight &&
      devicePixelRatio === lastDevicePixelRatio
    ) {
      return;
    }

    lastWidth = width;
    lastHeight = height;
    lastDevicePixelRatio = devicePixelRatio;
    renderInventoryChart(canvas, data, {
      shouldUseResponsiveSize: ownsCanvas,
      hasCallerProvidedWidth,
      hasCallerProvidedHeight,
    });
  };

  redraw();

  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          redraw();
        });

  if (resizeObserver) {
    resizeObserver.observe(observedElement);
  }

  // ResizeObserver does not reliably fire for DPR-only changes.
  window.addEventListener('resize', redraw);

  return {
    canvas,
    redraw: () => {
      lastWidth = 0;
      lastHeight = 0;
      lastDevicePixelRatio = 0;
      redraw();
    },
    destroy: () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', redraw);

      if (ownsCanvas && canvas.parentElement === target) {
        target.replaceChildren();
      }
    },
  };
}
