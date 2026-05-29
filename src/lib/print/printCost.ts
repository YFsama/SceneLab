import type { SolidBody } from '../geometry/types';
import { estimatePrintJob } from './printJob';
import type { PrintJobOptions } from './printJob';

export interface PrintCostOptions extends PrintJobOptions {
  /** Filament/resin price per kilogram. Default 25. */
  pricePerKg?: number;
  /** Machine + labour rate per hour. Default 0 (material only). */
  hourlyRate?: number;
}

export interface PrintCostEstimate {
  filamentMassG: number;
  printTimeMinutes: number;
  materialCost: number;
  machineCost: number;
  totalCost: number;
  pricePerKg: number;
  hourlyRate: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Estimate the cost of a print: material (mass × price/kg) plus machine time
 * (print time × hourly rate). Builds on estimatePrintJob, so infill, wall
 * thickness and material flow through.
 */
export function estimatePrintCost(body: SolidBody, options: PrintCostOptions = {}): PrintCostEstimate {
  const pricePerKg = options.pricePerKg ?? 25;
  const hourlyRate = options.hourlyRate ?? 0;

  const job = estimatePrintJob(body, options);
  const materialCost = (job.filamentMassG / 1000) * pricePerKg;
  const machineCost = (job.printTimeMinutes / 60) * hourlyRate;

  return {
    filamentMassG: round2(job.filamentMassG),
    printTimeMinutes: round2(job.printTimeMinutes),
    materialCost: round2(materialCost),
    machineCost: round2(machineCost),
    totalCost: round2(materialCost + machineCost),
    pricePerKg,
    hourlyRate,
  };
}
