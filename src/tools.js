import { tool } from '@openai/agents';
import { z } from 'zod';
import { TABLES, createApproval, getRecord, logActivity, readActiveControls, updateRecord } from './airtable.js';
import { assertTransition } from './state-machine.js';
import { createQuoteForJob } from './quotes.js';
import { createRelayDraft } from './relay-delivery.js';
import { createBuilderRequest } from './builder.js';
import { storeSupplyResults } from './supply.js';

export const getJobTool = tool({
  name: 'get_job',
  description: 'Read the current Airtable job/lead record by Airtable record ID before making operational decisions.',
  parameters: z.object({ recordId: z.string().min(1) }),
  async execute({ recordId }) { return getRecord(TABLES.JOBS, recordId); },
});

export const getControlsTool = tool({
  name: 'get_business_controls',
  description: 'Read active GhostOS owner rules, operating boundaries, goals, service area, vendor and payment policies.',
  parameters: z.object({}),
  async execute() { return readActiveControls(); },
});

export const updateJobStateTool = tool({
  name: 'update_job_state',
  description: 'Move a job through the approved GhostOS state machine. Invalid jumps are rejected.',
  parameters: z.object({ recordId: z.string().min(1), nextStatus: z.enum(['New Lead','Need Quote','Quoted','Awaiting Customer','Part Approval','Part Ordered','Scheduled','In Progress','Completed','Lost / Declined']), relayState: z.enum(['New','Need More Info','Ready to Quote','Part Research','Awaiting Owner','Awaiting Customer','Scheduled','Closed']).optional(), nextAction: z.string().max(10000).optional(), notes: z.string().max(10000).optional() }),
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
  description: 'Create a customer-facing RELAY draft in Airtable for owner review. This tool can never send a message. The owner edits/copies the text in the dashboard, sends it personally from their phone, then manually marks it sent.',
  parameters: z.object({ recordId: z.string().min(1), reply: z.string().min(1).max(20000), messageType: z.enum(['clarification','quote','follow_up','status_update','scheduling_question']).default('follow_up'), channel: z.enum(['sms','email','auto']).default('sms'), relayState: z.enum(['New','Need More Info','Ready to Quote','Part Research','Awaiting Owner','Awaiting Customer','Scheduled','Closed']).optional(), nextAction: z.string().max(10000).optional() }),
  async execute({ recordId, reply, messageType, channel, relayState, nextAction }) {
    const draft = await createRelayDraft({ jobId: recordId, message: reply, messageType, channel });
    const fields = {};
    if (relayState) fields['RELAY State'] = relayState;
    if (nextAction) fields['RELAY Next Action'] = nextAction;
    if (Object.keys(fields).length) await updateRecord(TABLES.JOBS, recordId, fields);
    return { draftId: draft.id, status: draft.fields?.Status || 'Pending', message: 'Draft saved for owner review/copy. No customer message was sent.' };
  },
});

const researchedPartSchema = z.object({
  tier: z.enum(['Budget', 'Standard', 'Premium']),
  partOrSku: z.string().min(1).max(250),
  compatibility: z.string().max(500).optional(),
  device: z.string().max(250).optional(),
  partType: z.string().max(250).optional(),
  vendor: z.string().min(1).max(250),
  vendorUrl: z.string().url().nullable().optional(),
  unitCost: z.number().nonnegative().nullable().optional(),
  shipping: z.number().nonnegative().nullable().optional(),
  shippingInfo: z.string().max(1000).optional(),
  stockStatus: z.string().max(250).default('UNKNOWN'),
  verified: z.boolean(),
  notes: z.string().max(10000).optional(),
  recommended: z.boolean().default(false),
});

export const storeSupplyResultsTool = tool({
  name: 'store_supply_results',
  description: 'Persist SUPPLY research into Parts & Inventory. Missing facts must remain UNKNOWN/UNVERIFIED; never invent price, URL, compatibility, stock or shipping. This tool never purchases or reserves parts and deduplicates repeated research for the same job/part/tier/vendor.',
  parameters: z.object({ jobId: z.string().min(1), parts: z.array(researchedPartSchema).min(1).max(3) }),
  async execute({ jobId, parts }) { return storeSupplyResults(jobId, parts); },
});

export const createQuoteTool = tool({
  name: 'create_quote',
  description: 'Create a quote from verified job and parts numbers. Deterministically calculates total, expected gross profit and margin, and creates owner approval only when required.',
  parameters: z.object({ jobId: z.string().min(1), jobName: z.string().max(250).optional(), laborPrice: z.number().nonnegative(), partsPrice: z.number().nonnegative(), otherFees: z.number().nonnegative().default(0), partsCost: z.number().nonnegative(), recommendedPartSummary: z.string().max(20000).optional(), customerMessage: z.string().min(1).max(20000), internalNotes: z.string().max(20000).optional(), pricingException: z.boolean().default(false), purchaseRequired: z.boolean().default(false) }),
  async execute(args) { return createQuoteForJob(args); },
});

export const requestOwnerApprovalTool = tool({
  name: 'request_owner_approval',
  description: 'Create an Owner Inbox item only for consequential actions: purchase, pricing exception, refund, contract, material ad spend, scheduling exception, or unusual external commitment. Routine customer drafts never belong in Owner Inbox.',
  parameters: z.object({ type: z.enum(['Purchase','Pricing Exception','Refund','Contract','Ad Spend','Scheduling Exception','Other']), jobId: z.string().optional(), quoteId: z.string().optional(), amount: z.number().nonnegative().optional(), summary: z.string().min(1).max(10000), requestedAction: z.string().min(1).max(10000), requestedBy: z.enum(['ATLAS','SUPPLY','LEDGER','DISPATCH','RELAY']).default('ATLAS') }),
  async execute(args) { return createApproval(args); },
});

export const requestBuilderWorkTool = tool({
  name: 'request_builder_work',
  description: 'Queue a non-urgent internal software/system improvement for BUILDER. This creates an engineering backlog item only; it does not modify code, deploy, or create Owner Inbox noise.',
  parameters: z.object({ goal: z.string().min(5).max(20000), context: z.string().max(30000).optional(), priority: z.enum(['Critical','High','Normal','Low']).default('Normal') }),
  async execute({ goal, context, priority }) { return createBuilderRequest({ goal, context, priority, requestedBy: 'ATLAS' }); },
});
