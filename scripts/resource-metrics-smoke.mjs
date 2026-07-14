import assert from 'node:assert/strict';
import { calculateNetworkRates, javaMemoryEnvironment } from '../build/agent/docker.js';

assert.deepEqual(javaMemoryEnvironment(16384), ['INIT_MEMORY=2048M', 'MAX_MEMORY=13107M']);
assert.deepEqual(javaMemoryEnvironment(1024), ['INIT_MEMORY=512M', 'MAX_MEMORY=819M']);

assert.deepEqual(calculateNetworkRates(
  { rxBytes: 5000, txBytes: 3000, measuredAt: 3000 },
  { rxBytes: 1000, txBytes: 2000, measuredAt: 1000 },
), { rxBytesPerSecond: 2000, txBytesPerSecond: 500 });
assert.deepEqual(calculateNetworkRates({ rxBytes: 5000, txBytes: 3000, measuredAt: 3000 }), { rxBytesPerSecond: 0, txBytesPerSecond: 0 });
assert.deepEqual(calculateNetworkRates(
  { rxBytes: 10, txBytes: 10, measuredAt: 4000 },
  { rxBytes: 5000, txBytes: 3000, measuredAt: 3000 },
), { rxBytesPerSecond: 0, txBytesPerSecond: 0 });

console.log('Resource metrics smoke test passed: adaptive Java heap and network rates are correct.');
