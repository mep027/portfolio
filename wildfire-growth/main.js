// County shapes (unprojected, so we can measure real area) and your two CSVs.
const ATLAS_URL = "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json";
const GROUPS_URL = "county_groups.csv";            // from county_groups.py
const FIRES_URL = "fire_cause_by_county.csv";      // from fire_cause.py (optional)
const WEEKS_URL = "drought_weeks_by_county.csv";  // from drought_weeks.py (optional)
const SIZE_URL = "fire_size_by_cause.csv";         // from fire_size_by_cause.py (optional)
const MASTER_URL = "county_year_master.csv";       // from merge_county_data.py (optional)
const FIRE_YEARS = 25;                             // fire counts cover 2000-2024
const EARTH_RADIUS_MI = 3958.8;

// The four county groups from county_groups.py, in display order.
const GROUP_ORDER = ["Fire + Drought", "Drought only", "Fire only", "Neither"];
const GROUP_COLOR = d3.scaleOrdinal(GROUP_ORDER, ["#b2182b", "#d8a530", "#f08a5d", "#cfcfd4"]);

// Region colors from the Okabe-Ito palette, chosen to stay distinguishable with color blindness.
// Order matches ["West", "South", "Midwest", "Northeast"].
const REGION_COLORS = ["#E69F00", "#0072B2", "#009E73", "#CC79A7"];

// Clicking a group anywhere highlights it everywhere.
const selection = { group: null, listeners: [] };
function selectGroup(g) {
  selection.group = selection.group === g ? null : g;
  selection.listeners.forEach(f => f(selection.group));
}
function onSelect(f) { selection.listeners.push(f); }

// A small "Highlighting: X (clear)" line placed above a chart.
function statusLine(containerSel) {
  const el = d3.select(containerSel).insert("div", ":first-child").attr("class", "status");
  onSelect(g => {
    el.html(g ? `Highlighting <b style="color:${d3.color(GROUP_COLOR(g)).darker(0.6)}">${g}</b> counties
                 <button type="button">clear</button>` : "");
    el.select("button").on("click", () => selectGroup(g));
  });
}

// Same layout as the us-atlas "albers" files the D3 examples use.
const projection = d3.geoAlbersUsa().scale(1300).translate([487.5, 305]);

const fmt = {
  int: d3.format(",.0f"),
  dec1: d3.format(",.1f"),
  dec2: d3.format(",.2f"),
  pct: d => d == null ? "n/a" : (d < 0.01 && d > 0 ? "<0.01%" : d3.format(",.2f")(d) + "%"),
};
const tip = d3.select("#tip");
function showTip(event, html) {
  tip.html(html).style("opacity", 1);
  const pad = 14, w = tip.node().offsetWidth, h = tip.node().offsetHeight;
  let x = event.clientX + pad, y = event.clientY + pad;
  if (x + w > window.innerWidth) x = event.clientX - w - pad;
  if (y + h > window.innerHeight) y = event.clientY - h - pad;
  tip.style("left", x + "px").style("top", y + "px");
}
function hideTip() { tip.style("opacity", 0); }

const num = v => (v === "" || v == null ? null : +v);

Promise.all([
  d3.json(ATLAS_URL),
  d3.csv(GROUPS_URL),
  d3.csv(FIRES_URL).catch(() => null),             // page still works without these
  d3.csv(WEEKS_URL).catch(() => null),
  d3.csv(SIZE_URL).catch(() => null),
  d3.csv(MASTER_URL).catch(() => null),
]).then(([us, groups, fires, weeks, sizes, master]) => {
  const counties = topojson.feature(us, us.objects.counties).features;

  // Land area of each county in square miles, measured from its shape.
  const areaSqMi = new Map(counties.map(f =>
    [f.id, d3.geoArea(f) * EARTH_RADIUS_MI ** 2]));

  const fireCount = new Map((fires || []).map(d => [
    d.fips.padStart(5, "0"),
    (num(d.fires_early) || 0) + (num(d.fires_late) || 0),
  ]));

  const rows = groups.map(d => {
    const fips = d.fips.padStart(5, "0");
    const area = areaSqMi.get(fips);
    const pop = num(d.avg_population);
    const nFires = fires ? (fireCount.get(fips) || 0) : null;
    return {
      fips,
      name: d.county_name, state: d.state, region: d.region, group: d.group,
      density: area && pop != null ? pop / area : null,
      pct_burned: num(d.pct_burned_total),
      fires_per_1k_sqmi: area && nFires != null ? 1000 * nFires / FIRE_YEARS / area : null,
      permits_per_1k: num(d.permits_per_1k_yr),
      total_units: num(d.total_units),
      pop_growth: num(d.pop_growth_pct),
    };
  });

  const byFips = new Map(rows.map(d => [d.fips, d]));
  drawMap(us, counties, byFips, rows);
  drawScatter(rows, !!fires);
  drawGroupMap(us, counties, byFips, rows);
  drawGroupBars(rows);
  drawDroughtHeatmap(weeks);
  drawHumanShare(fires);
  drawFireSize(sizes);
  drawFireRebuild(master);
}).catch(err => {
  document.querySelector("main").insertAdjacentHTML("beforeend",
    `<p style="color:#b00">Couldn't load data: ${err}. Open this page through a local server
     or GitHub Pages, with county_groups.csv in the same folder.</p>`);
});

