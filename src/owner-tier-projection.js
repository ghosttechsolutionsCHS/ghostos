import { normalizeOwnerPartTiers } from './owner-part-tiers.js';

const linked=(row,jobId)=>Array.isArray(row?.fields?.Job)&&row.fields.Job.includes(jobId);
const n=(v)=>v==null||v===''?null:Number(v);
function part(row){const f=row.fields||{};return{id:row.id,partName:f['Part / SKU']||'',compatibility:f.Device||f.Compatibility||'',vendor:f.Vendor||'',vendorUrl:f['Vendor URL']||'',sourceTier:f['Research Tier']||'',partType:f['Part Type']||'',partCost:Number.isFinite(n(f['Unit Cost']))?n(f['Unit Cost']):null,shipping:Number.isFinite(n(f.Shipping))?n(f.Shipping):null,shippingInfo:f['Shipping Info']||'',stockStatus:f['Stock Status']||'UNKNOWN',researchStatus:f['Research Status']||'UNVERIFIED',recommended:Boolean(f.Recommended),verifiedAt:f['Researched At']||row.createdTime||null,notes:f.Notes||''}}
export function ownerTiersForJob(job,parts=[]){return normalizeOwnerPartTiers(parts.filter((p)=>linked(p,job.id)).map(part),job.fields?.['Device / Service'])}
