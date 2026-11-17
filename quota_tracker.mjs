#!/usr/bin/env node
import { fetchAllQuotas, formatQuotaTable, formatQuotaChip } from './src/quota_tracker.mjs';
import { pathToFileURL } from 'node:url';
export * from './src/quota_tracker.mjs';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const data = await fetchAllQuotas({ force: process.argv.includes('--refresh') || process.argv.includes('-r') });
    if (process.argv.includes('--json')) console.log(JSON.stringify(data, null, 2));
    else if (process.argv.includes('--chip')) console.log(formatQuotaChip(data));
    else console.log(formatQuotaTable(data));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

