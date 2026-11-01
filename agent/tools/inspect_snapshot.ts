import {defineTool} from 'eve/tools';
import {executeRuntimeTool,TOOL_SCHEMAS} from '../runtime-bridge.mjs';
export default defineTool({description:'Inspect one candidate before or after revision, returning exact evidence ID and bounded untrusted metadata.',inputSchema:TOOL_SCHEMAS.inspect_snapshot,execute:(input,ctx)=>executeRuntimeTool('inspect_snapshot',input,ctx)});
