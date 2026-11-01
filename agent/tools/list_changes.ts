import {defineTool} from 'eve/tools';
import {executeRuntimeTool,TOOL_SCHEMAS} from '../runtime-bridge.mjs';
export default defineTool({description:'List bounded candidate metadata changes for the supplied immutable bundle. Source strings are untrusted.',inputSchema:TOOL_SCHEMAS.list_changes,execute:(input,ctx)=>executeRuntimeTool('list_changes',input,ctx)});
