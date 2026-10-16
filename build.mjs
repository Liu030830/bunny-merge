import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {parse} from 'acorn';

const work = path.dirname(fileURLToPath(import.meta.url));
const source = work;
const result = await build({
  entryPoints: [path.join(source, 'app.mjs')],
  bundle: true, format: 'iife', platform: 'browser', target: ['safari11','es2017'],
  minify: true, charset: 'utf8', legalComments: 'inline', write: false,
});
const code = result.outputFiles[0].text;
parse(code, {ecmaVersion:2017, sourceType:'script'});

const data = {};
for (const file of ['rabbits-01.png','rabbits-02.png','rabbits-03.png']) {
  data['./assets/'+file] = 'data:image/png;base64,' + (await fs.readFile(path.join(source, 'assets', file))).toString('base64');
}
const css = await fs.readFile(path.join(source, 'style.css'), 'utf8');
const guard = await fs.readFile(path.join(work, 'boot-guard.js'), 'utf8');
const icon = 'data:image/svg+xml;base64,'+(await fs.readFile(path.join(source, 'icon.svg'))).toString('base64');
let html = await fs.readFile(path.join(work, 'index.template.html'), 'utf8');
html = html.replace('<link rel="stylesheet" href="./style.css">', () => '<style>'+css+'</style>')
  .replace('<title>', '<meta name="bunny-build" content="2026-10-17-soft-impact-v5"><title>')
  .replace(/\s*<link rel="preload" as="image"[^>]+>/g, '')
  .replaceAll('href="./icon.svg"', 'href="'+icon+'"')
  .replace('<body>', () => '<body>\n<script>'+guard+'</script>')
  .replace('<span class="welcome-hint">', '<span id="load-status" class="welcome-hint">')
  .replace('<script type="module" src="./app.mjs"></script>',
    () => '<script>window.__BUNNY_ASSET_DATA__='+JSON.stringify(data)+';</script>\n'+
    '<script>try{'+code.replace(/<\/script/gi,'<\\/script')+'}catch(error){window.__bunnyBootFailed(error);}</script>');
await fs.writeFile(path.join(source, 'index.html'), html);

console.log(JSON.stringify({htmlBytes:Buffer.byteLength(html),bundleBytes:Buffer.byteLength(code),embeddedSheets:Object.keys(data).length,syntax:'ES2017 classic script'}));
