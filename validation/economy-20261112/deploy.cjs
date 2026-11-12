const fs=require('fs'),path=require('path'),vm=require('vm');
const root=path.resolve(__dirname,'../..'),[label,folder,logName,expected]=process.argv.slice(2);
if(!/^[a-z0-9-]+$/.test(label||'')||!['stage','observation-stage'].includes(folder))throw Error('Invalid release target');
const stage=path.join(__dirname,folder),log=fs.readFileSync(path.join(stage,logName),'utf8');
const passed=log.split(/\r?\n/).filter(l=>l.startsWith('PASS ')).length;
if(passed!==Number(expected))throw Error('Check count mismatch: '+passed);
const files=fs.readdirSync(stage).filter(f=>f.endsWith('.js'));
for(const file of files)new vm.Script(fs.readFileSync(path.join(stage,file),'utf8'),{filename:file});
const before=JSON.parse(fs.readFileSync(path.join(root,'Runtime.Build.js'),'utf8').match(/Object.freeze\((.*)\)/)[1]);
const after=JSON.parse(fs.readFileSync(path.join(stage,'Runtime.Build.js'),'utf8').match(/Object.freeze\((.*)\)/)[1]);
const backup=path.join(__dirname,'releases',label,'original');if(fs.existsSync(backup))throw Error('Release checkpoint already exists');
fs.mkdirSync(backup,{recursive:true});for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.js')||f==='package.json'))fs.copyFileSync(path.join(root,file),path.join(backup,file));
// New dependencies first; build marker last. No world writes or module removal.
for(const file of files.filter(f=>f!=='Runtime.Build.js').sort((a,b)=>Number(fs.existsSync(path.join(root,a)))-Number(fs.existsSync(path.join(root,b)))))
    fs.copyFileSync(path.join(stage,file),path.join(root,file));
fs.copyFileSync(path.join(stage,'Runtime.Build.js'),path.join(root,'Runtime.Build.js'));
fs.copyFileSync(path.join(stage,'package.json'),path.join(root,'package.json'));
fs.cpSync(path.join(stage,'test'),path.join(root,'test'),{recursive:true});
fs.copyFileSync(path.join(stage,logName),path.join(__dirname,label+'-validation.log'));
const receipt={at:new Date().toISOString(),target:root,branch:'Sushi',before,after,passed,backup,files};
fs.writeFileSync(path.join(__dirname,'releases',label,'receipt.json'),JSON.stringify(receipt,null,2));
console.log(JSON.stringify(receipt,null,2));
