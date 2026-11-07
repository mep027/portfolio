import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
import * as topojson from 'https://cdn.jsdelivr.net/npm/topojson-client@3/+esm';

// =====================================================
// CONFIG: column names, labels, and formats in one place
// =====================================================

// Guttmacher column headers (must match your CSV; dashes and spaces are normalized below)
const FIELDS = {
  clinics: 'No. of abortion clinics, 2020',
  occurrence: 'No. of abortions, by state of occurrence, 2020',
  residence: 'No. of abortions, by state of residence, 2020',
  abortionRate: 'No. of abortions per 1,000 women aged 15–44, by state of residence, 2020',
  changeAbortionRate: '% change in abortion rate, 2017-2020',
  changeClinics: '% change in the no. of abortion clinics, 2017-2020',
  countiesNoClinic: '% of counties without a known clinic, 2020',
  travelOut: '% of residents obtaining abortions who traveled out of state for care, 2020',
  womenNoClinic: '% of women aged 15-44 living in a county without a clinic, 2020',
  shareUS: '% of all U.S. abortions, by state of occurrence, 2020',
  teenRate: 'Abortion rate (the no. of abortions per 1,000 women aged 15-19), by state of residence, 2017',
};

const f1 = d3.format('.1f');
const pct = (v) => `${f1(v)}%`;

// Labels and number formats for every measure we display
const MEASURES = {
  abortionRate:       { label: 'Abortion rate (per 1,000 women 15–44)', short: 'Abortion rate', format: f1 },
  clinicsPerMillion:  { label: 'Abortion clinics per million residents', short: 'Clinics per million', format: f1 },
  changeAbortionRate: { label: '% change in abortion rate, 2017–2020', short: '% change in abortion rate', format: pct },
  changeClinics:      { label: '% change in no. of clinics, 2017–2020', short: '% change in clinics', format: pct },
  countiesNoClinic:   { label: '% of counties without a clinic', short: '% counties w/o clinic', format: pct },
  travelOut:          { label: '% of residents who traveled out of state', short: '% traveled out of state', format: pct },
  womenNoClinic:      { label: '% of women 15–44 in a county w/o a clinic', short: '% women w/o local clinic', format: pct },
  shareUS:            { label: '% of all U.S. abortions', short: '% of U.S. abortions', format: pct },
  teenRate:           { label: 'Teen abortion rate (15–19), 2017', short: 'Teen abortion rate', format: f1 },
  infantMortality:    { label: 'Infant mortality (per 1,000 births)', short: 'Infant mortality rate', format: d3.format('.2f') },
  clinics:            { label: 'No. of abortion clinics, 2020', short: 'No. of clinics', format: d3.format(',') },
  netTravel:          { label: 'Net abortion travel', short: 'Net travel', format: d3.format('+.0%') },
};

// Options in the map dropdown
const MAP_MEASURES = ['infantMortality', 'abortionRate', 'clinicsPerMillion', 'changeAbortionRate', 'travelOut'];

// Rows in the "Stats at a Glance" bar chart
const STAT_MEASURES = [
  'changeAbortionRate', 'changeClinics', 'countiesNoClinic', 'travelOut',
  'womenNoClinic', 'shareUS', 'teenRate', 'infantMortality', 'clinics',
];

// =====================================================
// LOAD AND CLEAN DATA
// =====================================================

const [us, guttmacher, stateInfo] = await Promise.all([
  d3.json('https://cdn.jsdelivr.net/npm/us-atlas@3/states-albers-10m.json'),
  d3.csv('guttmacher.csv'),
  d3.csv('state_2020_combined.csv', d3.autoType),
]);

// Treat en dashes, em dashes, and hyphens the same, and ignore extra spaces
const norm = (s) => String(s).trim().replace(/[–—]/g, '-');

// Turn text like "1,234", "<10", "45%", or "n/a" into numbers
function num(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (text === '' || text === '—' || text.toLowerCase() === 'n/a') return null;
  const n = parseFloat(text.replace(/[<,$%]/g, ''));
  if (isNaN(n)) return null;
  return text.startsWith('<') ? n / 2 : n;
}