/* ------------------------------------------------------------------ MAP */
function drawMap(us, counties, byFips, rows) {
  const width = 975, height = 610;
  const path = d3.geoPath(projection);
  const statemap = new Map(topojson.feature(us, us.objects.states).features.map(d => [d.id, d]));

  // Building: split counties into thirds. Fire: none / under 1% / 1%+.
  const permits = rows.map(d => d.permits_per_1k).filter(v => v != null).sort(d3.ascending);
  const g1 = d3.quantileSorted(permits, 1 / 3), g2 = d3.quantileSorted(permits, 2 / 3);
  const growthClass = v => v == null ? null : v <= g1 ? 0 : v <= g2 ? 1 : 2;
  const fireClass = v => v == null ? null : v <= 0 ? 0 : v < 1 ? 1 : 2;

  // Rows = building (low -> high), columns = fire (low -> high).
  // Blue (building) x orange (fire): this pair stays distinct for the common kinds of
  // color blindness, and both axes also get darker, so lightness alone tells the story.
  const palette = [
    ["#eeeeee", "#f9c98f", "#e66101"],
    ["#a9cbe6", "#c4a57e", "#a9480c"],
    ["#2f6fa8", "#5b5670", "#2a1c24"],
  ];
  const fill = d => {
    if (!d) return "#fff";
    const gc = growthClass(d.permits_per_1k), fc = fireClass(d.pct_burned);
    return gc == null || fc == null ? "#fff" : palette[gc][fc];
  };

  const svg = d3.select("#map").append("svg")
      .attr("viewBox", [0, 0, width, height]);

  svg.append("path")
      .datum(topojson.feature(us, us.objects.nation))
      .attr("fill", "#fff").attr("stroke", "#bbb").attr("d", path);

  const countyPaths = svg.append("g")
    .selectAll("path")
    .data(counties)
    .join("path")
      .attr("d", path)
      .attr("fill", f => fill(byFips.get(f.id)));

  // Fade counties outside the selected group
  statusLine("#map");
  onSelect(g => countyPaths.transition().duration(300)
      .attr("fill-opacity", f => !g || byFips.get(f.id)?.group === g ? 1 : 0.12));

  countyPaths
      .on("mousemove", (event, f) => {
        const d = byFips.get(f.id);
        const st = statemap.get(f.id.slice(0, 2));
        const title = d ? `${d.name}, ${d.state}` :
          `${f.properties.name}, ${st ? st.properties.name : ""}`;
        showTip(event, d ? `<b>${title}</b><br>
          New homes: ${d.permits_per_1k == null ? "n/a" : fmt.dec1(d.permits_per_1k)} per 1,000 residents/yr<br>
          Total new homes: ${d.total_units == null ? "n/a" : fmt.int(d.total_units)}<br>
          Burned (2000–2025): ${fmt.pct(d.pct_burned)} of county`
          : `<b>${title}</b><br>No data`);
      })
      .on("mouseleave", hideTip);

  svg.append("path")
      .datum(topojson.mesh(us, us.objects.states, (a, b) => a !== b))
      .attr("fill", "none").attr("stroke", "#fff").attr("stroke-width", 1)
      .attr("stroke-linejoin", "round").attr("d", path);

  // ---- Spikes: total new homes 2000-2025
  const spike = (len, w = 5) => `M${-w / 2},0L0,${-len}L${w / 2},0`;
  const spikeData = counties
    .map(f => ({ f, d: byFips.get(f.id), c: path.centroid(f) }))
    .filter(o => o.d && o.d.total_units > 0 && o.c && !isNaN(o.c[0]))
    .sort((a, b) => a.c[1] - b.c[1]);
  const length = d3.scaleLinear([0, d3.max(spikeData, o => o.d.total_units)], [0, 120]);

  const spikes = svg.append("g")
      .attr("fill", "#1d1d1f").attr("fill-opacity", 0.35)
      .attr("stroke", "#1d1d1f").attr("stroke-width", 0.5)
      .style("display", "none");
  spikes.selectAll("path")
    .data(spikeData)
    .join("path")
      .attr("transform", o => `translate(${o.c})`)
      .attr("d", o => spike(length(o.d.total_units)))
      .on("mousemove", (event, o) => showTip(event,
        `<b>${o.d.name}, ${o.d.state}</b><br>${fmt.int(o.d.total_units)} new homes, 2000–2025`))
      .on("mouseleave", hideTip);

  const spikeLegend = svg.append("g")
      .attr("transform", "translate(880,590)")
      .style("display", "none")
      .attr("font-size", 10).attr("fill", "#6b6b70").attr("text-anchor", "middle");
  const ticks = length.ticks(3).filter(t => t > 0);
  const item = spikeLegend.selectAll("g").data(ticks).join("g")
      .attr("transform", (d, i) => `translate(${i * 34},0)`);
  item.append("path")
      .attr("fill", "#1d1d1f").attr("fill-opacity", 0.35)
      .attr("stroke", "#1d1d1f").attr("stroke-width", 0.5)
      .attr("d", d => spike(length(d)));
  item.append("text").attr("dy", "1.1em").text(d3.format(".2s"));
  spikeLegend.append("text").attr("x", -16).attr("y", 0).attr("dy", "1.1em")
      .attr("text-anchor", "end").attr("fill", "#1d1d1f").text("New homes");

 d3.select("#spikes").on("change", function () {
    const showSpikes = this.checked;
    const on = showSpikes ? null : "none";
    spikes.style("display", on);
    spikeLegend.style("display", on);

    // With spikes on, gray out the counties so the spikes stand out; restore colors when off
    countyPaths.transition().duration(400)
        .attr("fill", f => showSpikes ? "#f2f2f2" : fill(byFips.get(f.id)));
    legend.transition().duration(400).style("opacity", showSpikes ? 0 : 1);
  });

  // ---- 3x3 legend
  const k = 22;
  const legend = svg.append("g").attr("transform", "translate(855,400)");
  const cells = legend.append("g").attr("transform", "rotate(-45) translate(0,0)");
  for (let gi = 0; gi < 3; gi++) {
    for (let fi = 0; fi < 3; fi++) {
      cells.append("rect")
          .attr("x", fi * k).attr("y", (2 - gi) * k)
          .attr("width", k).attr("height", k)
          .attr("fill", palette[gi][fi]);
    }
  }
  // Edge labels (drawn unrotated so the text reads cleanly)
  const c = Math.SQRT1_2;
  legend.append("text")
      .attr("transform", `translate(${3.18 * k + 11},${1.06 * k + 11}) rotate(-45)`)
      .attr("text-anchor", "middle").attr("font-size", 11).attr("fill", "#1d1d1f")
      .text("More fire →");
  legend.append("text")
      .attr("transform", `translate(${1.06 * k - 11},${1.06 * k + 11}) rotate(45)`)
      .attr("text-anchor", "middle").attr("font-size", 11).attr("fill", "#1d1d1f")
      .text("← More building");
}

