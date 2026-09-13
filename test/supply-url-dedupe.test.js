import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLES } from '../src/airtable.js';
import { createSupplyStore } from '../src/supply.js';

test('SUPPLY refreshes same canonical product URL even when AI product title punctuation changes', async () => {
  const rows = [];
  const job = { id:'job1', fields:{} };
  const deps = {
    now: () => '2026-09-13T04:15:00.000Z',
    listRecords: async (table) => table === TABLES.PARTS ? rows : [],
    createRecord: async (table, fields) => {
      assert.equal(table, TABLES.PARTS);
      const row = { id:`part${rows.length+1}`, fields:{ ...fields } };
      rows.push(row);
      return row;
    },
    updateRecord: async (table, id, fields) => {
      if (table === TABLES.JOBS) { Object.assign(job.fields, fields); return job; }
      const row = rows.find((item) => item.id === id);
      Object.assign(row.fields, fields);
      return row;
    },
    logActivity: async () => ({ id:'activity' }),
  };
  const store = createSupplyStore(deps);
  const url = 'https://www.injuredgadgets.com/premium-refurbished-oled-screen-and-digitizer-assembly-for-iphone-17-pro-max-black/';

  await store.store(job.id, [{
    tier:'Standard', partOrSku:'Premium Refurbished OLED Screen and Digitizer Assembly for iPhone 17 Pro Max (Black)',
    compatibility:'iPhone 17 Pro Max', vendor:'Injured Gadgets', vendorUrl:url, stockStatus:'UNKNOWN', verified:true,
  }]);
  await store.store(job.id, [{
    tier:'Standard', partOrSku:'Premium Refurbished - OLED Screen and Digitizer Assembly for iPhone 17 Pro Max (Black)',
    compatibility:'iPhone 17 Pro Max', vendor:'Injured Gadgets', vendorUrl:url.replace(/\/$/, ''), stockStatus:'UNKNOWN', verified:true,
  }]);

  assert.equal(rows.length, 1);
  assert.match(rows[0].fields['Part / SKU'], /Premium Refurbished - OLED/);
  assert.equal(rows[0].fields['Vendor URL'], url.replace(/\/$/, ''));
});