// Warn in the console if a column name doesn't match
const headers = new Set(guttmacher.columns.map(norm));
for (const [key, field] of Object.entries(FIELDS)) {
  if (!headers.has(norm(field))) console.warn(`Column not found for "${key}": ${field}`);
}

// Look up each Guttmacher row by state name
const guttByState = new Map(
  guttmacher.map((row) => {
    const cleanRow = {};
    for (const [k, v] of Object.entries(row)) cleanRow[norm(k)] = v;
    return [String(cleanRow[norm('U.S. State')]).trim(), cleanRow];
  }),
);

// Join the two files and add calculated fields
const data = stateInfo.map((d) => {
  const g = guttByState.get(d.State) ?? {};
  const row = {
    State: d.State,
    population: d.Population_2020,
    infantMortality: d.Infant_Mortality_Rate_2020,
  };
  for (const [key, field] of Object.entries(FIELDS)) row[key] = num(g[norm(field)]);
  row.clinicsPerMillion = row.clinics != null ? (row.clinics / row.population) * 1e6 : null;
  row.netTravel = row.occurrence != null && row.residence
    ? (row.occurrence - row.residence) / row.residence
    : null;
  return row;
});

const byState = new Map(data.map((d) => [d.State, d]));
const nationalAvg = Object.fromEntries(
  STAT_MEASURES.map((k) => [k, d3.mean(data, (d) => d[k])]), // d3.mean skips missing values
);

const show = (key, value) => (value == null ? 'n/a' : MEASURES[key].format(value));

// =====================================================
// SHARED STATE: dropdown choice and selected state
// =====================================================

let currentMeasure = 'infantMortality';
let selected = null;

function toggleSelect(name) {
  selected = selected === name ? null : name;
  refresh();
}

// =====================================================
// TOOLTIP
// =====================================================

const tooltip = d3.select('#tooltip');

function showTooltip(event, name) {
  const r = byState.get(name);
  if (!r) return;
  tooltip
    .style('opacity', 1)
    .html(`
      <strong>${name}</strong>
      <dl>
        <dt>Abortion clinics, 2020</dt><dd>${show('clinics', r.clinics)}</dd>
        <dt>${MEASURES[currentMeasure].label}</dt><dd>${show(currentMeasure, r[currentMeasure])}</dd>
        <dt>Infant mortality rate</dt><dd>${show('infantMortality', r.infantMortality)}</dd>
        <dt>Net abortion travel</dt><dd>${show('netTravel', r.netTravel)}</dd>
        <dt>Population, 2020</dt><dd>${d3.format(',')(r.population)}</dd>
      </dl>
    `);
  moveTooltip(event);
}

function moveTooltip(event) {
  tooltip.style('left', `${event.clientX + 14}px`).style('top', `${event.clientY + 14}px`);
}

function hideTooltip() {
  tooltip.style('opacity', 0);
}

// =====================================================
// MAP
// =====================================================

function colorScaleFor(key) {
  const [lo, hi] = d3.extent(data, (d) => d[key]);
  if (lo < 0 && hi > 0) {
    // Values above and below zero (like % change): red = decrease, blue = increase
    return d3.scaleDiverging([lo, 0, hi], d3.interpolateRdBu);
  }
  return d3.scaleSequential([lo, hi], (t) => d3.interpolateBlues(0.15 + 0.85 * t));
}

