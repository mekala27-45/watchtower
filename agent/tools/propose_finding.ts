import {defineTool} from 'eve/tools';
import {executeRuntimeTool,TOOL_SCHEMAS} from '../runtime-bridge.mjs';
export default defineTool({description:'Append an UNAPPROVED factual proposal with exact inspected evidence IDs. This cannot approve or publish.',inputSchema:TOOL_SCHEMAS.propose_finding,endsTurn:true,execute:(input,ctx)=>executeRuntimeTool('propose_finding',input,ctx)});
