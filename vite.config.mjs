import {defineConfig} from 'vite';
import {publicRuntimeConfig} from './apps/site/runtime-config.mjs';

const config=publicRuntimeConfig(process.env.WATCHTOWER_PUBLIC_API_ORIGIN||'',{allowLocal:process.env.WATCHTOWER_ALLOW_LOCAL_API==='1'});
export default defineConfig({
  root:'apps/site',
  base:'./',
  publicDir:false,
  build:{outDir:'../../dist/site',emptyOutDir:true,assetsInlineLimit:0,sourcemap:false},
  plugins:[{
    name:'watchtower-public-origin',
    transformIndexHtml(html){return html.replace('<html lang="en"',`<html lang="en" data-api-base="${config.apiOrigin}"`);}
  }]
});