function drawMap() {
  const states = topojson.feature(us, us.objects.states);
  const path = d3.geoPath();

  const svg = d3.create('svg')
    .attr('viewBox', [0, 0, 975, 610])
    .attr('style', 'max-width: 100%; height: auto;');

  const shapes = svg.append('g')
    .selectAll('path')
    .data(states.features)
    .join('path')
      .attr('class', 'state-shape')
      .attr('d', path)
      .on('mouseenter', (event, d) => showTooltip(event, d.properties.name))
      .on('mousemove', moveTooltip)
      .on('mouseleave', hideTooltip)
      .on('click', (event, d) => toggleSelect(d.properties.name));

  svg.append('path')
    .datum(topojson.mesh(us, us.objects.states, (a, b) => a !== b))
    .attr('fill', 'none')
    .attr('stroke', 'white')
    .attr('stroke-linejoin', 'round')
    .attr('pointer-events', 'none')
    .attr('d', path);

  // Dark outline drawn on top of the selected state
  const outline = svg.append('path')
    .attr('fill', 'none')
    .attr('stroke', '#222')
    .attr('stroke-width', 2.5)
    .attr('pointer-events', 'none');

  document.querySelector('#map').append(svg.node());

  return function updateMap() {
    const color = colorScaleFor(currentMeasure);

    shapes.transition().duration(400)
      .attr('fill', (d) => {
        const v = byState.get(d.properties.name)?.[currentMeasure];
        return v == null ? '#ddd' : color(v);
      });

    shapes.classed('faded', (d) => selected !== null && d.properties.name !== selected);
    const selectedFeature = states.features.find((d) => d.properties.name === selected);
    outline.attr('d', selectedFeature ? path(selectedFeature) : null);

    // Legend: gradient from lowest to highest value
    const [lo, hi] = d3.extent(data, (d) => d[currentMeasure]);
    const stops = d3.range(11).map((i) => color(lo + (i / 10) * (hi - lo)));
    d3.select('#legend-title').text(MEASURES[currentMeasure].label);
    d3.select('#legend-bar').style('background', `linear-gradient(to right, ${stops.join(', ')})`);
    d3.select('#legend-min').text(show(currentMeasure, lo));
    d3.select('#legend-max').text(show(currentMeasure, hi));
  };
}

// =====================================================
// STATS AT A GLANCE: national average or selected state
// =====================================================

function drawStats() {
  const width = 560, height = 380;
  const marginTop = 10, marginRight = 60, marginBottom = 30, marginLeft = 170;

  const y = d3.scaleBand()
    .domain(STAT_MEASURES)
    .range([marginTop, height - marginBottom])
    .padding(0.25);
  const x = d3.scaleLinear().range([marginLeft, width - marginRight]);

  const svg = d3.create('svg')
    .attr('viewBox', [0, 0, width, height])
    .attr('style', 'max-width: 100%; height: auto; font: 11px sans-serif;');

  const xAxis = svg.append('g').attr('transform', `translate(0,${height - marginBottom})`);

  svg.append('g')
    .attr('transform', `translate(${marginLeft},0)`)
    .call(d3.axisLeft(y).tickFormat((k) => MEASURES[k].short).tickSize(0).tickPadding(6))
    .call((g) => g.select('.domain').remove());

  const bars = svg.append('g')
    .selectAll('rect')
    .data(STAT_MEASURES)
    .join('rect')
      .attr('y', (k) => y(k))
      .attr('height', y.bandwidth())
      .attr('fill', (k, i) => d3.schemeTableau10[i % 10]);

  const avgLines = svg.append('g')
    .selectAll('line')
    .data(STAT_MEASURES)
    .join('line')
      .attr('y1', (k) => y(k) - 3)
      .attr('y2', (k) => y(k) + y.bandwidth() + 3)
      .attr('stroke', 'black')
      .attr('stroke-width', 2);

  const labels = svg.append('g')
    .selectAll('text')
    .data(STAT_MEASURES)
    .join('text')
      .attr('y', (k) => y(k) + y.bandwidth() / 2)
      .attr('dy', '0.35em');

  const zeroLine = svg.append('line')
    .attr('y1', marginTop)
    .attr('y2', height - marginBottom)
    .attr('stroke', 'currentColor')
    .attr('stroke-opacity', 0.4);

  document.querySelector('#stats').append(svg.node());

  return function updateStats() {
    const row = selected ? byState.get(selected) : null;
    const value = (k) => (row ? row[k] : nationalAvg[k]);

    // Rescale the axis to fit whatever is being shown
    const shown = STAT_MEASURES.flatMap((k) => [value(k), nationalAvg[k]]).filter((v) => v != null);
    x.domain([Math.min(0, d3.min(shown)), Math.max(0, d3.max(shown))]).nice();

    const t = svg.transition().duration(500);
    xAxis.transition(t).call(d3.axisBottom(x).ticks(6));
    zeroLine.transition(t).attr('x1', x(0)).attr('x2', x(0));

    bars.transition(t)
      .attr('x', (k) => x(Math.min(0, value(k) ?? 0)))
      .attr('width', (k) => Math.abs(x(value(k) ?? 0) - x(0)));

    avgLines.transition(t)
      .attr('x1', (k) => x(nationalAvg[k] ?? 0))
      .attr('x2', (k) => x(nationalAvg[k] ?? 0))
      .attr('opacity', row ? 1 : 0); // only show the average marker when a state is selected

    labels.transition(t)
      .attr('x', (k) => x(Math.max(0, value(k) ?? 0)) + 4)
      .text((k) => show(k, value(k)));

    d3.select('#stats-title').text(
      row ? `Stats at a Glance: ${selected}` : 'Stats at a Glance: National Average',
    );
    d3.select('#stats-note').text(
      row
        ? 'Bars show the selected state. Black lines mark the national average.'
        : 'Click a state on the map or scatter plot to compare it with the national average.',
    );
    d3.select('#clear').property('hidden', !row);
  };
}

