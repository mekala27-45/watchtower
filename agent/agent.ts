import {defineAgent,defineDynamic} from 'eve';
import {guardedModel} from './runtime-bridge.mjs';

export default defineAgent({
  model:defineDynamic(ctx=>guardedModel(ctx.session.id)),
  defaultTools:false,
  tool:false,
  reasoning:'none',
  limits:{sessionUsage:false,sessionTimeoutMs:60_000},
});