/* -------------------------------------------------------------- SCATTER */
function drawScatter(rows, hasFireCounts) {
  const width = 975, height = 560;
  const m = { top: 20, right: 150, bottom: 56, left: 70 };
  const zeroBand = 34;                       // space for "no fire" counties
  const plotBottom = height - m.bottom - zeroBand;

  const regions = ["West", "South", "Midwest", "Northeast"];
  const color = d3.scaleOrdinal(regions, REGION_COLORS);

  const data = rows.filter(d => d.density > 0);
  const x = d3.scaleLog()
      .domain(d3.extent(data, d => d.density)).nice()
      .range([m.left, width - m.right]);

  const svg = d3.select("#scatter").append("svg")
      .attr("viewBox", [0, 0, width, height]);

  const gridY = svg.append("g").attr("class", "grid");
  const axisY = svg.append("g").attr("class", "axis")
      .attr("transform", `translate(${m.left},0)`);
  svg.append("g").attr("class", "axis")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).ticks(6, ",~g"));
  svg.append("text").attr("class", "axis-label")
      .attr("x", (m.left + width - m.right) / 2).attr("y", height - 14)
      .attr("text-anchor", "middle").text("People per square mile (log scale)");
  const yLabel = svg.append("text").attr("class", "axis-label")
      .attr("transform", `translate(18,${(m.top + plotBottom) / 2}) rotate(-90)`)
      .attr("text-anchor", "middle");

  // Zero band
  svg.append("rect").attr("x", m.left).attr("y", plotBottom + 6)
      .attr("width", width - m.right - m.left).attr("height", zeroBand - 12)
      .attr("fill", "#f4f4f6");
  svg.append("text").attr("class", "axis").attr("x", m.left - 8)
      .attr("y", plotBottom + zeroBand / 2 + 4).attr("text-anchor", "end")
      .attr("font-size", 11).attr("fill", "#6b6b70").text("No fire");

  const dots = svg.append("g")
    .selectAll("circle")
    .data(data, d => d.fips)
    .join("circle")
      .attr("cx", d => x(d.density))
      .attr("r", 2.6)
      .attr("fill", d => color(d.region) ?? "#999")
      .attr("fill-opacity", 0.55)
      .on("mousemove", (event, d) => showTip(event, `<b>${d.name}, ${d.state}</b><br>
          ${fmt.dec1(d.density)} people per sq mi<br>
          Burned (2000–2025): ${fmt.pct(d.pct_burned)} of county<br>
          Fires: ${d.fires_per_1k_sqmi == null ? "n/a" : fmt.dec1(d.fires_per_1k_sqmi)} per 1,000 sq mi/yr`))
      .on("mouseleave", hideTip);

  // Legend
  const lg = svg.append("g").attr("transform", `translate(${width - m.right + 24},${m.top + 8})`);
  regions.forEach((r, i) => {
    const row = lg.append("g").attr("transform", `translate(0,${i * 20})`);
    row.append("circle").attr("r", 5).attr("fill", color(r)).attr("fill-opacity", 0.8);
    row.append("text").attr("x", 12).attr("dy", "0.35em").attr("font-size", 12).text(r);
  });

  const labels = {
    pct_burned: "% of county burned, 2000–2025 (log scale)",
    fires_per_1k_sqmi: "Fires per 1,000 sq mi per year (log scale)",
  };

  function update(metric, animate) {
    const vals = data.map(d => d[metric]).filter(v => v > 0);
    const lo = d3.quantile(vals.sort(d3.ascending), 0.01);
    const y = d3.scaleLog().domain([lo, d3.max(vals)]).nice()
        .range([plotBottom, m.top]).clamp(true);

    const t = svg.transition().duration(animate ? 600 : 0);
    axisY.transition(t).call(d3.axisLeft(y).ticks(6, "~g"));
    gridY.transition(t).call(d3.axisLeft(y).ticks(6).tickSize(-(width - m.left - m.right)).tickFormat(""))
        .attr("transform", `translate(${m.left},0)`);
    gridY.select(".domain").remove();
    yLabel.text(labels[metric]);

    // Spread "no fire" counties a little so they don't stack into one line
    const jitter = d => ((parseInt(d.fips, 10) * 9301 + 49297) % 233280) / 233280;
    dots.transition(t)
        .attr("cy", d => {
          const v = d[metric];
          if (v == null) return -100;                       // no data: hide
          if (v <= 0) return plotBottom + 10 + jitter(d) * (zeroBand - 20);
          return y(v);
        });
  }

  if (!hasFireCounts) {
    d3.select("input[value=fires_per_1k_sqmi]").property("disabled", true)
      .node().parentNode.title = "Add fire_cause_by_county.csv to enable";
  }
  update("pct_burned", false);
  d3.selectAll("input[name=ymetric]").on("change", function () { update(this.value, true); });
}

/* --------------------------------------------------------- GROUP MAP */
// Every county colored by its group. The legend is clickable too.
function drawGroupMap(us, counties, byFips, rows) {
  const width = 975, height = 610;
  const path = d3.geoPath(projection);
  const counts = d3.rollup(rows, v => v.length, d => d.group);

  const legend = d3.select("#group-legend");
  const items = legend.selectAll("button")
    .data(GROUP_ORDER)
    .join("button")
      .attr("type", "button").attr("class", "chip")
      .on("click", (e, g) => selectGroup(g));
  items.append("span").attr("class", "swatch").style("background", g => GROUP_COLOR(g));
  items.append("span").text(g => `${g} (${fmt.int(counts.get(g) || 0)})`);

  const svg = d3.select("#group-map").append("svg").attr("viewBox", [0, 0, width, height]);
  svg.append("path").datum(topojson.feature(us, us.objects.nation))
      .attr("fill", "#fff").attr("stroke", "#bbb").attr("d", path);

  const paths = svg.append("g").selectAll("path")
    .data(counties)
    .join("path")
      .attr("d", path)
      .attr("fill", f => { const d = byFips.get(f.id); return d && d.group ? GROUP_COLOR(d.group) : "#fff"; })
      .on("mousemove", (event, f) => {
        const d = byFips.get(f.id);
        showTip(event, d ? `<b>${d.name}, ${d.state}</b><br>${d.group}<br>
          Population growth since 2000: ${d.pop_growth == null ? "n/a" : fmt.dec1(d.pop_growth) + "%"}<br>
          New homes: ${d.permits_per_1k == null ? "n/a" : fmt.dec1(d.permits_per_1k)} per 1,000 residents/yr`
          : `<b>${f.properties.name}</b><br>No data`);
      })
      .on("mouseleave", hideTip)
      .on("click", (e, f) => { const d = byFips.get(f.id); if (d) selectGroup(d.group); });

  svg.append("path")
      .datum(topojson.mesh(us, us.objects.states, (a, b) => a !== b))
      .attr("fill", "none").attr("stroke", "#fff").attr("stroke-width", 1).attr("d", path);

  statusLine("#group-map");
  onSelect(g => {
    paths.transition().duration(300)
        .attr("fill-opacity", f => !g || byFips.get(f.id)?.group === g ? 1 : 0.12);
    items.classed("active", d => d === g).classed("dim", d => g && d !== g);
  });
}

