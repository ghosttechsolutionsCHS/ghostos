import { tool } from '@openai/agents';
import { z } from 'zod';
import { TABLES, createApproval, createRecord, listRecords, logActivity } from './airtable.js';
import { createBuilderRequest } from './builder.js';

const GROWTH_AGENTS = ['FORGE','ECHO','SCOUT','BEACON','HORIZON'];

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function clean(value, max = 30000) { return String(value || '').slice(0, max); }

export async function getGrowthSnapshot() {
  const [channels, jobs, opportunities, work] = await Promise.all([
    listRecords(TABLES.MARKETING, { maxRecords: 200 }),
    listRecords(TABLES.JOBS, { maxRecords: 500 }),
    listRecords(TABLES.GROWTH, { maxRecords: 250 }),
    listRecords(TABLES.GROWTH_WORK, { maxRecords: 250 }),
  ]);
  const channelMetrics = channels.map((row) => {
    const f = row.fields || {};
    const spend = num(f.Spend), leads = num(f.Leads), completedJobs = num(f['Completed Jobs']);
    const revenue = num(f.Revenue), grossProfit = num(f['Gross Contribution']);
    const cac = completedJobs > 0 ? spend / completedJobs : null;
    const profitAfterSpend = grossProfit - spend;
    return {
      id: row.id, channel: f['Channel / Campaign'] || row.id, platform: f.Platform || '', paidOrFree: f['Paid or Free'] || '', status: f.Status || '',
      spend, leads, bookings: num(f.Bookings), completedJobs, revenue, grossProfit, cac, profitAfterSpend,
      profitable: completedJobs > 0 ? profitAfterSpend > 0 : null, nextAction: f['Next Action'] || '', learnings: f.Learnings || '',
    };
  });
  const completedJobs = jobs.filter((j) => j.fields.Status === 'Completed');
  return {
    channels: channelMetrics,
    totals: channelMetrics.reduce((a, c) => ({ spend:a.spend+c.spend, leads:a.leads+c.leads, completedJobs:a.completedJobs+c.completedJobs, revenue:a.revenue+c.revenue, grossProfit:a.grossProfit+c.grossProfit, profitAfterSpend:a.profitAfterSpend+c.profitAfterSpend }), { spend:0, leads:0, completedJobs:0, revenue:0, grossProfit:0, profitAfterSpend:0 }),
    attribution: jobs.slice(0, 300).map((j) => ({ id:j.id, status:j.fields.Status, leadSource:j.fields['Lead Source'] || '', utmSource:j.fields['UTM Source'] || '', utmMedium:j.fields['UTM Medium'] || '', utmCampaign:j.fields['UTM Campaign'] || '', revenue:num(j.fields['Revenue Collected']), grossProfit:num(j.fields['Gross Profit']) })),
    business: { totalJobs: jobs.length, completedJobs: completedJobs.length, completedRevenue: completedJobs.reduce((s,j)=>s+num(j.fields['Revenue Collected']),0), completedGrossProfit: completedJobs.reduce((s,j)=>s+num(j.fields['Gross Profit']),0) },
    opportunities: opportunities.slice(0, 100), work: work.slice(0, 120),
  };
}

export const getGrowthDataTool = tool({
  name: 'get_growth_data',
  description: 'Read stored Ghost Tech marketing channels, attribution, completed-job economics, growth opportunities and existing Growth Work. No external action occurs.',
  parameters: z.object({}), async execute() { return getGrowthSnapshot(); },
});

export const saveGrowthWorkTool = tool({
  name: 'save_growth_work',
  description: 'Save a Growth Division analysis, content/outreach draft, SEO recommendation, or partnership brief for owner review. This never publishes, messages, spends, signs, or changes an external system.',
  parameters: z.object({
    agent: z.enum(GROWTH_AGENTS),
    workType: z.enum(['Marketing Analysis','Content Draft','Content Calendar','Free Acquisition','SEO / Website','Partnership Brief','Outreach Draft','Executive Input']),
    title: z.string().min(3).max(250), currentTask: z.string().max(10000).optional(), latestResult: z.string().min(1).max(30000), nextAction: z.string().max(10000).optional(), evidence: z.string().max(30000).optional(), draftContent: z.string().max(30000).optional(), channelOrPartner: z.string().max(500).optional(), urlOrContact: z.string().url().optional(),
    leads: z.number().nonnegative().optional(), completedJobs: z.number().nonnegative().optional(), revenue: z.number().optional(), grossProfit: z.number().optional(), spend: z.number().nonnegative().optional(), cac: z.number().nonnegative().nullable().optional(), profitAfterSpend: z.number().optional(),
    ownerApprovalRequired: z.boolean().default(false), approvalType: z.enum(['Ad Spend','Contract','Other']).optional(), requestedAction: z.string().max(10000).optional(),
  }),
  async execute(args) {
    const now = new Date().toISOString();
    const record = await createRecord(TABLES.GROWTH_WORK, {
      'Growth Item': args.title, Agent: args.agent, 'Work Type': args.workType, Status: args.ownerApprovalRequired ? 'Needs Owner' : 'Ready for Owner',
      'Current Task': args.currentTask || '', 'Latest Result': args.latestResult, 'Next Action': args.nextAction || '', 'Evidence / Context': args.evidence || '', 'Draft Content': args.draftContent || '', 'Channel / Partner': args.channelOrPartner || '', 'URL / Contact': args.urlOrContact,
      Leads: args.leads, 'Completed Jobs': args.completedJobs, Revenue: args.revenue, 'Gross Profit': args.grossProfit, Spend: args.spend, CAC: args.cac === null ? undefined : args.cac, 'Profit After Spend': args.profitAfterSpend,
      'Owner Approval Required': args.ownerApprovalRequired, 'Created At': now, 'Updated At': now,
    });
    await logActivity({ agent: args.agent, actionType: 'growth_work_saved', status: args.ownerApprovalRequired ? 'Blocked' : 'Done', detail: `${args.workType}: ${args.title}${args.nextAction ? ` | next: ${clean(args.nextAction, 1000)}` : ''}`, consequential: args.ownerApprovalRequired });
    if (args.ownerApprovalRequired) {
      await createApproval({ type: args.approvalType || 'Other', summary: `${args.agent}: ${args.title}`, requestedAction: args.requestedAction || args.nextAction || 'Review the consequential growth recommendation.', requestedBy: args.agent });
    }
    return { id: record.id, status: record.fields.Status, externalActionTaken: false };
  },
});

