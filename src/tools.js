import { tool } from '@openai/agents';
import { z } from 'zod';
import { TABLES, createApproval, createRecord, getRecord, logActivity, readActiveControls, updateRecord } from './airtable.js';
import { assertTransition } from './state-machine.js';
import { createQuoteForJob } from './quotes.js';

export const getJobTool = tool({
  name: 'get_job',
  description: 'Read the current Airtable job/lead record by Airtable record ID before making operational decisions.',
  parameters: z.object({ recordId: z.string().min(1) }),
  async execute({ recordId }) {
    return getRecord(TABLES.JOBS, recordId);
  },
});

export const getControlsTool = tool({
  name: 'get_business_controls',
  description: 'Read active GhostOS owner rules, operating boundaries, goals, service area, vendor and payment policies.',
  parameters: z.object({}),
  async execute() {
    return readActiveControls();
  },
});

export const updateJobStateTool = tool({
  name: 'update_job_state',
  description: 'Move a job through the approved GhostOS state machine. Invalid jumps are rejected.',
  parameters: z.object({
    recordId: z.string().min(1),
    nextStatus: z.enum(['New Lead','Need Quote','Quoted','Awaiting Customer','Part Approval','Part Ordered','Scheduled','In Progress','Completed','Lost / Declined']),
    relayState: z.enum(['New','Need More Info','Ready to Quote','Part Research','Awaiting Owner','Awaiting Customer','Scheduled','Closed']).optional(),
    nextAction: z.string().max(10000).optional(),
    notes: z.string().max(10000).optional(),
  }),
  async execute({ recordId, nextStatus, relayState, nextAction, notes }) {
    const job = await getRecord(TABLES.JOBS, recordId);
    assertTransition(job.fields.Status, nextStatus);
    const fields = { Status: nextStatus };
    if (relayState) fields['RELAY State'] = relayState;
    if (nextAction) fields['RELAY Next Action'] = nextAction;
    if (notes) fields.Notes = [job.fields.Notes, notes].filter(Boolean).join('\n\n').slice(0, 90000);
    const updated = await updateRecord(TABLES.JOBS, recordId, fields);
    await logActivity({ agent: 'ATLAS', jobId: recordId, actionType: 'job_state_changed', detail: `${job.fields.Status || '(none)'} -> ${nextStatus}` });
    return updated;
  },
});

export const saveRelayDraftTool = tool({
  name: 'save_relay_draft',
  description: 'Save a routine customer-facing draft and next action to Airtable. This does not claim the message was externally sent.',
  parameters: z.object({
    recordId: z.string().min(1),
    reply: z.string().min(1).max(20000),
    nextAction: z.string().min(1).max(10000),
    relayState: z.enum(['New','Need More Info','Ready to Quote','Part Research','Awaiting Owner','Awaiting Customer','Scheduled','Closed']),
  }),
  async execute({ recordId, reply, nextAction, relayState }) {
    const updated = await updateRecord(TABLES.JOBS, recordId, {
      'RELAY Reply Draft': reply,
      'RELAY Next Action': nextAction,
      'RELAY State': relayState,
    });
    await logActivity({ agent: 'RELAY', jobId: recordId, actionType: 'customer_reply_drafted', detail: reply });
    return updated;
  },
});

const researchedPartSchema = z.object({
  tier: z.enum(['Budget', 'Standard', 'Premium']),
  partOrSku: z.string().min(1).max(250),
  device: z.string().max(250).optional(),
  partType: z.string().max(250).optional(),
  vendor: z.string().min(1).max(250),
  vendorUrl: z.string().url(),
  unitCost: z.number().nonnegative(),
  shipping: z.number().nonnegative().default(0),
  stockStatus: z.string().max(250),
  verified: z.boolean(),
  notes: z.string().max(10000).optional(),
  recommended: z.boolean().default(false),
});

export const storeSupplyResultsTool = tool({
  name: 'store_supply_results',
  description: 'Persist verified or explicitly unverified SUPPLY part research into Parts & Inventory. Never use this tool to purchase or reserve a part.',
  parameters: z.object({
    jobId: z.string().min(1),
    parts: z.array(researchedPartSchema).min(1).max(3),
  }),
  async execute({ jobId, parts }) {
    const stamp = new Date().toISOString();
    const created = [];
    for (const part of parts) {
      created.push(await createRecord(TABLES.PARTS, {
        'Part / SKU': part.partOrSku,
        Job: [jobId],
        Device: part.device || '',
        'Part Type': part.partType || '',
        Vendor: part.vendor,
        'Vendor URL': part.vendorUrl,
        'Unit Cost': part.unitCost,
        Shipping: part.shipping,
        'Purchase Status': part.recommended ? 'Approval Needed' : 'Researching',
        'Research Tier': part.tier,
        'Research Status': part.verified ? 'Verified' : 'Unverified',
        'Stock Status': part.stockStatus,
        'Researched At': stamp,
        Recommended: part.recommended,
        Notes: part.notes || '',
      }));
    }
    await updateRecord(TABLES.JOBS, jobId, {
      'RELAY State': 'Part Research',
      'RELAY Next Action': 'Review stored SUPPLY options and generate a quote from verified economics.',
    });
    await logActivity({ agent: 'SUPPLY', jobId, actionType: 'parts_research_stored', detail: `${created.length} option(s) stored.` });
    return created;
  },
});

export const createQuoteTool = tool({
  name: 'create_quote',
  description: 'Create a quote from verified job and parts numbers. Deterministically calculates total, expected gross profit and margin, and creates owner approval only when required.',
  parameters: z.object({
    jobId: z.string().min(1),
    jobName: z.string().max(250).optional(),
    laborPrice: z.number().nonnegative(),
    partsPrice: z.number().nonnegative(),
    otherFees: z.number().nonnegative().default(0),
    partsCost: z.number().nonnegative(),
    recommendedPartSummary: z.string().max(20000).optional(),
    customerMessage: z.string().min(1).max(20000),
    internalNotes: z.string().max(20000).optional(),
    pricingException: z.boolean().default(false),
    purchaseRequired: z.boolean().default(false),
  }),
  async execute(args) {
    return createQuoteForJob(args);
  },
});

export const requestOwnerApprovalTool = tool({
  name: 'request_owner_approval',
  description: 'Create an Owner Inbox item only for consequential actions: purchase, pricing exception, refund, contract, material ad spend, scheduling exception, or unusual external commitment.',
  parameters: z.object({
    type: z.enum(['Purchase','Pricing Exception','Refund','Contract','Ad Spend','Scheduling Exception','Other']),
    jobId: z.string().optional(),
    quoteId: z.string().optional(),
    amount: z.number().nonnegative().optional(),
    summary: z.string().min(1).max(10000),
    requestedAction: z.string().min(1).max(10000),
    requestedBy: z.enum(['ATLAS','SUPPLY','LEDGER','DISPATCH','RELAY']).default('ATLAS'),
  }),
  async execute(args) {
    return createApproval(args);
  },
});
