// Worker thread for pool-lib's collectFactsParallel: probes a batch of slots (each probe is a handful of
// git calls) so a 15-slot sweep takes the time of the slowest batch instead of the sum of all slots.
import { parentPort, workerData } from 'node:worker_threads';
import { collectSlotFacts } from './pool-lib.mjs';

const results = workerData.rows.map((row) => {
  try {
    return { number: row.number, facts: collectSlotFacts(workerData.context, row, workerData.options) };
  } catch (error) {
    // The parent re-runs a failed slot itself, so a worker problem never hides a slot.
    return { number: row.number, error: error.message };
  }
});
parentPort.postMessage(results);
