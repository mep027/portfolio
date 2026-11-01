import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
import { fetchJSON, renderProjects } from '../global.js';

const projects = await fetchJSON('../lib/projects.json');
const projectsContainer = document.querySelector('.projects');
const title = document.querySelector('.projects-title');
const searchInput = document.querySelector('.searchBar');

// Both filters are stored here, so neither one forgets the other
let query = '';
let selectedYear = null; // null means no wedge selected

// Defined once so each year keeps the same color, even after searching
const colors = d3.scaleOrdinal(d3.schemeTableau10);

function searchProjects(list) {
  return list.filter((project) => {
    let values = Object.values(project).join('\n').toLowerCase();
    return values.includes(query.toLowerCase());
  });
}

function renderPieChart(projectsGiven) {
  // Count projects per year, sorted so wedges stay in order
  let rolledData = d3.rollups(projectsGiven, (v) => v.length, (d) => d.year);
  let data = rolledData
    .map(([year, count]) => ({ value: count, label: year }))
    .sort((a, b) => a.label.localeCompare(b.label));

  let arcGenerator = d3.arc().innerRadius(0).outerRadius(50);
  let sliceGenerator = d3.pie().value((d) => d.value).sort(null);
  let arcData = sliceGenerator(data);
  let arcs = arcData.map((d) => arcGenerator(d));

  // Clear the old chart and legend before redrawing
  let svg = d3.select('#projects-pie-plot');
  svg.selectAll('path').remove();
  let legend = d3.select('.legend');
  legend.selectAll('li').remove();

  // Clicking a selected year deselects it; clicking another selects that one
  function toggleYear(year) {
    selectedYear = selectedYear === year ? null : year;
    updatePage();
  }

  arcs.forEach((arc, i) => {
    svg
      .append('path')
      .attr('d', arc)
      .attr('fill', colors(data[i].label))
      .attr('class', data[i].label === selectedYear ? 'selected' : '')
      .on('click', () => toggleYear(data[i].label));
  });

  data.forEach((d) => {
    legend
      .append('li')
      .attr('style', `--color:${colors(d.label)}`)
      .attr('class', d.label === selectedYear ? 'legend-item selected' : 'legend-item')
      .html(`<span class="swatch"></span> ${d.label} <em>(${d.value})</em>`)
      .on('click', () => toggleYear(d.label));
  });
}

// One function applies BOTH filters, so they always work together
function updatePage() {
  let searched = searchProjects(projects);

  // If the search removed every project from the selected year, clear the selection
  if (selectedYear !== null && !searched.some((p) => p.year === selectedYear)) {
    selectedYear = null;
  }

  let visible =
    selectedYear === null
      ? searched
      : searched.filter((p) => p.year === selectedYear);

  renderPieChart(searched); // pie shows the search results
  renderProjects(visible, projectsContainer, 'h2'); // list shows search + year
  title.textContent = `${visible.length} Projects`;
}

searchInput.addEventListener('input', (event) => {
  query = event.target.value;
  updatePage();
});

updatePage(); // first render on page load