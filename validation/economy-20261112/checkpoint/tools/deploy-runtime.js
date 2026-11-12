/* Local runtime-only deployment. No credentials, network, deletion or Git writes. */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Build = require('./runtime-build');
const target = 'C:/Users/xbenv/AppData/Local/Screeps/scripts/screeps.com/Sushi';
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function checkKnownTarget(source, destination) {
    const sourceFiles = Build.inventory(source), deployed = Build.inventory(destination);
    const releases = path.join(source, 'validation', 'deployments');
    if (fs.existsSync(releases)) for (const directory of fs.readdirSync(releases)) {
        try {
            const folder = path.join(releases, directory);
            const previous = JSON.parse(fs.readFileSync(path.join(folder, 'plan.json'), 'utf8'));
            const result = JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8'));
            if (equal(previous.sourceFiles, deployed) && equal(result.build, previous.build)) return;
        } catch { /* An incomplete release cannot authorize an overwrite. */ }
    }
    const history = cp.execFileSync('git', ['rev-list', '-30', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim().split(/\s+/);
    for (const name of Object.keys(deployed)) {
        if (!(name in sourceFiles)) throw new Error('Unrelated runtime module in target: ' + name);
        if (sourceFiles[name] === deployed[name]) continue;
        const text = fs.readFileSync(path.join(destination, name), 'utf8').replace(/\r\n/g, '\n');
        const known = history.some(commit => {
            try { return cp.execFileSync('git', ['show', commit + ':' + name],
                { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\r\n/g, '\n') === text; }
            catch { return false; }
        });
        if (!known) throw new Error('Unexplained target change; review before overwriting: ' + name);
    }
}
function makePlan(source, destination, output) {
    const build = Build.verify(source), sourceFiles = Build.inventory(source), targetFiles = Build.inventory(destination);
    for (const name of Object.keys(targetFiles)) if (!(name in sourceFiles)) throw new Error('Unrelated runtime module in target: ' + name);
    const changed = Object.keys(sourceFiles).filter(name => sourceFiles[name] !== targetFiles[name]);
    const plan = { source: path.resolve(source), target: path.resolve(destination), build, sourceFiles, targetFiles, changed,
        createdAt: new Date().toISOString(), backup: path.resolve(output, 'backup') };
    fs.mkdirSync(plan.backup, { recursive: true });
    for (const name of Object.keys(targetFiles)) fs.copyFileSync(path.join(destination, name), path.join(plan.backup, name));
    if (!equal(Build.inventory(plan.backup), targetFiles)) throw new Error('Backup verification failed');
    fs.writeFileSync(path.join(output, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
    return plan;
}
function apply(plan, write = fs.writeFileSync) {
    if (!equal(Build.verify(plan.source), plan.build) || !equal(Build.inventory(plan.source), plan.sourceFiles)) throw new Error('Source changed after validation; create a new plan');
    if (!equal(Build.inventory(plan.target), plan.targetFiles)) throw new Error('Target changed after plan; review and create a new plan');
    if (!equal(Build.inventory(plan.backup), plan.targetFiles)) throw new Error('Backup changed; create a new plan');
    // Freeze validated bytes before the first write; publish the marker last.
    const staged = new Map(Object.keys(plan.sourceFiles).map(name => [name, fs.readFileSync(path.join(plan.source, name))]));
    for (const [name, bytes] of staged) if (Build.hash(bytes) !== plan.sourceFiles[name]) throw new Error('Source changed while staging');
    const names = plan.changed.filter(name => name !== 'Runtime.Build.js').concat(plan.changed.includes('Runtime.Build.js') ? ['Runtime.Build.js'] : []);
    try {
        for (const name of names) write(path.join(plan.target, name), staged.get(name));
        if (!equal(Build.inventory(plan.target), plan.sourceFiles)) throw new Error('Deployment verification failed');
    } catch (error) {
        try { restore(plan); }
        catch (restoreError) { throw new Error('Deployment failed AND rollback failed: ' + error.message + '; ' + restoreError.message); }
        throw new Error('Deployment failed; prior runtime restored: ' + error.message);
    }
    return { build: plan.build, modules: staged.size, changed: names, backup: plan.backup, verifiedAt: new Date().toISOString() };
}
function restore(plan) {
    // Restore backed-up files; leave added, now-unreachable modules present.
    if (!equal(Build.inventory(plan.backup), plan.targetFiles)) throw new Error('Backup verification failed');
    for (const name of Object.keys(plan.targetFiles)) fs.copyFileSync(path.join(plan.backup, name), path.join(plan.target, name));
    const current = Build.inventory(plan.target);
    for (const name of Object.keys(plan.targetFiles)) if (current[name] !== plan.targetFiles[name]) throw new Error('Restore verification failed');
}
function main() {
    const mode = process.argv[2];
    if (mode === 'plan') {
        checkKnownTarget(Build.root, target);
        const result = cp.spawnSync('npm run validate', { cwd: Build.root, shell: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
        if (result.status !== 0) throw new Error('Validation failed; deployment plan not created');
        const output = path.join(Build.root, 'validation', 'deployments', new Date().toISOString().replace(/[:.]/g, '-'));
        const plan = makePlan(Build.root, target, output);
        fs.writeFileSync(path.join(output, 'validation.log'), (result.stdout || '') + (result.stderr || ''));
        console.log(JSON.stringify({ plan: path.join(output, 'plan.json'), build: plan.build, changed: plan.changed, backup: plan.backup }, null, 2));
    } else if (mode === 'apply' || mode === 'restore') {
        const planFile = path.resolve(process.argv[3] || ''), plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        if (path.resolve(plan.source) !== Build.root || path.resolve(plan.target) !== path.resolve(target) ||
            path.dirname(plan.backup) !== path.dirname(planFile) ||
            !planFile.startsWith(path.join(Build.root, 'validation', 'deployments') + path.sep)) throw new Error('Plan outside the authorized deployment paths');
        if (!fs.existsSync(path.join(path.dirname(planFile), 'validation.log'))) throw new Error('Missing validation evidence');
        if (mode === 'restore') { restore(plan); console.log('Restored prior runtime from ' + plan.backup); }
        else {
            const result = apply(plan);
            fs.writeFileSync(path.join(path.dirname(planFile), 'result.json'), JSON.stringify(result, null, 2) + '\n');
            console.log(JSON.stringify(result, null, 2));
        }
    } else throw new Error('Usage: node tools/deploy-runtime.js plan | apply <plan.json> | restore <plan.json>');
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { checkKnownTarget, makePlan, apply, restore };
