import test from 'node:test';
import assert from 'node:assert/strict';
import { getManagedGoogleRegistry, assertManagedGoogleTarget, validateExecutionSpec, MARKETING_AUTH } from '../src/marketing-execution.js';

function row(id,action,payload,providerId,completedAt='2026-09-15T12:00:00.000Z',extra={}){
  return {id,fields:{'Execution Connector':'google_ads','Execution Status':'Completed','Execution Action':action,'Execution Payload JSON':JSON.stringify(payload),'Provider Object ID':providerId,'Execution Completed At':completedAt,...extra}};
}

test('registry contains only provider-confirmed GhostOS-created campaigns and ad groups',()=>{
  const rows=[
    row('rec1','create_campaign',{budget_amount_micros:10_000_000,status:'paused'},'camp-1'),
    row('rec2','create_ad_group',{campaign_id:'camp-1'},'ag-1'),
    row('rec3','enable_campaign',{campaign_id:'camp-1'},'enable-result','2026-09-16T12:00:00.000Z'),
    {id:'other',fields:{'Execution Connector':'google_ads','Execution Status':'Failed — Owner Attention','Execution Action':'create_campaign','Provider Object ID':'camp-unconfirmed','Execution Payload JSON':'{}'}},
  ];
  const reg=getManagedGoogleRegistry(rows);
  assert.deepEqual([...reg.campaignIds],['camp-1']);
  assert.deepEqual([...reg.adGroupIds],['ag-1']);
  assert.equal(reg.campaigns.get('camp-1').firstEnabledAt,'2026-09-16T12:00:00.000Z');
});

test('unrelated existing Google Ads campaigns and ad groups are blocked',()=>{
  const reg=getManagedGoogleRegistry([row('rec1','create_campaign',{budget_amount_micros:10_000_000,status:'paused'},'camp-1'),row('rec2','create_ad_group',{campaign_id:'camp-1'},'ag-1')]);
  assert.throws(()=>assertManagedGoogleTarget('set_campaign_budget',{campaign_id:'unrelated',budget_type:'daily',amount_micros:5_000_000},reg),/not registered as GhostOS-managed/);
  assert.throws(()=>assertManagedGoogleTarget('push_keywords',{ad_group_id:'unrelated',keywords:[{text:'business it'}]},reg),/ad group not registered as GhostOS-managed/);
  assert.doesNotThrow(()=>assertManagedGoogleTarget('set_campaign_budget',{campaign_id:'camp-1',budget_type:'daily',amount_micros:5_000_000},reg));
  assert.doesNotThrow(()=>assertManagedGoogleTarget('push_keywords',{ad_group_id:'ag-1',keywords:[{text:'business it'}]},reg));
});

test('configured average daily budget cannot exceed $10 and campaign starts paused',()=>{
  assert.equal(MARKETING_AUTH.configuredAverageDailyBudgetMaxUsd,10);
  assert.throws(()=>validateExecutionSpec({connector:'google_ads',action:'create_campaign',payload:{budget_amount_micros:10_000_001,status:'paused'}}),/above \$10\/day/);
  assert.throws(()=>validateExecutionSpec({connector:'google_ads',action:'create_campaign',payload:{budget_amount_micros:10_000_000,status:'enabled'}}),/must be paused/);
  assert.doesNotThrow(()=>validateExecutionSpec({connector:'google_ads',action:'create_campaign',payload:{budget_amount_micros:10_000_000,status:'paused'}}));
});

test('geo writes cannot expand beyond the authorized proximity radius',()=>{
  assert.throws(()=>validateExecutionSpec({connector:'google_ads',action:'set_campaign_geo_targeting',payload:{campaign_id:'camp-1',locations:[{geo_target_constant_id:'2840',negative:false}],proximities:[{latitude:32.8,longitude:-80,radius:25,radius_units:'MILES'}]}}),/positive broad location targets are blocked/);
  assert.throws(()=>validateExecutionSpec({connector:'google_ads',action:'set_campaign_geo_targeting',payload:{campaign_id:'camp-1',locations:[],proximities:[{latitude:32.8,longitude:-80,radius:26,radius_units:'MILES'}]}}),/above 25 miles/);
  assert.doesNotThrow(()=>validateExecutionSpec({connector:'google_ads',action:'set_campaign_geo_targeting',payload:{campaign_id:'camp-1',locations:[],proximities:[{latitude:32.8,longitude:-80,radius:25,radius_units:'MILES'}]}}));
});

test('spend-guard pause marker prevents a lagging provider status from being treated as active by registry consumers',()=>{
  const reg=getManagedGoogleRegistry([row('rec1','create_campaign',{budget_amount_micros:10_000_000,status:'paused'},'camp-1','2026-09-15T12:00:00.000Z',{'Spend Guard Paused At':'2026-09-17T12:00:00.000Z'}),row('rec2','enable_campaign',{campaign_id:'camp-1'},'enable-result','2026-09-16T12:00:00.000Z')]);
  assert.equal(reg.campaigns.get('camp-1').spendGuardPausedAt,'2026-09-17T12:00:00.000Z');
});
