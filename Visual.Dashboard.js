const HiveMemory = require('HiveMind.Memory');
const TickIndex = require('HiveMind.Index');
const View = require('Diagnostics.View');
const Diagnostics = require('Diagnostics');
const Layout = require('Visual.Layout');
const number = value => { const n = Number(value) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'm' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n * 10) / 10); };
function build(room, mode = 'NORMAL') {
    const view = View.room(room.name), layout = Layout.create();
    if (!view) return layout;
    const index = TickIndex.get(), cpu = Game.cpu || {}, used = typeof cpu.getUsed === 'function' ? cpu.getUsed() : 0;
    Layout.add(layout, 0, 'SUSHI / ' + view.state, [
        'Tick ' + Game.time + ' | CPU ' + number(used) + '/' + number(cpu.limit),
        'Bucket ' + number(cpu.bucket) + ' | Rooms ' + index.ownedRooms.length + ' | Creeps ' + index.allCreeps.length
    ]);
    Layout.add(layout, 0, 'COLONY / ' + view.room, [
        'RCL ' + view.rcl + (view.progressTotal > 0 ? ' | Progress ' + number(100 * view.progress / view.progressTotal) + '%' : ''),
        'Economy: ' + view.state,
        'Spawn energy: ' + number(view.energy) + '/' + number(view.energyCapacity),
        'Stored energy: ' + number(view.stored),
        'Priority: ' + view.priority
    ], { maxRows: mode === 'COMPACT' ? 4 : 5 });
    Layout.add(layout, 0, 'ALERTS', view.alerts.length ? view.alerts.map(text => ({ text, warn: true })) :
        [{ text: 'Core operations healthy', muted: true }], { maxRows: mode === 'COMPACT' ? 2 : 5 });
    if (mode === 'COMPACT') return layout;
    const roles = Array.from(new Set([...Object.keys(view.counts), ...Object.keys(view.spawning), ...Object.keys(view.queued)]))
        .sort((a, b) => {
            const order = ['Foreman', 'Extractor', 'Freighter', 'Tech', 'Artificer'];
            return (order.includes(a) ? order.indexOf(a) : 99) - (order.includes(b) ? order.indexOf(b) : 99) || a.localeCompare(b);
        });
    Layout.add(layout, 0, 'POPULATION / active + spawning + queued', roles.map(role =>
        role + ': ' + (view.counts[role] || 0) + ' + ' + (view.spawning[role] || 0) + ' + ' + (view.queued[role] || 0)), { maxRows: 9 });
    const diagnostic = Diagnostics.summary(room.name);
    Layout.add(layout, 0, 'DIAGNOSTICS', [
        'History: ' + Diagnostics.status().events + ' | Warnings ' + diagnostic.warnings + ' | Errors ' + diagnostic.errors,
        diagnostic.last ? 'Last: ' + diagnostic.last.event + ' @' + diagnostic.last.tick : 'No recorded room events',
        'Console: Sushi.debug.room("' + room.name + '")'
    ], { maxRows: 3 });
    const sourceRows = [];
    view.sources.forEach((s, i) => {
        sourceRows.push('Source ' + (i + 1) + ' | WORK ' + s.activeWork + '/' + s.requiredWork);
        sourceRows.push('  Income ' + number(s.income) + '/' + number(s.expectedIncome) +
            ' | incoming ' + (s.spawningWork + s.queuedWork) + ' WORK');
        sourceRows.push('  Seats ' + (s.seats ?? '?') + ' | max ' + (s.maximumWork ?? '?') +
            ' WORK | ' + (s.replacement === 'PENDING' ? 'replacement pending' : s.constraint || 'unknown'));
        if (mode === 'DEBUG') {
            sourceRows.push('  At source ' + s.stationedWork + ' WORK | planned ' + (s.plannedWork ?? '?'));
            sourceRows.push('  ' + (s.planningReason || 'No source plan'));
            s.miners.forEach(m => sourceRows.push('  ' + m.name + ' ' + m.body.WORK + 'W/' + m.body.CARRY + 'C/' +
                m.body.MOVE + 'M' + (m.replaces ? ' replaces ' + m.replaces : '')));
            sourceRows.push('  Next: ' + (s.recommendedAction || 'observe'));
        }
    });
    Layout.add(layout, 1, 'LOCAL SOURCES', sourceRows, { maxRows: mode === 'DEBUG' ? 12 : 6 });
    Layout.add(layout, 1, 'SPAWNING', view.spawn ? [
        (view.spawn.current ? '' : 'Stale @' + view.spawn.tick + ' | ') + (view.spawn.status || 'Unknown'),
        'Next role: ' + (view.spawn.role || 'none') + ' | Queue ' + view.spawn.queue,
        view.spawn.reason || 'No decision reason',
        'Energy: ' + view.spawn.available + '/' + (view.spawn.capacity || '?') + ' | body ' + (view.spawn.required || '-'),
        view.spawn.sizingReason || 'Harvest: ' + view.activeWork + '/' + view.requiredWork + ' active WORK',
        view.spawn.admission || 'Incoming: ' + view.spawningWork + ' spawning + ' + view.queuedWork + ' queued WORK'
    ].slice(0, mode === 'DEBUG' ? 6 : 4) : ['No spawn decision this tick'], { maxRows: mode === 'DEBUG' ? 6 : 4 });
    Layout.add(layout, 1, 'REMOTE OPERATIONS', view.remotes.map(r => r.room + ' | ' + r.status + ' | ' + r.sources + ' sources'),
        { when: view.remotes.length > 0, maxRows: 4 });
    const resources = Object.entries(view.resources).filter(([,n]) => n > 0).sort((a, b) => b[1] - a[1]);
    Layout.add(layout, 1, 'RESOURCE ECONOMY', [
        'Local income: ' + number(view.income) + '/' + number(view.expectedIncome) + ' energy/tick',
        'Safe reserve: ' + number(view.reserveTarget),
        ...resources.map(([type,n]) => (type === 'energy' ? 'Energy' : type) + ': ' + number(n))
    ], { maxRows: 7 });
    if (mode === 'DEBUG') Layout.add(layout, 1, 'DEBUG / sample ages', [
        'Economy sample: ' + (view.economyTick ?? 'unavailable'),
        'Recovery confirmation: ' + view.healthyTicks + ' ticks',
        'Storage: ' + Diagnostics.status().storage,
        'Details: Sushi.debug.cpu()'
    ], { maxRows: 4 });
    return layout;
}
function run() {
    const settings = HiveMemory.getConfig('visuals');
    const mode = ['OFF', 'COMPACT', 'NORMAL', 'DEBUG'].includes(settings.dashboardMode) ? settings.dashboardMode : 'NORMAL';
    if (settings.showDashboard === false || mode === 'OFF') return;
    for (const room of TickIndex.get().ownedRooms) {
        if (settings.dashboardRoom && settings.dashboardRoom !== room.name) continue;
        Layout.draw(new RoomVisual(room.name), build(room, mode));
    }
    if (settings.showRemoteRoomDashboard !== false && mode !== 'COMPACT') {
        for (const home of TickIndex.get().ownedRooms) {
            if (settings.dashboardRoom && settings.dashboardRoom !== home.name) continue;
            const view = View.room(home.name);
            for (const remote of view.remotes) {
                if (!Game.rooms[remote.room] || Game.rooms[remote.room].controller?.my) continue;
                const layout = Layout.create();
                Layout.add(layout, 0, 'SUSHI / REMOTE ' + remote.room,
                    ['Home: ' + home.name, 'Status: ' + remote.status, 'Sources: ' + remote.sources]);
                Layout.draw(new RoomVisual(remote.room), layout);
            }
        }
    }
}
module.exports = { run, build };
