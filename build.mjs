import {readFile, writeFile, mkdir} from 'node:fs/promises';

const html = await readFile('dist/index.html', 'utf8');
const classroom = await readFile('worker/classroom.js', 'utf8');
const worker = await readFile('worker/index.js', 'utf8');
const script = html.match(/<script>([\s\S]*?)\binit\(\);\s*<\/script>/);
if (!script) throw new Error('Cannot find exam validation and catalog.');
const iconNames = {32:'/favicon.png',180:'/apple-touch-icon.png',192:'/icon-192.png',512:'/icon-512.png'};
const icons = Object.fromEntries(await Promise.all(Object.entries(iconNames).map(async ([size,path]) => [
  path,(await readFile('worker/icons/icon-'+size+'.png')).toString('base64')
])));
const manifest = {
  id:'/',name:'共テ演習ログ',short_name:'共テ演習ログ',lang:'ja',start_url:'/',scope:'/',
  display:'standalone',background_color:'#f4f6f0',theme_color:'#173d30',
  icons:[192,512].map(size=>({src:iconNames[size],sizes:size+'x'+size,type:'image/png',purpose:'any'}))
};
const hostedPage = html.replace('<main>','<main hidden>')
  .replace('</head>', [
    '<link rel="icon" type="image/png" sizes="32x32" href="/favicon.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/manifest.webmanifest">',
    '<meta name="apple-mobile-web-app-title" content="共テ演習ログ">',
    '</head>'
  ].join('\n'))
  .replace('<span class="logo" aria-hidden="true">✓</span>', '<img width="34" height="34" src="/icon-192.png" alt="">')
  .replace('<nav aria-label="画面切り替え">','<nav aria-label="画面切り替え" hidden>')
  .replace('<script>','<script>globalThis.hostedClassroom=true;</script>\n<script>')
  .replace('</body>', () => '<script>' + classroom + '</script>\n</body>');
await mkdir('dist/server', {recursive:true});
await writeFile('dist/server/index.js',
  'const page = ' + JSON.stringify(hostedPage) + ';\n' +
  'const siteIcons = ' + JSON.stringify(icons) + ';\n' +
  'const webManifest = ' + JSON.stringify(manifest) + ';\n' +
  'const validateRecords = (() => {\n' + script[1] + '\nreturn validate;\n})();\n' + worker);
