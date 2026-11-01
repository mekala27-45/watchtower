import {normalizeRelease,makeObservation,makeBundle} from './index.mjs';
export function loadFixtureObservations(fixture){
  return fixture.observations.map(observation=>observation===null?null:makeObservation({
    namespace:fixture.namespace,sourceId:fixture.source_id,state:observation.state,scope:observation.scope,
    items:observation.raw_items.map(raw=>normalizeRelease(raw,{namespace:fixture.namespace,sourceId:fixture.source_id})),
    coverage:{procedure_complete:observation.state==='captured',uncovered_scope:observation.uncovered_scope??(observation.state==='captured'?[]:['incomplete_observation'])}
  }));
}
export function loadFixtureBundle(fixture,{transition=1}={}){
  if(!Number.isInteger(transition)||transition<1||transition>=fixture.observations.length)throw new Error('invalid_transition');
  const observations=loadFixtureObservations({...fixture,observations:fixture.observations.slice(0,transition+1)});
  let comparison=observations[0];
  for(let i=1;i<transition;i++)if(observations[i]?.state==='captured')comparison=observations[i];
  return makeBundle(comparison,observations[transition],{watchlistVersion:'watchlist-v1'});
}