// =====================================================
// SCATTER PLOT
// =====================================================

function drawScatter() {
  const rows = data.filter((d) => d.clinicsPerMillion != null && d.abortionRate != null);
  const width = 560, height = 380;
  const marginTop = 20, marginRight = 20, marginBottom = 45, marginLeft = 50;

  const x = d3.scaleLinear()
    .domain([0, d3.max(rows, (d) => d.clinicsPerMillion)]).nice()
    .range([marginLeft, width - marginRight]);
  const y = d3.scaleLinear()
    .domain([0, d3.max(rows, (d) => d.abortionRate)]).nice()
    .range([height - marginBottom, marginTop]);

  const svg = d3.create('svg')
    .attr('viewBox', [0, 0, width, height])
    .attr('style', 'max-width: 100%; height: auto; font: 11px sans-serif;');

  svg.append('g')
    .attr('transform', `translate(0,${height - marginBottom})`)
    .call(d3.axisBottom(x))
    .call((g) => g.append('text')
      .attr('x', width - marginRight).attr('y', 35)
      .attr('fill', 'currentColor').attr('text-anchor', 'end')
      .text('Abortion clinics per million residents →'));

  svg.append('g')
    .attr('transform', `translate(${marginLeft},0)`)
    .call(d3.axisLeft(y))
    .call((g) => g.append('text')
      .attr('x', -marginLeft).attr('y', 10)
      .attr('fill', 'currentColor').attr('text-anchor', 'start')
      .text('↑ Abortions per 1,000 women aged 15–44'));

  const dots = svg.append('g')
    .selectAll('circle')
    .data(rows)
    .join('circle')
      .attr('class', 'dot')
      .attr('cx', (d) => x(d.clinicsPerMillion))
      .attr('cy', (d) => y(d.abortionRate))
      .on('mouseenter', (event, d) => showTooltip(event, d.State))
      .on('mousemove', moveTooltip)
      .on('mouseleave', hideTooltip)
      .on('click', (event, d) => toggleSelect(d.State));

  document.querySelector('#scatter').append(svg.node());

  return function updateScatter() {
    dots
      .attr('fill', (d) => {
        if (!selected) return '#4e79a7';
        return d.State === selected ? '#1f3f73' : '#d3d7de';
      })
      .attr('r', (d) => (d.State === selected ? 8 : 5));
    dots.filter((d) => d.State === selected).raise(); // draw the selected dot on top
  };
}

// =====================================================
// WIRE IT ALL UP
// =====================================================

const updateMap = drawMap();
const updateStats = drawStats();
const updateScatter = drawScatter();

function refresh() {
  updateMap();
  updateStats();
  updateScatter();
}

d3.select('#measure')
  .selectAll('option')
  .data(MAP_MEASURES)
  .join('option')
    .attr('value', (k) => k)
    .text((k) => MEASURES[k].label)
    .property('selected', (k) => k === currentMeasure);

d3.select('#measure').on('change', (event) => {
  currentMeasure = event.target.value;
  updateMap();
});

d3.select('#clear').on('click', () => {
  selected = null;
  refresh();
});

refresh();