import { MIN_NORMAL_GROSS_MARGIN } from './quotes.js';

const roundMoney=(v)=>Math.round((Number(v)+Number.EPSILON)*100)/100;
const ceilMoney=(v)=>Math.ceil((Number(v)+Number.EPSILON)*100)/100;
const norm=(v)=>String(v||'').trim().toLowerCase();
const num=(v)=>{if(v==null||v==='')return null;const n=Number(v);return Number.isFinite(n)?n:null};

function qualityScore(part){
  const s=norm(`${part.sourceTier||part.tier} ${part.partName} ${part.partType} ${part.notes}`);
  if(/premium|oem|original|genuine|refurb|refurbished|service pack/.test(s))return 3;
  if(/standard|soft oled|oled/.test(s))return 2;
  if(/budget|economy|lcd|incell|in-cell|hard oled|aftermarket/.test(s))return 1;
  return 2;
}

function compatible(part,device){
  const wanted=norm(device),found=norm(part.compatibility);
  return !wanted||!found||found.includes(wanted)||wanted.includes(found);
}

export function isTrustworthyOwnerPart(part,device){
  return part?.researchStatus==='Verified'
    && num(part.partCost)>0
    && /^https?:\/\//i.test(String(part.vendorUrl||''))
    && compatible(part,device);
}

export function tierEconomics(part){
  const unit=num(part?.partCost),shipping=num(part?.shipping);
  const stock=norm(part?.stockStatus);
  const unusable=!stock||/unknown|unverified|out of stock|unavailable|discontinued|backorder/.test(stock);
  if(unit==null||shipping==null||unusable)return {ready:false,total:null,partsCost:unit!=null&&shipping!=null?roundMoney(unit+shipping):null,partsPrice:null,laborPrice:null,otherFees:null,grossProfit:null,grossMargin:null,reason:unit==null?'Verified part price is missing.':shipping==null?'Verified shipping cost is missing.':'Verified usable stock/availability is missing.'};
  const cost=roundMoney(unit+shipping);
  const total=ceilMoney(cost/(1-MIN_NORMAL_GROSS_MARGIN));
  const grossProfit=roundMoney(total-cost);
  return {ready:true,total,partsCost:cost,partsPrice:cost,laborPrice:grossProfit,otherFees:0,grossProfit,grossMargin:total>0?grossProfit/total:0,reason:null};
}

export function normalizeOwnerPartTiers(parts,device){
  const trusted=parts.filter((p)=>isTrustworthyOwnerPart(p,device));
  if(!trusted.length)return [];
  const byCost=[...trusted].sort((a,b)=>a.partCost-b.partCost);
  if(byCost.length===1){const only=byCost[0];return [{...only,tier:'Medium',recommended:true,economics:tierEconomics(only)}]}
  const cheap=byCost[0];
  if(byCost.length===2){
    const second=byCost[1];
    const secondTier=qualityScore(second)>qualityScore(cheap)?'Expensive':'Medium';
    const recommendedId=(second.recommended||secondTier==='Medium')?second.id:cheap.id;
    return [{...cheap,tier:'Cheap',recommended:cheap.id===recommendedId,economics:tierEconomics(cheap)},{...second,tier:secondTier,recommended:second.id===recommendedId,economics:tierEconomics(second)}];
  }
  const expensive=[...trusted].filter((p)=>p.id!==cheap.id).sort((a,b)=>qualityScore(b)-qualityScore(a)||b.partCost-a.partCost)[0];
  const middlePool=trusted.filter((p)=>p.id!==cheap.id&&p.id!==expensive.id);
  const medium=middlePool.find((p)=>p.recommended)||middlePool.find((p)=>norm(p.sourceTier||p.tier)==='standard')||[...middlePool].sort((a,b)=>a.partCost-b.partCost)[Math.floor((middlePool.length-1)/2)];
  const recommendedId=medium?.id||trusted.find((p)=>p.recommended)?.id||cheap.id;
  return [{...cheap,tier:'Cheap',recommended:cheap.id===recommendedId,economics:tierEconomics(cheap)},...(medium?[{...medium,tier:'Medium',recommended:medium.id===recommendedId,economics:tierEconomics(medium)}]:[]),...(expensive?[{...expensive,tier:'Expensive',recommended:expensive.id===recommendedId,economics:tierEconomics(expensive)}]:[])];
}
