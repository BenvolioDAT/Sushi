/* RoomVisual layout in tile coordinates. Bounds are explicit; no DOM assumptions. */
const STYLE = Object.freeze({ margin: 0.6, gap: 0.45, padding: 0.55, line: 0.86,
    font: 0.58, titleFont: 0.62, title: 1.25, bottom: 49.1,
    background: '#07130f', border: '#188a60', text: '#d6f6df', muted: '#7da992', green: '#50f6a0', warn: '#ffcd69' });
function truncate(text, width, font = STYLE.font) {
    // Monospace glyphs use <= 0.62 em; reserve extra room for client rendering.
    const max = Math.max(0, Math.floor(width / (font * 0.68)));
    const clean = String(text ?? '').replace(/[^\x20-\x7e]/g, '?');
    return clean.length <= max ? clean : max < 3 ? '.'.repeat(max) : clean.slice(0, max - 3) + '...';
}
function create(columns) {
    const widths = columns || [{ x: 0.6, width: 24.1 }, { x: 25.15, width: 24.1 }];
    return { columns: widths.map(c => ({ ...c, y: 0.6 })), panels: [], hidden: 0 };
}
function add(layout, column, title, rows, options = {}) {
    const col = layout.columns[column];
    if (!col || options.when === false) return null;
    const available = Math.min(options.maxHeight || 48.5, STYLE.bottom - col.y);
    const capacity = Math.max(0, Math.floor((available - STYLE.title - STYLE.padding) / STYLE.line));
    const maxRows = Math.min(capacity, options.maxRows ?? 12);
    if (maxRows < 1) { layout.hidden++; return null; }
    const visible = rows.slice(0, maxRows).map(row => typeof row === 'string' ? { text: row } : row);
    if (rows.length > maxRows) visible[maxRows - 1] = { text: '+ ' + (rows.length - maxRows + 1) + ' more - see console', muted: true };
    if (!visible.length) visible.push({ text: 'No current data', muted: true });
    const panel = { x: col.x, y: col.y, width: col.width,
        height: STYLE.title + visible.length * STYLE.line + STYLE.padding, title, rows: visible };
    if (panel.x < 0 || panel.x + panel.width > 49.5 || panel.y + panel.height > STYLE.bottom) { layout.hidden++; return null; }
    layout.panels.push(panel); col.y += panel.height + STYLE.gap; return panel;
}
function draw(visual, layout) {
    // Backgrounds first, then titles and rows: predictable order even with multiple columns.
    for (const p of layout.panels) visual.rect(p.x, p.y, p.width, p.height,
        { fill: STYLE.background, opacity: 0.9, stroke: STYLE.border, strokeWidth: 0.035 });
    for (const p of layout.panels) {
        const x = p.x + STYLE.padding, width = p.width - 2 * STYLE.padding;
        visual.text(truncate(p.title, width, STYLE.titleFont), x, p.y + 0.84,
            { align: 'left', font: STYLE.titleFont + ' monospace', color: STYLE.green });
        p.rows.forEach((row, i) => visual.text(truncate(row.text, width), x,
            p.y + STYLE.title + (i + 0.72) * STYLE.line,
            { align: 'left', font: STYLE.font + ' monospace', color: row.warn ? STYLE.warn : row.muted ? STYLE.muted : STYLE.text }));
    }
    return layout;
}
module.exports = { STYLE, truncate, create, add, draw };