/* ------------------------------------------------------- GROUP BARS */
// Median population growth and median building rate for each group.
function drawGroupBars(rows) {
  const width = 975, rowH = 46;
  const m = { top: 46, right: 50, bottom: 10, left: 170 };
  const gap = 70;
  const panelW = (width - m.left - m.right - gap) / 2;
  const height = m.top + rowH * GROUP_ORDER.length + m.bottom;

  const stats = GROUP_ORDER.map(g => {
    const v = rows.filter(d => d.group === g);
    return {
      group: g, n: v.length,
      growth: d3.median(v, d => d.pop_growth),
      permits: d3.median(v, d => d.permits_per_1k),
    };
  });

  const y = d3.scaleBand(GROUP_ORDER, [m.top, height - m.bottom]).padding(0.28);
  const svg = d3.select("#group-bars").append("svg").attr("viewBox", [0, 0, width, height]);

  const panels = [
    { key: "growth", title: "Median population growth since 2000", unit: "%", x0: m.left },
    { key: "permits", title: "Median new homes per 1,000 residents per year", unit: "", x0: m.left + panelW + gap },
  ];

  const bars = [];
  panels.forEach(p => {
    const vals = stats.map(s => s[p.key]).filter(v => v != null);
    const x = d3.scaleLinear([Math.min(0, d3.min(vals)), Math.max(0, d3.max(vals))], [p.x0, p.x0 + panelW]).nice();
    const g = svg.append("g");
    g.append("text").attr("x", p.x0).attr("y", 18).attr("class", "panel-title").text(p.title);
    g.append("line").attr("x1", x(0)).attr("x2", x(0))
        .attr("y1", m.top - 6).attr("y2", height - m.bottom).attr("stroke", "#999");
    const b = g.selectAll("g.bar").data(stats).join("g").attr("class", "bar clickable")
        .on("click", (e, d) => selectGroup(d.group));
    b.append("rect")
        .attr("x", d => x(Math.min(0, d[p.key] ?? 0)))
        .attr("y", d => y(d.group))
        .attr("width", d => Math.abs(x(d[p.key] ?? 0) - x(0)))
        .attr("height", y.bandwidth())
        .attr("rx", 2)
        .attr("fill", d => GROUP_COLOR(d.group));
    b.append("text")
        // Negative values get their label just right of the zero line, clear of the group names
        .attr("x", d => (d[p.key] ?? 0) < 0 ? x(0) + 6 : x(d[p.key] ?? 0) + 6)
        .attr("y", d => y(d.group) + y.bandwidth() / 2).attr("dy", "0.35em")
        .attr("text-anchor", "start")
        .attr("class", "value")
        .text(d => d[p.key] == null ? "n/a" : (d[p.key] > 0 && p.unit ? "+" : "") + fmt.dec1(d[p.key]) + p.unit);
    bars.push(b);
  });

  // Group names (also clickable)
  const labels = svg.append("g").selectAll("g").data(stats).join("g")
      .attr("class", "clickable")
      .attr("transform", d => `translate(${m.left - 12},${y(d.group) + y.bandwidth() / 2})`)
      .on("click", (e, d) => selectGroup(d.group));
  labels.append("text").attr("text-anchor", "end").attr("dy", "-0.15em")
      .attr("class", "row-label").text(d => d.group);
  labels.append("text").attr("text-anchor", "end").attr("dy", "1.05em")
      .attr("class", "row-sub").text(d => `${fmt.int(d.n)} counties`);

  onSelect(g => {
    bars.forEach(b => b.transition().duration(200).attr("opacity", d => !g || d.group === g ? 1 : 0.25));
    labels.transition().duration(200).attr("opacity", d => !g || d.group === g ? 1 : 0.35);
  });
}

