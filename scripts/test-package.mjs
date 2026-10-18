import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile,mkdtemp,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
if(execFileSync('npm',['--version'],{encoding:'utf8'}).trim()!=='10.9.3')throw new Error('Pack SDK releases with npm 10.9.3.');
if(process.version!=='v22.19.0')throw new Error('Pack SDK releases with Node 22.19.0 from sdk/.nvmrc.');
const root=new URL('../',import.meta.url),dir=new URL('artifacts/',root);await mkdir(dir,{recursive:true});
const temporary=await mkdtemp(new URL('.pack-check-',dir));
try{
const result=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',temporary],{cwd:root,encoding:'utf8'}))[0];
const names=new Set(result.files.map(file=>file.path));
for(const path of ['dist/index.js','dist/index.d.ts','dist/react.js','dist/react.d.ts','dist/server.js','dist/server.d.ts'])
  if(!names.has(path))throw new Error('Missing export: '+path);
for(const path of names)if(/\.env|node_modules|test|\.map$/.test(path))throw new Error('Unexpected package file: '+path);
const bytes=await readFile(temporary+'/'+result.filename),destination=new URL(result.filename,dir);
const existing=await readFile(destination).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
if(existing && !existing.equals(bytes))throw new Error('Immutable artifact differs. Bump the version before packing changed bytes.');
if(!existing)await rename(temporary+'/'+result.filename,destination);
const snapshot=await readFile(new URL('SOURCE.json',root),'utf8').then(JSON.parse).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
if(snapshot&&!/^[0-9a-f]{40}$/.test(snapshot.source_sha))throw new Error('Invalid exported source identity');
const manifest=JSON.stringify({filename:result.filename,version:result.version,
  node_version:process.version,npm_version:execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),
  source_sha:snapshot?.source_sha??execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),files:[...names].sort(),
  sha256:createHash('sha256').update(bytes).digest('hex'),integrity:result.integrity},null,2)+'\n';
await writeFile(new URL(result.filename+'.json',dir),manifest);
await writeFile(new URL('manifest.json',dir),manifest);
process.stdout.write(`Validated SDK tarball ${result.filename}; ${names.size} files.\n`);
}finally{await rm(temporary,{recursive:true,force:true});}
