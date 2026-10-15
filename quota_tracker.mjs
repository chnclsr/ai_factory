#!/usr/bin/env node
import { fetchAllQuotas, formatQuotaTable } from './src/quota_tracker.mjs';
import { pathToFileURL } from 'node:url';
export * from './src/quota_tracker.mjs';

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const data = await fetchAllQuotas({ force: process.argv.includes('--refresh') || process.argv.includes('-r') });
    console.log(process.argv.includes('--json') ? JSON.stringify(data, null, 2) : formatQuotaTable(data));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