/* --------------------------------------------------- DROUGHT HEATMAP */
// Average weeks each group spent at each drought level or worse.
function drawDroughtHeatmap(weeks) {
  const box = d3.select("#drought-heatmap");
  if (!weeks) {
    box.append("p").attr("class", "note").text("Add drought_weeks_by_county.csv to this folder to see this chart.");
    return;
  }
  const levels = [
    ["D0", "Abnormally dry"], ["D1", "Moderate"], ["D2", "Severe"],
    ["D3", "Extreme"], ["D4", "Exceptional"],
  ];
  const cells = [];
  GROUP_ORDER.forEach(g => {
    const v = weeks.filter(d => d.group === g);
    levels.forEach(([lv]) => cells.push({ group: g, level: lv, n: v.length,
      weeks: d3.mean(v, d => num(d[`weeks_${lv}`])) }));
  });

  const width = 975, rowH = 54;
  const m = { top: 54, right: 20, bottom: 10, left: 170 };
  const height = m.top + rowH * GROUP_ORDER.length + m.bottom;
  const x = d3.scaleBand(levels.map(l => l[0]), [m.left, width - m.right]).padding(0.06);
  const y = d3.scaleBand(GROUP_ORDER, [m.top, height - m.bottom]).padding(0.06);
  const maxW = d3.max(cells, d => d.weeks) || 1;
  const color = d3.scaleSequential([0, maxW], d3.interpolateYlOrBr);

  const svg = box.append("svg").attr("viewBox", [0, 0, width, height]);

  svg.append("g").selectAll("text").data(levels).join("text")
      .attr("x", d => x(d[0]) + x.bandwidth() / 2).attr("text-anchor", "middle")
      .call(t => t.append("tspan").attr("y", 22).attr("class", "row-label").text(d => d[0]))
      .call(t => t.append("tspan").attr("x", d => x(d[0]) + x.bandwidth() / 2).attr("y", 40)
                  .attr("class", "row-sub").text(d => d[1]));

  const rowsG = svg.append("g").selectAll("g").data(GROUP_ORDER).join("g")
      .attr("class", "clickable")
      .on("click", (e, g) => selectGroup(g));

  rowsG.append("text")
      .attr("x", m.left - 12).attr("y", g => y(g) + y.bandwidth() / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end").attr("class", "row-label").text(g => g);
  rowsG.append("rect")
      .attr("x", m.left - 8).attr("y", g => y(g) + 6).attr("width", 4)
      .attr("height", y.bandwidth() - 12).attr("fill", g => GROUP_COLOR(g));

  const cell = rowsG.selectAll("g.cell")
    .data(g => cells.filter(c => c.group === g))
    .join("g").attr("class", "cell")
      .on("mousemove", (event, d) => showTip(event, `<b>${d.group}</b><br>
        ${d.level} or worse: ${fmt.int(d.weeks)} weeks on average<br>
        (about ${fmt.dec1(d.weeks / 52.18)} years of 2000–2025)`))
      .on("mouseleave", hideTip);
  cell.append("rect")
      .attr("x", d => x(d.level)).attr("y", d => y(d.group))
      .attr("width", x.bandwidth()).attr("height", y.bandwidth())
      .attr("rx", 3).attr("fill", d => d.weeks == null ? "#eee" : color(d.weeks));
  cell.append("text")
      .attr("x", d => x(d.level) + x.bandwidth() / 2)
      .attr("y", d => y(d.group) + y.bandwidth() / 2).attr("dy", "0.35em")
      .attr("text-anchor", "middle").attr("class", "cell-value")
      .attr("fill", d => d.weeks > maxW * 0.55 ? "#fff" : "#1d1d1f")
      .text(d => d.weeks == null ? "" : fmt.int(d.weeks));

  onSelect(g => rowsG.transition().duration(200).attr("opacity", d => !g || d === g ? 1 : 0.3));
}

/* ------------------------------------------- HUMAN-CAUSED SHARE (dumbbell) */
function drawHumanShare(fires) {
  const box = d3.select("#human-share");
  if (!fires || !fires.length || !("building_level" in fires[0])) {
    box.append("p").attr("class", "note").text("Add fire_cause_by_county.csv to this folder to see this chart.");
    return;
  }
  const LEVELS = ["Lowest 20%", "Low", "Middle", "High", "Highest 20%"];
  const LABELS = { "Lowest 20%": "Built least (bottom 20%)", "Low": "Low", "Middle": "Middle",
                   "High": "High", "Highest 20%": "Built most (top 20%)" };
  const data = fires.map(d => ({
    level: d.building_level, region: d.region,
    early: num(d.human_share_early), late: num(d.human_share_late),
  })).filter(d => d.early != null && d.late != null && LEVELS.includes(d.level));

  const summarize = scope => LEVELS.map(lv => {
    const v = data.filter(d => d.level === lv && (scope === "national" || d.region === "West"));
    return { level: lv, n: v.length, early: d3.median(v, d => d.early), late: d3.median(v, d => d.late) };
  });

  const width = 975, rowH = 52;
  const m = { top: 40, right: 110, bottom: 44, left: 210 };
  const height = m.top + rowH * LEVELS.length + m.bottom;
  const x = d3.scaleLinear([0, 100], [m.left, width - m.right]);
  const y = d3.scaleBand(LEVELS, [m.top, height - m.bottom]).padding(0.3);
  const cy = lv => y(lv) + y.bandwidth() / 2;

  const svg = box.append("svg").attr("viewBox", [0, 0, width, height]);
  svg.append("g").attr("class", "grid")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).ticks(5).tickSize(-(height - m.top - m.bottom)).tickFormat(""))
      .call(g => g.select(".domain").remove());
  svg.append("g").attr("class", "axis")
      .attr("transform", `translate(0,${height - m.bottom})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(d => d + "%"));
  svg.append("text").attr("class", "axis-label").attr("x", (m.left + width - m.right) / 2)
      .attr("y", height - 6).attr("text-anchor", "middle")
      .text("Median share of fires started by people");

  // Legend
  const lg = svg.append("g").attr("transform", `translate(${m.left},16)`);
  lg.append("circle").attr("r", 6).attr("fill", "#fff").attr("stroke", "#e66101").attr("stroke-width", 2);
  lg.append("text").attr("x", 12).attr("dy", "0.35em").attr("class", "row-sub").text("2000–2012");
  lg.append("circle").attr("cx", 100).attr("r", 6).attr("fill", "#e66101");
  lg.append("text").attr("x", 112).attr("dy", "0.35em").attr("class", "row-sub").text("2013–2024");

  const labels = svg.append("g").selectAll("g").data(LEVELS).join("g")
      .attr("transform", lv => `translate(${m.left - 14},${cy(lv)})`);
  labels.append("text").attr("text-anchor", "end").attr("dy", "-0.1em")
      .attr("class", "row-label").text(lv => LABELS[lv]);
  const nText = labels.append("text").attr("text-anchor", "end").attr("dy", "1.1em").attr("class", "row-sub");

  const rowG = svg.append("g").selectAll("g").data(summarize("west"), d => d.level).join("g");
  rowG.append("line").attr("class", "conn").attr("stroke", "#e66101").attr("stroke-width", 3).attr("stroke-opacity", 0.45);
  rowG.append("circle").attr("class", "early").attr("r", 7).attr("fill", "#fff").attr("stroke", "#e66101").attr("stroke-width", 2.5);
  rowG.append("circle").attr("class", "late").attr("r", 7).attr("fill", "#e66101");
  rowG.append("text").attr("class", "value change").attr("dy", "0.35em");

  rowG.on("mousemove", (event, d) => showTip(event, `<b>${LABELS[d.level]}</b><br>
        2000–2012: ${fmt.dec1(d.early)}% human-caused<br>
        2013–2024: ${fmt.dec1(d.late)}% human-caused<br>${fmt.int(d.n)} counties`))
      .on("mouseleave", hideTip);

  function update(scope, animate) {
    const s = summarize(scope);
    rowG.data(s, d => d.level);
    const t = svg.transition().duration(animate ? 600 : 0);
    // select() passes the new data down to each row's shapes
    rowG.select(".conn").transition(t).attr("x1", d => x(d.early)).attr("x2", d => x(d.late))
        .attr("y1", d => cy(d.level)).attr("y2", d => cy(d.level));
    rowG.select(".early").transition(t).attr("cx", d => x(d.early)).attr("cy", d => cy(d.level));
    rowG.select(".late").transition(t).attr("cx", d => x(d.late)).attr("cy", d => cy(d.level));
    rowG.select(".change").transition(t)
        .attr("x", d => x(Math.max(d.early, d.late)) + 14).attr("y", d => cy(d.level))
        .text(d => `${d.late - d.early >= 0 ? "+" : ""}${fmt.dec1(d.late - d.early)} pts`);
    nText.data(s).text(d => `${fmt.int(d.n)} counties`);
  }
  update("west", false);
  d3.selectAll("input[name=share-scope]").on("change", function () { update(this.value, true); });
}

/* ------------------------------------------------- FIRE SIZE BY CAUSE */
// Share of fires vs. share of acres burned, human vs. lightning.
function drawFireSize(sizes) {
  const box = d3.select("#fire-size");
  if (!sizes) {
    box.append("p").attr("class", "note").text("Add fire_size_by_cause.csv to this folder to see this chart.");
    return;
  }
  const CAUSES = ["Human", "Natural"];
  const CAUSE_LABEL = { Human: "Started by people", Natural: "Lightning" };
  const CAUSE_COLOR = { Human: "#e66101", Natural: "#5e3c99" };
  const REGIONS = ["All U.S.", "West", "Rest of U.S."];

  const get = (region, period, cause) => {
    const r = sizes.find(d => d.region === region && d.period === period && d.cause === cause);
    return r ? { fires: num(r.fires), acres: num(r.total_acres) } : { fires: 0, acres: 0 };
  };
  function build(period) {
    return REGIONS.map(region => {
      const by = {};
      CAUSES.forEach(c => {
        by[c] = region === "All U.S."
          ? ["West", "Rest of U.S."].map(r => get(r, period, c))
              .reduce((a, b) => ({ fires: a.fires + b.fires, acres: a.acres + b.acres }))
          : get(region, period, c);
      });
      const totF = d3.sum(CAUSES, c => by[c].fires), totA = d3.sum(CAUSES, c => by[c].acres);
      return { region, by, bars: [
        { measure: "Fires", segs: stack(CAUSES.map(c => ({ cause: c, value: by[c].fires, share: totF ? by[c].fires / totF : 0 }))) },
        { measure: "Acres burned", segs: stack(CAUSES.map(c => ({ cause: c, value: by[c].acres, share: totA ? by[c].acres / totA : 0 }))) },
      ]};
    });
  }
  function stack(segs) { let x0 = 0; return segs.map(s => ({ ...s, x0, x1: (x0 += s.share) })); }

  const width = 975, barH = 26, groupGap = 34, barGap = 8;
  const m = { top: 46, right: 30, bottom: 16, left: 230 };
  const groupH = barH * 2 + barGap;
  const height = m.top + REGIONS.length * groupH + (REGIONS.length - 1) * groupGap + m.bottom;
  const x = d3.scaleLinear([0, 1], [m.left, width - m.right]);
  const gy = i => m.top + i * (groupH + groupGap);

  const svg = box.append("svg").attr("viewBox", [0, 0, width, height]);

  const lg = svg.append("g").attr("transform", `translate(${m.left},16)`);
  CAUSES.forEach((c, i) => {
    const it = lg.append("g").attr("transform", `translate(${i * 170},0)`);
    it.append("rect").attr("width", 14).attr("height", 14).attr("y", -7).attr("rx", 2).attr("fill", CAUSE_COLOR[c]);
    it.append("text").attr("x", 20).attr("dy", "0.35em").attr("class", "row-sub").text(CAUSE_LABEL[c]);
  });

  const groups = svg.append("g").selectAll("g").data(REGIONS).join("g")
      .attr("transform", (r, i) => `translate(0,${gy(i)})`);
  groups.append("text").attr("x", 0).attr("y", groupH / 2).attr("dy", "0.35em")
      .attr("class", "row-label").text(r => r);
  groups.append("text").attr("x", m.left - 10).attr("y", barH / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end").attr("class", "row-sub").text("Share of fires");
  groups.append("text").attr("x", m.left - 10).attr("y", barH + barGap + barH / 2).attr("dy", "0.35em")
      .attr("text-anchor", "end").attr("class", "row-sub").text("Share of acres burned");

  function update(period, animate) {
    const data = build(period);
    const t = svg.transition().duration(animate ? 600 : 0);
    groups.data(data.map(d => d.region)).each(function (region, i) {
      const d = data[i];
      const segs = d.bars.flatMap((b, bi) => b.segs.map(s => ({ ...s, bi, measure: b.measure, region })));
      const g = d3.select(this);
      g.selectAll("rect.seg").data(segs, s => s.bi + s.cause).join("rect")
          .attr("class", "seg")
          .attr("y", s => s.bi * (barH + barGap)).attr("height", barH)
          .attr("fill", s => CAUSE_COLOR[s.cause])
          .on("mousemove", (event, s) => {
            const c = d.by[s.cause];
            showTip(event, `<b>${region}: ${CAUSE_LABEL[s.cause]}</b><br>
              ${fmt.int(c.fires)} fires (${fmt.dec1(100 * (d.bars[0].segs.find(z => z.cause === s.cause).share))}% of fires)<br>
              ${fmt.int(c.acres)} acres (${fmt.dec1(100 * (d.bars[1].segs.find(z => z.cause === s.cause).share))}% of acres)<br>
              Average fire: ${c.fires ? fmt.int(c.acres / c.fires) : "n/a"} acres`);
          })
          .on("mouseleave", hideTip)
        .transition(t)
          .attr("x", s => x(s.x0)).attr("width", s => Math.max(0, x(s.x1) - x(s.x0)));
      g.selectAll("text.seg-label").data(segs, s => s.bi + s.cause).join("text")
          .attr("class", "seg-label").attr("dy", "0.35em").attr("text-anchor", "middle")
          .attr("y", s => s.bi * (barH + barGap) + barH / 2)
        .transition(t)
          .attr("x", s => (x(s.x0) + x(s.x1)) / 2)
          .text(s => (x(s.x1) - x(s.x0)) > 44 ? `${Math.round(100 * s.share)}%` : "");
    });

    // Average fire size line under the chart
    const all = data[0].by;
    d3.select("#fire-size-note").html(
      `Average fire size (${period === "All" ? "2000–2024" : period.replace("-", "–")}, all U.S.): ` +
      `<b>${fmt.int(all.Natural.acres / all.Natural.fires)} acres</b> for lightning fires vs. ` +
      `<b>${fmt.int(all.Human.acres / all.Human.fires)} acres</b> for fires started by people.`);
  }
  update("All", false);
  d3.selectAll("input[name=size-period]").on("change", function () { update(this.value, true); });
}

/* ------------------------------------------- BUILDING AFTER A FIRE */
// For each county-year with a big fire, compare new homes in the 3 years
// after the fire with the 3 years before. Then compare that change with
// counties in the same state that had no such fire, over the same years.
function drawFireRebuild(master) {
  const box = d3.select("#rebuild");
  if (!master) {
    box.append("p").attr("class", "note").text("Add county_year_master.csv to this folder to see this section.");
    return;
  }
  const WINDOW = 3;           // years before and after the fire
  const MIN_BASE = 5;         // need at least 5 homes/yr before the fire (avoids tiny-number noise)
  const FIRST = 2000, LAST = 2025;
  const REGION_OF = {};
  Object.entries({
    Northeast: "CT ME MA NH RI VT NJ NY PA",
    Midwest: "IL IN MI OH WI IA KS MN MO NE ND SD",
    South: "DE DC FL GA MD NC SC VA WV AL KY MS TN AR LA OK TX",
    West: "AZ CO ID MT NV NM UT WY AK CA HI OR WA",
  }).forEach(([r, sts]) => sts.split(" ").forEach(s => { REGION_OF[s] = r; }));
  const REGION_COLOR = d3.scaleOrdinal(["West", "South", "Midwest", "Northeast"],
                                       REGION_COLORS);

  // One time series per county
  const series = [];
  for (const [fips, rows] of d3.group(master, d => d.fips.padStart(5, "0"))) {
    const r0 = rows[0];
    series.push({
      fips, name: r0.county_name, state: r0.state, region: REGION_OF[r0.state],
      units: new Map(rows.map(r => [+r.year, num(r.units_total)])),
      acres: new Map(rows.map(r => [+r.year, num(r.acres_burned) || 0])),
    });
  }
  const yrs = (a, b) => d3.range(a, b + 1);
  const meanOf = (s, ys) => {
    const v = ys.map(y => s.units.get(y));
    return v.some(x => x == null) ? null : d3.mean(v);
  };

  function analyze(minAcres) {
    // Comparison counties: never had a fire this big, 2000-2025
    const hadFire = new Set(series.filter(s =>
      yrs(FIRST, LAST).some(y => s.acres.get(y) >= minAcres)).map(s => s.fips));
    const control = d3.rollup(series.filter(s => !hadFire.has(s.fips)),
      v => new Map(yrs(FIRST, LAST).map(y => [y, d3.sum(v, s => s.units.get(y) || 0)])),
      s => s.state);

    // All new homes in each state, per year (every county, fire or not), for the share measure
    const stateTotal = d3.rollup(series,
      v => new Map(yrs(FIRST, LAST).map(y => [y, d3.sum(v, s => s.units.get(y) || 0)])),
      s => s.state);
    const sumYears = (m, ys) => d3.sum(ys, y => m.get(y) || 0);

    const events = [];
    for (const s of series) {
      for (let t = FIRST + WINDOW; t <= LAST - WINDOW; t++) {
        const acres = s.acres.get(t);
        if (!(acres >= minAcres)) continue;
        // Skip if another big fire hit in the years before (it would spoil the baseline)
        if (yrs(t - WINDOW, t - 1).some(y => s.acres.get(y) >= minAcres)) continue;
        const before = meanOf(s, yrs(t - WINDOW, t - 1));
        const after = meanOf(s, yrs(t + 1, t + WINDOW));
        if (before == null || after == null || before < MIN_BASE) continue;

        const ctl = control.get(s.state);
        const ctlBefore = ctl ? d3.mean(yrs(t - WINDOW, t - 1), y => ctl.get(y)) : 0;
        const hasCtl = ctlBefore > 0;
        const change = after / before - 1;
        const ctlChange = hasCtl ? d3.mean(yrs(t + 1, t + WINDOW), y => ctl.get(y)) / ctlBefore - 1 : null;

        // County's share of all new homes in its state, 3 years before vs. 3 years after.
        // This controls for counties that were already outgrowing their state before the fire.
        const st = stateTotal.get(s.state);
        const stBefore = sumYears(st, yrs(t - WINDOW, t - 1));
        const stAfter = sumYears(st, yrs(t + 1, t + WINDOW));
        const shareBefore = stBefore > 0 ? (before * WINDOW) / stBefore : null;
        const shareAfter = stAfter > 0 ? (after * WINDOW) / stAfter : null;
        const shareChange = shareBefore == null || shareAfter == null
          ? null : 100 * (shareAfter - shareBefore);       // percentage points

        events.push({
          ...s, year: t, acres, before, after, change, ctlChange,
          shareBefore, shareAfter, shareChange,
          excess: ctlChange == null ? null : change - ctlChange,
          index: d3.range(-WINDOW, WINDOW + 1).map(k => 100 * (s.units.get(t + k) ?? NaN) / before),
          ctlIndex: hasCtl ? d3.range(-WINDOW, WINDOW + 1).map(k => 100 * ctl.get(t + k) / ctlBefore) : null,
        });
      }
    }
    return events;
  }

  /* ---- layout */
  // The lines, dots, and table each sit on their own page (see index.html)
  const summary = box.append("p").attr("class", "summary");
  const lineBox = box.append("div");
  const dotBox = d3.select("#rebuild-dots");
  const tableBox = d3.select("#rebuild-table");

  /* ---- 1. event-study lines */
  const W = 975, H = 380, m = { top: 30, right: 200, bottom: 50, left: 64 };
  const ks = d3.range(-WINDOW, WINDOW + 1);
  const kLabel = k => k === 0 ? "Fire year" : k < 0 ? `${-k} yr before` : `${k} yr after`;
  const x = d3.scalePoint(ks, [m.left, W - m.right]).padding(0.3);
  const lineSvg = lineBox.append("svg").attr("viewBox", [0, 0, W, H]);
  const yAxisG = lineSvg.append("g").attr("class", "axis").attr("transform", `translate(${m.left},0)`);
  const gridG = lineSvg.append("g").attr("class", "grid").attr("transform", `translate(${m.left},0)`);
  lineSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.bottom})`)
      .call(d3.axisBottom(x).tickFormat(kLabel));
  lineSvg.append("text").attr("class", "axis-label")
      .attr("transform", `translate(16,${(m.top + H - m.bottom) / 2}) rotate(-90)`)
      .attr("text-anchor", "middle").text("New homes (avg. of 3 years before fire = 100)");
  const fireBand = lineSvg.append("rect").attr("fill", "#fdebd8").attr("y", m.top)
      .attr("height", H - m.top - m.bottom);
  const baseLine = lineSvg.append("line").attr("stroke", "#999").attr("stroke-dasharray", "4 3")
      .attr("x1", m.left).attr("x2", W - m.right);
  const lineG = lineSvg.append("g");

  const SERIES = [
    { key: "fire", label: "Counties after a big fire", color: "#d7301f" },
    { key: "ctl", label: "Rest of the same state", color: "#8a8a91" },
  ];

  /* ---- 2. dot plot */
  const DW = 975, DH = 420, dm = { top: 20, right: 150, bottom: 50, left: 70 };
  const dotSvg = dotBox.append("svg").attr("viewBox", [0, 0, DW, DH]);
  const dxAxis = dotSvg.append("g").attr("class", "axis").attr("transform", `translate(0,${DH - dm.bottom})`);
  const dyAxis = dotSvg.append("g").attr("class", "axis").attr("transform", `translate(${dm.left},0)`);
  const dZero = dotSvg.append("line").attr("stroke", "#999").attr("x1", dm.left).attr("x2", DW - dm.right);
  dotSvg.append("text").attr("class", "axis-label").attr("x", (dm.left + DW - dm.right) / 2)
      .attr("y", DH - 10).attr("text-anchor", "middle").text("Acres burned in the county that year (log scale)");
  dotSvg.append("text").attr("class", "axis-label")
      .attr("transform", `translate(18,${(dm.top + DH - dm.bottom) / 2}) rotate(-90)`)
      .attr("text-anchor", "middle").text("Change in share of state's new homes (pts)");
  const dotG = dotSvg.append("g");
  const lg = dotSvg.append("g").attr("transform", `translate(${DW - dm.right + 24},${dm.top + 8})`);
  REGION_COLOR.domain().forEach((r, i) => {
    const row = lg.append("g").attr("transform", `translate(0,${i * 20})`);
    row.append("circle").attr("r", 5).attr("fill", REGION_COLOR(r));
    row.append("text").attr("x", 12).attr("dy", "0.35em").attr("font-size", 12).text(r);
  });
  const pct = v => `${v >= 0 ? "+" : ""}${Math.round(100 * v)}%`;
  const pts = v => `${v >= 0 ? "+" : ""}${Math.round(100 * v)} pts`;
  const share = v => v == null ? "n/a" : (v < 0.0001 && v > 0 ? "<0.01%" : d3.format(".2%")(v));
  const sharePts = v => v == null ? "n/a" : `${v >= 0 ? "+" : ""}${d3.format(".2f")(v)} pts`;
  const eventTip = e => `<b>${e.name}, ${e.state}: ${e.year} fire</b><br>
      ${fmt.int(e.acres)} acres burned<br>
      New homes/yr: ${fmt.int(e.before)} before → ${fmt.int(e.after)} after (${pct(e.change)})<br>
      Share of ${e.state}'s new homes: ${share(e.shareBefore)} → ${share(e.shareAfter)}<br>
      <b>Change in share: ${sharePts(e.shareChange)}</b>`;

  function update(minAcres, animate) {
    const events = analyze(minAcres);
    const withCtl = events.filter(e => e.excess != null);
    const t = d3.transition().duration(animate ? 600 : 0);

    // Summary sentence
    if (!events.length) {
      summary.html("No fires this large with enough building data. Try a smaller size.");
    } else {
      const up = withCtl.filter(e => e.excess > 0).length;
      summary.html(`<b>${fmt.int(events.length)}</b> county fires of ${fmt.int(minAcres)}+ acres (2003–2022).
        In the 3 years after, <b>${Math.round(100 * up / (withCtl.length || 1))}%</b> of these counties built
        faster than the rest of their state. Typical (median) difference:
        <b>${withCtl.length ? pts(d3.median(withCtl, e => e.excess)) : "n/a"}</b>.
        <b>${Math.round(100 * events.filter(e => e.shareChange > 0).length / events.length)}%</b>
        took a bigger share of their state's new homes than before the fire.`);
    }

    // 1. Lines (medians across fires)
    const med = (key) => ks.map((k, i) => ({ k,
      v: d3.median(events.filter(e => e[key]), e => e[key][i]) }));
    const lines = [
      { ...SERIES[0], pts: med("index") },
      { ...SERIES[1], pts: med("ctlIndex") },
    ];
    const vals = lines.flatMap(l => l.pts.map(p => p.v)).filter(v => v != null && isFinite(v));
    const y = d3.scaleLinear([Math.min(60, d3.min(vals) ?? 60), Math.max(140, d3.max(vals) ?? 140)],
                             [H - m.bottom, m.top]).nice();
    yAxisG.transition(t).call(d3.axisLeft(y).ticks(6));
    gridG.transition(t).call(d3.axisLeft(y).ticks(6).tickSize(-(W - m.left - m.right)).tickFormat(""))
         .on("end", () => gridG.select(".domain").remove());
    baseLine.transition(t).attr("y1", y(100)).attr("y2", y(100));
    fireBand.attr("x", x(0) - x.step() / 2).attr("width", x.step());
    const line = d3.line().defined(p => p.v != null && isFinite(p.v)).x(p => x(p.k)).y(p => y(p.v));

    const lg2 = lineG.selectAll("g.series").data(lines, d => d.key).join(enter => {
      const g = enter.append("g").attr("class", "series");
      g.append("path").attr("fill", "none").attr("stroke-width", 3).attr("stroke", d => d.color);
      g.append("text").attr("class", "end-label").attr("dy", "0.35em").attr("font-size", 13)
          .attr("font-weight", 600).attr("fill", d => d.color).text(d => d.label);
      return g;
    });
    lg2.select("path").transition(t).attr("d", d => line(d.pts));
    lg2.select("text.end-label").transition(t)
        .attr("x", x(ks.at(-1)) + 12)
        .attr("y", d => { const p = d.pts.at(-1); return p.v != null && isFinite(p.v) ? y(p.v) : -100; });
    lg2.selectAll("circle").data(d => d.pts.map(p => ({ ...p, color: d.color, label: d.label })))
      .join("circle").attr("r", 4.5).attr("fill", p => p.color)
        .on("mousemove", (event, p) => showTip(event, `<b>${p.label}</b><br>${kLabel(p.k)}:
            ${p.v == null ? "n/a" : Math.round(p.v)} (before-fire level = 100)`))
        .on("mouseleave", hideTip)
      .transition(t)
        .attr("cx", p => x(p.k)).attr("cy", p => p.v != null && isFinite(p.v) ? y(p.v) : -100);

    // 2. Dots: change in the county's share of its state's new homes
    const shareEvents = events.filter(e => e.shareChange != null);
    const acresExtent = d3.extent(shareEvents, e => e.acres);
    const dx = d3.scaleLog([minAcres, Math.max(minAcres * 10, acresExtent[1] || minAcres * 10)],
                           [dm.left, DW - dm.right]).nice();
    // Symmetric y-axis around 0; the most extreme 2% are pinned to the edge so they don't squash the rest
    const absVals = shareEvents.map(e => Math.abs(e.shareChange)).sort(d3.ascending);
    const yMax = Math.max(0.5, d3.quantileSorted(absVals, 0.98) || 0.5);
    const dy = d3.scaleLinear([-yMax, yMax], [DH - dm.bottom, dm.top]).nice().clamp(true);
    const dr = d3.scaleSqrt([0, d3.max(shareEvents, e => e.before) || 1], [2.5, 11]);
    dxAxis.transition(t).call(d3.axisBottom(dx).ticks(6, ",.0f"));
    dyAxis.transition(t).call(d3.axisLeft(dy).ticks(8).tickFormat(d => (d > 0 ? "+" : "") + d));
    dZero.transition(t).attr("y1", dy(0)).attr("y2", dy(0));
    dotG.selectAll("circle").data(shareEvents, e => e.fips + e.year)
      .join(enter => enter.append("circle").attr("r", 0).attr("cx", e => dx(e.acres)).attr("cy", dy(0)))
        .attr("fill", e => REGION_COLOR(e.region) ?? "#999")
        .attr("fill-opacity", 0.7).attr("stroke", "#fff").attr("stroke-width", 0.5)
        .on("mousemove", (event, e) => showTip(event, eventTip(e)))
        .on("mouseleave", hideTip)
      .transition(t)
        .attr("r", e => dr(e.before))   // bigger dot = more homes built before the fire
        .attr("cx", e => dx(e.acres))
        .attr("cy", e => dy(e.shareChange));

    // 3. Table of the biggest share jumps
    const top = shareEvents.filter(e => e.before >= 20)
      .sort((a, b) => d3.descending(a.shareChange, b.shareChange)).slice(0, 10);
    tableBox.html("");
    const table = tableBox.append("table").attr("class", "data-table");
    table.append("thead").append("tr").selectAll("th")
      .data(["County", "Fire year", "Acres burned", "New homes/yr before", "After",
             "Share of state before", "After", "Change in share"])
      .join("th").text(d => d);
    const tr = table.append("tbody").selectAll("tr").data(top).join("tr");
    tr.append("td").text(e => `${e.name}, ${e.state}`);
    tr.append("td").text(e => e.year);
    tr.append("td").text(e => fmt.int(e.acres));
    tr.append("td").text(e => fmt.int(e.before));
    tr.append("td").text(e => fmt.int(e.after));
    tr.append("td").text(e => share(e.shareBefore));
    tr.append("td").text(e => share(e.shareAfter));
    tr.append("td").append("b").text(e => sharePts(e.shareChange));
    if (!top.length) tableBox.append("p").attr("class", "note").text("No qualifying fires at this size.");
  }

  // Two sets of size buttons (one on the line page, one on the dot page) stay in sync
  const sizeInputs = d3.selectAll("input[name=rebuild-size-a], input[name=rebuild-size-b]");
  sizeInputs.on("change", function () {
    const v = this.value;
    sizeInputs.property("checked", function () { return this.value === v; });
    update(+v, true);
  });
  update(10000, false);
}

/* ------------------------------------------------------- PAGE NAVIGATION */
// Bottom bar shows the current page; arrow keys and Page Up/Down jump one page at a time.
(function pageNav() {
  const pages = Array.from(document.querySelectorAll(".page"));
  const label = document.getElementById("page-label");
  const count = document.getElementById("page-count");
  let current = 0;

  const setCurrent = i => {
    current = i;
    const p = pages[i];
    label.textContent = `${String(i).padStart(2, "0")} · ${p.dataset.title}`;
    count.textContent = `${i + 1} / ${pages.length}`;
  };
  setCurrent(0);

  const io = new IntersectionObserver(entries => {
    entries.forEach(en => { if (en.isIntersecting) setCurrent(pages.indexOf(en.target)); });
  }, { threshold: 0.5 });
  pages.forEach(p => io.observe(p));

  document.addEventListener("keydown", e => {
    if (e.target.closest("input, textarea, select, button")) return;
    const next = { ArrowDown: 1, PageDown: 1, ArrowUp: -1, PageUp: -1 }[e.key];
    if (!next) return;
    const i = Math.max(0, Math.min(pages.length - 1, current + next));
    if (i === current) return;
    e.preventDefault();
    pages[i].scrollIntoView({ behavior: "smooth" });
  });
})();