export const beaconBuilderTool = tool({
  name: 'queue_site_builder_request',
  description: 'Queue a technical website/SEO implementation request into existing BUILDER controls. This does not modify production; BUILDER v2/v3 approval/branch/CI/merge guardrails remain in force.',
  parameters: z.object({ goal: z.string().min(5).max(20000), context: z.string().max(30000).optional(), priority: z.enum(['Critical','High','Normal','Low']).default('Normal') }),
  async execute({ goal, context, priority }) {
    const request = await createBuilderRequest({ goal, context, priority, requestedBy: 'BEACON' });
    await logActivity({ agent: 'BEACON', actionType: 'site_builder_request_queued', detail: `Builder Request ${request.id}: ${clean(goal, 800)}` });
    return { requestId: request.id, productionChanged: false };
  },
});

export const forge = {
  name: 'FORGE', tools: [getGrowthDataTool, saveGrowthWorkTool],
  instructions: `You are FORGE, Paid Marketing for Ghost Tech Solutions. Analyze only stored marketing/ad performance supplied by get_growth_data. Calculate and discuss leads, completed jobs, revenue, gross profit, CAC (spend divided by completed jobs when completed jobs > 0), and profit after spend. Measure success by profitable completed jobs, never clicks/impressions. Make missing data explicit. Recommend campaign/budget changes, but NEVER increase spend, launch/pause ads, alter budgets, or claim an ad action happened. Any material spend recommendation must be saved with ownerApprovalRequired=true and approvalType=Ad Spend. Save useful analysis to Growth Work.`
};

export const echo = {
  name: 'ECHO', tools: [getGrowthDataTool, saveGrowthWorkTool],
  instructions: `You are ECHO, Social Media / Content for Ghost Tech Solutions. Use actual Ghost Tech services, stored jobs/business context, and verified facts to create content ideas, captions, offers and posting calendars. Never fabricate reviews, customer stories, outcomes, job details, before/after results, or testimonials. Never autonomously publish or claim something was posted. Save drafts/calendars to Growth Work for owner review.`
};

export const scout = {
  name: 'SCOUT', webSearch: true, tools: [getGrowthDataTool, saveGrowthWorkTool],
  instructions: `You are SCOUT, Free Customer Acquisition for Ghost Tech Solutions in the Charleston, South Carolina market. Identify legitimate free/local acquisition opportunities such as appropriate directories, local/community groups, referral opportunities and local channels. Verify live opportunities on the web when possible. Respect platform/group rules; explicitly note uncertainty about posting rules. No spam, scraping-based blasts, mass unsolicited outreach, fake engagement, or automatic posting. Prepare outreach/post drafts only and save worthwhile opportunities to Growth Work.`
};

export const beacon = {
  name: 'BEACON', webSearch: true, tools: [getGrowthDataTool, saveGrowthWorkTool, beaconBuilderTool],
  instructions: `You are BEACON, Website + SEO for Ghost Tech Solutions. Analyze available website/lead attribution, service-page opportunities, SEO, conversion friction and customer acquisition paths using supplied data and live public web evidence when relevant. Produce prioritized recommendations. You may queue a Builder Request for technical site improvements using queue_site_builder_request, but NEVER modify production directly or bypass BUILDER controls. Never claim a site change or ranking improvement occurred without connected-system confirmation.`
};

export const horizon = {
  name: 'HORIZON', webSearch: true, tools: [getGrowthDataTool, saveGrowthWorkTool],
  instructions: `You are HORIZON, Growth / Partnerships for Ghost Tech Solutions. Identify and track credible B2B/referral partners such as restaurants, small businesses, property managers, cafes, hotels, taxi/transportation companies and local businesses needing ongoing tech support. Use live public evidence when finding real businesses. Produce partnership briefs and owner-review outreach drafts. Never claim outreach occurred. Never negotiate, agree to terms, sign, or create a contract/deal. Any proposed contract or binding partnership action must be saved with ownerApprovalRequired=true and approvalType=Contract.`
};

export const growthAgents = { FORGE: forge, ECHO: echo, SCOUT: scout, BEACON: beacon, HORIZON: horizon };
