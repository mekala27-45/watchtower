import {build} from 'vite';
import {copyFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
await build({configFile:resolve(root,'vite.config.mjs')});
await mkdir(resolve(root,'dist/site/licenses'),{recursive:true});
for(const family of ['bodoni-moda','noto-sans','fira-mono']) {
  await copyFile(resolve(root,`apps/site/fonts/${family}-LICENSE.txt`),resolve(root,`dist/site/licenses/${family}.txt`));
}
await copyFile(resolve(root,'apps/site/fonts/provenance.json'),resolve(root,'dist/site/licenses/font-provenance.json'));
await writeFile(resolve(root,'dist/site/.nojekyll'),'');
await writeFile(resolve(root,'dist/site/build.json'),JSON.stringify({schema:'watchtower-site-build-v1',revision:process.env.BUILD_REVISION||execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),apiOrigin:process.env.WATCHTOWER_PUBLIC_API_ORIGIN||'same-origin',build:'vite',licenseDirectory:'./licenses/'},null,2)+'\n');
